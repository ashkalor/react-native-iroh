//! Routes the iroh stack's `tracing` output to the host platform's log.
//!
//! Nothing in `tracing` reaches anywhere without a subscriber installed, so
//! until this module is initialized every diagnostic the iroh stack emits about
//! connection attempts, path changes and protocol failures is discarded. That
//! leaves a failed transfer explainable only by the error that surfaces in JS,
//! which is the receiving side's view of a failure that usually originates on
//! the sending side.

use std::sync::Once;

static INIT: Once = Once::new();

/// Per-crate verbosity, as a `tracing` env-filter directive.
///
/// Deliberately narrow. Android caps its log ring buffer at 5 MiB, and
/// `iroh_gossip::net` plus `iroh::_events::path` between them emit enough per
/// second to rotate a whole session out of that buffer before it can be read.
/// A default of `warn` keeps the connection machinery quiet while leaving the
/// blob store, which is where storage panics originate, at full detail.
const FILTER: &str = "warn,iroh_blobs::store=trace,iroh_blobs=debug,iroh_rn_core=debug,iroh::endpoint=info,iroh_rn_core::panic=error";

/// Installs the platform log subscriber and panic reporter, at most once per
/// process.
///
/// Safe and cheap to call from every entry point that might be the first one;
/// subsequent calls are no-ops. It never fails: a subscriber that cannot be
/// installed (because the host process already installed one) is not worth
/// failing an endpoint over.
pub fn init() {
    INIT.call_once(|| {
        install();
        install_panic_reporter();
    });
}

/// Reports panics that would otherwise be swallowed by the task that hit them.
///
/// The iroh stack runs its work in `tokio` tasks and catches their panics, which
/// keeps the process alive but means the payload and location never surface. A
/// panic inside `iroh-blobs`' store, for instance, is reported only as
/// "task failed", and the state it leaves behind then makes every later request
/// panic on a tripwire far from the original fault. This hook records the real
/// site before the unwind starts, and chains to the previous hook so it adds
/// information rather than replacing it.
fn install_panic_reporter() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_owned());
        let thread = std::thread::current();
        tracing::error!(
            target: "iroh_rn_core::panic",
            "PANIC at {location} on thread {:?}: {}\nbacktrace:\n{}",
            thread.name().unwrap_or("<unnamed>"),
            info,
            std::backtrace::Backtrace::force_capture(),
        );
        previous(info);
    }));
}

#[cfg(target_os = "android")]
fn install() {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

    // `paranoid-android` writes through liblog, so entries land in logcat under
    // this tag rather than being swallowed with stdout.
    let _ = fmt()
        .with_writer(paranoid_android::AndroidLogMakeWriter::new(
            "IrohRust".to_owned(),
        ))
        .with_env_filter(EnvFilter::new(FILTER))
        .with_ansi(false)
        .finish()
        .try_init();
}

#[cfg(not(target_os = "android"))]
fn install() {
    use tracing_subscriber::{fmt, util::SubscriberInitExt, EnvFilter};

    // Apple platforms capture a process's stderr into the device log, and it is
    // also the right destination when the core runs under `cargo test`.
    let _ = fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(EnvFilter::new(FILTER))
        .with_ansi(false)
        .finish()
        .try_init();
}
