//! Implementation of the nitrogen-generated `HybridIrohSpec` trait.
//!
//! This is the adapter between the typed core API and the Phase-0 bridge
//! surface (`nodeId(): string`). Phase 2 widens the generated trait to the
//! full endpoint/blobs API; the core functions it will call already exist in
//! [`crate::endpoint`] and [`crate::blobs`].

use std::sync::Mutex;

use iroh_rust::hybrid_iroh_spec::HybridIrohSpec;

use crate::{
    endpoint::{endpoint_create, endpoint_node_id, EndpointConfig, EndpointHandle},
    error::IrohError,
};

/// The Rust-backed `Iroh` HybridObject.
///
/// Owns a lazily-created default endpoint (standard network profile,
/// in-memory blob store); the endpoint is created on first use.
pub struct HybridIroh {
    endpoint: Mutex<Option<EndpointHandle>>,
}

impl HybridIroh {
    /// Creates the hybrid object without binding any sockets yet.
    pub fn new() -> Self {
        Self {
            endpoint: Mutex::new(None),
        }
    }

    /// Returns the default endpoint's handle, creating the endpoint on first
    /// call (blocking until the bind completes).
    fn endpoint(&self) -> Result<EndpointHandle, IrohError> {
        let mut slot = self.endpoint.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handle) = *slot {
            return Ok(handle);
        }
        let (tx, rx) = std::sync::mpsc::channel();
        endpoint_create(EndpointConfig::default(), move |result| {
            tx.send(result).ok();
        });
        let handle = rx
            .recv()
            .map_err(|_| IrohError::Internal("endpoint_create callback was dropped".into()))??;
        *slot = Some(handle);
        Ok(handle)
    }
}

impl Default for HybridIroh {
    fn default() -> Self {
        Self::new()
    }
}

/// Formats an [`IrohError`] for the current string-typed bridge boundary as
/// `"[<code>] <message>"`.
fn to_bridge_error(err: IrohError) -> String {
    format!("[{}] {err}", err.code())
}

impl HybridIrohSpec for HybridIroh {
    fn node_id(&self) -> Result<String, String> {
        let handle = self.endpoint().map_err(to_bridge_error)?;
        endpoint_node_id(handle).map_err(to_bridge_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_id_is_a_real_endpoint_id_and_stable() {
        let hybrid = HybridIroh::new();
        let id = hybrid.node_id().expect("node id");
        id.parse::<iroh::EndpointId>()
            .expect("node id parses as an iroh EndpointId");
        // The lazily-created endpoint is reused: the id must not change.
        assert_eq!(hybrid.node_id().unwrap(), id);
    }
}
