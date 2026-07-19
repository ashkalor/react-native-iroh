//! Endpoint lifecycle: create, query the endpoint id, close.
//!
//! An endpoint owns an [`iroh::Endpoint`], its blob store, and an
//! [`iroh::protocol::Router`] that accepts incoming iroh-blobs connections.
//! Endpoints are addressed by opaque [`EndpointHandle`]s held in a
//! process-wide registry.

use std::{path::PathBuf, sync::Arc, sync::LazyLock, time::Duration};

use iroh::{
    endpoint::presets, protocol::Router, Endpoint, EndpointAddr, RelayMode, RelayUrl,
    TransportAddr, Watcher,
};
use iroh_blobs::{
    store::{fs::FsStore, mem::MemStore},
    BlobsProtocol,
};
use n0_future::{task::AbortOnDropHandle, StreamExt};

use crate::{
    error::{IrohError, Result},
    guarded_callback,
    registry::Registry,
    require_absolute,
    runtime::runtime,
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

/// Configuration for [`endpoint_create`].
#[derive(Debug, Clone, Default)]
pub struct EndpointConfig {
    /// Network infrastructure preset.
    pub preset: NetworkPreset,
    /// Directory for the persistent blob store. `None` keeps blobs in memory
    /// (blobs are lost when the endpoint closes).
    pub blob_store_dir: Option<PathBuf>,
    /// Relay configuration as a delimited string, or `None` to inherit the
    /// preset's default. See [`parse_relay_mode`] for the accepted syntax.
    pub relay_mode: Option<String>,
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

    /// Whether the store persists blobs on the filesystem.
    pub(crate) fn is_persistent(&self) -> bool {
        matches!(self, BlobStore::Fs(_))
    }
}

/// Everything owned by one live endpoint.
#[derive(Debug)]
pub(crate) struct EndpointState {
    pub(crate) endpoint: Endpoint,
    pub(crate) store: BlobStore,
    pub(crate) preset: NetworkPreset,
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
    runtime().spawn(async move {
        let result = create_inner(config).await;
        guarded_callback(move || on_complete(result));
    });
}

async fn create_inner(config: EndpointConfig) -> Result<EndpointHandle> {
    // Validate before doing any work: a relative store dir would silently
    // resolve against an arbitrary process working directory.
    let blob_store_dir = config
        .blob_store_dir
        .map(|dir| require_absolute(dir, "blob store dir"))
        .transpose()?;

    // Parse the relay override before any async work so a bad relay config
    // fails fast, before sockets are bound or the store is touched.
    let relay_mode = parse_relay_mode(config.relay_mode.as_deref())?;
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
    let load_store = async {
        Ok(match blob_store_dir {
            Some(dir) => BlobStore::Fs(
                FsStore::load(dir)
                    .await
                    .map_err(|e| IrohError::EndpointBind(format!("blob store: {e}")))?,
            ),
            None => BlobStore::Mem(MemStore::new()),
        })
    };
    // Socket binding and blob-store loading are independent; run them
    // concurrently and fail fast if either errors.
    let (endpoint, store) = tokio::try_join!(bind, load_store)?;

    let blobs = BlobsProtocol::new(store.api(), None);
    let router = Router::builder(endpoint.clone())
        .accept(iroh_blobs::ALPN, blobs)
        .spawn();

    let handle = ENDPOINTS.insert(EndpointState {
        endpoint,
        store,
        preset: config.preset,
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
    runtime().spawn(async move {
        let result = match tokio::time::timeout(timeout, endpoint.online()).await {
            Ok(()) => Ok(()),
            Err(_elapsed) => Err(IrohError::EndpointBind(format!(
                "endpoint did not come online within {}ms",
                timeout.as_millis()
            ))),
        };
        guarded_callback(move || on_complete(result));
    });
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
    runtime().spawn(async move {
        let result = close_inner(state).await;
        guarded_callback(move || on_complete(result));
    });
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
            relay_mode: None,
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
            relay_mode: Some("disabled".into()),
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
}
