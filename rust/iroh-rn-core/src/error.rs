//! Typed error taxonomy for the react-native-iroh core.
//!
//! Every fallible core operation returns [`IrohError`]. Each variant maps to a
//! stable numeric [`code`](IrohError::code) so the FFI bridge can expose a
//! `(code, message)` pair to JavaScript without string matching.

/// The result type used throughout the core crate.
pub type Result<T> = std::result::Result<T, IrohError>;

/// All errors the react-native-iroh core can produce.
///
/// The numeric codes returned by [`IrohError::code`] are part of the public
/// FFI contract: they are stable, append-only, and never reused. Ranges:
///
/// | range | domain |
/// |-------|-----------------------------|
/// | 1xxx  | generic / infrastructure |
/// | 2xxx  | endpoint lifecycle |
/// | 3xxx  | blob transfer |
/// | 4xxx  | gossip |
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum IrohError {
    /// Unexpected internal failure (bug, panicked task, runtime failure).
    #[error("internal error: {0}")]
    Internal(String),
    /// The handle does not refer to a live object in the registry.
    #[error("invalid or stale handle: {0}")]
    InvalidHandle(u64),
    /// A blob ticket string failed to parse.
    #[error("invalid blob ticket: {0}")]
    InvalidTicket(String),
    /// A supplied filesystem path is unusable (e.g. not absolute).
    #[error("invalid path: {0}")]
    InvalidPath(String),
    /// Creating an endpoint (binding sockets, loading the blob store) failed.
    #[error("failed to create endpoint: {0}")]
    EndpointBind(String),
    /// Importing a local file into the blob store failed.
    #[error("failed to share blob: {0}")]
    BlobImport(String),
    /// Connecting to the provider or fetching blob bytes failed.
    #[error("failed to download blob: {0}")]
    BlobDownload(String),
    /// Exporting a downloaded blob to its destination path failed.
    #[error("failed to export blob: {0}")]
    BlobExport(String),
    /// The transfer was cancelled by the caller.
    #[error("transfer cancelled")]
    Cancelled,
    /// Subscribing to a gossip topic failed (bad bootstrap address, or the
    /// gossip actor could not join the topic).
    #[error("failed to subscribe to gossip topic: {0}")]
    GossipSubscribe(String),
    /// Broadcasting a message to a gossip topic failed.
    #[error("failed to broadcast gossip message: {0}")]
    GossipBroadcast(String),
    /// A gossip payload exceeded the topic's maximum message size.
    #[error("gossip message too large: {0}")]
    GossipMessageTooLarge(String),
}

impl IrohError {
    /// Stable numeric error code for this error, for use across the FFI
    /// boundary.
    ///
    /// Codes are append-only and never reused; JS/TS relies on these exact
    /// values.
    pub fn code(&self) -> u32 {
        match self {
            IrohError::Internal(_) => 1000,
            IrohError::InvalidHandle(_) => 1001,
            IrohError::InvalidTicket(_) => 1002,
            IrohError::InvalidPath(_) => 1003,
            IrohError::EndpointBind(_) => 2000,
            IrohError::BlobImport(_) => 3000,
            IrohError::BlobDownload(_) => 3001,
            IrohError::BlobExport(_) => 3002,
            IrohError::Cancelled => 3003,
            IrohError::GossipSubscribe(_) => 4000,
            IrohError::GossipBroadcast(_) => 4001,
            IrohError::GossipMessageTooLarge(_) => 4002,
        }
    }
}

/// Renders `error` together with its whole `source` chain, joined by `": "`.
///
/// Several of the errors this crate wraps carry the useful part in `source`
/// rather than in `Display`. `iroh_blobs::get::error::GetError::LocalFailure`
/// is the worst case: it renders as the bare string `"local failure"` and the
/// actual cause is only reachable through `source`, so formatting it with
/// `{e}` alone discards the one detail a caller needs. Everything that crosses
/// the FFI boundary as a message string should go through this.
pub fn error_chain(error: &dyn std::error::Error) -> String {
    let mut rendered = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        // `#[error(transparent)]` wrappers repeat their source verbatim; adding
        // the same sentence twice reads like two distinct failures.
        if !rendered.ends_with(&text) {
            rendered.push_str(": ");
            rendered.push_str(&text);
        }
        source = cause.source();
    }
    rendered
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The FFI contract: these exact codes are stable. If this test fails,
    /// a code was changed or reused (both are breaking changes).
    #[test]
    fn error_codes_are_stable() {
        let cases: Vec<(IrohError, u32)> = vec![
            (IrohError::Internal("x".into()), 1000),
            (IrohError::InvalidHandle(7), 1001),
            (IrohError::InvalidTicket("x".into()), 1002),
            (IrohError::InvalidPath("x".into()), 1003),
            (IrohError::EndpointBind("x".into()), 2000),
            (IrohError::BlobImport("x".into()), 3000),
            (IrohError::BlobDownload("x".into()), 3001),
            (IrohError::BlobExport("x".into()), 3002),
            (IrohError::Cancelled, 3003),
            (IrohError::GossipSubscribe("x".into()), 4000),
            (IrohError::GossipBroadcast("x".into()), 4001),
            (IrohError::GossipMessageTooLarge("x".into()), 4002),
        ];
        for (err, code) in cases {
            assert_eq!(err.code(), code, "code changed for {err:?}");
        }
    }

    #[test]
    fn messages_carry_context() {
        let err = IrohError::InvalidTicket("bad base32".into());
        assert_eq!(err.to_string(), "invalid blob ticket: bad base32");
        let err = IrohError::InvalidHandle(42);
        assert_eq!(err.to_string(), "invalid or stale handle: 42");
    }

    #[derive(Debug, thiserror::Error)]
    #[error("outer")]
    struct Outer {
        source: Middle,
    }

    #[derive(Debug, thiserror::Error)]
    #[error("middle")]
    struct Middle {
        source: std::io::Error,
    }

    #[test]
    fn error_chain_appends_every_source() {
        let err = Outer {
            source: Middle {
                source: std::io::Error::new(std::io::ErrorKind::PermissionDenied, "disk on fire"),
            },
        };
        assert_eq!(error_chain(&err), "outer: middle: disk on fire");
    }

    #[test]
    fn error_chain_keeps_a_sourceless_error_intact() {
        let err = std::io::Error::other("standalone");
        assert_eq!(error_chain(&err), "standalone");
    }

    /// A `#[error(transparent)]` wrapper renders exactly as its source, so
    /// naively appending would print the same sentence twice.
    #[test]
    fn error_chain_does_not_repeat_a_transparent_wrapper() {
        #[derive(Debug, thiserror::Error)]
        #[error(transparent)]
        struct Transparent {
            source: std::io::Error,
        }

        let err = Transparent {
            source: std::io::Error::other("only once"),
        };
        assert_eq!(error_chain(&err), "only once");
    }

    /// The case this exists for: an error whose `Display` hides the cause
    /// entirely, as `iroh_blobs`' `GetError::LocalFailure` does.
    #[test]
    fn error_chain_recovers_a_cause_hidden_behind_an_opaque_display() {
        #[derive(Debug, thiserror::Error)]
        #[error("local failure")]
        struct Opaque {
            source: std::io::Error,
        }

        let err = Opaque {
            source: std::io::Error::other("store write refused"),
        };
        assert_eq!(err.to_string(), "local failure");
        assert_eq!(error_chain(&err), "local failure: store write refused");
    }
}
