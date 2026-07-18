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
        }
    }
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
}
