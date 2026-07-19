//! Implementation of the nitrogen-generated `HybridIrohSpec` trait.
//!
//! This is the adapter between the typed core API (callback-based, typed
//! errors) and the generated bridge surface. Promise-returning methods are
//! callback-completed: each takes a `promise` completer (a boxed `FnOnce`)
//! that the C++ bridge wires to `Promise::resolve`/`reject`, and returns `()`
//! immediately. The completer is fired from the core's completion callback,
//! which runs on a tokio worker (never blocking the JS thread), so there is no
//! native thread-pool concurrency cap.
//!
//! Responsibilities:
//! - forward the core's completion callbacks into the generated completer,
//!   mapping success and both error kinds (typed error, dropped callback);
//! - encode [`IrohError`]s as `"[iroh:<code>] <message>"` strings so JS can
//!   recover the stable numeric code with a regex;
//! - coalesce progress callbacks to at most ~30 events/second before they
//!   cross into JS (see [`crate::coalesce`]).

use std::{path::PathBuf, sync::Arc, sync::Mutex, time::Duration};

use iroh_rust::{
    endpoint_config::EndpointConfig as BridgeEndpointConfig, hybrid_iroh_spec::HybridIrohSpec,
    network_preset::NetworkPreset as BridgeNetworkPreset,
};

use crate::{
    blobs::{blob_download, blob_download_cancel, blob_share, TransferHandle},
    coalesce::Coalescer,
    endpoint::{
        endpoint_close, endpoint_create, endpoint_id, endpoint_is_open, EndpointConfig,
        EndpointHandle, NetworkPreset,
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
    /// Creates the hybrid object. Cheap: no sockets, no threads.
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
/// `"[iroh:<code>] <message>"`, the one format JS parses (`/\[iroh:(\d+)\]/`).
fn encode_error(err: IrohError) -> String {
    format!("[iroh:{}] {err}", err.code())
}

/// The completer a Promise-returning trait method receives: settles the JS
/// Promise exactly once with the bridge-encoded result.
type Completer<T> = Box<dyn FnOnce(Result<T, String>) + Send>;

impl HybridIrohSpec for HybridIroh {
    fn create_endpoint(&self, config: BridgeEndpointConfig, promise: Completer<f64>) {
        let preset = match config.preset {
            BridgeNetworkPreset::N0 => NetworkPreset::N0,
            BridgeNetworkPreset::Minimal => NetworkPreset::Minimal,
        };
        // Path validation (absolute blob store dir) happens in the core.
        let blob_store_dir = config.blob_store_dir.map(PathBuf::from);
        endpoint_create(
            EndpointConfig {
                preset,
                blob_store_dir,
            },
            move |result| {
                promise(
                    result
                        .map(|handle| handle.raw() as f64)
                        .map_err(encode_error),
                );
            },
        );
    }

    fn endpoint_id(&self, endpoint: f64) -> Result<String, String> {
        endpoint_id(EndpointHandle::from_raw(endpoint as u64)).map_err(encode_error)
    }

    fn is_endpoint_open(&self, endpoint: f64) -> Result<bool, String> {
        Ok(endpoint_is_open(EndpointHandle::from_raw(endpoint as u64)))
    }

    fn close_endpoint(&self, endpoint: f64, promise: Completer<()>) {
        endpoint_close(EndpointHandle::from_raw(endpoint as u64), move |result| {
            promise(result.map_err(encode_error));
        });
    }

    fn share_blob(&self, endpoint: f64, path: String, promise: Completer<String>) {
        blob_share(
            EndpointHandle::from_raw(endpoint as u64),
            PathBuf::from(path),
            move |result| {
                promise(result.map_err(encode_error));
            },
        );
    }

    fn download_blob(
        &self,
        endpoint: f64,
        ticket: String,
        dest_path: String,
        on_start: Box<dyn Fn(f64) + Send + Sync>,
        on_progress: Box<dyn Fn(f64) + Send + Sync>,
        promise: Completer<()>,
    ) {
        // Coalesce native-side; the sink forwards into the JS callback. The
        // completion closure flushes the newest suppressed value so the last
        // progress state always reaches JS before the Promise settles.
        let coalescer = Arc::new(Coalescer::new(PROGRESS_MIN_INTERVAL, move |bytes| {
            on_progress(bytes as f64)
        }));
        let progress = Arc::clone(&coalescer);
        // The completer must be reachable from both the async completion path
        // and the synchronous-error path (invalid ticket / destination). Share
        // it via a guarded Option so exactly one path consumes it.
        let promise = Arc::new(Mutex::new(Some(promise)));
        let promise_async = Arc::clone(&promise);
        let started = blob_download(
            EndpointHandle::from_raw(endpoint as u64),
            &ticket,
            PathBuf::from(dest_path),
            move |bytes| progress.offer(bytes),
            move |result| {
                coalescer.flush();
                if let Some(complete) = promise_async
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take()
                {
                    complete(result.map_err(encode_error));
                }
            },
        );
        match started {
            Ok(transfer) => on_start(transfer.raw() as f64),
            Err(err) => {
                if let Some(complete) = promise.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    complete(Err(encode_error(err)));
                }
            }
        }
    }

    fn cancel_download(&self, transfer_id: f64) -> Result<(), String> {
        // Idempotent: cancelling a finished or unknown transfer is a no-op:
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
        mpsc, Mutex,
    };

    use super::*;

    /// Drives a Promise-returning trait method to completion by blocking on its
    /// completer. Test-only: production callers never block, they let the
    /// completer settle the JS Promise on a tokio worker.
    fn block_on<T: Send + 'static>(start: impl FnOnce(Completer<T>)) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        start(Box::new(move |result| {
            tx.send(result).ok();
        }));
        rx.recv()
            .unwrap_or_else(|_| Err("completer was dropped without firing".into()))
    }

    fn create_minimal(hybrid: &HybridIroh, store_dir: Option<&std::path::Path>) -> f64 {
        block_on(|done| {
            hybrid.create_endpoint(
                BridgeEndpointConfig {
                    preset: BridgeNetworkPreset::Minimal,
                    blob_store_dir: store_dir.map(|p| p.to_string_lossy().into_owned()),
                },
                done,
            )
        })
        .expect("endpoint created")
    }

    #[test]
    fn endpoint_lifecycle_via_trait() {
        let hybrid = HybridIroh::new();
        let endpoint = create_minimal(&hybrid, None);
        assert!(endpoint >= 1.0);

        let id = hybrid.endpoint_id(endpoint).expect("endpoint id");
        id.parse::<iroh::EndpointId>()
            .expect("endpoint id parses as an iroh EndpointId");
        assert_eq!(hybrid.is_endpoint_open(endpoint), Ok(true));

        block_on(|done| hybrid.close_endpoint(endpoint, done)).expect("close succeeded");
        assert_eq!(hybrid.is_endpoint_open(endpoint), Ok(false));
        let err = hybrid.endpoint_id(endpoint).unwrap_err();
        assert!(err.starts_with("[iroh:1001] "), "unexpected error: {err}");
    }

    #[test]
    fn create_endpoint_rejects_relative_blob_store_dir() {
        let hybrid = HybridIroh::new();
        let err = block_on(|done| {
            hybrid.create_endpoint(
                BridgeEndpointConfig {
                    preset: BridgeNetworkPreset::Minimal,
                    blob_store_dir: Some("relative/store".into()),
                },
                done,
            )
        })
        .unwrap_err();
        assert!(err.starts_with("[iroh:1003] "), "unexpected error: {err}");
    }

    #[test]
    fn download_with_garbage_ticket_reports_invalid_ticket_code() {
        let hybrid = HybridIroh::new();
        let endpoint = create_minimal(&hybrid, None);
        let err = block_on(|done| {
            hybrid.download_blob(
                endpoint,
                "garbage-ticket".into(),
                "/tmp/never-written-hybrid".into(),
                Box::new(|_| {}),
                Box::new(|_| {}),
                done,
            )
        })
        .unwrap_err();
        assert!(err.starts_with("[iroh:1002] "), "unexpected error: {err}");
        block_on(|done| hybrid.close_endpoint(endpoint, done)).unwrap();
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
        let provider = create_minimal(&hybrid, Some(&dir.path().join("provider-store")));
        let receiver = create_minimal(&hybrid, Some(&dir.path().join("receiver-store")));

        let ticket = block_on(|done| {
            hybrid.share_blob(provider, src_path.to_string_lossy().into_owned(), done)
        })
        .expect("share produced a ticket");

        let dest_path = dir.path().join("downloaded.bin");
        let started = Arc::new(Mutex::new(None::<f64>));
        let started_sink = Arc::clone(&started);
        let progress_events = Arc::new(AtomicUsize::new(0));
        let progress_sink = Arc::clone(&progress_events);
        block_on(|done| {
            hybrid.download_blob(
                receiver,
                ticket.clone(),
                dest_path.to_string_lossy().into_owned(),
                Box::new(move |id| {
                    *started_sink.lock().unwrap() = Some(id);
                }),
                Box::new(move |_bytes| {
                    progress_sink.fetch_add(1, Ordering::SeqCst);
                }),
                done,
            )
        })
        .expect("download succeeded");

        let transfer_id = started.lock().unwrap().expect("on_start fired");
        assert!(transfer_id >= 1.0);
        assert!(progress_events.load(Ordering::SeqCst) >= 1);
        assert_eq!(std::fs::read(&dest_path).unwrap(), bytes);

        // Cancelling after completion is a no-op.
        assert_eq!(hybrid.cancel_download(transfer_id), Ok(()));

        // Re-sharing the downloaded file on the *same* provider endpoint must
        // reproduce the identical ticket (same addresses, same content hash).
        // This is the string-side integrity check the example app relies on.
        let ticket2 = block_on(|done| {
            hybrid.share_blob(provider, dest_path.to_string_lossy().into_owned(), done)
        })
        .expect("re-share produced a ticket");
        assert_eq!(ticket, ticket2);

        block_on(|done| hybrid.close_endpoint(provider, done)).unwrap();
        block_on(|done| hybrid.close_endpoint(receiver, done)).unwrap();
    }
}
