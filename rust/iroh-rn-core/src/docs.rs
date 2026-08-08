//! Docs: author identity plus document CRUD over the iroh-docs meta-protocol.
//!
//! A document is a key/value replica addressed by its [`NamespaceId`]. Entries
//! carry metadata (author, key, content hash, size, timestamp); the value bytes
//! live OUT-OF-BAND in the endpoint's shared blob store, keyed by the entry's
//! content hash. Reads therefore return the hash always and never fetch the
//! bytes implicitly; [`docs_get_content`] resolves an entry's content through
//! the same blob store the blobs protocol uses.
//!
//! Documents are addressed by [`NamespaceId`] per call: each operation resolves
//! the endpoint's [`DocsApi`], opens the replica, runs, and closes it again. No
//! doc handle is kept across calls, so there is no per-doc registry or JS-side
//! lifecycle to leak. The iroh-docs engine keeps the replica's data in its own
//! store regardless of open/close, so a close only unloads the in-memory handle.
//!
//! Docs run only when the endpoint was created with docs enabled
//! (`EndpointConfig::docs`); every entry point first resolves [`docs_api`],
//! which fails with [`IrohError::DocsDisabled`] on a docs-off endpoint so a
//! docs-disabled endpoint is entirely unaffected.

use std::sync::{Arc, LazyLock};

use bytes::Bytes;
use iroh::EndpointAddr;
use iroh_blobs::Hash;
use iroh_docs::{
    api::{
        protocol::{AddrInfoOptions, ShareMode},
        Doc, DocsApi,
    },
    engine::LiveEvent,
    store::Query,
    Author, AuthorId, CapabilityKind, ContentStatus, DocTicket, Entry, NamespaceId,
};
use n0_future::{task::AbortOnDropHandle, StreamExt};

use crate::{
    endpoint::{endpoint_state, parse_endpoint_addr, EndpointHandle},
    error::{error_chain, IrohError, Result},
    guarded_callback,
    registry::Registry,
    runtime::runtime,
    spawn_completing,
};

/// A document entry's metadata, as surfaced across the bridge. The content
/// bytes are addressed by [`Self::hash`] and fetched separately via
/// [`docs_get_content`]; they are never carried inline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocEntryInfo {
    /// The entry author's id (hex).
    pub author: String,
    /// The entry key, decoded as UTF-8 (docs keys are byte strings; the JS
    /// surface treats them as strings).
    pub key: String,
    /// The BLAKE3 content hash of the entry's value (hex).
    pub hash: String,
    /// The value's size in bytes.
    pub size: u64,
    /// The entry's timestamp, in microseconds since the Unix epoch.
    pub timestamp: u64,
}

/// The decoded fields of a [`DocTicket`], produced by [`parse_doc_ticket`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocTicketInfo {
    /// The document's [`NamespaceId`] (hex).
    pub namespace: String,
    /// The capability the ticket grants: `"read"` or `"write"`.
    pub capability: &'static str,
    /// The ids of the peers the ticket names to sync with.
    pub node_ids: Vec<String>,
}

/// Resolves the endpoint's [`DocsApi`], or fails with
/// [`IrohError::DocsDisabled`] if docs were not enabled at creation.
fn docs_api(endpoint: EndpointHandle) -> Result<DocsApi> {
    let state = endpoint_state(endpoint)?;
    state
        .docs
        .as_ref()
        .map(|docs| docs.api().clone())
        .ok_or_else(|| {
            IrohError::DocsDisabled("create the endpoint with docs enabled first".into())
        })
}

fn parse_namespace(value: &str) -> Result<NamespaceId> {
    value
        .parse()
        .map_err(|e| IrohError::DocsInvalidId(format!("namespace id {value:?}: {e}")))
}

fn parse_author(value: &str) -> Result<AuthorId> {
    value
        .parse()
        .map_err(|e| IrohError::DocsInvalidId(format!("author id {value:?}: {e}")))
}

/// Builds a [`DocEntryInfo`] from a live [`Entry`], reading the raw content hash
/// (never the bytes).
fn entry_info(entry: &Entry) -> DocEntryInfo {
    DocEntryInfo {
        author: entry.author().to_string(),
        key: String::from_utf8_lossy(entry.key()).into_owned(),
        hash: entry.content_hash().to_string(),
        size: entry.content_len(),
        timestamp: entry.timestamp(),
    }
}

/// Opens the replica for `namespace` against `api`, failing with
/// [`IrohError::Docs`] if it is unknown to this node.
async fn open_doc(api: &DocsApi, namespace: NamespaceId) -> Result<Doc> {
    api.open(namespace)
        .await
        .map_err(|e| IrohError::Docs(format!("open document: {e:#}")))?
        .ok_or_else(|| IrohError::Docs(format!("document {namespace} not found")))
}

/// Balances the [`open_doc`] open by closing the replica handle. A close error
/// is non-fatal to the operation whose result the caller already has, so it is
/// logged and dropped rather than masking that result.
async fn close_doc(doc: Doc) {
    if let Err(e) = doc.close().await {
        tracing::warn!("closing document handle failed: {e:#}");
    }
}

/// Builds a [`Query`] from the bridge's optional JSON selector
/// (`{ author?, keyExact?, keyPrefix? }`). An empty or absent selector matches
/// all entries. `keyExact` takes precedence over `keyPrefix` when both are set.
fn build_query(json: &str) -> Result<Query> {
    let mut builder = Query::all();
    if json.trim().is_empty() {
        return Ok(builder.build());
    }
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| IrohError::Docs(format!("invalid query: {e}")))?;
    if let Some(author) = value.get("author").and_then(|v| v.as_str()) {
        builder = builder.author(parse_author(author)?);
    }
    if let Some(key) = value.get("keyExact").and_then(|v| v.as_str()) {
        builder = builder.key_exact(key);
    } else if let Some(prefix) = value.get("keyPrefix").and_then(|v| v.as_str()) {
        builder = builder.key_prefix(prefix);
    }
    Ok(builder.build())
}

/// Returns this node's default author id (hex), creating it on first use.
pub fn authors_default(
    endpoint: EndpointHandle,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            api.author_default()
                .await
                .map(|id| id.to_string())
                .map_err(|e| IrohError::Docs(format!("default author: {e:#}")))
        },
        on_complete,
    );
}

/// Creates a new author and returns its id (hex).
pub fn authors_create(
    endpoint: EndpointHandle,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            api.author_create()
                .await
                .map(|id| id.to_string())
                .map_err(|e| IrohError::Docs(format!("create author: {e:#}")))
        },
        on_complete,
    );
}

/// Lists the ids (hex) of every author this node holds a secret key for.
pub fn authors_list(
    endpoint: EndpointHandle,
    on_complete: impl FnOnce(Result<Vec<String>>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let mut stream = Box::pin(
                api.author_list()
                    .await
                    .map_err(|e| IrohError::Docs(format!("list authors: {e:#}")))?,
            );
            let mut ids = Vec::new();
            while let Some(item) = stream.next().await {
                let id = item.map_err(|e| IrohError::Docs(format!("list authors: {e:#}")))?;
                ids.push(id.to_string());
            }
            Ok(ids)
        },
        on_complete,
    );
}

/// Imports an author from its secret key (hex), making it usable for writes on
/// this node, and returns its id (hex). Portable across devices: the secret is
/// the whole identity.
pub fn authors_import(
    endpoint: EndpointHandle,
    secret: String,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let author: Author = secret
                .parse()
                .map_err(|e| IrohError::DocsInvalidId(format!("author secret: {e}")))?;
            let id = author.id().to_string();
            api.author_import(author)
                .await
                .map_err(|e| IrohError::Docs(format!("import author: {e:#}")))?;
            Ok(id)
        },
        on_complete,
    );
}

/// Creates a new document and returns its [`NamespaceId`] (hex).
pub fn docs_create(
    endpoint: EndpointHandle,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let doc = api
                .create()
                .await
                .map_err(|e| IrohError::Docs(format!("create document: {e:#}")))?;
            let id = doc.id().to_string();
            close_doc(doc).await;
            Ok(id)
        },
        on_complete,
    );
}

/// Whether a document with `namespace` (hex) is known to this node. Backs
/// `open() -> Doc | null` on the JS side.
pub fn docs_open(
    endpoint: EndpointHandle,
    namespace: String,
    on_complete: impl FnOnce(Result<bool>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let target = parse_namespace(&namespace)?;
            let mut stream = api
                .list()
                .await
                .map_err(|e| IrohError::Docs(format!("list documents: {e:#}")))?;
            while let Some(item) = stream.next().await {
                let (id, _kind) =
                    item.map_err(|e| IrohError::Docs(format!("list documents: {e:#}")))?;
                if id == target {
                    return Ok(true);
                }
            }
            Ok(false)
        },
        on_complete,
    );
}

/// Imports a document from a [`DocTicket`] string and returns its
/// [`NamespaceId`] (hex). This registers the document and seeds the addresses of
/// the peers the ticket names into the endpoint's address lookup, so a later
/// [`docs_start_sync`] (or [`docs_subscribe`]) can reach them even on the
/// minimal preset. Live sync is NOT started here: it begins on an explicit
/// [`docs_start_sync`].
pub fn docs_import(
    endpoint: EndpointHandle,
    ticket: String,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let state = endpoint_state(endpoint)?;
            let api = docs_api(endpoint)?;
            let ticket: DocTicket = ticket
                .parse()
                .map_err(|e| IrohError::DocsInvalidTicket(format!("{e}")))?;
            // Seed the ticket's peer addresses so a later sync can dial them by
            // id without a discovery service (mirrors the gossip bootstrap seed).
            for node in &ticket.nodes {
                state.bootstrap_lookup.add_endpoint_info(node.clone());
            }
            let doc = api
                .import_namespace(ticket.capability)
                .await
                .map_err(|e| IrohError::Docs(format!("import document: {e:#}")))?;
            let id = doc.id().to_string();
            close_doc(doc).await;
            Ok(id)
        },
        on_complete,
    );
}

/// Lists the [`NamespaceId`]s (hex) of every document on this node.
pub fn docs_list(
    endpoint: EndpointHandle,
    on_complete: impl FnOnce(Result<Vec<String>>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let mut stream = api
                .list()
                .await
                .map_err(|e| IrohError::Docs(format!("list documents: {e:#}")))?;
            let mut ids = Vec::new();
            while let Some(item) = stream.next().await {
                let (id, _kind) =
                    item.map_err(|e| IrohError::Docs(format!("list documents: {e:#}")))?;
                ids.push(id.to_string());
            }
            Ok(ids)
        },
        on_complete,
    );
}

/// Removes a document and its entries from this node.
pub fn docs_drop(
    endpoint: EndpointHandle,
    namespace: String,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let namespace = parse_namespace(&namespace)?;
            api.drop_doc(namespace)
                .await
                .map_err(|e| IrohError::Docs(format!("drop document: {e:#}")))
        },
        on_complete,
    );
}

/// Writes `value` under `key` for `author` in the document, storing the bytes in
/// the shared blob store, and returns the content hash (hex).
pub fn docs_set_bytes(
    endpoint: EndpointHandle,
    namespace: String,
    author: String,
    key: String,
    value: Vec<u8>,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let namespace = parse_namespace(&namespace)?;
            let author = parse_author(&author)?;
            let doc = open_doc(&api, namespace).await?;
            let result = doc
                .set_bytes(author, Bytes::from(key.into_bytes()), Bytes::from(value))
                .await
                .map(|hash| hash.to_string())
                .map_err(|e| IrohError::Docs(format!("set entry: {e:#}")));
            close_doc(doc).await;
            result
        },
        on_complete,
    );
}

/// Returns the entry for `author` + `key`, or `None` if there is none (a deleted
/// entry reads as absent). The content hash is included; bytes are not.
pub fn docs_get_exact(
    endpoint: EndpointHandle,
    namespace: String,
    author: String,
    key: String,
    on_complete: impl FnOnce(Result<Option<DocEntryInfo>>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let namespace = parse_namespace(&namespace)?;
            let author = parse_author(&author)?;
            let doc = open_doc(&api, namespace).await?;
            let result = doc
                .get_exact(author, key.as_bytes(), false)
                .await
                .map(|entry| entry.as_ref().map(entry_info))
                .map_err(|e| IrohError::Docs(format!("get entry: {e:#}")));
            close_doc(doc).await;
            result
        },
        on_complete,
    );
}

/// Returns every entry matching `query_json` (`{ author?, keyExact?, keyPrefix? }`,
/// empty for all). Each entry carries its content hash; bytes are not fetched.
pub fn docs_get_many(
    endpoint: EndpointHandle,
    namespace: String,
    query_json: String,
    on_complete: impl FnOnce(Result<Vec<DocEntryInfo>>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let namespace = parse_namespace(&namespace)?;
            let query = build_query(&query_json)?;
            let doc = open_doc(&api, namespace).await?;
            let mut entries = Vec::new();
            let result = async {
                let mut stream = Box::pin(
                    doc.get_many(query)
                        .await
                        .map_err(|e| IrohError::Docs(format!("query entries: {e:#}")))?,
                );
                while let Some(item) = stream.next().await {
                    let entry =
                        item.map_err(|e| IrohError::Docs(format!("query entries: {e:#}")))?;
                    entries.push(entry_info(&entry));
                }
                Ok(entries)
            }
            .await;
            close_doc(doc).await;
            result
        },
        on_complete,
    );
}

/// Deletes every entry for `author` whose key equals `prefix` OR starts with it,
/// returning how many were removed.
///
/// Prefix-scoped, mirroring iroh-docs: [`Doc::del`] takes a prefix and there is
/// no exact-delete primitive, so `prefix` also clears any prefix-siblings (e.g.
/// deleting `"note"` also deletes `"note-draft"`). To remove exactly one key the
/// caller must ensure no other key has it as a prefix.
pub fn docs_delete_prefix(
    endpoint: EndpointHandle,
    namespace: String,
    author: String,
    prefix: String,
    on_complete: impl FnOnce(Result<u64>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let namespace = parse_namespace(&namespace)?;
            let author = parse_author(&author)?;
            let doc = open_doc(&api, namespace).await?;
            let result = doc
                .del(author, Bytes::from(prefix.into_bytes()))
                .await
                .map(|removed| removed as u64)
                .map_err(|e| IrohError::Docs(format!("delete entries: {e:#}")));
            close_doc(doc).await;
            result
        },
        on_complete,
    );
}

/// Mints a shareable [`DocTicket`] string for the document. `mode` is `"read"`
/// or `"write"`.
pub fn docs_share(
    endpoint: EndpointHandle,
    namespace: String,
    mode: String,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let namespace = parse_namespace(&namespace)?;
            let mode = match mode.as_str() {
                "read" => ShareMode::Read,
                "write" => ShareMode::Write,
                other => {
                    return Err(IrohError::Docs(format!(
                        "share mode must be \"read\" or \"write\", got {other:?}"
                    )))
                }
            };
            let doc = open_doc(&api, namespace).await?;
            let result = doc
                .share(mode, AddrInfoOptions::RelayAndAddresses)
                .await
                .map(|ticket| ticket.to_string())
                .map_err(|e| IrohError::Docs(format!("share document: {e:#}")));
            close_doc(doc).await;
            result
        },
        on_complete,
    );
}

/// Resolves an entry's content by its hash (hex), reading the bytes out of the
/// endpoint's shared blob store. This is the opt-in content fetch: reads never
/// pull bytes on their own.
pub fn docs_get_content(
    endpoint: EndpointHandle,
    hash: String,
    on_complete: impl FnOnce(Result<Vec<u8>>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let state = endpoint_state(endpoint)?;
            let hash: Hash = hash
                .parse()
                .map_err(|e| IrohError::DocsInvalidId(format!("content hash {hash:?}: {e}")))?;
            let bytes = state
                .store
                .api()
                .blobs()
                .get_bytes(hash)
                .await
                .map_err(|e| IrohError::Docs(format!("read content: {}", error_chain(&e))))?;
            Ok(bytes.to_vec())
        },
        on_complete,
    );
}

/// Decodes a [`DocTicket`] string into its namespace, capability, and peer ids.
/// A pure parse: no network or store access.
pub fn parse_doc_ticket(ticket: &str) -> Result<DocTicketInfo> {
    let ticket: DocTicket = ticket
        .parse()
        .map_err(|e| IrohError::DocsInvalidTicket(format!("{e}")))?;
    let capability = match ticket.capability.kind() {
        CapabilityKind::Read => "read",
        CapabilityKind::Write => "write",
    };
    let namespace = ticket.capability.id().to_string();
    let node_ids = ticket
        .nodes
        .iter()
        .map(|node| node.id.to_string())
        .collect();
    Ok(DocTicketInfo {
        namespace,
        capability,
        node_ids,
    })
}

/// Opaque handle to a live document subscription. `0` is never a valid handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DocsSubHandle(u64);

impl DocsSubHandle {
    /// Reconstructs a handle from its raw FFI representation.
    pub fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    /// The raw numeric value passed across the FFI boundary.
    pub fn raw(self) -> u64 {
        self.0
    }
}

/// A live document subscription: the open [`Doc`] handle that keeps the replica
/// loaded plus the abort-on-drop task forwarding [`LiveEvent`]s into the host
/// callback. Dropping the state (via [`docs_unsubscribe`]) aborts the task; the
/// replica handle is closed separately so the open count is balanced.
struct DocsSubscription {
    doc: Doc,
    _task: AbortOnDropHandle<()>,
}

static DOCS_SUBS: LazyLock<Registry<DocsSubscription>> = LazyLock::new(Registry::new);

/// Maps a [`ContentStatus`] onto its JS discriminator.
fn content_status_str(status: ContentStatus) -> &'static str {
    match status {
        ContentStatus::Complete => "complete",
        ContentStatus::Incomplete => "incomplete",
        ContentStatus::Missing => "missing",
    }
}

/// Builds the JSON value for an [`Entry`] carried by a live event, matching the
/// `DocEntry` TS shape.
fn entry_json(entry: &Entry) -> serde_json::Value {
    serde_json::json!({
        "author": entry.author().to_string(),
        "key": String::from_utf8_lossy(entry.key()),
        "hash": entry.content_hash().to_string(),
        "size": entry.content_len(),
        "timestamp": entry.timestamp(),
    })
}

/// Serializes a [`LiveEvent`] into the JS discriminated-union JSON the bridge
/// forwards to a subscription's `on_event`.
fn live_event_to_json(event: &LiveEvent) -> String {
    let value = match event {
        LiveEvent::InsertLocal { entry } => serde_json::json!({
            "type": "insert-local",
            "entry": entry_json(entry),
        }),
        LiveEvent::InsertRemote {
            from,
            entry,
            content_status,
        } => serde_json::json!({
            "type": "insert-remote",
            "from": from.to_string(),
            "entry": entry_json(entry),
            "contentStatus": content_status_str(*content_status),
        }),
        LiveEvent::ContentReady { hash } => serde_json::json!({
            "type": "content-ready",
            "hash": hash.to_string(),
        }),
        LiveEvent::PendingContentReady => serde_json::json!({ "type": "pending-content-ready" }),
        LiveEvent::NeighborUp(id) => serde_json::json!({
            "type": "neighbor-up",
            "endpointId": id.to_string(),
        }),
        LiveEvent::NeighborDown(id) => serde_json::json!({
            "type": "neighbor-down",
            "endpointId": id.to_string(),
        }),
        LiveEvent::SyncFinished(sync) => serde_json::json!({
            "type": "sync-finished",
            "peer": sync.peer.to_string(),
        }),
    };
    value.to_string()
}

/// Parses the newline-joined `EndpointAddr` JSON list (the shape the bridge
/// emits, matching the gossip bootstrap convention) into [`EndpointAddr`]s.
/// Empty segments are ignored; a malformed entry fails the whole call.
fn parse_peers(joined: &str) -> Result<Vec<EndpointAddr>> {
    joined
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            parse_endpoint_addr(line)
                .map_err(|detail| IrohError::Docs(format!("sync peer {detail}")))
        })
        .collect()
}

/// Subscribes to the [`LiveEvent`] stream of the document `namespace` on
/// `endpoint`, holding the replica open for the subscription's lifetime.
///
/// Set-up is validated synchronously (a stale endpoint or docs-disabled endpoint
/// returns an error immediately, nothing is spawned). The replica is opened and
/// the event stream established asynchronously; once live, `on_start` fires once
/// with the subscription's [`DocsSubHandle`] (pass it to [`docs_unsubscribe`]),
/// thereafter `on_event` fires per event as a JSON discriminated union.
///
/// `on_close` fires exactly once when the subscription ends: `None` for an
/// orderly finish (the stream ended, e.g. the endpoint closed) or `Some(error)`
/// on failure. If opening the replica or the stream fails, `on_close` receives
/// the error and `on_start` never fires: the subscription is dead and any host
/// waiting on it should settle.
///
/// Subscribing does NOT start live sync; drive sync with [`docs_start_sync`].
/// The subscription only keeps the replica open and forwards its events.
pub fn docs_subscribe(
    endpoint: EndpointHandle,
    namespace: String,
    on_start: impl Fn(DocsSubHandle) + Send + Sync + 'static,
    on_event: impl Fn(String) + Send + Sync + 'static,
    on_close: impl Fn(Option<IrohError>) + Send + Sync + 'static,
) -> Result<()> {
    let api = docs_api(endpoint)?;
    let namespace = parse_namespace(&namespace)?;
    // `on_close` is fired from either the set-up path (open/subscribe failed) or
    // the forward loop (stream ended); share it so exactly one path settles it.
    let on_close = Arc::new(on_close);

    runtime().spawn(async move {
        let doc = match open_doc(&api, namespace).await {
            Ok(doc) => doc,
            Err(e) => {
                let on_close = Arc::clone(&on_close);
                guarded_callback(move || on_close(Some(e)));
                return;
            }
        };
        let mut events = match doc.subscribe().await {
            Ok(events) => events,
            Err(e) => {
                close_doc(doc).await;
                let err = IrohError::Docs(format!("subscribe to document: {e:#}"));
                let on_close = Arc::clone(&on_close);
                guarded_callback(move || on_close(Some(err)));
                return;
            }
        };

        let close_on_end = Arc::clone(&on_close);
        let forward = runtime().spawn(async move {
            while let Some(item) = events.next().await {
                match item {
                    Ok(event) => {
                        let json = live_event_to_json(&event);
                        guarded_callback(|| on_event(json));
                    }
                    Err(e) => {
                        let err = IrohError::Docs(format!("subscription stream errored: {e:#}"));
                        guarded_callback(move || close_on_end(Some(err)));
                        return;
                    }
                }
            }
            guarded_callback(move || close_on_end(None));
        });

        let handle = DOCS_SUBS.insert(DocsSubscription {
            doc,
            _task: AbortOnDropHandle::new(forward),
        });
        guarded_callback(|| on_start(DocsSubHandle(handle)));
    });

    Ok(())
}

/// Ends a subscription started with [`docs_subscribe`]: aborts its forwarding
/// task and closes the replica handle it held open. Idempotent: unsubscribing an
/// unknown or already-ended subscription is a no-op.
pub fn docs_unsubscribe(sub: DocsSubHandle) {
    if let Ok(subscription) = DOCS_SUBS.remove(sub.raw()) {
        // Closing the replica is an async RPC; the Doc handle is cheap to clone.
        // Dropping `subscription` at the end of this scope aborts the forward
        // task via its AbortOnDropHandle.
        let doc = subscription.doc.clone();
        runtime().spawn(async move {
            close_doc(doc).await;
        });
    }
}

/// Starts (or refreshes) live sync of the document `namespace` with `peers`
/// (a newline-joined `EndpointAddr` JSON list; empty to sync with already-known
/// peers). Non-empty peers do an initial set-reconciliation with each and join
/// the document's gossip swarm; their addresses are seeded into the endpoint's
/// lookup first so they are dialable on the minimal preset.
pub fn docs_start_sync(
    endpoint: EndpointHandle,
    namespace: String,
    peers_joined: String,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let state = endpoint_state(endpoint)?;
            let api = docs_api(endpoint)?;
            let namespace = parse_namespace(&namespace)?;
            let peers = parse_peers(&peers_joined)?;
            for addr in &peers {
                state.bootstrap_lookup.add_endpoint_info(addr.clone());
            }
            let doc = open_doc(&api, namespace).await?;
            let result = doc
                .start_sync(peers)
                .await
                .map_err(|e| IrohError::Docs(format!("start sync: {e:#}")));
            close_doc(doc).await;
            result
        },
        on_complete,
    );
}

/// Stops the live sync for the document `namespace` and leaves its gossip swarm.
pub fn docs_leave(
    endpoint: EndpointHandle,
    namespace: String,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let namespace = parse_namespace(&namespace)?;
            let doc = open_doc(&api, namespace).await?;
            let result = doc
                .leave()
                .await
                .map_err(|e| IrohError::Docs(format!("leave document: {e:#}")));
            close_doc(doc).await;
            result
        },
        on_complete,
    );
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    use crate::test_support::{
        close_endpoint_blocking, create_minimal_endpoint, create_minimal_endpoint_with_docs,
        TIMEOUT,
    };

    /// Drives a callback-completed docs op to its result, blocking the test.
    fn block_on<T: Send + 'static>(
        start: impl FnOnce(Box<dyn FnOnce(Result<T>) + Send>),
    ) -> Result<T> {
        let (tx, rx) = mpsc::channel();
        start(Box::new(move |result| {
            tx.send(result).ok();
        }));
        rx.recv_timeout(TIMEOUT).expect("docs op completed")
    }

    #[test]
    fn crud_roundtrip_over_a_single_document() {
        let endpoint = create_minimal_endpoint_with_docs(None);

        // A default author exists (auto-created) and shows up in the list.
        let author = block_on(|done| authors_default(endpoint, done)).expect("default author");
        author.parse::<AuthorId>().expect("author id is valid");
        let created = block_on(|done| authors_create(endpoint, done)).expect("create author");
        let authors = block_on(|done| authors_list(endpoint, done)).expect("list authors");
        assert!(authors.contains(&author), "default author is listed");
        assert!(authors.contains(&created), "created author is listed");

        // Create a doc and write an entry.
        let namespace = block_on(|done| docs_create(endpoint, done)).expect("create doc");
        namespace
            .parse::<NamespaceId>()
            .expect("namespace is valid");
        let value = b"the treaty of the meadow".to_vec();
        let hash = block_on(|done| {
            docs_set_bytes(
                endpoint,
                namespace.clone(),
                author.clone(),
                "chapter/1".into(),
                value.clone(),
                done,
            )
        })
        .expect("set bytes");

        // getExact surfaces hash + size + timestamp; no bytes are fetched.
        let entry = block_on(|done| {
            docs_get_exact(
                endpoint,
                namespace.clone(),
                author.clone(),
                "chapter/1".into(),
                done,
            )
        })
        .expect("get exact")
        .expect("entry present");
        assert_eq!(entry.hash, hash);
        assert_eq!(entry.size, value.len() as u64);
        assert_eq!(entry.author, author);
        assert_eq!(entry.key, "chapter/1");
        assert!(entry.timestamp > 0, "entry carries a timestamp");

        // getContent resolves the raw bytes through the blob store.
        let content =
            block_on(|done| docs_get_content(endpoint, entry.hash.clone(), done)).expect("content");
        assert_eq!(content, value, "content matches what was written");

        // getMany lists the entry.
        let many = block_on(|done| docs_get_many(endpoint, namespace.clone(), String::new(), done))
            .expect("get many");
        assert_eq!(many.len(), 1);
        assert_eq!(many[0].key, "chapter/1");

        // A query scoped by key prefix still finds it; an unrelated prefix does not.
        let scoped = block_on(|done| {
            docs_get_many(
                endpoint,
                namespace.clone(),
                r#"{"keyPrefix":"chapter/"}"#.into(),
                done,
            )
        })
        .expect("scoped query");
        assert_eq!(scoped.len(), 1);
        let empty = block_on(|done| {
            docs_get_many(
                endpoint,
                namespace.clone(),
                r#"{"keyPrefix":"other/"}"#.into(),
                done,
            )
        })
        .expect("empty query");
        assert!(empty.is_empty());

        // deletePrefix removes the entry: getExact goes empty, getMany drops it.
        // Only one key exists here, so exactly one is removed.
        let removed = block_on(|done| {
            docs_delete_prefix(
                endpoint,
                namespace.clone(),
                author.clone(),
                "chapter/1".into(),
                done,
            )
        })
        .expect("delete");
        assert_eq!(removed, 1, "exactly the one entry was removed");
        let gone = block_on(|done| {
            docs_get_exact(
                endpoint,
                namespace.clone(),
                author.clone(),
                "chapter/1".into(),
                done,
            )
        })
        .expect("get exact after del");
        assert!(gone.is_none(), "deleted entry reads as absent");
        let after =
            block_on(|done| docs_get_many(endpoint, namespace.clone(), String::new(), done))
                .expect("get many after del");
        assert!(after.is_empty(), "no live entries remain");

        // The doc is listed, then dropped, then gone.
        let docs = block_on(|done| docs_list(endpoint, done)).expect("list docs");
        assert!(docs.contains(&namespace), "namespace is listed");
        block_on(|done| docs_drop(endpoint, namespace.clone(), done)).expect("drop doc");
        let after_drop = block_on(|done| docs_list(endpoint, done)).expect("list after drop");
        assert!(
            !after_drop.contains(&namespace),
            "dropped namespace is gone"
        );

        close_endpoint_blocking(endpoint).expect("close");
    }

    /// Locks the prefix-scoped delete contract: `delete_prefix` removes the key
    /// AND every prefix-sibling, and nothing outside the prefix. A verbatim
    /// exact-key delete would leave the sibling behind (removed count 1, not 2).
    #[test]
    fn delete_prefix_removes_prefix_siblings_and_nothing_else() {
        let endpoint = create_minimal_endpoint_with_docs(None);
        let author = block_on(|done| authors_default(endpoint, done)).expect("author");
        let namespace = block_on(|done| docs_create(endpoint, done)).expect("create doc");

        let write = |key: &str| {
            let key = key.to_owned();
            block_on(|done| {
                docs_set_bytes(
                    endpoint,
                    namespace.clone(),
                    author.clone(),
                    key,
                    b"v".to_vec(),
                    done,
                )
            })
            .expect("set");
        };
        let present = |key: &str| {
            let key = key.to_owned();
            block_on(|done| docs_get_exact(endpoint, namespace.clone(), author.clone(), key, done))
                .expect("get exact")
                .is_some()
        };
        let delete = |prefix: &str| {
            let prefix = prefix.to_owned();
            block_on(|done| {
                docs_delete_prefix(endpoint, namespace.clone(), author.clone(), prefix, done)
            })
            .expect("delete prefix")
        };

        // "note" and "note-draft" share the "note" prefix; deleting "note"
        // removes BOTH (this is the data-loss surface the contract makes honest).
        write("note");
        write("note-draft");
        assert_eq!(
            delete("note"),
            2,
            "prefix delete removes the key and its siblings"
        );
        assert!(!present("note"));
        assert!(!present("note-draft"));

        // "a" and "b" do not share a prefix; deleting "a" removes ONLY "a".
        write("a");
        write("b");
        assert_eq!(
            delete("a"),
            1,
            "a non-shared prefix removes exactly one key"
        );
        assert!(!present("a"));
        assert!(present("b"), "the unrelated key survives");

        close_endpoint_blocking(endpoint).expect("close");
    }

    #[test]
    fn share_produces_a_ticket_that_parses_back_to_the_namespace() {
        let endpoint = create_minimal_endpoint_with_docs(None);
        let namespace = block_on(|done| docs_create(endpoint, done)).expect("create doc");
        let ticket = block_on(|done| docs_share(endpoint, namespace.clone(), "write".into(), done))
            .expect("share");
        let info = parse_doc_ticket(&ticket).expect("ticket parses");
        assert_eq!(info.namespace, namespace);
        assert_eq!(info.capability, "write");
        assert!(
            !info.node_ids.is_empty(),
            "ticket carries this node as a peer"
        );
        close_endpoint_blocking(endpoint).expect("close");
    }

    #[test]
    fn import_reintroduces_an_author_from_its_secret() {
        let endpoint = create_minimal_endpoint_with_docs(None);
        // A freestanding author (as another device would hold): its secret is
        // the whole identity, so importing it must reproduce the same id.
        let author = Author::from_bytes(&[7u8; 32]);
        let secret = author.to_string();
        let expected = author.id().to_string();
        let imported =
            block_on(|done| authors_import(endpoint, secret, done)).expect("import author");
        assert_eq!(imported, expected);
        let authors = block_on(|done| authors_list(endpoint, done)).expect("list authors");
        assert!(authors.contains(&expected), "imported author is usable");
        close_endpoint_blocking(endpoint).expect("close");
    }

    #[test]
    fn docs_calls_on_a_docs_disabled_endpoint_report_docs_disabled() {
        let endpoint = create_minimal_endpoint(None);
        assert!(matches!(
            block_on(|done| docs_create(endpoint, done)),
            Err(IrohError::DocsDisabled(_))
        ));
        assert!(matches!(
            block_on(|done| authors_default(endpoint, done)),
            Err(IrohError::DocsDisabled(_))
        ));
        close_endpoint_blocking(endpoint).expect("close");
    }

    #[test]
    fn set_on_an_unknown_document_reports_a_docs_error() {
        let endpoint = create_minimal_endpoint_with_docs(None);
        let author = block_on(|done| authors_default(endpoint, done)).expect("author");
        // A syntactically valid namespace this node has never created (an
        // ed25519 public key is a valid namespace id).
        let stranger = Author::from_bytes(&[9u8; 32]).id().to_string();
        assert!(matches!(
            block_on(|done| docs_set_bytes(
                endpoint,
                stranger,
                author,
                "k".into(),
                b"v".to_vec(),
                done
            )),
            Err(IrohError::Docs(_))
        ));
        close_endpoint_blocking(endpoint).expect("close");
    }

    #[test]
    fn parse_doc_ticket_rejects_garbage() {
        assert!(matches!(
            parse_doc_ticket("not-a-doc-ticket"),
            Err(IrohError::DocsInvalidTicket(_))
        ));
    }

    /// End-to-end live sync over two docs-enabled minimal-preset endpoints on
    /// loopback (relay disabled): Alice writes a key, Bob imports the ticket and
    /// subscribes BEFORE any sync (so the insert cannot be missed), both start
    /// sync, and Bob observes the REMOTE insert of Alice's key plus its content
    /// becoming ready, then fetches the content and finds it equal to Alice's
    /// bytes. Bounded timeouts turn a hang into a failure.
    #[test]
    fn two_endpoint_loopback_sync_observes_remote_insert() {
        let alice = create_minimal_endpoint_with_docs(None);
        let bob = create_minimal_endpoint_with_docs(None);

        // Alice authors an entry and mints a write ticket for the document.
        let author = block_on(|done| authors_default(alice, done)).expect("alice author");
        let namespace = block_on(|done| docs_create(alice, done)).expect("alice creates doc");
        let value = b"the remote treaty of the meadow".to_vec();
        let hash = block_on(|done| {
            docs_set_bytes(
                alice,
                namespace.clone(),
                author.clone(),
                "chapter/1".into(),
                value.clone(),
                done,
            )
        })
        .expect("alice set bytes");
        let ticket = block_on(|done| docs_share(alice, namespace.clone(), "write".into(), done))
            .expect("alice share");

        // Bob imports the ticket (registers the doc, no sync yet) and subscribes
        // before sync starts, so the remote insert lands on a live subscriber.
        let bob_namespace = block_on(|done| docs_import(bob, ticket, done)).expect("bob import");
        assert_eq!(bob_namespace, namespace, "bob imported the same namespace");
        let (sub, events) = subscribe_collecting(bob, &namespace);

        // Alice enables her side; Bob dials Alice by her address and reconciles.
        block_on(|done| docs_start_sync(alice, namespace.clone(), String::new(), done))
            .expect("alice start_sync");
        let alice_addr = addr_json(alice);
        block_on(|done| docs_start_sync(bob, namespace.clone(), alice_addr, done))
            .expect("bob start_sync");

        // Bob's subscription observes the remote insert (authored by Alice, not a
        // local echo) and the content download completing.
        wait_for_remote_insert(&events, &author, "chapter/1");
        wait_for_content_ready(&events, &hash);

        // Bob fetches the synced content: byte-for-byte equal to Alice's write.
        let content =
            block_on(|done| docs_get_content(bob, hash.clone(), done)).expect("bob content");
        assert_eq!(content, value, "synced content equals the origin bytes");

        docs_unsubscribe(sub);
        // Unsubscribe is idempotent.
        docs_unsubscribe(sub);
        close_endpoint_blocking(alice).expect("close alice");
        close_endpoint_blocking(bob).expect("close bob");
    }

    type CollectedDocs = (DocsSubHandle, mpsc::Receiver<String>);

    /// Subscribes to a document's live events, returning the handle plus a
    /// channel of the JSON event payloads. Blocks until `on_start` fires.
    fn subscribe_collecting(endpoint: EndpointHandle, namespace: &str) -> CollectedDocs {
        let (start_tx, start_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        docs_subscribe(
            endpoint,
            namespace.to_owned(),
            move |handle| {
                start_tx.send(handle).ok();
            },
            move |json| {
                event_tx.send(json).ok();
            },
            |_reason| {},
        )
        .expect("subscribe started");
        let handle = start_rx.recv_timeout(TIMEOUT).expect("on_start fired");
        (handle, event_rx)
    }

    /// Blocks until a live event whose parsed JSON satisfies `predicate` arrives,
    /// or the timeout elapses.
    fn wait_for_event(
        events: &mpsc::Receiver<String>,
        predicate: impl Fn(&serde_json::Value) -> bool,
    ) {
        let deadline = std::time::Instant::now() + TIMEOUT;
        loop {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .expect("matching event within timeout");
            let json = events.recv_timeout(remaining).expect("event arrived");
            let value: serde_json::Value =
                serde_json::from_str(&json).expect("event is valid json");
            if predicate(&value) {
                return;
            }
        }
    }

    fn wait_for_remote_insert(events: &mpsc::Receiver<String>, author: &str, key: &str) {
        wait_for_event(events, |value| {
            value["type"].as_str() == Some("insert-remote")
                && value["entry"]["author"].as_str() == Some(author)
                && value["entry"]["key"].as_str() == Some(key)
        });
    }

    fn wait_for_content_ready(events: &mpsc::Receiver<String>, hash: &str) {
        wait_for_event(events, |value| {
            value["type"].as_str() == Some("content-ready") && value["hash"].as_str() == Some(hash)
        });
    }

    fn addr_json(endpoint: EndpointHandle) -> String {
        let info = crate::endpoint::endpoint_addr(endpoint).expect("addr");
        let directs: Vec<String> = info.direct_addrs.iter().map(|a| format!("{a:?}")).collect();
        format!(
            "{{\"id\":\"{}\",\"relayUrls\":[],\"directAddrs\":[{}]}}",
            info.id,
            directs.join(",")
        )
    }
}
