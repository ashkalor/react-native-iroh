//! Blocking wrappers around the callback-based endpoint API, shared by unit
//! tests and integration tests.
//!
//! Not part of the public API: the module is `#[doc(hidden)]` and only public
//! because integration tests (`tests/`) link the library without `cfg(test)`,
//! so a `#[cfg(test)]` module could not be shared with them.

use std::{path::PathBuf, sync::mpsc, time::Duration};

use crate::{
    endpoint::{endpoint_close, endpoint_create, EndpointConfig, EndpointHandle, NetworkPreset},
    error::Result,
};

/// How long the helpers wait for a completion callback before panicking.
pub const TIMEOUT: Duration = Duration::from_secs(60);

/// Creates an endpoint, blocking until its completion callback fires.
pub fn create_endpoint_blocking(config: EndpointConfig) -> Result<EndpointHandle> {
    let (tx, rx) = mpsc::channel();
    endpoint_create(config, move |result| {
        tx.send(result).ok();
    });
    rx.recv_timeout(TIMEOUT)
        .expect("endpoint_create completion callback fired")
}

/// Creates a `Minimal`-preset endpoint, panicking on failure.
pub fn create_minimal_endpoint(blob_store_dir: Option<PathBuf>) -> EndpointHandle {
    create_minimal_endpoint_with_alpns(blob_store_dir, Vec::new())
}

/// Creates a `Minimal`-preset endpoint accepting the given custom ALPNs,
/// panicking on failure.
pub fn create_minimal_endpoint_with_alpns(
    blob_store_dir: Option<PathBuf>,
    alpns: Vec<String>,
) -> EndpointHandle {
    create_endpoint_blocking(EndpointConfig {
        preset: NetworkPreset::Minimal,
        blob_store_dir,
        gc: None,
        docs: false,
        docs_store_dir: None,
        discovery_mdns: false,
        relay_mode: None,
        alpns,
    })
    .expect("endpoint created")
}

/// Creates a `Minimal`-preset endpoint with the iroh-docs meta-protocol
/// enabled, backed by `docs_store_dir` (`None` for an in-memory docs store),
/// panicking on failure.
pub fn create_minimal_endpoint_with_docs(docs_store_dir: Option<PathBuf>) -> EndpointHandle {
    create_endpoint_blocking(EndpointConfig {
        preset: NetworkPreset::Minimal,
        blob_store_dir: None,
        gc: None,
        docs: true,
        docs_store_dir,
        discovery_mdns: false,
        relay_mode: None,
        alpns: Vec::new(),
    })
    .expect("endpoint with docs created")
}

/// Creates a `Minimal`-preset endpoint whose store runs the opt-in GC loop at
/// the given interval, backed by `blob_store_dir` (`None` for an in-memory
/// store), panicking on failure.
pub fn create_minimal_endpoint_with_gc(
    blob_store_dir: Option<PathBuf>,
    gc_interval: Duration,
) -> EndpointHandle {
    create_endpoint_blocking(EndpointConfig {
        preset: NetworkPreset::Minimal,
        blob_store_dir,
        gc: Some(crate::endpoint::GcSettings {
            interval: gc_interval,
        }),
        docs: false,
        docs_store_dir: None,
        discovery_mdns: false,
        relay_mode: None,
        alpns: Vec::new(),
    })
    .expect("endpoint with gc created")
}

/// Creates a `Minimal`-preset endpoint with mDNS LAN discovery enabled,
/// panicking on failure. Only compiled with the `mdns` feature.
#[cfg(feature = "mdns")]
pub fn create_minimal_endpoint_with_mdns() -> EndpointHandle {
    create_endpoint_blocking(EndpointConfig {
        preset: NetworkPreset::Minimal,
        blob_store_dir: None,
        gc: None,
        docs: false,
        docs_store_dir: None,
        discovery_mdns: true,
        relay_mode: None,
        alpns: Vec::new(),
    })
    .expect("endpoint with mdns created")
}

/// Closes an endpoint, blocking until shutdown completes.
pub fn close_endpoint_blocking(handle: EndpointHandle) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    endpoint_close(handle, move |result| {
        tx.send(result).ok();
    });
    rx.recv_timeout(TIMEOUT)
        .expect("endpoint_close completion callback fired")
}
