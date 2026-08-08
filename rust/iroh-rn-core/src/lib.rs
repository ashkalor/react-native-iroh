//! Core Rust library backing the `react-native-iroh` module.
//!
//! Architecture:
//! - **Handle-based object model**: endpoints and transfers live in
//!   process-wide `registry::Registry` instances and are addressed by opaque
//!   `u64` handles; nothing structured crosses the FFI boundary.
//! - **Sync-call + completion-callback surface**: async operations
//!   (create/close/share/download) return immediately and deliver their
//!   result via callbacks run on the shared tokio runtime; cheap queries
//!   (`endpoint_id`, `endpoint_is_open`) and `blob_download_cancel` return
//!   synchronously. The Nitro bridge (`hybrid_iroh`) adapts these callbacks
//!   to JS Promises and event listeners.
//! - **Typed errors**: all failures are [`error::IrohError`] values with
//!   stable numeric codes.
//!
//! The crate is named `Iroh_rust` so cargo emits `libIroh_rust.a`, which the
//! nitrogen-generated CMake links by that exact name.
#![allow(non_snake_case)]
#![warn(missing_docs)]

#[cfg(target_os = "android")]
pub mod android_context;
pub mod blobs;
mod coalesce;
pub mod docs;
pub mod endpoint;
pub mod error;
mod ffi;
pub mod gossip;
mod hybrid_iroh;
pub mod logging;
pub(crate) mod registry;
mod runtime;
pub mod streams;
#[doc(hidden)]
pub mod test_support;

pub use hybrid_iroh::HybridIroh;

/// Validates that `path` is absolute, returning it unchanged.
///
/// `what` names the path's role in the [`error::IrohError::InvalidPath`]
/// message (e.g. `"share path"`, `"blob store dir"`).
pub(crate) fn require_absolute(
    path: std::path::PathBuf,
    what: &str,
) -> error::Result<std::path::PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(error::IrohError::InvalidPath(format!(
            "{what} must be absolute: {}",
            path.display()
        )))
    }
}

/// Runs a host-supplied callback, catching any panic so it can never unwind
/// across the FFI boundary or kill a runtime worker thread.
pub(crate) fn guarded_callback<F: FnOnce()>(f: F) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
        tracing::error!("a host callback panicked; the panic was contained");
    }
}

/// Spawns `work` on the shared runtime and delivers its output to `on_complete`
/// through [`guarded_callback`].
///
/// This is the single shape behind every callback-completed async FFI entry
/// point: the operation runs on a tokio worker (never the JS thread), and its
/// result is handed back through the panic-guarded callback so a panicking host
/// callback can never unwind across the FFI boundary. Synchronous-error paths
/// (a stale handle, a rejected argument) call [`guarded_callback`] directly
/// instead, since they settle without spawning.
pub(crate) fn spawn_completing<O, Fut>(work: Fut, on_complete: impl FnOnce(O) + Send + 'static)
where
    O: Send + 'static,
    Fut: std::future::Future<Output = O> + Send + 'static,
{
    runtime::runtime().spawn(async move {
        let output = work.await;
        guarded_callback(move || on_complete(output));
    });
}
