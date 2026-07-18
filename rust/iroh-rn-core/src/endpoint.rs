//! Endpoint lifecycle: create, query the node id, close.
//!
//! An endpoint owns an [`iroh::Endpoint`], its blob store, and an
//! [`iroh::protocol::Router`] that accepts incoming iroh-blobs connections.
//! Endpoints are addressed by opaque [`EndpointHandle`]s held in a
//! process-wide registry.

use std::{path::PathBuf, sync::Arc, sync::LazyLock};

use iroh::{endpoint::presets, protocol::Router, Endpoint};
use iroh_blobs::{
    store::{fs::FsStore, mem::MemStore},
    BlobsProtocol,
};

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

/// Which network infrastructure the endpoint uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NetworkProfile {
    /// Production default: n0 relay servers and address lookup services.
    #[default]
    Standard,
    /// No relays, no address lookup. Peers are only reachable through direct
    /// addresses embedded in tickets. Used for tests and LAN-only setups.
    Isolated,
}

/// Configuration for [`endpoint_create`].
#[derive(Debug, Clone, Default)]
pub struct EndpointConfig {
    /// Network infrastructure profile.
    pub profile: NetworkProfile,
    /// Directory for the persistent blob store. `None` keeps blobs in memory
    /// (blobs are lost when the endpoint closes).
    pub blob_store_dir: Option<PathBuf>,
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
    pub(crate) profile: NetworkProfile,
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

    let bind = async {
        match config.profile {
            NetworkProfile::Standard => Endpoint::bind(presets::N0).await,
            // `Minimal` sets only the mandatory crypto provider: relays stay
            // disabled and no address lookup services are configured.
            NetworkProfile::Isolated => Endpoint::bind(presets::Minimal).await,
        }
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
        profile: config.profile,
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

/// Returns the endpoint's node id (its public key) as a string.
///
/// Cheap and synchronous: no network involved.
pub fn endpoint_node_id(handle: EndpointHandle) -> Result<String> {
    Ok(endpoint_state(handle)?.endpoint.id().to_string())
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
        close_endpoint_blocking, create_endpoint_blocking, create_isolated_endpoint,
    };

    #[test]
    fn create_isolated_endpoint_yields_valid_node_id() {
        let handle = create_isolated_endpoint(None);

        let node_id = endpoint_node_id(handle).expect("node id");
        node_id
            .parse::<iroh::EndpointId>()
            .expect("node id is a valid iroh EndpointId");

        close_endpoint_blocking(handle).expect("close succeeded");
    }

    #[test]
    fn create_rejects_relative_blob_store_dir() {
        let result = create_endpoint_blocking(EndpointConfig {
            profile: NetworkProfile::Isolated,
            blob_store_dir: Some(PathBuf::from("relative/store")),
        });
        assert!(matches!(result, Err(IrohError::InvalidPath(_))));
    }

    #[test]
    fn closed_handle_becomes_invalid() {
        let handle = create_isolated_endpoint(None);

        close_endpoint_blocking(handle).expect("close succeeded");

        assert!(matches!(
            endpoint_node_id(handle),
            Err(IrohError::InvalidHandle(_))
        ));
        // Double close reports InvalidHandle through the callback.
        assert!(matches!(
            close_endpoint_blocking(handle),
            Err(IrohError::InvalidHandle(_))
        ));
    }

    #[test]
    fn node_id_on_unknown_handle_is_invalid_handle() {
        assert!(matches!(
            endpoint_node_id(EndpointHandle::from_raw(u64::MAX)),
            Err(IrohError::InvalidHandle(_))
        ));
    }
}
