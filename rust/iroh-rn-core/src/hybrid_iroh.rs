//! Implementation of the nitrogen-generated `HybridIrohSpec` trait.
//!
//! This is the adapter between the typed core API (callback-based, typed
//! errors) and the generated bridge surface (blocking methods returning
//! `Result<T, String>`, executed by the C++ side on Nitro's thread pool and
//! surfaced to JS as Promises).
//!
//! Responsibilities:
//! - block on the core's completion callbacks (the calling thread is a Nitro
//!   pool worker, never the JS thread);
//! - encode [`IrohError`]s as `"[iroh:<code>] <message>"` strings so JS can
//!   recover the stable numeric code with a regex;
//! - coalesce progress callbacks to at most ~30 events/second before they
//!   cross into JS (see [`crate::coalesce`]).

use std::{path::PathBuf, sync::mpsc, sync::Arc, time::Duration};

use iroh_rust::{
    endpoint_config::EndpointConfig as BridgeEndpointConfig, hybrid_iroh_spec::HybridIrohSpec,
    network_profile::NetworkProfile as BridgeNetworkProfile,
};

use crate::{
    blobs::{blob_download, blob_download_cancel, blob_share, TransferHandle},
    coalesce::Coalescer,
    endpoint::{
        endpoint_close, endpoint_create, endpoint_is_open, endpoint_node_id, EndpointConfig,
        EndpointHandle, NetworkProfile,
    },
    error::IrohError,
};

/// Minimum spacing between progress events crossing into JS: 34ms keeps the
/// rate strictly at or below ~30 events/second per transfer.
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(34);

/// The Rust-backed `Iroh` HybridObject. Stateless: all state lives in the
/// process-wide endpoint/transfer registries, addressed by numeric handles.
pub struct HybridIroh;

impl HybridIroh {
    /// Creates the hybrid object. Cheap — no sockets, no threads.
    pub fn new() -> Self {
        Self
    }
}

impl Default for HybridIroh {
    fn default() -> Self {
        Self::new()
    }
}

/// Encodes an [`IrohError`] for the bridge boundary as
/// `"[iroh:<code>] <message>"` — the one format JS parses (`/\[iroh:(\d+)\]/`).
fn encode_error(err: IrohError) -> String {
    format!("[iroh:{}] {err}", err.code())
}

/// Blocks until the core's completion callback delivers a result, mapping
/// both the error and a dropped-callback failure to the bridge encoding.
fn wait_for<T>(rx: mpsc::Receiver<crate::error::Result<T>>) -> Result<T, String> {
    rx.recv()
        .map_err(|_| {
            encode_error(IrohError::Internal(
                "completion callback was dropped".into(),
            ))
        })?
        .map_err(encode_error)
}

impl HybridIrohSpec for HybridIroh {
    fn create_endpoint(&self, config: BridgeEndpointConfig) -> Result<f64, String> {
        let profile = match config.profile {
            BridgeNetworkProfile::Standard => NetworkProfile::Standard,
            BridgeNetworkProfile::Isolated => NetworkProfile::Isolated,
        };
        let blob_store_dir = match config.blob_store_dir {
            Some(dir) => {
                let dir = PathBuf::from(dir);
                if !dir.is_absolute() {
                    return Err(encode_error(IrohError::InvalidPath(format!(
                        "blob store dir must be absolute: {}",
                        dir.display()
                    ))));
                }
                Some(dir)
            }
            None => None,
        };
        let (tx, rx) = mpsc::channel();
        endpoint_create(
            EndpointConfig {
                profile,
                blob_store_dir,
            },
            move |result| {
                tx.send(result).ok();
            },
        );
        wait_for(rx).map(|handle| handle.raw() as f64)
    }

    fn node_id(&self, endpoint: f64) -> Result<String, String> {
        endpoint_node_id(EndpointHandle::from_raw(endpoint as u64)).map_err(encode_error)
    }

    fn is_endpoint_open(&self, endpoint: f64) -> Result<bool, String> {
        Ok(endpoint_is_open(EndpointHandle::from_raw(endpoint as u64)))
    }

    fn close_endpoint(&self, endpoint: f64) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        endpoint_close(EndpointHandle::from_raw(endpoint as u64), move |result| {
            tx.send(result).ok();
        });
        wait_for(rx)
    }

    fn share_blob(&self, endpoint: f64, path: String) -> Result<String, String> {
        let (tx, rx) = mpsc::channel();
        blob_share(
            EndpointHandle::from_raw(endpoint as u64),
            PathBuf::from(path),
            move |result| {
                tx.send(result).ok();
            },
        );
        wait_for(rx)
    }

    fn download_blob(
        &self,
        endpoint: f64,
        ticket: String,
        dest_path: String,
        on_start: Box<dyn Fn(f64) + Send + Sync>,
        on_progress: Box<dyn Fn(f64) + Send + Sync>,
    ) -> Result<(), String> {
        // Coalesce native-side; the sink forwards into the JS callback. The
        // completion closure flushes the newest suppressed value so the last
        // progress state always reaches JS before the Promise settles.
        let coalescer = Arc::new(Coalescer::new(PROGRESS_MIN_INTERVAL, move |bytes| {
            on_progress(bytes as f64)
        }));
        let progress = Arc::clone(&coalescer);
        let (tx, rx) = mpsc::channel();
        let transfer = blob_download(
            EndpointHandle::from_raw(endpoint as u64),
            &ticket,
            PathBuf::from(dest_path),
            move |bytes| progress.offer(bytes),
            move |result| {
                coalescer.flush();
                tx.send(result).ok();
            },
        )
        .map_err(encode_error)?;
        on_start(transfer.raw() as f64);
        wait_for(rx)
    }

    fn cancel_download(&self, transfer_id: f64) -> Result<(), String> {
        // Idempotent: cancelling a finished or unknown transfer is a no-op —
        // completion already won the race, which is indistinguishable (and
        // harmless) from the caller's point of view.
        match blob_download_cancel(TransferHandle::from_raw(transfer_id as u64)) {
            Ok(()) | Err(IrohError::InvalidHandle(_)) => Ok(()),
            Err(err) => Err(encode_error(err)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };

    use super::*;

    fn create_isolated(hybrid: &HybridIroh, store_dir: Option<&std::path::Path>) -> f64 {
        hybrid
            .create_endpoint(BridgeEndpointConfig {
                profile: BridgeNetworkProfile::Isolated,
                blob_store_dir: store_dir.map(|p| p.to_string_lossy().into_owned()),
            })
            .expect("endpoint created")
    }

    #[test]
    fn endpoint_lifecycle_via_trait() {
        let hybrid = HybridIroh::new();
        let endpoint = create_isolated(&hybrid, None);
        assert!(endpoint >= 1.0);

        let id = hybrid.node_id(endpoint).expect("node id");
        id.parse::<iroh::EndpointId>()
            .expect("node id parses as an iroh EndpointId");
        assert_eq!(hybrid.is_endpoint_open(endpoint), Ok(true));

        hybrid.close_endpoint(endpoint).expect("close succeeded");
        assert_eq!(hybrid.is_endpoint_open(endpoint), Ok(false));
        let err = hybrid.node_id(endpoint).unwrap_err();
        assert!(err.starts_with("[iroh:1001] "), "unexpected error: {err}");
    }

    #[test]
    fn create_endpoint_rejects_relative_blob_store_dir() {
        let hybrid = HybridIroh::new();
        let err = hybrid
            .create_endpoint(BridgeEndpointConfig {
                profile: BridgeNetworkProfile::Isolated,
                blob_store_dir: Some("relative/store".into()),
            })
            .unwrap_err();
        assert!(err.starts_with("[iroh:1003] "), "unexpected error: {err}");
    }

    #[test]
    fn download_with_garbage_ticket_reports_invalid_ticket_code() {
        let hybrid = HybridIroh::new();
        let endpoint = create_isolated(&hybrid, None);
        let err = hybrid
            .download_blob(
                endpoint,
                "garbage-ticket".into(),
                "/tmp/never-written-hybrid".into(),
                Box::new(|_| {}),
                Box::new(|_| {}),
            )
            .unwrap_err();
        assert!(err.starts_with("[iroh:1002] "), "unexpected error: {err}");
        hybrid.close_endpoint(endpoint).unwrap();
    }

    #[test]
    fn cancel_download_is_idempotent_for_unknown_transfers() {
        let hybrid = HybridIroh::new();
        assert_eq!(hybrid.cancel_download(987654321.0), Ok(()));
    }

    #[test]
    fn loopback_transfer_via_trait_with_progress_and_ticket_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src_path = dir.path().join("payload.bin");
        let bytes: Vec<u8> = (0..2u32 * 1024 * 1024)
            .map(|i| (i.wrapping_mul(2654435761) >> 24) as u8)
            .collect();
        std::fs::write(&src_path, &bytes).expect("write payload");

        let hybrid = HybridIroh::new();
        let provider = create_isolated(&hybrid, Some(&dir.path().join("provider-store")));
        let receiver = create_isolated(&hybrid, Some(&dir.path().join("receiver-store")));

        let ticket = hybrid
            .share_blob(provider, src_path.to_string_lossy().into_owned())
            .expect("share produced a ticket");

        let dest_path = dir.path().join("downloaded.bin");
        let started = Arc::new(Mutex::new(None::<f64>));
        let started_sink = Arc::clone(&started);
        let progress_events = Arc::new(AtomicUsize::new(0));
        let progress_sink = Arc::clone(&progress_events);
        hybrid
            .download_blob(
                receiver,
                ticket.clone(),
                dest_path.to_string_lossy().into_owned(),
                Box::new(move |id| {
                    *started_sink.lock().unwrap() = Some(id);
                }),
                Box::new(move |_bytes| {
                    progress_sink.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .expect("download succeeded");

        let transfer_id = started.lock().unwrap().expect("on_start fired");
        assert!(transfer_id >= 1.0);
        assert!(progress_events.load(Ordering::SeqCst) >= 1);
        assert_eq!(std::fs::read(&dest_path).unwrap(), bytes);

        // Cancelling after completion is a no-op.
        assert_eq!(hybrid.cancel_download(transfer_id), Ok(()));

        // Re-sharing the downloaded file on the *same* provider endpoint must
        // reproduce the identical ticket (same addresses, same content hash) —
        // this is the string-side integrity check the example app relies on.
        let ticket2 = hybrid
            .share_blob(provider, dest_path.to_string_lossy().into_owned())
            .expect("re-share produced a ticket");
        assert_eq!(ticket, ticket2);

        hybrid.close_endpoint(provider).unwrap();
        hybrid.close_endpoint(receiver).unwrap();
    }
}
