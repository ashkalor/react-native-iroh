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

use bytes::Bytes;
use iroh_blobs::Hash;
use iroh_docs::{
    api::{
        protocol::{AddrInfoOptions, ShareMode},
        Doc, DocsApi,
    },
    store::Query,
    Author, AuthorId, CapabilityKind, DocTicket, Entry, NamespaceId,
};
use n0_future::StreamExt;

use crate::{
    endpoint::{endpoint_state, EndpointHandle},
    error::{error_chain, IrohError, Result},
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

/// Imports a document from a [`DocTicket`] string, joining the peers it names,
/// and returns its [`NamespaceId`] (hex). Live sync is Phase 3; this only
/// registers the document and its peers.
pub fn docs_import(
    endpoint: EndpointHandle,
    ticket: String,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    spawn_completing(
        async move {
            let api = docs_api(endpoint)?;
            let ticket: DocTicket = ticket
                .parse()
                .map_err(|e| IrohError::DocsInvalidTicket(format!("{e}")))?;
            let doc = api
                .import(ticket)
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
}
