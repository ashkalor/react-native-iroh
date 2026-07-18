//! Core Rust library backing the `react-native-iroh` module.
//!
//! Architecture:
//! - **Handle-based object model** — endpoints and transfers live in
//!   process-wide [`registry::Registry`] instances and are addressed by opaque
//!   `u64` handles; nothing structured crosses the FFI boundary.
//! - **Sync-call + completion-callback surface** — every public operation
//!   returns immediately; results arrive via callbacks run on the shared
//!   tokio runtime. The Nitro bridge (Phase 2) adapts these callbacks to JS
//!   Promises/event listeners.
//! - **Typed errors** — all failures are [`error::IrohError`] values with
//!   stable numeric codes.
//!
//! The crate is named `Iroh_rust` so cargo emits `libIroh_rust.a`, which the
//! nitrogen-generated CMake links by that exact name.
#![allow(non_snake_case)]
#![warn(missing_docs)]

pub mod blobs;
pub mod endpoint;
pub mod error;
mod ffi;
mod hybrid_iroh;
pub mod registry;
mod runtime;

pub use hybrid_iroh::HybridIroh;

/// Runs a host-supplied callback, catching any panic so it can never unwind
/// across the FFI boundary or kill a runtime worker thread.
pub(crate) fn guarded_callback<F: FnOnce()>(f: F) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
        tracing::error!("a host callback panicked; the panic was contained");
    }
}
