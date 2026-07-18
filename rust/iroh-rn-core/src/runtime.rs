//! Lazily-initialized multi-thread tokio runtime shared by the whole core.
//!
//! All async work (endpoint binding, blob transfers) runs on this singleton;
//! FFI-facing functions are synchronous and hand results back via completion
//! callbacks executed on runtime worker threads.

use std::sync::LazyLock;

use tokio::runtime::Runtime;

static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .thread_name("iroh-rn")
        .enable_all()
        .build()
        .expect("failed to build tokio runtime")
});

/// Returns the shared runtime, initializing it on first use.
///
/// The first call may panic if the OS refuses to spawn threads; FFI entry
/// points guard against this with `catch_unwind`.
pub(crate) fn runtime() -> &'static Runtime {
    &RUNTIME
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_executes_spawned_work() {
        let (tx, rx) = std::sync::mpsc::channel();
        runtime().spawn(async move {
            tx.send(2 + 2).ok();
        });
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(5)), Ok(4));
    }

    #[test]
    fn runtime_is_a_singleton() {
        let a: *const Runtime = runtime();
        let b: *const Runtime = runtime();
        assert!(std::ptr::eq(a, b));
    }
}
