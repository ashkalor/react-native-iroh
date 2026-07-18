//! Blocking wrappers around the callback-based endpoint API, shared by unit
//! tests and integration tests.
//!
//! Not part of the public API: the module is `#[doc(hidden)]` and only public
//! because integration tests (`tests/`) link the library without `cfg(test)`,
//! so a `#[cfg(test)]` module could not be shared with them.

use std::{path::PathBuf, sync::mpsc, time::Duration};

use crate::{
    endpoint::{endpoint_close, endpoint_create, EndpointConfig, EndpointHandle, NetworkProfile},
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

/// Creates an `Isolated`-profile endpoint, panicking on failure.
pub fn create_isolated_endpoint(blob_store_dir: Option<PathBuf>) -> EndpointHandle {
    create_endpoint_blocking(EndpointConfig {
        profile: NetworkProfile::Isolated,
        blob_store_dir,
    })
    .expect("endpoint created")
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
