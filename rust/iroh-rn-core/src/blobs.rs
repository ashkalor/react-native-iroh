//! Blob transfer: share a local file as a ticket, download a ticket to a
//! local file with progress events.
//!
//! Progress reporting is intentionally unthrottled: the core emits one event
//! per progress item from the underlying transfer. The bridge layer is
//! responsible for coalescing events before crossing into JS.

use std::{path::PathBuf, sync::LazyLock, sync::Mutex};

use iroh_blobs::{
    api::{
        blobs::{AddPathOptions, ExportOptions, ImportMode},
        remote::GetProgressItem,
    },
    ticket::BlobTicket,
    BlobFormat,
};
use n0_future::StreamExt;
use tokio::sync::oneshot;

use crate::{
    endpoint::{endpoint_state, EndpointHandle, NetworkProfile},
    error::{IrohError, Result},
    guarded_callback,
    registry::Registry,
    require_absolute,
    runtime::runtime,
};

/// How long [`blob_share`] waits for a `Standard`-profile endpoint to come
/// online (home relay + addresses known) before minting a ticket anyway.
const ONLINE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Opaque handle to an in-flight download. `0` is never a valid handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TransferHandle(u64);

impl TransferHandle {
    /// Reconstructs a handle from its raw FFI representation.
    pub fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    /// The raw numeric value passed across the FFI boundary.
    pub fn raw(self) -> u64 {
        self.0
    }
}

/// A live transfer: holds the trigger that cancels it.
#[derive(Debug)]
struct TransferState {
    cancel: Mutex<Option<oneshot::Sender<()>>>,
}

static TRANSFERS: LazyLock<Registry<TransferState>> = LazyLock::new(Registry::new);

/// Imports the file at `path` into the endpoint's blob store and produces a
/// shareable ticket string via `on_complete`.
///
/// `path` must be absolute. With a persistent blob store the file is
/// referenced in place (no byte copy); an in-memory store must read it.
pub fn blob_share(
    endpoint: EndpointHandle,
    path: PathBuf,
    on_complete: impl FnOnce(Result<String>) + Send + 'static,
) {
    runtime().spawn(async move {
        let result = share_inner(endpoint, path).await;
        guarded_callback(move || on_complete(result));
    });
}

async fn share_inner(endpoint: EndpointHandle, path: PathBuf) -> Result<String> {
    let path = require_absolute(path, "share path")?;
    let state = endpoint_state(endpoint)?;
    // TryReference avoids copying file bytes into a persistent store; stores
    // that cannot reference (in-memory) fall back to reading the file.
    let mode = if state.store.is_persistent() {
        ImportMode::TryReference
    } else {
        ImportMode::Copy
    };
    let import = async {
        state
            .store
            .api()
            .blobs()
            .add_path_with_opts(AddPathOptions {
                path,
                format: BlobFormat::Raw,
                mode,
            })
            .await
            .map_err(|e| IrohError::BlobImport(e.to_string()))
    };
    // On the Standard profile a ticket minted right after bind may not carry
    // dialable addresses yet (no home relay, no confirmed direct addresses).
    // Wait — bounded — for the endpoint to come online; on timeout the ticket
    // is still produced with whatever addresses are known (best effort).
    // Isolated endpoints skip this: their only addresses are the locally bound
    // sockets, which are known immediately.
    let wait_online = async {
        if state.profile == NetworkProfile::Standard {
            let _ = tokio::time::timeout(ONLINE_TIMEOUT, state.endpoint.online()).await;
        }
    };
    // The import and the online wait are independent — overlap them and mint
    // the ticket once both are done.
    let (tag, ()) = tokio::join!(import, wait_online);
    let tag = tag?;
    let ticket = BlobTicket::new(state.endpoint.addr(), tag.hash, tag.format);
    Ok(ticket.to_string())
}

/// Starts downloading the blob described by `ticket` into `dest_path`.
///
/// Returns a [`TransferHandle`] immediately (or an error if the ticket or
/// destination path is invalid). While the transfer runs, `on_progress`
/// receives the cumulative number of payload bytes fetched — values are
/// non-decreasing and unthrottled (the bridge coalesces). `on_complete` fires
/// exactly once with the terminal result, after which the handle is invalid.
pub fn blob_download(
    endpoint: EndpointHandle,
    ticket: &str,
    dest_path: PathBuf,
    on_progress: impl Fn(u64) + Send + Sync + 'static,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) -> Result<TransferHandle> {
    let ticket: BlobTicket = ticket
        .parse()
        .map_err(|e| IrohError::InvalidTicket(format!("{e}")))?;
    let dest_path = require_absolute(dest_path, "destination path")?;

    let (cancel_tx, cancel_rx) = oneshot::channel();
    let handle = TRANSFERS.insert(TransferState {
        cancel: Mutex::new(Some(cancel_tx)),
    });

    runtime().spawn(async move {
        // Running the transfer as its own task turns a panic anywhere inside
        // it into a JoinError instead of a lost completion callback.
        let mut task = runtime().spawn(download_inner(endpoint, ticket, dest_path, on_progress));
        let result = tokio::select! {
            _ = cancel_rx => {
                task.abort();
                Err(IrohError::Cancelled)
            }
            joined = &mut task => match joined {
                Ok(result) => result,
                Err(join_err) => Err(IrohError::Internal(format!("download task failed: {join_err}"))),
            },
        };
        // The handle may already be gone if the caller raced a cancel.
        TRANSFERS.remove(handle).ok();
        guarded_callback(move || on_complete(result));
    });

    Ok(TransferHandle(handle))
}

/// Cancels an in-flight download.
///
/// The transfer's `on_complete` still fires exactly once, with
/// [`IrohError::Cancelled`]. Returns [`IrohError::InvalidHandle`] if the
/// transfer already finished.
pub fn blob_download_cancel(transfer: TransferHandle) -> Result<()> {
    let state = TRANSFERS.get(transfer.raw())?;
    let sender = state
        .cancel
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(sender) = sender {
        // If the transfer just completed, the receiver is gone; that's fine —
        // completion already won the race.
        sender.send(()).ok();
    }
    Ok(())
}

async fn download_inner(
    endpoint: EndpointHandle,
    ticket: BlobTicket,
    dest_path: PathBuf,
    on_progress: impl Fn(u64) + Send + Sync + 'static,
) -> Result<()> {
    let state = endpoint_state(endpoint)?;

    // Dial the provider directly via the addresses in the ticket (plus any
    // address lookup the endpoint's network profile provides).
    let connection = state
        .endpoint
        .connect(ticket.addr().clone(), iroh_blobs::ALPN)
        .await
        .map_err(|e| IrohError::BlobDownload(format!("connect: {e}")))?;

    let mut stream = state
        .store
        .api()
        .remote()
        .fetch(connection, ticket.hash_and_format())
        .stream();
    let mut finished = false;
    while let Some(item) = stream.next().await {
        match item {
            GetProgressItem::Progress(bytes) => {
                guarded_callback(|| on_progress(bytes));
            }
            GetProgressItem::Done(_stats) => {
                finished = true;
            }
            GetProgressItem::Error(e) => {
                return Err(IrohError::BlobDownload(e.to_string()));
            }
        }
    }
    if !finished {
        return Err(IrohError::BlobDownload(
            "transfer stream ended before completion".into(),
        ));
    }

    // Export the verified blob out of the store to the destination path.
    // TryReference lets a persistent store move/reference the file instead of
    // copying the bytes a second time.
    let mode = if state.store.is_persistent() {
        iroh_blobs::api::blobs::ExportMode::TryReference
    } else {
        iroh_blobs::api::blobs::ExportMode::Copy
    };
    state
        .store
        .api()
        .blobs()
        .export_with_opts(ExportOptions {
            hash: ticket.hash(),
            mode,
            target: dest_path,
        })
        .await
        .map_err(|e| IrohError::BlobExport(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        },
        time::Duration,
    };

    use iroh::{EndpointAddr, SecretKey, TransportAddr};
    use iroh_blobs::Hash;

    use super::*;
    use crate::test_support::{close_endpoint_blocking, create_isolated_endpoint, TIMEOUT};

    fn close(handle: EndpointHandle) {
        close_endpoint_blocking(handle).expect("endpoint closed");
    }

    #[test]
    fn download_rejects_garbage_ticket_synchronously() {
        let endpoint = create_isolated_endpoint(None);
        let result = blob_download(
            endpoint,
            "not-a-ticket",
            PathBuf::from("/tmp/never-written"),
            |_| {},
            |_| {},
        );
        assert!(matches!(result, Err(IrohError::InvalidTicket(_))));
        close(endpoint);
    }

    #[test]
    fn share_rejects_relative_path_via_callback() {
        let endpoint = create_isolated_endpoint(None);
        let (tx, rx) = mpsc::channel();
        blob_share(
            endpoint,
            PathBuf::from("relative/file.bin"),
            move |result| {
                tx.send(result).ok();
            },
        );
        assert!(matches!(
            rx.recv_timeout(TIMEOUT).unwrap(),
            Err(IrohError::InvalidPath(_))
        ));
        close(endpoint);
    }

    #[test]
    fn share_on_unknown_endpoint_reports_invalid_handle() {
        let (tx, rx) = mpsc::channel();
        blob_share(
            EndpointHandle::from_raw(u64::MAX),
            PathBuf::from("/tmp/x.bin"),
            move |result| {
                tx.send(result).ok();
            },
        );
        assert!(matches!(
            rx.recv_timeout(TIMEOUT).unwrap(),
            Err(IrohError::InvalidHandle(_))
        ));
    }

    #[test]
    fn cancelled_download_terminates_exactly_once_with_cancelled() {
        let endpoint = create_isolated_endpoint(None);
        // A well-formed ticket pointing at an unreachable peer: the connect
        // stalls, so cancellation is what terminates the transfer.
        let unreachable = SecretKey::from_bytes(&[7u8; 32]).public();
        let addr = EndpointAddr::from_parts(
            unreachable,
            [TransportAddr::Ip("127.0.0.1:1".parse().unwrap())],
        );
        let ticket = BlobTicket::new(addr, Hash::new(b"nothing"), BlobFormat::Raw).to_string();

        let completions = Arc::new(AtomicUsize::new(0));
        let completions_sink = Arc::clone(&completions);
        let (done_tx, done_rx) = mpsc::channel();
        let transfer = blob_download(
            endpoint,
            &ticket,
            PathBuf::from("/tmp/never-written-cancel"),
            |_| {},
            move |result| {
                completions_sink.fetch_add(1, Ordering::SeqCst);
                done_tx.send(result).ok();
            },
        )
        .unwrap();

        blob_download_cancel(transfer).expect("cancel accepted");
        let result = done_rx.recv_timeout(TIMEOUT).expect("terminal event fired");
        assert!(matches!(result, Err(IrohError::Cancelled)));

        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(completions.load(Ordering::SeqCst), 1);
        // The transfer handle is gone now.
        assert!(matches!(
            blob_download_cancel(transfer),
            Err(IrohError::InvalidHandle(_))
        ));
        close(endpoint);
    }
}
