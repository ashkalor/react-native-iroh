//! Endpoint lifecycle: create, query the endpoint id, close.
//!
//! An endpoint owns an [`iroh::Endpoint`], its blob store, and an
//! [`iroh::protocol::Router`] that accepts incoming iroh-blobs connections.
//! Endpoints are addressed by opaque [`EndpointHandle`]s held in a
//! process-wide registry.

use std::{
    collections::HashMap, net::SocketAddr, path::PathBuf, sync::Arc, sync::LazyLock, time::Duration,
};

use iroh::{
    address_lookup::memory::MemoryLookup, endpoint::presets, endpoint::TransportAddrUsage,
    protocol::Router, Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, TransportAddr,
    Watcher,
};
use iroh_blobs::{
    api::blobs::{ExportMode, ImportMode},
    store::{fs::FsStore, mem::MemStore, GcConfig},
    BlobsProtocol,
};
use iroh_docs::{protocol::Docs, ALPN as DOCS_ALPN};
use iroh_gossip::net::Gossip;
use n0_future::{task::AbortOnDropHandle, StreamExt};

use crate::{
    error::{IrohError, Result},
    guarded_callback,
    registry::Registry,
    require_absolute,
    runtime::runtime,
    spawn_completing,
    streams::{inbound_alpn_channel, validate_alpns, InboundQueue},
};

/// Opaque handle to a live endpoint. `0` is never a valid handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EndpointHandle(u64);

impl EndpointHandle {
    /// Reconstructs a handle from its raw FFI representation.
    pub fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    /// The raw numeric value passed across the FFI boundary.
    pub fn raw(self) -> u64 {
        self.0
    }
}

/// Which of iroh's endpoint presets the endpoint binds with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NetworkPreset {
    /// Production default: n0's relay and discovery infrastructure
    /// ([`presets::N0`]).
    #[default]
    N0,
    /// Only the mandatory configuration ([`presets::Minimal`]): no relays,
    /// no discovery. Peers are only reachable through direct addresses
    /// embedded in tickets. Used for tests and LAN-only setups.
    Minimal,
}

/// Opt-in blob garbage collection for an endpoint's store.
///
/// Off by default: an [`EndpointConfig`] with `gc: None` runs no GC loop, so
/// retention is unchanged (nothing is ever reclaimed). When set, the store
/// spawns a loop that reclaims untagged, un-temp-tagged blobs every
/// [`Self::interval`]; tagged blobs (see [`crate::blobs::tags_create`]) survive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GcSettings {
    /// How often the GC loop runs a mark-and-sweep pass.
    pub interval: Duration,
}

/// Configuration for [`endpoint_create`].
#[derive(Debug, Clone, Default)]
pub struct EndpointConfig {
    /// Network infrastructure preset.
    pub preset: NetworkPreset,
    /// Directory for the persistent blob store. `None` keeps blobs in memory
    /// (blobs are lost when the endpoint closes).
    pub blob_store_dir: Option<PathBuf>,
    /// Opt-in blob garbage collection. `None` (the default) runs no GC loop and
    /// keeps every blob forever; `Some` spawns the reclaiming loop at store
    /// load. Tagged blobs are always protected.
    pub gc: Option<GcSettings>,
    /// Whether to run the iroh-docs meta-protocol on this endpoint. When
    /// `false` the endpoint pays no docs cost: no docs store, no `DOCS_ALPN`
    /// accept, no background docs engine.
    pub docs: bool,
    /// Directory for the persistent docs store, used only when [`Self::docs`]
    /// is enabled. `None` keeps docs (replicas and authors) in memory (lost
    /// when the endpoint closes).
    pub docs_store_dir: Option<PathBuf>,
    /// Relay configuration as a delimited string, or `None` to inherit the
    /// preset's default. See [`parse_relay_mode`] for the accepted syntax.
    pub relay_mode: Option<String>,
    /// Custom ALPN protocol names the endpoint accepts inbound connections on
    /// (see [`crate::streams`]). Fixed here because the router's ALPN set is
    /// fixed when it spawns, which happens during [`endpoint_create`].
    pub alpns: Vec<String>,
}

/// Parses the bridge's `relay_mode` field into an [`iroh::RelayMode`].
///
/// `None` (or an omitted field) yields `None`, meaning "inherit the network
/// preset's default relay behavior". Otherwise the string is one of:
///
/// - `"default"`, `"disabled"`, `"staging"`: the matching preset relay map;
/// - `"custom\n<url>\n<url>..."`: the literal tag `custom` followed by one or
///   more newline-separated relay URLs (each parsed as a [`RelayUrl`]).
///
/// A custom mode overrides the preset's relays. Any other tag, a malformed
/// URL, or an empty custom list is an [`IrohError::EndpointBind`] (parse
/// failures surface at endpoint creation).
pub fn parse_relay_mode(field: Option<&str>) -> Result<Option<RelayMode>> {
    let Some(field) = field else {
        return Ok(None);
    };
    let mode = match field {
        "default" => RelayMode::Default,
        "disabled" => RelayMode::Disabled,
        "staging" => RelayMode::Staging,
        other => {
            let mut parts = other.split('\n');
            let tag = parts.next().unwrap_or_default();
            if tag != "custom" {
                return Err(IrohError::EndpointBind(format!(
                    "unknown relay mode: {other:?}"
                )));
            }
            let urls = parts
                .filter(|segment| !segment.is_empty())
                .map(|segment| {
                    segment.parse::<RelayUrl>().map_err(|e| {
                        IrohError::EndpointBind(format!("invalid relay url {segment:?}: {e}"))
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            if urls.is_empty() {
                return Err(IrohError::EndpointBind(
                    "custom relay mode needs at least one relay url".into(),
                ));
            }
            RelayMode::custom(urls)
        }
    };
    Ok(Some(mode))
}

/// The blob store backing an endpoint.
#[derive(Debug)]
pub(crate) enum BlobStore {
    Mem(MemStore),
    Fs(FsStore),
}

impl BlobStore {
    /// The store API client.
    pub(crate) fn api(&self) -> &iroh_blobs::api::Store {
        match self {
            BlobStore::Mem(store) => store,
            BlobStore::Fs(store) => store,
        }
    }

    /// `TryReference` would record the caller's path instead of copying the
    /// bytes in, leaving the store dependent on a file it does not own. See
    /// [`Self::export_mode`].
    pub(crate) fn import_mode(&self) -> ImportMode {
        ImportMode::Copy
    }

    /// Never `TryReference`: it does not link the blob, it renames the store's
    /// own file onto the destination and re-points the entry at it. A caller who
    /// later deletes that download leaves the store loading a path that no
    /// longer resolves, which iroh-blobs turns into a poisoned entry that panics
    /// on every later use, permanently and across restarts.
    ///
    /// The price is a second write per transfer, reflinked where the filesystem
    /// supports it (APFS) and a real copy where it does not (ext4/f2fs).
    pub(crate) fn export_mode(&self) -> ExportMode {
        ExportMode::Copy
    }
}

/// Everything owned by one live endpoint.
#[derive(Debug)]
pub(crate) struct EndpointState {
    pub(crate) endpoint: Endpoint,
    pub(crate) store: BlobStore,
    pub(crate) preset: NetworkPreset,
    /// The gossip protocol running over this endpoint. The [`Router`] below
    /// accepts incoming gossip connections into it; [`crate::gossip`] drives
    /// its subscriptions.
    pub(crate) gossip: Gossip,
    /// Addresses supplied by the host (gossip bootstrap peers), so the endpoint
    /// can dial those peers by id without a discovery service. Registered once
    /// with the endpoint's address-lookup chain at creation; entries are added
    /// to it thereafter.
    pub(crate) bootstrap_lookup: MemoryLookup,
    /// One inbound connection queue per ALPN declared in
    /// [`EndpointConfig::alpns`], keyed by the ALPN name that
    /// [`crate::streams::stream_listen`] attaches to.
    pub(crate) inbound_alpns: HashMap<String, InboundQueue>,
    /// The iroh-docs meta-protocol running over this endpoint, present only when
    /// [`EndpointConfig::docs`] was set. The [`Router`] accepts `DOCS_ALPN` into
    /// it, and [`Router::shutdown`] cascades into its [`Docs::shutdown`], so the
    /// close path needs no separate teardown for it.
    // Read only by Phase 2 (doc CRUD / authors / sync). The router owns the
    // clone that keeps the engine alive, so nothing reads this field yet.
    #[allow(dead_code)]
    pub(crate) docs: Option<Docs>,
    router: Router,
}

static ENDPOINTS: LazyLock<Registry<EndpointState>> = LazyLock::new(Registry::new);

/// Looks up the state behind `handle`.
pub(crate) fn endpoint_state(handle: EndpointHandle) -> Result<Arc<EndpointState>> {
    ENDPOINTS.get(handle.raw())
}

/// Creates an endpoint asynchronously; `on_complete` receives its handle.
///
/// The callback runs on a tokio worker thread of the shared runtime.
pub fn endpoint_create(
    config: EndpointConfig,
    on_complete: impl FnOnce(Result<EndpointHandle>) + Send + 'static,
) {
    // The first endpoint is the earliest point at which anything worth logging
    // can happen, and every path into the core goes through one.
    crate::logging::init();
    spawn_completing(create_inner(config), on_complete);
}

async fn create_inner(config: EndpointConfig) -> Result<EndpointHandle> {
    // Validate before doing any work: a relative store dir would silently
    // resolve against an arbitrary process working directory.
    let blob_store_dir = config
        .blob_store_dir
        .map(|dir| require_absolute(dir, "blob store dir"))
        .transpose()?;
    // Only meaningful (and only validated) when docs are enabled, so a disabled
    // endpoint keeps exactly today's behavior regardless of this field.
    let docs_enabled = config.docs;
    let docs_store_dir = if docs_enabled {
        config
            .docs_store_dir
            .map(|dir| require_absolute(dir, "docs store dir"))
            .transpose()?
    } else {
        None
    };

    // Parse the relay override and the custom ALPNs before any async work so a
    // bad config fails fast, before sockets are bound or the store is touched.
    let relay_mode = parse_relay_mode(config.relay_mode.as_deref())?;
    validate_alpns(&config.alpns)?;
    let preset = config.preset;
    let bind = async {
        let builder = match preset {
            NetworkPreset::N0 => Endpoint::builder(presets::N0),
            // `Minimal` sets only the mandatory crypto provider: relays stay
            // disabled and no address lookup services are configured.
            NetworkPreset::Minimal => Endpoint::builder(presets::Minimal),
        };
        // `relay_mode` overrides the preset's relays; discovery (an orthogonal
        // preset concern) is left untouched. `None` keeps the preset default.
        let builder = match relay_mode {
            Some(mode) => builder.relay_mode(mode),
            None => builder,
        };
        builder
            .bind()
            .await
            .map_err(|e| IrohError::EndpointBind(e.to_string()))
    };
    // The GC loop is spawned inside the store on load when a config is present;
    // `add_protected` stays `None` because retention is driven entirely by tags
    // (a JS-side ProtectCb is a documented follow-up, not wired here).
    let gc = config.gc;
    let load_store = async {
        let gc_config = gc.map(|settings| GcConfig {
            interval: settings.interval,
            add_protected: None,
        });
        Ok(match blob_store_dir {
            Some(dir) => {
                // `load` uses `<dir>/blobs.db` with default options; replicate
                // that path so only the GC field differs from the default load.
                let mut options = iroh_blobs::store::fs::options::Options::new(&dir);
                options.gc = gc_config;
                let db_path = dir.join("blobs.db");
                BlobStore::Fs(
                    FsStore::load_with_opts(db_path, options)
                        .await
                        .map_err(|e| IrohError::EndpointBind(format!("blob store: {e}")))?,
                )
            }
            None => BlobStore::Mem(MemStore::new_with_opts(iroh_blobs::store::mem::Options {
                gc_config,
            })),
        })
    };
    // Socket binding and blob-store loading are independent; run them
    // concurrently and fail fast if either errors.
    let (endpoint, store) = tokio::try_join!(bind, load_store)?;
    tracing::debug!(
        kind = match &store {
            BlobStore::Mem(_) => "mem",
            BlobStore::Fs(_) => "fs",
        },
        import = ?store.import_mode(),
        export = ?store.export_mode(),
        "blob store ready, owning every byte it serves"
    );

    let blobs = BlobsProtocol::new(store.api(), None);
    // Gossip is registered as a second ALPN on the same router, additively:
    // the blobs accept (and its ordering) is unchanged so blob transfer is
    // unaffected. The gossip instance shares the endpoint and is driven by
    // `crate::gossip`.
    let gossip = Gossip::builder().spawn(endpoint.clone());
    // Docs is a meta-protocol over the same endpoint, sharing the blob store and
    // the gossip instance. It is built only when enabled so a docs-off endpoint
    // spawns no docs engine and registers no extra ALPN.
    let docs = if docs_enabled {
        let builder = match docs_store_dir {
            // `Docs::persistent` opens `<dir>/docs.redb` without creating `<dir>`,
            // unlike `FsStore::load`; create it first so a fresh store dir works.
            Some(dir) => {
                tokio::fs::create_dir_all(&dir)
                    .await
                    .map_err(|e| IrohError::EndpointBind(format!("docs store dir: {e}")))?;
                Docs::persistent(dir)
            }
            None => Docs::memory(),
        };
        let docs = builder
            .spawn(endpoint.clone(), store.api().clone(), gossip.clone())
            .await
            .map_err(|e| IrohError::EndpointBind(format!("docs: {e}")))?;
        Some(docs)
    } else {
        None
    };
    let mut builder = Router::builder(endpoint.clone())
        .accept(iroh_blobs::ALPN, blobs)
        .accept(iroh_gossip::net::GOSSIP_ALPN, gossip.clone());
    if let Some(docs) = &docs {
        builder = builder.accept(DOCS_ALPN, docs.clone());
    }
    // Custom ALPNs are additive on the same router. Each gets a queue the
    // handler fills and a listener drains; `validate_alpns` has already refused
    // any name that would shadow the two protocols registered above.
    let mut inbound_alpns = HashMap::with_capacity(config.alpns.len());
    for alpn in &config.alpns {
        let (handler, queue) = inbound_alpn_channel();
        builder = builder.accept(alpn.as_bytes(), handler);
        inbound_alpns.insert(alpn.clone(), queue);
    }
    let router = builder.spawn();

    let bootstrap_lookup = MemoryLookup::new();
    endpoint
        .address_lookup()
        .map_err(|e| IrohError::EndpointBind(format!("address lookup unavailable: {e}")))?
        .add(bootstrap_lookup.clone());

    let handle = ENDPOINTS.insert(EndpointState {
        endpoint,
        store,
        preset: config.preset,
        gossip,
        bootstrap_lookup,
        inbound_alpns,
        docs,
        router,
    });
    Ok(EndpointHandle(handle))
}

/// Whether `handle` refers to a live (not yet closed) endpoint.
///
/// Cheap and synchronous: a registry lookup.
pub fn endpoint_is_open(handle: EndpointHandle) -> bool {
    endpoint_state(handle).is_ok()
}

/// Returns the endpoint's id (its public key) as a string.
///
/// Cheap and synchronous: no network involved.
pub fn endpoint_id(handle: EndpointHandle) -> Result<String> {
    Ok(endpoint_state(handle)?.endpoint.id().to_string())
}

/// A structured snapshot of an endpoint's current address, produced by
/// [`endpoint_addr`] and delivered by [`watch_addr`].
///
/// The bridge serializes this to a JSON object string; the TS layer parses it
/// into a typed `EndpointAddr`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointAddrInfo {
    /// The endpoint's id (its public key) as a string.
    pub id: String,
    /// Home-relay URLs the endpoint is reachable through, as strings.
    pub relay_urls: Vec<String>,
    /// Direct socket addresses the endpoint is reachable through, as strings.
    pub direct_addrs: Vec<String>,
}

/// Splits an [`EndpointAddr`] into the relay and direct address lists the
/// bridge exposes. Custom transport addresses (a `#[non_exhaustive]` variant)
/// are not surfaced.
fn addr_info(addr: &EndpointAddr) -> EndpointAddrInfo {
    let mut relay_urls = Vec::new();
    let mut direct_addrs = Vec::new();
    for transport in &addr.addrs {
        match transport {
            TransportAddr::Relay(url) => relay_urls.push(url.to_string()),
            TransportAddr::Ip(socket) => direct_addrs.push(socket.to_string()),
            _ => {}
        }
    }
    EndpointAddrInfo {
        id: addr.id.to_string(),
        relay_urls,
        direct_addrs,
    }
}

/// Parses one `EndpointAddr` JSON object (the shape [`addr_info`] is serialized
/// to: `{ id, relayUrls, directAddrs }`) back into an [`EndpointAddr`].
///
/// This is the one place structured addressing input is parsed, shared by every
/// caller that accepts a peer address from the host ([`crate::gossip`] bootstrap
/// peers, [`crate::streams`] dial targets). Failures are plain messages so each
/// caller can wrap them in the error variant its own API documents.
pub(crate) fn parse_endpoint_addr(json: &str) -> std::result::Result<EndpointAddr, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("addr json is invalid: {e}"))?;
    let id_str = value
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| String::from("addr is missing id"))?;
    let id: EndpointId = id_str
        .parse()
        .map_err(|e| format!("endpoint id is invalid: {e}"))?;

    let mut transports: Vec<TransportAddr> = Vec::new();
    for relay in json_strings(&value, "relayUrls") {
        let url: RelayUrl = relay
            .parse()
            .map_err(|e| format!("relay url {relay:?} is invalid: {e}"))?;
        transports.push(TransportAddr::Relay(url));
    }
    for direct in json_strings(&value, "directAddrs") {
        let socket: SocketAddr = direct
            .parse()
            .map_err(|e| format!("direct addr {direct:?} is invalid: {e}"))?;
        transports.push(TransportAddr::Ip(socket));
    }
    Ok(EndpointAddr::from_parts(id, transports))
}

/// The string members of `value[key]`, or nothing when the key is absent, not
/// an array, or holds non-string entries.
fn json_strings<'a>(value: &'a serde_json::Value, key: &str) -> impl Iterator<Item = &'a str> {
    value
        .get(key)
        .and_then(|found| found.as_array())
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.as_str())
}

/// Returns the endpoint's current address (its id plus the relay and direct
/// addresses currently known).
///
/// Cheap and synchronous: a snapshot of the endpoint's latest observed
/// address, no network I/O.
pub fn endpoint_addr(handle: EndpointHandle) -> Result<EndpointAddrInfo> {
    Ok(addr_info(&endpoint_state(handle)?.endpoint.addr()))
}

/// Opaque handle to a running address watcher. `0` is never a valid handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WatchHandle(u64);

impl WatchHandle {
    /// Reconstructs a handle from its raw FFI representation.
    pub fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    /// The raw numeric value passed across the FFI boundary.
    pub fn raw(self) -> u64 {
        self.0
    }
}

/// A running address watcher: an abort-on-drop task streaming address changes
/// into the host callback. Dropping the state (via [`stop_watch_addr`]) aborts
/// the task.
#[derive(Debug)]
struct WatchState {
    _task: AbortOnDropHandle<()>,
}

static ADDR_WATCHES: LazyLock<Registry<WatchState>> = LazyLock::new(Registry::new);

/// Starts watching `handle`'s address, invoking `on_change` with each new
/// [`EndpointAddrInfo`] (including the current value at subscription time).
///
/// Returns a [`WatchHandle`] immediately (or [`IrohError::InvalidHandle`] for a
/// stale endpoint). The watch runs until [`stop_watch_addr`] is called with the
/// returned handle. The task holds its own clone of the endpoint, so it keeps
/// delivering until explicitly stopped.
pub fn watch_addr(
    handle: EndpointHandle,
    on_change: impl Fn(EndpointAddrInfo) + Send + Sync + 'static,
) -> Result<WatchHandle> {
    let endpoint = endpoint_state(handle)?.endpoint.clone();
    let task = runtime().spawn(async move {
        let mut stream = endpoint.watch_addr().stream();
        while let Some(addr) = stream.next().await {
            let info = addr_info(&addr);
            guarded_callback(|| on_change(info));
        }
    });
    let id = ADDR_WATCHES.insert(WatchState {
        _task: AbortOnDropHandle::new(task),
    });
    Ok(WatchHandle(id))
}

/// Stops an address watcher started with [`watch_addr`], aborting its task.
///
/// Idempotent: stopping an already-stopped or unknown watch is a no-op.
pub fn stop_watch_addr(handle: WatchHandle) {
    // Removing the state drops its `AbortOnDropHandle`, which aborts the task.
    ADDR_WATCHES.remove(handle.raw()).ok();
}

/// One transport address a remote endpoint is known by, plus whether the local
/// endpoint is actually using it.
///
/// `active` is what distinguishes an observed network path from a merely
/// advertised one: iroh keeps every address it has learned for a remote, but
/// only the active ones carry traffic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteAddrInfo {
    /// The address itself: a relay URL, or a `host:port` socket address.
    pub addr: String,
    /// Which transport the address belongs to: `"relay"` or `"ip"`.
    pub kind: &'static str,
    /// Whether the address is in active use, as opposed to merely known.
    pub active: bool,
}

/// A snapshot of what the local endpoint knows about a remote endpoint,
/// produced by [`endpoint_remote_info`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEndpointInfo {
    /// The remote endpoint's id (its public key) as a string.
    pub id: String,
    /// Every transport address known for the remote, active or not.
    pub addrs: Vec<RemoteAddrInfo>,
}

/// Returns what `handle`'s endpoint currently knows about the remote endpoint
/// `remote_id`, or `None` if it knows nothing about it (never connected, or the
/// remote has since been forgotten).
///
/// This is the only way to tell whether traffic to a peer is flowing directly
/// or through a relay: [`endpoint_addr`] reports what the *local* endpoint
/// advertises, which says nothing about the path a transfer actually took.
///
/// The snapshot is not live; call again for a fresh one.
pub fn endpoint_remote_info(
    handle: EndpointHandle,
    remote_id: &str,
    on_complete: impl FnOnce(Result<Option<RemoteEndpointInfo>>) + Send + 'static,
) {
    let endpoint = match endpoint_state(handle) {
        Ok(state) => state.endpoint.clone(),
        Err(err) => {
            guarded_callback(move || on_complete(Err(err)));
            return;
        }
    };
    let parsed = remote_id.parse::<iroh::EndpointId>();
    let remote = match parsed {
        Ok(id) => id,
        Err(err) => {
            let err = IrohError::EndpointBind(format!("invalid remote endpoint id: {err}"));
            guarded_callback(move || on_complete(Err(err)));
            return;
        }
    };
    spawn_completing(
        async move {
            Ok(endpoint.remote_info(remote).await.map(|info| {
                let id = info.id().to_string();
                let addrs = info
                    .addrs()
                    .filter_map(|entry| {
                        let active = matches!(entry.usage(), TransportAddrUsage::Active);
                        match entry.addr() {
                            TransportAddr::Relay(url) => Some(RemoteAddrInfo {
                                addr: url.to_string(),
                                kind: "relay",
                                active,
                            }),
                            TransportAddr::Ip(socket) => Some(RemoteAddrInfo {
                                addr: socket.to_string(),
                                kind: "ip",
                                active,
                            }),
                            _ => None,
                        }
                    })
                    .collect();
                RemoteEndpointInfo { id, addrs }
            }))
        },
        on_complete,
    );
}

/// Resolves when `handle`'s endpoint has a connected home relay, or fails with
/// [`IrohError::EndpointBind`] if `timeout` elapses first.
///
/// On relay-less endpoints (the `disabled` relay mode, or a `minimal` preset)
/// no home relay can ever connect, so this always times out.
pub fn endpoint_online(
    handle: EndpointHandle,
    timeout: Duration,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) {
    let endpoint = match endpoint_state(handle) {
        Ok(state) => state.endpoint.clone(),
        Err(err) => {
            guarded_callback(move || on_complete(Err(err)));
            return;
        }
    };
    spawn_completing(
        async move {
            match tokio::time::timeout(timeout, endpoint.online()).await {
                Ok(()) => Ok(()),
                Err(_elapsed) => Err(IrohError::EndpointBind(format!(
                    "endpoint did not come online within {}ms",
                    timeout.as_millis()
                ))),
            }
        },
        on_complete,
    );
}

/// Closes an endpoint: shuts down its router (which closes the underlying
/// iroh endpoint) and its blob store, then invalidates the handle.
///
/// The handle is invalidated immediately; shutdown completes asynchronously
/// and `on_complete` fires when it is done.
pub fn endpoint_close(
    handle: EndpointHandle,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) {
    let state = match ENDPOINTS.remove(handle.raw()) {
        Ok(state) => state,
        Err(err) => {
            guarded_callback(move || on_complete(Err(err)));
            return;
        }
    };
    spawn_completing(close_inner(state), on_complete);
}

async fn close_inner(state: Arc<EndpointState>) -> Result<()> {
    // Router shutdown closes the underlying iroh endpoint and shuts down the
    // blobs protocol handler, which in turn shuts down the blob store.
    state
        .router
        .shutdown()
        .await
        .map_err(|e| IrohError::Internal(format!("router shutdown: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        close_endpoint_blocking, create_endpoint_blocking, create_minimal_endpoint,
        create_minimal_endpoint_with_docs, create_minimal_endpoint_with_gc,
    };

    #[test]
    fn create_minimal_endpoint_yields_valid_endpoint_id() {
        let handle = create_minimal_endpoint(None);

        let id = endpoint_id(handle).expect("endpoint id");
        id.parse::<iroh::EndpointId>()
            .expect("endpoint id is a valid iroh EndpointId");

        close_endpoint_blocking(handle).expect("close succeeded");
    }

    #[test]
    fn create_rejects_relative_blob_store_dir() {
        let result = create_endpoint_blocking(EndpointConfig {
            preset: NetworkPreset::Minimal,
            blob_store_dir: Some(PathBuf::from("relative/store")),
            gc: None,
            docs: false,
            docs_store_dir: None,
            relay_mode: None,
            alpns: Vec::new(),
        });
        assert!(matches!(result, Err(IrohError::InvalidPath(_))));
    }

    #[test]
    fn create_with_docs_enabled_registers_docs_and_closes_cleanly() {
        let mem = create_minimal_endpoint_with_docs(None);
        assert!(
            endpoint_state(mem).expect("live endpoint").docs.is_some(),
            "docs enabled must register a docs handle in the endpoint state"
        );
        close_endpoint_blocking(mem).expect("close succeeded");

        let dir = tempfile::tempdir().expect("tempdir");
        let persistent = create_minimal_endpoint_with_docs(Some(dir.path().join("docs")));
        assert!(
            endpoint_state(persistent)
                .expect("live endpoint")
                .docs
                .is_some(),
            "persistent docs must register a docs handle in the endpoint state"
        );
        close_endpoint_blocking(persistent).expect("close succeeded");
    }

    #[test]
    fn create_with_docs_disabled_registers_no_docs() {
        let handle = create_minimal_endpoint(None);
        assert!(
            endpoint_state(handle)
                .expect("live endpoint")
                .docs
                .is_none(),
            "docs disabled must leave the docs handle absent"
        );
        close_endpoint_blocking(handle).expect("close succeeded");
    }

    #[test]
    fn create_rejects_relative_docs_store_dir() {
        let result = create_endpoint_blocking(EndpointConfig {
            preset: NetworkPreset::Minimal,
            blob_store_dir: None,
            gc: None,
            docs: true,
            docs_store_dir: Some(PathBuf::from("relative/docs")),
            relay_mode: None,
            alpns: Vec::new(),
        });
        assert!(matches!(result, Err(IrohError::InvalidPath(_))));
    }

    #[test]
    fn closed_handle_becomes_invalid() {
        let handle = create_minimal_endpoint(None);

        close_endpoint_blocking(handle).expect("close succeeded");

        assert!(matches!(
            endpoint_id(handle),
            Err(IrohError::InvalidHandle(_))
        ));
        // Double close reports InvalidHandle through the callback.
        assert!(matches!(
            close_endpoint_blocking(handle),
            Err(IrohError::InvalidHandle(_))
        ));
    }

    #[test]
    fn endpoint_id_on_unknown_handle_is_invalid_handle() {
        assert!(matches!(
            endpoint_id(EndpointHandle::from_raw(u64::MAX)),
            Err(IrohError::InvalidHandle(_))
        ));
    }

    #[test]
    fn parse_relay_mode_maps_bare_keywords_and_none() {
        assert!(matches!(parse_relay_mode(None), Ok(None)));
        assert!(matches!(
            parse_relay_mode(Some("default")),
            Ok(Some(RelayMode::Default))
        ));
        assert!(matches!(
            parse_relay_mode(Some("disabled")),
            Ok(Some(RelayMode::Disabled))
        ));
        assert!(matches!(
            parse_relay_mode(Some("staging")),
            Ok(Some(RelayMode::Staging))
        ));
    }

    #[test]
    fn parse_relay_mode_builds_a_custom_relay_map() {
        let field = "custom\nhttps://relay.one.example/\nhttps://relay.two.example/";
        let mode = parse_relay_mode(Some(field))
            .expect("custom relay mode parses")
            .expect("some mode");
        let RelayMode::Custom(map) = mode else {
            panic!("expected a custom relay mode");
        };
        assert_eq!(map.len(), 2);
        let urls: Vec<String> = map
            .urls::<Vec<_>>()
            .into_iter()
            .map(|u| u.to_string())
            .collect();
        assert!(urls.iter().any(|u| u.contains("relay.one.example")));
        assert!(urls.iter().any(|u| u.contains("relay.two.example")));
    }

    #[test]
    fn parse_relay_mode_rejects_bad_input() {
        // Unknown tag.
        assert!(matches!(
            parse_relay_mode(Some("bogus")),
            Err(IrohError::EndpointBind(_))
        ));
        // Malformed custom URL.
        assert!(matches!(
            parse_relay_mode(Some("custom\nnot a url")),
            Err(IrohError::EndpointBind(_))
        ));
        // Custom tag with no URLs.
        assert!(matches!(
            parse_relay_mode(Some("custom")),
            Err(IrohError::EndpointBind(_))
        ));
    }

    #[test]
    fn create_with_disabled_relay_mode_binds() {
        let handle = create_endpoint_blocking(EndpointConfig {
            preset: NetworkPreset::Minimal,
            blob_store_dir: None,
            gc: None,
            docs: false,
            docs_store_dir: None,
            relay_mode: Some("disabled".into()),
            alpns: Vec::new(),
        })
        .expect("endpoint with disabled relay binds");
        close_endpoint_blocking(handle).expect("close succeeded");
    }

    #[test]
    fn endpoint_addr_reports_id_and_no_relay_for_minimal() {
        let handle = create_minimal_endpoint(None);
        let info = endpoint_addr(handle).expect("addr snapshot");
        assert_eq!(info.id, endpoint_id(handle).expect("id"));
        // A minimal endpoint configures no relays.
        assert!(info.relay_urls.is_empty());
        close_endpoint_blocking(handle).expect("close succeeded");
    }

    #[test]
    fn watch_addr_delivers_current_value_then_stops() {
        use std::sync::mpsc;

        let handle = create_minimal_endpoint(None);
        let (tx, rx) = mpsc::channel();
        let watch = watch_addr(handle, move |info| {
            tx.send(info).ok();
        })
        .expect("watch started");

        // The address watcher yields the current value at subscription time.
        let first = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("an address was delivered");
        assert_eq!(first.id, endpoint_id(handle).expect("id"));

        stop_watch_addr(watch);
        // Stopping is idempotent.
        stop_watch_addr(watch);
        close_endpoint_blocking(handle).expect("close succeeded");
    }

    #[test]
    fn watch_addr_on_unknown_endpoint_is_invalid_handle() {
        let result = watch_addr(EndpointHandle::from_raw(u64::MAX), |_| {});
        assert!(matches!(result, Err(IrohError::InvalidHandle(_))));
    }

    #[test]
    fn online_times_out_on_a_relay_less_endpoint() {
        use std::sync::mpsc;

        let handle = create_minimal_endpoint(None);
        let (tx, rx) = mpsc::channel();
        endpoint_online(handle, Duration::from_millis(200), move |result| {
            tx.send(result).ok();
        });
        let result = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("online completion fired");
        assert!(matches!(result, Err(IrohError::EndpointBind(_))));
        close_endpoint_blocking(handle).expect("close succeeded");
    }

    /// The opt-in GC loop reclaims an untagged blob while a tagged one survives.
    /// Retention is driven entirely by tags: a named tag protects its blob, an
    /// unprotected (temp-tag-dropped) blob is swept.
    #[test]
    fn gc_reclaims_untagged_but_keeps_tagged_blobs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let handle = create_minimal_endpoint_with_gc(
            Some(dir.path().join("store")),
            Duration::from_millis(200),
        );
        let state = endpoint_state(handle).expect("live endpoint");

        let (tagged_hash, untagged_hash) = runtime().block_on(async {
            let blobs = state.store.api().blobs();
            let tagged = blobs
                .add_slice(vec![1u8; 4096])
                .temp_tag()
                .await
                .expect("add tagged");
            let untagged = blobs
                .add_slice(vec![2u8; 4096])
                .temp_tag()
                .await
                .expect("add untagged");
            let tagged_hash = tagged.hash();
            let untagged_hash = untagged.hash();
            state
                .store
                .api()
                .tags()
                .set("keep", tagged.hash_and_format())
                .await
                .expect("set tag");
            // Drop both temp tags: the named tag still protects `tagged`, while
            // `untagged` now has no protection and becomes GC-eligible.
            drop(tagged);
            drop(untagged);
            state.store.api().wait_idle().await.expect("store idle");
            (tagged_hash, untagged_hash)
        });

        // Poll until the loop has run a pass (the untagged blob is reclaimed).
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let (has_tagged, has_untagged) = runtime().block_on(async {
                let blobs = state.store.api().blobs();
                (
                    blobs.has(tagged_hash).await.expect("has tagged"),
                    blobs.has(untagged_hash).await.expect("has untagged"),
                )
            });
            if !has_untagged {
                assert!(has_tagged, "the tagged blob must survive a GC pass");
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "GC did not reclaim the untagged blob within the deadline"
            );
            std::thread::sleep(Duration::from_millis(100));
        }

        close_endpoint_blocking(handle).expect("close succeeded");
    }

    /// GC is OFF by default: a store loaded without a GC config runs no loop, so
    /// an untagged blob is retained forever (today's unchanged semantics).
    #[test]
    fn gc_off_by_default_retains_untagged_blobs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let handle = create_minimal_endpoint(Some(dir.path().join("store")));
        let state = endpoint_state(handle).expect("live endpoint");

        let untagged_hash = runtime().block_on(async {
            let tt = state
                .store
                .api()
                .blobs()
                .add_slice(vec![7u8; 4096])
                .temp_tag()
                .await
                .expect("add untagged");
            let hash = tt.hash();
            drop(tt);
            state.store.api().wait_idle().await.expect("store idle");
            hash
        });

        // No loop can reclaim it; after a delay well past any GC interval it is
        // still present.
        std::thread::sleep(Duration::from_millis(500));
        let present = runtime().block_on(async {
            state
                .store
                .api()
                .blobs()
                .has(untagged_hash)
                .await
                .expect("has untagged")
        });
        assert!(
            present,
            "with GC off the untagged blob must be retained (unchanged semantics)"
        );

        close_endpoint_blocking(handle).expect("close succeeded");
    }
}
