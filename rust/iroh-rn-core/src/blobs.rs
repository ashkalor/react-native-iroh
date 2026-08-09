//! Blob transfer: share a local file as a ticket, download a ticket to a
//! local file with progress events.
//!
//! Progress reporting is intentionally unthrottled: the core emits one event
//! per progress item from the underlying transfer. The bridge layer is
//! responsible for coalescing events before crossing into JS.

use std::{path::PathBuf, sync::LazyLock, sync::Mutex};

use iroh_blobs::{
    api::{
        blobs::{AddPathOptions, BlobStatus, ExportOptions},
        remote::GetProgressItem,
    },
    format::collection::Collection,
    hashseq::HashSeq,
    ticket::BlobTicket,
    BlobFormat, Hash, HashAndFormat,
};
use n0_future::StreamExt;
use tokio::sync::oneshot;

use crate::{
    endpoint::{endpoint_state, EndpointHandle, NetworkPreset},
    error::{error_chain, IrohError, Result},
    guarded_callback,
    registry::Registry,
    require_absolute,
    runtime::runtime,
    spawn_completing,
};

/// How long [`blob_share`] waits for an `N0`-preset endpoint to come
/// online (home relay + addresses known) before minting a ticket anyway.
const ONLINE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Opaque handle to an in-flight download. `0` is never a valid handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TransferHandle(u64);

impl TransferHandle {
    /// Reconstructs a handle from its raw FFI representation.
    pub fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    /// The raw numeric value passed across the FFI boundary.
    pub fn raw(self) -> u64 {
        self.0
    }
}

/// A live transfer: holds the trigger that cancels it.
#[derive(Debug)]
struct TransferState {
    cancel: Mutex<Option<oneshot::Sender<()>>>,
}

static TRANSFERS: LazyLock<Registry<TransferState>> = LazyLock::new(Registry::new);

/// Imports the file at `path` into the endpoint's blob store and produces a
/// shareable ticket string via `on_complete`.
///
/// `path` must be absolute. The bytes are copied into the store, so the caller
/// stays free to move, change or delete the file afterwards.
pub fn blob_share(
    endpoint: EndpointHandle,
    path: PathBuf,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(share_inner(endpoint, path), on_complete);
}

async fn share_inner(endpoint: EndpointHandle, path: PathBuf) -> Result<String> {
    let path = require_absolute(path, "share path")?;
    let state = endpoint_state(endpoint)?;
    let mode = state.store.import_mode();
    let import = async {
        state
            .store
            .api()
            .blobs()
            .add_path_with_opts(AddPathOptions {
                path,
                format: BlobFormat::Raw,
                mode,
            })
            .await
            .map_err(|e| IrohError::BlobImport(e.to_string()))
    };
    // On the N0 preset a ticket minted right after bind may not carry
    // dialable addresses yet (no home relay, no confirmed direct addresses).
    // Wait (bounded) for the endpoint to come online; on timeout the ticket
    // is still produced with whatever addresses are known (best effort).
    // Minimal endpoints skip this: their only addresses are the locally bound
    // sockets, which are known immediately.
    let wait_online = async {
        if state.preset == NetworkPreset::N0 {
            let _ = tokio::time::timeout(ONLINE_TIMEOUT, state.endpoint.online()).await;
        }
    };
    // The import and the online wait are independent: overlap them and mint
    // the ticket once both are done.
    let (tag, ()) = tokio::join!(import, wait_online);
    let tag = tag?;
    let ticket = BlobTicket::new(state.endpoint.addr(), tag.hash, tag.format);
    Ok(ticket.to_string())
}

/// Native introspection of a blob ticket string, produced by [`parse_ticket`].
///
/// A pure decode of the ticket wire format: no network, no store lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketInfo {
    /// The blob's BLAKE3 content hash, 64 lowercase hex characters.
    pub hash: String,
    /// `"raw"` for a single blob, `"hashSeq"` for a collection (HashSeq root).
    pub format: &'static str,
    /// The sharing endpoint's id (its public key) as a string.
    pub node_id: String,
    /// The blob's payload size, if it can be known without downloading. A bare
    /// ticket does not encode size, so this is currently always `None`
    /// (reserved: populated only when the blob is already local).
    pub size: Option<u64>,
}

/// Decodes a blob ticket string into its constituent parts.
///
/// Synchronous and side-effect-free: it parses the ticket wire format only.
/// Returns [`IrohError::InvalidTicket`] if the string is not a valid ticket.
///
/// See [`BlobTicket`](https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/ticket/struct.BlobTicket.html).
pub fn parse_ticket(ticket: &str) -> Result<TicketInfo> {
    let ticket: BlobTicket = ticket
        .parse()
        .map_err(|e| IrohError::InvalidTicket(format!("{e}")))?;
    Ok(TicketInfo {
        hash: ticket.hash().to_string(),
        format: match ticket.format() {
            BlobFormat::Raw => "raw",
            BlobFormat::HashSeq => "hashSeq",
        },
        node_id: ticket.addr().id.to_string(),
        size: None,
    })
}

/// A resolved child of a collection: its file name and a standalone Raw blob
/// ticket that fetches that one child from the same provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionEntry {
    /// The child's name within the collection (the source file's base name).
    pub name: String,
    /// A [`BlobFormat::Raw`] ticket for this child, dialable independently.
    pub ticket: String,
}

/// Bundles the files at `paths` into an iroh-blobs [`Collection`] (a HashSeq of
/// per-file blobs plus a metadata blob) stored under a persistent tag, and
/// produces one shareable HashSeq ticket via `on_complete`.
///
/// Each child's name is its source file's base name. `paths` must be non-empty
/// and every path absolute. Mirrors [`blob_share`]'s import/online semantics.
pub fn collection_share(
    endpoint: EndpointHandle,
    paths: Vec<PathBuf>,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(collection_share_inner(endpoint, paths), on_complete);
}

async fn collection_share_inner(endpoint: EndpointHandle, paths: Vec<PathBuf>) -> Result<String> {
    if paths.is_empty() {
        return Err(IrohError::BlobImport(
            "a collection needs at least one file".into(),
        ));
    }
    let state = endpoint_state(endpoint)?;
    let mode = state.store.import_mode();
    // Import every child in order, pairing each with its source file's name.
    let import = async {
        let mut items: Vec<(String, iroh_blobs::Hash)> = Vec::with_capacity(paths.len());
        for path in paths {
            let path = require_absolute(path, "share path")?;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .ok_or_else(|| {
                    IrohError::InvalidPath(format!(
                        "share path has no file name: {}",
                        path.display()
                    ))
                })?;
            let tag = state
                .store
                .api()
                .blobs()
                .add_path_with_opts(AddPathOptions {
                    path,
                    format: BlobFormat::Raw,
                    mode,
                })
                .await
                .map_err(|e| IrohError::BlobImport(e.to_string()))?;
            items.push((name, tag.hash));
        }
        Ok::<_, IrohError>(items)
    };
    // Overlap the online wait with the imports (see [`share_inner`]).
    let wait_online = async {
        if state.preset == NetworkPreset::N0 {
            let _ = tokio::time::timeout(ONLINE_TIMEOUT, state.endpoint.online()).await;
        }
    };
    let (items, ()) = tokio::join!(import, wait_online);
    let items = items?;

    let collection = Collection::from_iter(items);
    // `store` returns a TempTag (dropped at end of scope, GC-eligible); persist
    // a permanent tag so the provider keeps serving the collection afterwards.
    let tag = collection
        .store(state.store.api())
        .await
        .map_err(|e| IrohError::BlobImport(format!("store collection: {e}")))?;
    state
        .store
        .api()
        .tags()
        .create(tag.hash_and_format())
        .await
        .map_err(|e| IrohError::BlobImport(format!("tag collection: {e}")))?;
    let ticket = BlobTicket::new(state.endpoint.addr(), tag.hash(), BlobFormat::HashSeq);
    Ok(ticket.to_string())
}

/// Fetches only a collection's manifest (its HashSeq root blob plus the
/// metadata blob, not the child payloads) and resolves the child list via
/// `on_complete`: for each child, its name and a standalone [`BlobFormat::Raw`]
/// ticket pointing at the same provider.
///
/// This is the front half of a per-child collection download: the caller then
/// downloads each returned child ticket through the ordinary [`blob_download`]
/// machinery, so children fan out concurrently and progress/fail independently.
///
/// Retention: fetching the manifest tags the collection root (a HashSeq tag
/// named after the root hash), which transitively retains the root, its
/// metadata blob, and every present child under opt-in GC; each child is also
/// tagged as it is downloaded. Drop the root tag with [`tags_delete`] to make
/// the collection reclaimable.
pub fn collection_manifest(
    endpoint: EndpointHandle,
    ticket: String,
    on_complete: impl FnOnce(Result<Vec<CollectionEntry>>) + Send + 'static,
) {
    spawn_completing(collection_manifest_inner(endpoint, ticket), on_complete);
}

async fn collection_manifest_inner(
    endpoint: EndpointHandle,
    ticket: String,
) -> Result<Vec<CollectionEntry>> {
    let ticket: BlobTicket = ticket
        .parse()
        .map_err(|e| IrohError::InvalidTicket(format!("{e}")))?;
    if ticket.format() != BlobFormat::HashSeq {
        return Err(IrohError::InvalidTicket(
            "ticket is not a collection (expected HashSeq format)".into(),
        ));
    }
    let state = endpoint_state(endpoint)?;
    let root = ticket.hash();
    let connection = state
        .endpoint
        .connect(ticket.addr().clone(), iroh_blobs::ALPN)
        .await
        .map_err(|e| IrohError::BlobDownload(format!("connect: {}", error_chain(&e))))?;
    let remote = state.store.api().remote();

    // Protect the collection root for the fetch-to-persist window (see
    // `download_inner`). A HashSeq tag transitively protects the root, its
    // metadata blob, and every child that is present, so tagging the root
    // retains the whole collection under opt-in GC; each child is additionally
    // retained by its own tag as it is downloaded via `blob_download`.
    let root_haf = HashAndFormat::hash_seq(root);
    let protect = state
        .store
        .api()
        .tags()
        .temp_tag(root_haf)
        .await
        .map_err(|e| IrohError::BlobDownload(format!("protect collection: {e}")))?;

    // Fetch just the HashSeq root blob (Raw, non-recursive), then read it to
    // discover the metadata blob's hash, then fetch that. With both present the
    // collection's (name, child-hash) pairs load without touching any payload.
    remote
        .fetch(connection.clone(), HashAndFormat::raw(root))
        .await
        .map_err(|e| {
            IrohError::BlobDownload(format!("fetch collection root: {}", error_chain(&e)))
        })?;
    let root_bytes = state
        .store
        .api()
        .blobs()
        .get_bytes(root)
        .await
        .map_err(|e| {
            IrohError::BlobDownload(format!("read collection root: {}", error_chain(&e)))
        })?;
    let hash_seq = HashSeq::new(root_bytes)
        .ok_or_else(|| IrohError::InvalidTicket("collection root is not a hash sequence".into()))?;
    let meta_hash = hash_seq
        .iter()
        .next()
        .ok_or_else(|| IrohError::InvalidTicket("collection hash sequence is empty".into()))?;
    remote
        .fetch(connection.clone(), HashAndFormat::raw(meta_hash))
        .await
        .map_err(|e| {
            IrohError::BlobDownload(format!("fetch collection metadata: {}", error_chain(&e)))
        })?;

    let collection = Collection::load(root, state.store.api())
        .await
        .map_err(|e| IrohError::BlobDownload(format!("load collection: {}", error_chain(&e))))?;

    // Persist the collection-root tag (named by the root hash) before releasing
    // the temp tag, so the collection is retained under opt-in GC with no gap.
    state
        .store
        .api()
        .tags()
        .set(retention_tag_name(&root_haf), root_haf)
        .await
        .map_err(|e| IrohError::BlobStore(format!("tag collection: {e}")))?;
    drop(protect);

    let provider = ticket.addr().clone();
    let entries = collection
        .iter()
        .map(|(name, hash)| CollectionEntry {
            name: name.clone(),
            ticket: BlobTicket::new(provider.clone(), *hash, BlobFormat::Raw).to_string(),
        })
        .collect();
    Ok(entries)
}

/// Starts downloading the blob described by `ticket` into `dest_path`.
///
/// Returns a [`TransferHandle`] immediately (or an error if the ticket or
/// destination path is invalid). While the transfer runs, `on_progress`
/// receives the cumulative number of payload bytes fetched: values are
/// non-decreasing and unthrottled (the bridge coalesces). `on_complete` fires
/// exactly once with the terminal result, after which the handle is invalid.
///
/// Retention: on success the downloaded blob is tagged (under a tag named after
/// the root hash), so it is retained under opt-in GC exactly like a shared or
/// imported blob. GC reclaims only untagged blobs; to make a downloaded blob
/// reclaimable, drop its tag with [`tags_delete`] (the tag name is the root
/// hash) and let a GC pass run. A partially-downloaded blob is protected too:
/// the tag is held across the fetch so a concurrent sweep cannot reclaim it.
pub fn blob_download(
    endpoint: EndpointHandle,
    ticket: &str,
    dest_path: PathBuf,
    on_progress: impl Fn(u64) + Send + Sync + 'static,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) -> Result<TransferHandle> {
    let ticket: BlobTicket = ticket
        .parse()
        .map_err(|e| IrohError::InvalidTicket(format!("{e}")))?;
    let dest_path = require_absolute(dest_path, "destination path")?;

    let (cancel_tx, cancel_rx) = oneshot::channel();
    let handle = TRANSFERS.insert(TransferState {
        cancel: Mutex::new(Some(cancel_tx)),
    });

    spawn_completing(
        async move {
            // Running the transfer as its own task turns a panic anywhere
            // inside it into a JoinError instead of a lost completion callback.
            let mut task =
                runtime().spawn(download_inner(endpoint, ticket, dest_path, on_progress));
            let result = tokio::select! {
                _ = cancel_rx => {
                    task.abort();
                    Err(IrohError::Cancelled)
                }
                joined = &mut task => match joined {
                    Ok(result) => result,
                    Err(join_err) => Err(IrohError::Internal(format!("download task failed: {join_err}"))),
                },
            };
            // The handle may already be gone if the caller raced a cancel.
            TRANSFERS.remove(handle).ok();
            result
        },
        on_complete,
    );

    Ok(TransferHandle(handle))
}

/// Cancels an in-flight download.
///
/// The transfer's `on_complete` still fires exactly once, with
/// [`IrohError::Cancelled`]. Returns [`IrohError::InvalidHandle`] if the
/// transfer already finished.
pub fn blob_download_cancel(transfer: TransferHandle) -> Result<()> {
    let state = TRANSFERS.get(transfer.raw())?;
    let sender = state
        .cancel
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(sender) = sender {
        // If the transfer just completed, the receiver is gone; that's fine:
        // completion already won the race.
        sender.send(()).ok();
    }
    Ok(())
}

/// Parses a 64-hex-character BLAKE3 content hash, the shape [`Hash::to_string`]
/// produces and every blob-store management call accepts.
fn parse_hash(hash: &str) -> Result<Hash> {
    hash.parse::<Hash>()
        .map_err(|e| IrohError::BlobStore(format!("invalid blob hash {hash:?}: {e}")))
}

/// The name of the retention tag a download creates for its root blob: the
/// root hash in hex. Deterministic (so re-downloading overwrites rather than
/// piling up tags), discoverable via [`tags_list`], and directly droppable via
/// [`tags_delete`] to make the blob GC-reclaimable again.
fn retention_tag_name(haf: &HashAndFormat) -> String {
    haf.hash.to_string()
}

/// Builds a [`HashAndFormat`] from a hash and a `"raw"` / `"hashSeq"` format
/// tag, the two [`BlobFormat`] names the bridge uses everywhere.
fn hash_and_format(hash: Hash, format: &str) -> Result<HashAndFormat> {
    match format {
        "raw" => Ok(HashAndFormat::raw(hash)),
        "hashSeq" => Ok(HashAndFormat::hash_seq(hash)),
        other => Err(IrohError::BlobStore(format!(
            "unknown blob format {other:?} (expected \"raw\" or \"hashSeq\")"
        ))),
    }
}

/// Local presence of a blob in the store, produced by [`blob_status`].
///
/// Mirrors iroh-blobs' [`BlobStatus`] but owns plain data the bridge can encode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobStatusInfo {
    /// The blob is not present at all.
    NotFound,
    /// Some of the blob's ranges are present but it is incomplete.
    Partial {
        /// The currently stored partial size in bytes, when known.
        size: Option<u64>,
    },
    /// The whole blob is present and BLAKE3-verified.
    Complete {
        /// The blob's full size in bytes.
        size: u64,
    },
}

impl From<BlobStatus> for BlobStatusInfo {
    fn from(status: BlobStatus) -> Self {
        match status {
            BlobStatus::NotFound => BlobStatusInfo::NotFound,
            BlobStatus::Partial { size } => BlobStatusInfo::Partial { size },
            BlobStatus::Complete { size } => BlobStatusInfo::Complete { size },
        }
    }
}

/// Reports whether `hash` is absent, partially present, or complete in the
/// endpoint's blob store.
///
/// This is what turns a resumable download into an observable one: a
/// [`BlobStatusInfo::Partial`] means the next [`blob_download`] fetches only the
/// missing ranges (see [`download_inner`]).
pub fn blob_status(
    endpoint: EndpointHandle,
    hash: String,
    on_complete: impl FnOnce(Result<BlobStatusInfo>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let state = endpoint_state(endpoint)?;
            let hash = parse_hash(&hash)?;
            let status = state
                .store
                .api()
                .blobs()
                .status(hash)
                .await
                .map_err(|e| IrohError::BlobStore(format!("status: {e}")))?;
            Ok(status.into())
        },
        on_complete,
    );
}

/// Whether the endpoint's store holds `hash` complete (BLAKE3-verified). A
/// partial blob reports `false`.
pub fn blob_has(
    endpoint: EndpointHandle,
    hash: String,
    on_complete: impl FnOnce(Result<bool>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let state = endpoint_state(endpoint)?;
            let hash = parse_hash(&hash)?;
            state
                .store
                .api()
                .blobs()
                .has(hash)
                .await
                .map_err(|e| IrohError::BlobStore(format!("has: {e}")))
        },
        on_complete,
    );
}

/// One blob in the store, as reported by [`blob_list`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobInfo {
    /// The blob's BLAKE3 content hash, 64 lowercase hex characters.
    pub hash: String,
    /// The blob's size in bytes (its full size when complete, the stored
    /// partial size otherwise, `0` when unknown).
    pub size: u64,
}

/// Lists the complete blobs the endpoint's store holds, each with its size.
pub fn blob_list(
    endpoint: EndpointHandle,
    on_complete: impl FnOnce(Result<Vec<BlobInfo>>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let state = endpoint_state(endpoint)?;
            let blobs = state.store.api().blobs();
            let hashes = blobs
                .list()
                .hashes()
                .await
                .map_err(|e| IrohError::BlobStore(format!("list: {e}")))?;
            let mut out = Vec::with_capacity(hashes.len());
            for hash in hashes {
                let size = match blobs.status(hash).await {
                    Ok(BlobStatus::Complete { size }) => size,
                    Ok(BlobStatus::Partial { size }) => size.unwrap_or(0),
                    _ => 0,
                };
                out.push(BlobInfo {
                    hash: hash.to_string(),
                    size,
                });
            }
            Ok(out)
        },
        on_complete,
    );
}

/// Imports the in-memory `bytes` into the endpoint's blob store and produces a
/// shareable ticket string, the in-memory counterpart of [`blob_share`].
///
/// The bytes are copied into the store (there is no borrowed-file mode to
/// avoid), so this is unaffected by the import-mode invariant.
pub fn blob_add_bytes(
    endpoint: EndpointHandle,
    bytes: Vec<u8>,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(add_bytes_inner(endpoint, bytes), on_complete);
}

async fn add_bytes_inner(endpoint: EndpointHandle, bytes: Vec<u8>) -> Result<String> {
    let state = endpoint_state(endpoint)?;
    let import = async {
        state
            .store
            .api()
            .blobs()
            .add_bytes(bytes)
            .await
            .map_err(|e| IrohError::BlobImport(e.to_string()))
    };
    // Mirror [`share_inner`]: overlap the online wait with the import so the
    // minted ticket carries dialable addresses on the N0 preset.
    let wait_online = async {
        if state.preset == NetworkPreset::N0 {
            let _ = tokio::time::timeout(ONLINE_TIMEOUT, state.endpoint.online()).await;
        }
    };
    let (tag, ()) = tokio::join!(import, wait_online);
    let tag = tag?;
    let ticket = BlobTicket::new(state.endpoint.addr(), tag.hash, tag.format);
    Ok(ticket.to_string())
}

/// One tag in the store, as reported by [`tags_list`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagEntry {
    /// The tag's name (its bytes read as UTF-8, lossily).
    pub name: String,
    /// The tagged blob's BLAKE3 content hash.
    pub hash: String,
    /// `"raw"` or `"hashSeq"`: the format the tag protects, which decides
    /// whether GC also protects a hash sequence's children.
    pub format: &'static str,
}

fn blob_format_name(format: BlobFormat) -> &'static str {
    match format {
        BlobFormat::Raw => "raw",
        BlobFormat::HashSeq => "hashSeq",
    }
}

/// Lists every tag in the store: the sanctioned way to see what survives GC.
pub fn tags_list(
    endpoint: EndpointHandle,
    on_complete: impl FnOnce(Result<Vec<TagEntry>>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let state = endpoint_state(endpoint)?;
            let mut stream = state
                .store
                .api()
                .tags()
                .list()
                .await
                .map_err(|e| IrohError::BlobStore(format!("list tags: {e}")))?;
            let mut out = Vec::new();
            while let Some(item) = stream.next().await {
                let info = item.map_err(|e| IrohError::BlobStore(format!("list tags: {e}")))?;
                out.push(TagEntry {
                    name: String::from_utf8_lossy(info.name.as_ref()).into_owned(),
                    hash: info.hash.to_string(),
                    format: blob_format_name(info.format),
                });
            }
            Ok(out)
        },
        on_complete,
    );
}

/// Creates (or overwrites) the tag `name`, pinning `hash` so GC keeps it. This
/// is the retention primitive: an untagged blob is reclaimed once GC runs, a
/// tagged one survives.
pub fn tags_create(
    endpoint: EndpointHandle,
    name: String,
    hash: String,
    format: String,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let state = endpoint_state(endpoint)?;
            let hash = parse_hash(&hash)?;
            let value = hash_and_format(hash, &format)?;
            state
                .store
                .api()
                .tags()
                .set(name.as_bytes(), value)
                .await
                .map_err(|e| IrohError::BlobStore(format!("create tag: {e}")))
        },
        on_complete,
    );
}

/// Deletes the tag `name`. The blob it pinned is not removed here: it becomes
/// GC-eligible, and (only if GC is running) is reclaimed on the next pass. This
/// is the "remove a blob" path, deletion staying GC-only by design.
pub fn tags_delete(
    endpoint: EndpointHandle,
    name: String,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let state = endpoint_state(endpoint)?;
            // `delete` reports how many tags it removed; deleting an absent tag
            // is not an error, matching the idempotent teardown callers expect.
            state
                .store
                .api()
                .tags()
                .delete(name.as_bytes())
                .await
                .map(|_removed| ())
                .map_err(|e| IrohError::BlobStore(format!("delete tag: {e}")))
        },
        on_complete,
    );
}

/// Renames the tag `from` to `to` atomically. Fails if `from` does not exist.
pub fn tags_rename(
    endpoint: EndpointHandle,
    from: String,
    to: String,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let state = endpoint_state(endpoint)?;
            state
                .store
                .api()
                .tags()
                .rename(from.as_bytes(), to.as_bytes())
                .await
                .map_err(|e| IrohError::BlobStore(format!("rename tag: {e}")))
        },
        on_complete,
    );
}

async fn download_inner(
    endpoint: EndpointHandle,
    ticket: BlobTicket,
    dest_path: PathBuf,
    on_progress: impl Fn(u64) + Send + Sync + 'static,
) -> Result<()> {
    let state = endpoint_state(endpoint)?;

    // Dial the provider directly via the addresses in the ticket (plus any
    // address lookup the endpoint's network preset provides).
    let connection = state
        .endpoint
        .connect(ticket.addr().clone(), iroh_blobs::ALPN)
        .await
        .map_err(|e| IrohError::BlobDownload(format!("connect: {}", error_chain(&e))))?;

    let store = state.store.api();
    let haf = ticket.hash_and_format();

    // Protect the blob for the whole fetch-to-persist window. `fetch` writes
    // ranges into the store without any protection of its own, so with opt-in
    // GC enabled a concurrent sweep could reclaim the just-written (partial or
    // complete) blob before it is tagged. A temp tag held across the fetch, the
    // export, and the persistent-tag creation closes that window: it is created
    // before the first byte and dropped only after the persistent tag exists,
    // so the root hash is protected at every instant. Symmetric with how
    // share/add_bytes retain their imports.
    let protect = store
        .tags()
        .temp_tag(haf)
        .await
        .map_err(|e| IrohError::BlobDownload(format!("protect download: {e}")))?;

    // `fetch` is resume-aware: it calls `Remote::local_for_request` and only
    // issues `LocalInfo::missing()` to the provider, so a re-issued download of
    // a partially-present blob (an earlier transfer cancelled or interrupted
    // mid-stream leaves verified ranges in the store) transfers only the ranges
    // still missing. Progress therefore counts payload bytes of that missing
    // request, not of the whole blob.
    let mut stream = store.remote().fetch(connection, haf).stream();
    let mut finished = false;
    while let Some(item) = stream.next().await {
        match item {
            GetProgressItem::Progress(bytes) => {
                guarded_callback(|| on_progress(bytes));
            }
            GetProgressItem::Done(_stats) => {
                finished = true;
            }
            GetProgressItem::Error(e) => {
                return Err(IrohError::BlobDownload(error_chain(&e)));
            }
        }
    }
    if !finished {
        return Err(IrohError::BlobDownload(
            "transfer stream ended before completion".into(),
        ));
    }

    // Export the verified blob out of the store to the destination path.
    clear_export_target(&dest_path).await?;
    let mode = state.store.export_mode();
    store
        .blobs()
        .export_with_opts(ExportOptions {
            hash: ticket.hash(),
            mode,
            target: dest_path,
        })
        .await
        .map_err(|e| IrohError::BlobExport(error_chain(&e)))?;

    // Persist a tag so the downloaded blob is retained under opt-in GC. The tag
    // is named after the root hash so it is both discoverable (`tags_list`
    // surfaces `name == hash`) and directly droppable (`tags_delete(hash)`) to
    // make the blob GC-reclaimable again. Created before the temp tag is
    // dropped, so retention never lapses.
    store
        .tags()
        .set(retention_tag_name(&haf), haf)
        .await
        .map_err(|e| IrohError::BlobStore(format!("tag download: {e}")))?;
    drop(protect);
    Ok(())
}

/// Removes an existing file at the export target so a download overwrites it.
///
/// Exporting fails with a bare `EEXIST` if anything is already at the target,
/// and downloading twice to the same path is ordinary usage, so the destination
/// is cleared first rather than surfacing an opaque I/O error.
///
/// A directory is never removed: recursively deleting whatever the caller
/// pointed at is far more destructive than refusing, so that case fails with an
/// explicit message instead.
async fn clear_export_target(dest_path: &std::path::Path) -> Result<()> {
    let metadata = match tokio::fs::symlink_metadata(dest_path).await {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(IrohError::BlobExport(format!(
                "could not inspect destination path: {e}"
            )))
        }
    };
    if metadata.is_dir() {
        return Err(IrohError::BlobExport(
            "destination path is a directory".into(),
        ));
    }
    tokio::fs::remove_file(dest_path).await.map_err(|e| {
        IrohError::BlobExport(format!("could not replace existing destination file: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        },
        time::Duration,
    };

    use iroh::{EndpointAddr, SecretKey, TransportAddr};
    use iroh_blobs::Hash;

    use super::*;
    use crate::test_support::{
        close_endpoint_blocking, create_minimal_endpoint, create_minimal_endpoint_with_gc, TIMEOUT,
    };

    fn close(handle: EndpointHandle) {
        close_endpoint_blocking(handle).expect("endpoint closed");
    }

    fn share_blocking(endpoint: EndpointHandle, path: PathBuf) -> String {
        let (tx, rx) = mpsc::channel();
        blob_share(endpoint, path, move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT)
            .expect("share completed")
            .expect("shared")
    }

    fn download_blocking(
        endpoint: EndpointHandle,
        ticket: &str,
        dest: &std::path::Path,
    ) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        blob_download(
            endpoint,
            ticket,
            dest.to_path_buf(),
            |_| {},
            move |result| {
                tx.send(result).ok();
            },
        )
        .expect("download started");
        rx.recv_timeout(TIMEOUT).expect("download completed")
    }

    #[test]
    fn download_rejects_garbage_ticket_synchronously() {
        let endpoint = create_minimal_endpoint(None);
        let result = blob_download(
            endpoint,
            "not-a-ticket",
            PathBuf::from("/tmp/never-written"),
            |_| {},
            |_| {},
        );
        assert!(matches!(result, Err(IrohError::InvalidTicket(_))));
        close(endpoint);
    }

    #[test]
    fn share_rejects_relative_path_via_callback() {
        let endpoint = create_minimal_endpoint(None);
        let (tx, rx) = mpsc::channel();
        blob_share(
            endpoint,
            PathBuf::from("relative/file.bin"),
            move |result| {
                tx.send(result).ok();
            },
        );
        assert!(matches!(
            rx.recv_timeout(TIMEOUT).unwrap(),
            Err(IrohError::InvalidPath(_))
        ));
        close(endpoint);
    }

    #[test]
    fn share_on_unknown_endpoint_reports_invalid_handle() {
        let (tx, rx) = mpsc::channel();
        blob_share(
            EndpointHandle::from_raw(u64::MAX),
            PathBuf::from("/tmp/x.bin"),
            move |result| {
                tx.send(result).ok();
            },
        );
        assert!(matches!(
            rx.recv_timeout(TIMEOUT).unwrap(),
            Err(IrohError::InvalidHandle(_))
        ));
    }

    #[test]
    fn cancelled_download_terminates_exactly_once_with_cancelled() {
        let endpoint = create_minimal_endpoint(None);
        // A well-formed ticket pointing at an unreachable peer: the connect
        // stalls, so cancellation is what terminates the transfer.
        let unreachable = SecretKey::from_bytes(&[7u8; 32]).public();
        let addr = EndpointAddr::from_parts(
            unreachable,
            [TransportAddr::Ip("127.0.0.1:1".parse().unwrap())],
        );
        let ticket = BlobTicket::new(addr, Hash::new(b"nothing"), BlobFormat::Raw).to_string();

        let completions = Arc::new(AtomicUsize::new(0));
        let completions_sink = Arc::clone(&completions);
        let (done_tx, done_rx) = mpsc::channel();
        let transfer = blob_download(
            endpoint,
            &ticket,
            PathBuf::from("/tmp/never-written-cancel"),
            |_| {},
            move |result| {
                completions_sink.fetch_add(1, Ordering::SeqCst);
                done_tx.send(result).ok();
            },
        )
        .unwrap();

        blob_download_cancel(transfer).expect("cancel accepted");
        let result = done_rx.recv_timeout(TIMEOUT).expect("terminal event fired");
        assert!(matches!(result, Err(IrohError::Cancelled)));

        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(completions.load(Ordering::SeqCst), 1);
        // The transfer handle is gone now.
        assert!(matches!(
            blob_download_cancel(transfer),
            Err(IrohError::InvalidHandle(_))
        ));
        close(endpoint);
    }

    /// Downloading twice to the same path must succeed. Persistent stores
    /// export with `TryReference`, which hard-links the blob and fails with a
    /// bare `EEXIST` if anything is already at the target, so without clearing
    /// it first the second download dies with an opaque I/O error.
    /// Reproduces the two-device failure: a persistent store imports with
    /// `ImportMode::TryReference`, so it points at the source file rather than
    /// copying it. Replacing that file after sharing leaves the store holding a
    /// reference to an unlinked inode, and the provider can no longer serve the
    /// blob even though the bytes on disk are byte-identical.
    /// Upstream reproduction attempt: interrupt a download mid-transfer so the
    /// store is left holding partial state for that hash, then ask for it again.
    /// On device this is what a network change does, and the retry is where
    /// `poisoned storage should not be used` fires.
    #[test]
    fn retrying_an_interrupted_download_does_not_poison_the_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("payload.bin");
        // Large enough that the transfer cannot finish before the first
        // progress event arrives and we cancel it.
        std::fs::write(&src, vec![9u8; 48 * 1024 * 1024]).expect("write");

        let provider = create_minimal_endpoint(Some(dir.path().join("provider")));
        let receiver = create_minimal_endpoint(Some(dir.path().join("receiver")));

        let (tx, rx) = mpsc::channel();
        blob_share(provider, src, move |result| {
            tx.send(result).ok();
        });
        let ticket = rx.recv_timeout(TIMEOUT).unwrap().expect("shared");

        let dest = dir.path().join("out.bin");
        let (done_tx, done_rx) = mpsc::channel();
        let (seen_tx, seen_rx) = mpsc::channel();
        let handle = blob_download(
            receiver,
            &ticket,
            dest.clone(),
            move |_bytes| {
                seen_tx.send(()).ok();
            },
            move |result| {
                done_tx.send(result).ok();
            },
        )
        .expect("download started");

        // Cancel as soon as bytes are moving, leaving partial state behind.
        seen_rx.recv_timeout(TIMEOUT).expect("progress observed");
        blob_download_cancel(handle).expect("cancelled");
        let first = done_rx.recv_timeout(TIMEOUT).unwrap();
        assert!(first.is_err(), "expected the cancel to fail the transfer");

        // The retry is the operation that has to reload the partial state.
        let (tx, rx) = mpsc::channel();
        blob_download(
            receiver,
            &ticket,
            dest,
            |_| {},
            move |result| {
                tx.send(result).ok();
            },
        )
        .expect("retry started");
        let retry = rx.recv_timeout(TIMEOUT).unwrap();
        assert!(
            retry.is_ok(),
            "retry after an interrupted download failed: {retry:?}"
        );
    }

    /// The same fault on the import side, where it surfaces to the receiver as
    /// `stream reset by peer` rather than as a local failure.
    #[test]
    fn deleting_a_shared_source_file_does_not_poison_the_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("payload.bin");
        // Above the 16 KiB inline threshold, so the entry references a file.
        let bytes = vec![5u8; 256 * 1024];
        std::fs::write(&src, &bytes).expect("write");

        let provider = create_minimal_endpoint(Some(dir.path().join("provider-store")));
        let ticket = share_blocking(provider, src.clone());

        // The caller deletes their own file after sharing it.
        std::fs::remove_file(&src).expect("remove source");

        let receiver = create_minimal_endpoint(Some(dir.path().join("receiver-store")));
        let dest = dir.path().join("out.bin");
        let outcome = download_blocking(receiver, &ticket, &dest);
        assert!(
            outcome.is_ok(),
            "serving a blob failed after the caller deleted the source file: {outcome:?}"
        );
        assert_eq!(std::fs::read(&dest).expect("read back"), bytes);

        close(receiver);
        close(provider);
    }

    #[test]
    fn sharing_survives_the_source_file_being_replaced() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("payload.bin");
        let bytes = vec![7u8; 64 * 1024];
        std::fs::write(&src, &bytes).expect("write");

        let provider = create_minimal_endpoint(Some(dir.path().join("provider-store")));
        let receiver = create_minimal_endpoint(Some(dir.path().join("receiver-store")));

        let (tx, rx) = mpsc::channel();
        blob_share(provider, src.clone(), move |result| {
            tx.send(result).ok();
        });
        let ticket = rx.recv_timeout(TIMEOUT).unwrap().expect("shared");

        // What resetPairDirs() does to the example app's source on every run.
        std::fs::remove_file(&src).expect("remove");
        std::fs::write(&src, &bytes).expect("rewrite");

        let dest = dir.path().join("downloaded.bin");
        let (tx, rx) = mpsc::channel();
        blob_download(
            receiver,
            &ticket,
            dest.clone(),
            |_| {},
            move |result| {
                tx.send(result).ok();
            },
        )
        .expect("download started");
        let outcome = rx.recv_timeout(TIMEOUT).unwrap();
        assert!(
            outcome.is_ok(),
            "download failed after the source file was replaced: {outcome:?}"
        );
        assert_eq!(std::fs::read(&dest).expect("read back"), bytes);
    }

    /// Reproduces the two-device failure: `ExportMode::TryReference` renamed the
    /// store's data file onto the destination, so deleting the download left the
    /// metadata pointing at nothing and poisoned the entry for good.
    #[test]
    fn deleting_a_downloaded_file_does_not_poison_the_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("payload.bin");
        // Above `max_data_inlined` (16 KiB), or the blob is inlined into the
        // metadata db and no path exists to invalidate.
        let bytes = vec![3u8; 256 * 1024];
        std::fs::write(&src, &bytes).expect("write");

        let provider = create_minimal_endpoint(Some(dir.path().join("provider-store")));
        let ticket = share_blocking(provider, src);

        let receiver_store = dir.path().join("receiver-store");
        let dest = dir.path().join("out.bin");

        let receiver = create_minimal_endpoint(Some(receiver_store.clone()));
        download_blocking(receiver, &ticket, &dest).expect("first download");
        assert_eq!(std::fs::read(&dest).expect("read back"), bytes);
        close(receiver);

        // What `resetPairDirs()` does to `iroh-pair/blob-in` on every run.
        std::fs::remove_file(&dest).expect("remove download");

        // Reopening forces the entry back out of the metadata db, which is where
        // a missing data file becomes a poisoned one.
        let receiver = create_minimal_endpoint(Some(receiver_store));
        let retry = download_blocking(receiver, &ticket, &dest);
        assert!(
            retry.is_ok(),
            "re-downloading after the caller deleted the file failed: {retry:?}"
        );
        assert_eq!(std::fs::read(&dest).expect("read back"), bytes);

        close(receiver);
        close(provider);
    }

    #[test]
    fn downloading_twice_to_the_same_path_overwrites() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("payload.bin");
        std::fs::write(&src, b"the payload being transferred").expect("write");

        let provider = create_minimal_endpoint(Some(dir.path().join("provider-store")));
        let receiver = create_minimal_endpoint(Some(dir.path().join("receiver-store")));

        let (tx, rx) = mpsc::channel();
        blob_share(provider, src, move |result| {
            tx.send(result).ok();
        });
        let ticket = rx.recv_timeout(TIMEOUT).unwrap().expect("shared");

        let dest = dir.path().join("downloaded.bin");
        for attempt in 1..=2 {
            let (tx, rx) = mpsc::channel();
            blob_download(
                receiver,
                &ticket,
                dest.clone(),
                |_| {},
                move |result| {
                    tx.send(result).ok();
                },
            )
            .expect("download started");
            rx.recv_timeout(TIMEOUT)
                .unwrap()
                .unwrap_or_else(|e| panic!("download attempt {attempt} failed: {e:?}"));
            assert_eq!(
                std::fs::read(&dest).unwrap(),
                b"the payload being transferred"
            );
        }

        close(provider);
        close(receiver);
    }

    /// Clearing the target must never turn into a recursive delete of whatever
    /// the caller pointed at.
    #[test]
    fn downloading_onto_a_directory_fails_without_removing_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("payload.bin");
        std::fs::write(&src, b"payload").expect("write");

        let provider = create_minimal_endpoint(Some(dir.path().join("provider-store")));
        let receiver = create_minimal_endpoint(Some(dir.path().join("receiver-store")));

        let (tx, rx) = mpsc::channel();
        blob_share(provider, src, move |result| {
            tx.send(result).ok();
        });
        let ticket = rx.recv_timeout(TIMEOUT).unwrap().expect("shared");

        // An occupied directory at the destination: it must survive intact.
        let dest = dir.path().join("occupied");
        std::fs::create_dir(&dest).expect("mkdir");
        std::fs::write(dest.join("keep.txt"), b"must survive").expect("write");

        let (tx, rx) = mpsc::channel();
        blob_download(
            receiver,
            &ticket,
            dest.clone(),
            |_| {},
            move |result| {
                tx.send(result).ok();
            },
        )
        .expect("download started");
        assert!(matches!(
            rx.recv_timeout(TIMEOUT).unwrap(),
            Err(IrohError::BlobExport(_))
        ));
        assert_eq!(
            std::fs::read(dest.join("keep.txt")).unwrap(),
            b"must survive"
        );

        close(provider);
        close(receiver);
    }

    #[test]
    fn parse_ticket_reports_hash_format_and_node_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("payload.bin");
        std::fs::write(&src, b"hello collection world").expect("write");

        let endpoint = create_minimal_endpoint(Some(dir.path().join("store")));
        let (tx, rx) = mpsc::channel();
        blob_share(endpoint, src, move |result| {
            tx.send(result).ok();
        });
        let ticket = rx.recv_timeout(TIMEOUT).unwrap().expect("shared");

        let info = parse_ticket(&ticket).expect("ticket parses");
        assert_eq!(info.format, "raw");
        assert_eq!(info.hash.len(), 64);
        assert!(info.hash.chars().all(|c| c.is_ascii_hexdigit()));
        // The node id is the sharing endpoint's own id.
        assert_eq!(
            info.node_id,
            crate::endpoint::endpoint_id(endpoint).unwrap()
        );
        assert_eq!(info.size, None);

        assert!(matches!(
            parse_ticket("not-a-ticket"),
            Err(IrohError::InvalidTicket(_))
        ));
        close(endpoint);
    }

    #[test]
    fn collection_share_manifest_and_child_download_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let files: [(&str, &[u8]); 3] = [
            ("alpha.bin", b"the first file in the collection"),
            ("beta.bin", b"a second, different file"),
            ("gamma.bin", b"and the third one to round it out"),
        ];
        let mut paths = Vec::new();
        for (name, bytes) in files {
            let p = dir.path().join(name);
            std::fs::write(&p, bytes).expect("write source");
            paths.push(p);
        }

        let provider = create_minimal_endpoint(Some(dir.path().join("provider-store")));
        let receiver = create_minimal_endpoint(Some(dir.path().join("receiver-store")));

        // Empty collections are rejected before any work.
        let (tx, rx) = mpsc::channel();
        collection_share(provider, Vec::new(), move |result| {
            tx.send(result).ok();
        });
        assert!(matches!(
            rx.recv_timeout(TIMEOUT).unwrap(),
            Err(IrohError::BlobImport(_))
        ));

        // Share the three files as one collection.
        let (tx, rx) = mpsc::channel();
        collection_share(provider, paths, move |result| {
            tx.send(result).ok();
        });
        let ticket = rx
            .recv_timeout(TIMEOUT)
            .unwrap()
            .expect("collection shared");
        assert_eq!(parse_ticket(&ticket).unwrap().format, "hashSeq");

        // Fetch the manifest on the receiver.
        let (tx, rx) = mpsc::channel();
        collection_manifest(receiver, ticket.clone(), move |result| {
            tx.send(result).ok();
        });
        let entries = rx.recv_timeout(TIMEOUT).unwrap().expect("manifest fetched");
        assert_eq!(entries.len(), 3);
        for entry in &entries {
            // Each child ticket is a standalone Raw ticket.
            assert_eq!(parse_ticket(&entry.ticket).unwrap().format, "raw");
        }

        // Download each child through the ordinary per-blob machinery and
        // verify byte-for-byte integrity.
        for entry in &entries {
            let dest = dir.path().join(format!("dl-{}", entry.name));
            let (tx, rx) = mpsc::channel();
            blob_download(
                receiver,
                &entry.ticket,
                dest.clone(),
                |_| {},
                move |result| {
                    tx.send(result).ok();
                },
            )
            .expect("child download started");
            rx.recv_timeout(TIMEOUT).unwrap().expect("child downloaded");
            let expected = files
                .iter()
                .find(|(name, _)| *name == entry.name)
                .expect("known child name")
                .1;
            assert_eq!(std::fs::read(&dest).unwrap(), expected);
        }

        // A non-collection (Raw) ticket is rejected by the manifest fetch.
        let (tx, rx) = mpsc::channel();
        let raw_ticket = entries[0].ticket.clone();
        collection_manifest(receiver, raw_ticket, move |result| {
            tx.send(result).ok();
        });
        assert!(matches!(
            rx.recv_timeout(TIMEOUT).unwrap(),
            Err(IrohError::InvalidTicket(_))
        ));

        close(provider);
        close(receiver);
    }

    fn status_blocking(endpoint: EndpointHandle, hash: &str) -> BlobStatusInfo {
        let (tx, rx) = mpsc::channel();
        blob_status(endpoint, hash.to_owned(), move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT)
            .expect("status completed")
            .expect("status ok")
    }

    fn has_blocking(endpoint: EndpointHandle, hash: &str) -> bool {
        let (tx, rx) = mpsc::channel();
        blob_has(endpoint, hash.to_owned(), move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT)
            .expect("has completed")
            .expect("has ok")
    }

    #[test]
    fn status_is_not_found_then_complete_across_a_full_download() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bytes = vec![4u8; 512 * 1024];
        let src = dir.path().join("payload.bin");
        std::fs::write(&src, &bytes).expect("write");

        let provider = create_minimal_endpoint(Some(dir.path().join("provider-store")));
        let receiver = create_minimal_endpoint(Some(dir.path().join("receiver-store")));

        let ticket = share_blocking(provider, src);
        let hash = parse_ticket(&ticket).unwrap().hash;

        // Before any transfer the receiver has nothing.
        assert_eq!(status_blocking(receiver, &hash), BlobStatusInfo::NotFound);
        assert!(!has_blocking(receiver, &hash));

        let dest = dir.path().join("out.bin");
        download_blocking(receiver, &ticket, &dest).expect("download");

        // After a full download the blob is complete at its true size.
        assert_eq!(
            status_blocking(receiver, &hash),
            BlobStatusInfo::Complete {
                size: bytes.len() as u64
            }
        );
        assert!(has_blocking(receiver, &hash));

        close(provider);
        close(receiver);
    }

    /// A partially-present blob resumes: the second pass fetches only the
    /// ranges still missing, never the whole blob again. Deterministic (no
    /// cancel race): the partial is pre-seeded with an explicit chunk-range get,
    /// then a full `blob_download` completes it while its progress is watched.
    #[test]
    fn interrupted_download_resumes_only_the_missing_ranges() {
        use iroh_blobs::protocol::{ChunkRanges, ChunkRangesExt, GetRequest};

        let dir = tempfile::tempdir().expect("tempdir");
        // Many chunk groups so a partial can sit strictly between empty and full.
        let full_len: usize = 4 * 1024 * 1024;
        let bytes: Vec<u8> = (0..full_len as u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8)
            .collect();
        let src = dir.path().join("payload.bin");
        std::fs::write(&src, &bytes).expect("write");

        let provider = create_minimal_endpoint(Some(dir.path().join("provider-store")));
        let receiver = create_minimal_endpoint(Some(dir.path().join("receiver-store")));

        let ticket_str = share_blocking(provider, src);
        let ticket: BlobTicket = ticket_str.parse().expect("ticket parses");
        let hash = ticket.hash();
        let hash_hex = hash.to_string();

        assert_eq!(
            status_blocking(receiver, &hash_hex),
            BlobStatusInfo::NotFound
        );

        // Pre-seed the first ~1.5 MiB (1536 chunks) on the receiver via a bounded
        // range get, so the store holds a genuine partial for `hash`.
        runtime().block_on(async {
            let state = endpoint_state(receiver).expect("receiver live");
            let connection = state
                .endpoint
                .connect(ticket.addr().clone(), iroh_blobs::ALPN)
                .await
                .expect("connect to provider");
            let request = GetRequest::builder()
                .root(ChunkRanges::chunks(..1536))
                .build(hash);
            let mut stream = state
                .store
                .api()
                .remote()
                .execute_get(connection, request)
                .stream();
            while let Some(item) = stream.next().await {
                match item {
                    GetProgressItem::Done(_) => break,
                    GetProgressItem::Error(e) => panic!("pre-seed get failed: {e}"),
                    GetProgressItem::Progress(_) => {}
                }
            }
            state.store.api().wait_idle().await.expect("store idle");
        });

        // The store now reports a partial strictly smaller than the whole blob,
        // and `local_for_request`/`missing` still has ranges to fetch.
        let partial_status = status_blocking(receiver, &hash_hex);
        assert!(
            matches!(partial_status, BlobStatusInfo::Partial { .. }),
            "expected Partial after a bounded get, got {partial_status:?}"
        );
        let local_bytes = runtime().block_on(async {
            let state = endpoint_state(receiver).expect("receiver live");
            let local = state
                .store
                .api()
                .remote()
                .local(HashAndFormat::raw(hash))
                .await
                .expect("local info");
            assert!(!local.is_complete(), "pre-seeded blob must be incomplete");
            local.local_bytes()
        });
        assert!(
            local_bytes > 0 && (local_bytes as usize) < full_len,
            "partial local_bytes {local_bytes} must lie strictly inside 0..{full_len}"
        );

        // Re-issue the full download and watch how many payload bytes it moves.
        // A resume fetches only `missing()`; a from-scratch refetch would move
        // the whole blob, so a max-progress strictly below the full size is the
        // proof that only the missing ranges crossed the wire.
        let dest = dir.path().join("out.bin");
        let max_progress = Arc::new(AtomicUsize::new(0));
        let max_sink = Arc::clone(&max_progress);
        let (done_tx, done_rx) = mpsc::channel();
        blob_download(
            receiver,
            &ticket_str,
            dest.clone(),
            move |transferred| {
                max_sink.fetch_max(transferred as usize, Ordering::SeqCst);
            },
            move |result| {
                done_tx.send(result).ok();
            },
        )
        .expect("resume download started");
        done_rx
            .recv_timeout(TIMEOUT)
            .unwrap()
            .expect("resume download completed");

        let observed = max_progress.load(Ordering::SeqCst);
        assert!(
            observed > 0 && observed < full_len,
            "second pass moved {observed} bytes; a resume must move fewer than the full {full_len}"
        );

        // The blob is now complete at its true size and byte-identical.
        assert_eq!(
            status_blocking(receiver, &hash_hex),
            BlobStatusInfo::Complete {
                size: full_len as u64
            }
        );
        assert!(has_blocking(receiver, &hash_hex));
        assert_eq!(
            blake3::hash(&std::fs::read(&dest).unwrap()),
            blake3::hash(&bytes)
        );

        close(provider);
        close(receiver);
    }

    /// `blob_add_bytes` imports in-memory bytes and mints a ticket that another
    /// endpoint can download, byte-for-byte, through the ordinary machinery.
    #[test]
    fn add_bytes_imports_and_is_downloadable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let provider = create_minimal_endpoint(Some(dir.path().join("provider-store")));
        let receiver = create_minimal_endpoint(Some(dir.path().join("receiver-store")));

        let payload = b"in-memory payload imported without a file".to_vec();
        let (tx, rx) = mpsc::channel();
        blob_add_bytes(provider, payload.clone(), move |result| {
            tx.send(result).ok();
        });
        let ticket = rx.recv_timeout(TIMEOUT).unwrap().expect("added bytes");
        assert_eq!(parse_ticket(&ticket).unwrap().format, "raw");

        let dest = dir.path().join("out.bin");
        download_blocking(receiver, &ticket, &dest).expect("download");
        assert_eq!(std::fs::read(&dest).unwrap(), payload);

        close(provider);
        close(receiver);
    }

    #[test]
    fn tag_lifecycle_create_list_rename_delete() {
        let dir = tempfile::tempdir().expect("tempdir");
        let endpoint = create_minimal_endpoint(Some(dir.path().join("store")));

        // A syntactically valid hash to pin. The tag store records the pin
        // whether or not the blob is present, and using a synthetic hash keeps
        // the store free of the auto-tag that importing a blob would create.
        let hash = Hash::new(b"tag target").to_string();

        let list = |endpoint: EndpointHandle| -> Vec<TagEntry> {
            let (tx, rx) = mpsc::channel();
            tags_list(endpoint, move |result| {
                tx.send(result).ok();
            });
            rx.recv_timeout(TIMEOUT).unwrap().expect("tags listed")
        };

        assert!(list(endpoint).is_empty(), "a fresh store has no tags");

        // create
        let (tx, rx) = mpsc::channel();
        tags_create(
            endpoint,
            "keep".into(),
            hash.clone(),
            "raw".into(),
            move |result| {
                tx.send(result).ok();
            },
        );
        rx.recv_timeout(TIMEOUT).unwrap().expect("tag created");

        let after_create = list(endpoint);
        assert_eq!(after_create.len(), 1);
        assert_eq!(after_create[0].name, "keep");
        assert_eq!(after_create[0].hash, hash);
        assert_eq!(after_create[0].format, "raw");

        // rename
        let (tx, rx) = mpsc::channel();
        tags_rename(endpoint, "keep".into(), "renamed".into(), move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT).unwrap().expect("tag renamed");

        let after_rename = list(endpoint);
        assert_eq!(after_rename.len(), 1);
        assert_eq!(after_rename[0].name, "renamed");
        assert_eq!(after_rename[0].hash, hash);

        // delete
        let (tx, rx) = mpsc::channel();
        tags_delete(endpoint, "renamed".into(), move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT).unwrap().expect("tag deleted");

        assert!(list(endpoint).is_empty(), "the tag is gone after delete");

        close(endpoint);
    }

    fn tags_list_blocking(endpoint: EndpointHandle) -> Vec<TagEntry> {
        let (tx, rx) = mpsc::channel();
        tags_list(endpoint, move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT)
            .expect("tags listed")
            .expect("tags ok")
    }

    fn tags_delete_blocking(endpoint: EndpointHandle, name: &str) {
        let (tx, rx) = mpsc::channel();
        tags_delete(endpoint, name.to_owned(), move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT)
            .expect("tag deleted")
            .expect("delete ok");
    }

    /// A downloaded blob is auto-tagged, so it survives the opt-in GC loop; once
    /// its tag is dropped it becomes reclaimable and the next pass sweeps it.
    /// This is the regression lock for the download-vs-GC data-loss race: with
    /// the download left UNTAGGED (the old behavior), the survive-assertion
    /// below fails because a GC pass reclaims the just-downloaded blob.
    #[test]
    fn a_downloaded_blob_survives_gc_until_its_tag_is_dropped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bytes = vec![6u8; 512 * 1024];
        let src = dir.path().join("payload.bin");
        std::fs::write(&src, &bytes).expect("write");

        let provider = create_minimal_endpoint(Some(dir.path().join("provider-store")));
        // The receiver runs the opt-in GC loop at a short interval.
        let receiver = create_minimal_endpoint_with_gc(
            Some(dir.path().join("receiver-store")),
            Duration::from_millis(200),
        );

        let ticket = share_blocking(provider, src);
        let hash = parse_ticket(&ticket).unwrap().hash;

        let dest = dir.path().join("out.bin");
        download_blocking(receiver, &ticket, &dest).expect("download");

        // The download created a retention tag named after the root hash.
        let tags = tags_list_blocking(receiver);
        assert!(
            tags.iter().any(|t| t.name == hash && t.hash == hash),
            "download must create a retention tag named after the root hash: {tags:?}"
        );

        // It SURVIVES GC because it is tagged. Wait well past several intervals;
        // an untagged blob would already have been reclaimed by now.
        std::thread::sleep(Duration::from_millis(1000));
        assert!(
            has_blocking(receiver, &hash),
            "a tagged download must survive GC"
        );
        assert!(matches!(
            status_blocking(receiver, &hash),
            BlobStatusInfo::Complete { .. }
        ));

        // Drop the tag: the only protection is gone, so a GC pass reclaims it.
        tags_delete_blocking(receiver, &hash);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if !has_blocking(receiver, &hash) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the blob was not reclaimed after its tag was dropped"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(status_blocking(receiver, &hash), BlobStatusInfo::NotFound);

        close(provider);
        close(receiver);
    }
}
