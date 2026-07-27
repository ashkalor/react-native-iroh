//! Blob transfer: share a local file as a ticket, download a ticket to a
//! local file with progress events.
//!
//! Progress reporting is intentionally unthrottled: the core emits one event
//! per progress item from the underlying transfer. The bridge layer is
//! responsible for coalescing events before crossing into JS.

use std::{path::PathBuf, sync::LazyLock, sync::Mutex};

use iroh_blobs::{
    api::{
        blobs::{AddPathOptions, ExportOptions},
        remote::GetProgressItem,
    },
    format::collection::Collection,
    hashseq::HashSeq,
    ticket::BlobTicket,
    BlobFormat, HashAndFormat,
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
/// `path` must be absolute. With a persistent blob store the file is
/// referenced in place (no byte copy); an in-memory store must read it.
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

    let mut stream = state
        .store
        .api()
        .remote()
        .fetch(connection, ticket.hash_and_format())
        .stream();
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
    state
        .store
        .api()
        .blobs()
        .export_with_opts(ExportOptions {
            hash: ticket.hash(),
            mode,
            target: dest_path,
        })
        .await
        .map_err(|e| IrohError::BlobExport(error_chain(&e)))?;
    Ok(())
}

/// Removes an existing file at the export target so a download overwrites it.
///
/// Persistent stores export with [`ExportMode::TryReference`], which hard-links
/// the blob into place and therefore fails with a bare `EEXIST` if anything is
/// already there. Downloading twice to the same path is ordinary usage, so the
/// destination is cleared first rather than surfacing an opaque I/O error.
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
    use crate::test_support::{close_endpoint_blocking, create_minimal_endpoint, TIMEOUT};

    fn close(handle: EndpointHandle) {
        close_endpoint_blocking(handle).expect("endpoint closed");
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
}
