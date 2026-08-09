//! Raw QUIC streams over caller-chosen ALPNs.
//!
//! This is the escape hatch out of the protocols this crate implements for you
//! ([`crate::blobs`], [`crate::gossip`]) and into iroh's transport itself: a
//! host declares its own ALPN, accepts or dials connections on it, and moves
//! bytes over bidirectional streams.
//!
//! Three handle types layer onto one another, each an entry in a process-wide
//! [`Registry`]: a [`ListenerHandle`] delivers inbound [`ConnectionHandle`]s,
//! and a connection carries [`StreamHandle`]s in both directions.
//!
//! ALPNs cannot be added after the fact: [`iroh::protocol::Router`] fixes its
//! ALPN set when it spawns, so the set is taken from [`crate::endpoint::EndpointConfig`]
//! and [`stream_listen`] only attaches to a name already declared there.
//!
//! Reading never starts on its own. A connection accepts no streams until
//! [`stream_connection_subscribe`], and a stream reads no bytes until
//! [`stream_subscribe`], so a host that registers its callbacks immediately
//! after receiving a handle cannot miss anything, and an unconsumed stream
//! backpressures the peer through QUIC's own flow control.

use std::sync::{Arc, LazyLock, Mutex};

use iroh::{
    endpoint::{
        Connection, ConnectionError, ReadError, ReadExactError, RecvStream, SendStream, VarInt,
        WriteError,
    },
    protocol::{AcceptError, ProtocolHandler},
    EndpointId,
};
use n0_future::task::AbortOnDropHandle;
use tokio::sync::mpsc;

use crate::{
    endpoint::{endpoint_state, parse_endpoint_addr, EndpointHandle},
    error::{IrohError, Result},
    guarded_callback,
    registry::Registry,
    runtime::runtime,
    spawn_completing,
};

/// The largest payload [`stream_send`] accepts under [`Framing::Framed`], and
/// the largest frame a reader will assemble, in bytes.
///
/// The length prefix is attacker-controlled on the read side, so it is bounded
/// before any buffer is allocated. 16 MiB is far above any plausible control
/// message and far below what would let one peer exhaust a phone's memory.
/// Protocols that need more should use [`Framing::Raw`] and frame themselves.
pub const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;

/// How many bytes an unframed read asks QUIC for at a time.
const RAW_READ_CHUNK: usize = 64 * 1024;

/// How many accepted connections wait for a listener before further attempts
/// are refused. A refused connection is a clear signal to the peer; an
/// unbounded queue would instead let one peer pin memory on the device.
const INBOUND_BACKLOG: usize = 64;

/// QUIC application error code used when closing a connection.
const CLOSE_CODE: u32 = 0;

/// How a stream splits its byte stream into the chunks the host sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Framing {
    /// Each send is written as a big-endian `u32` length followed by the
    /// payload, and reads reassemble whole frames: one send, one chunk.
    #[default]
    Framed,
    /// Bytes are written and delivered verbatim, with no message boundaries.
    Raw,
}

/// Opaque handle to a live ALPN listener. `0` is never a valid handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ListenerHandle(u64);

/// Opaque handle to a live connection. `0` is never a valid handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConnectionHandle(u64);

/// Opaque handle to a live bidirectional stream. `0` is never a valid handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StreamHandle(u64);

macro_rules! raw_handle {
    ($name:ident) => {
        impl $name {
            /// Reconstructs a handle from its raw FFI representation.
            pub fn from_raw(raw: u64) -> Self {
                Self(raw)
            }

            /// The raw numeric value passed across the FFI boundary.
            pub fn raw(self) -> u64 {
                self.0
            }
        }
    };
}

raw_handle!(ListenerHandle);
raw_handle!(ConnectionHandle);
raw_handle!(StreamHandle);

/// A running listener: the task forwarding accepted connections into the host
/// callbacks. Dropping it aborts the task and releases the ALPN's inbound
/// queue, so the same ALPN can be listened on again.
#[derive(Debug)]
struct RawListener {
    _task: AbortOnDropHandle<()>,
}

/// A live connection plus the framing its streams inherit.
#[derive(Debug)]
struct RawConnection {
    connection: Connection,
    framing: Mutex<Framing>,
    accept_task: Mutex<Option<AbortOnDropHandle<()>>>,
}

/// A live bidirectional stream. The send half is behind an async mutex so
/// concurrent sends serialize instead of interleaving a frame's prefix with
/// another frame's payload; the receive half is taken by [`stream_subscribe`].
#[derive(Debug)]
struct RawStream {
    send: Arc<tokio::sync::Mutex<SendStream>>,
    recv: Mutex<Option<RecvStream>>,
    framing: Framing,
    read_task: Mutex<Option<AbortOnDropHandle<()>>>,
}

static LISTENERS: LazyLock<Registry<RawListener>> = LazyLock::new(Registry::new);
static CONNECTIONS: LazyLock<Registry<RawConnection>> = LazyLock::new(Registry::new);
static STREAMS: LazyLock<Registry<RawStream>> = LazyLock::new(Registry::new);

/// The inbound queue for one declared ALPN, shared between the router's
/// protocol handler (which fills it) and [`stream_listen`] (which drains it).
///
/// The receiver sits behind an async mutex so a listener can claim it for its
/// lifetime and hand it back by simply going away: a second concurrent listener
/// on the same ALPN fails to lock and is rejected, while listening again after
/// [`stop_stream_listen`] succeeds.
pub(crate) type InboundQueue = Arc<tokio::sync::Mutex<mpsc::Receiver<Connection>>>;

/// The [`ProtocolHandler`] registered on the router for one declared ALPN. It
/// owns no protocol logic: it hands accepted connections to whichever listener
/// is draining the ALPN's queue and then keeps the connection alive until the
/// peer or the host closes it.
#[derive(Debug)]
pub(crate) struct InboundAlpnHandler {
    inbound: mpsc::Sender<Connection>,
}

impl ProtocolHandler for InboundAlpnHandler {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        if self.inbound.try_send(connection.clone()).is_err() {
            connection.close(VarInt::from_u32(CLOSE_CODE), b"listener backlog full");
            return Ok(());
        }
        // Returning here would drop the router's handle to the connection; hold
        // it open for the host, which has only just been handed it.
        connection.closed().await;
        Ok(())
    }
}

/// Builds the router registration and inbound queue for one declared ALPN.
pub(crate) fn inbound_alpn_channel() -> (InboundAlpnHandler, InboundQueue) {
    let (sender, receiver) = mpsc::channel(INBOUND_BACKLOG);
    (
        InboundAlpnHandler { inbound: sender },
        Arc::new(tokio::sync::Mutex::new(receiver)),
    )
}

/// Rejects an ALPN that iroh's router or the TLS handshake could not carry, or
/// that would shadow a protocol this crate already serves.
///
/// Shadowing is the interesting case: registering `iroh-blobs`' ALPN would
/// replace the blobs handler on the router and silently break every transfer,
/// so it is refused rather than resolved by registration order.
pub(crate) fn validate_alpns(alpns: &[String]) -> Result<()> {
    let mut seen: Vec<&str> = Vec::with_capacity(alpns.len());
    for alpn in alpns {
        if alpn.is_empty() {
            return Err(IrohError::EndpointBind("alpn must not be empty".into()));
        }
        if alpn.len() > 255 {
            return Err(IrohError::EndpointBind(format!(
                "alpn {alpn:?} exceeds the 255-byte limit"
            )));
        }
        // The docs ALPN is reserved unconditionally, like the blobs and gossip
        // ones: a custom accept on `/iroh-sync/1` would silently shadow doc sync
        // whenever docs is enabled, so it is refused regardless of the docs flag.
        if alpn.as_bytes() == iroh_blobs::ALPN
            || alpn.as_bytes() == iroh_gossip::net::GOSSIP_ALPN
            || alpn.as_bytes() == iroh_docs::ALPN
        {
            return Err(IrohError::EndpointBind(format!(
                "alpn {alpn:?} is reserved by a built-in protocol"
            )));
        }
        if seen.contains(&alpn.as_str()) {
            return Err(IrohError::EndpointBind(format!("duplicate alpn {alpn:?}")));
        }
        seen.push(alpn);
    }
    Ok(())
}

/// Starts delivering inbound connections that negotiated `alpn`.
///
/// `alpn` must be one of the names declared in the endpoint's configuration;
/// anything else, or a second concurrent listener on the same name, is an
/// [`IrohError::StreamListen`]. `on_connection` fires per accepted connection
/// with its handle and the peer's id; `on_close` fires once when the endpoint
/// stops delivering.
pub fn stream_listen(
    endpoint: EndpointHandle,
    alpn: &str,
    on_connection: impl Fn(ConnectionHandle, EndpointId) + Send + Sync + 'static,
    on_close: impl Fn(Option<IrohError>) + Send + Sync + 'static,
) -> Result<ListenerHandle> {
    let state = endpoint_state(endpoint)?;
    let queue = state.inbound_alpns.get(alpn).cloned().ok_or_else(|| {
        IrohError::StreamListen(format!("alpn {alpn:?} was not declared on this endpoint"))
    })?;
    let mut inbound = queue
        .try_lock_owned()
        .map_err(|_| IrohError::StreamListen(format!("already listening on alpn {alpn:?}")))?;

    let task = runtime().spawn(async move {
        while let Some(connection) = inbound.recv().await {
            let remote_id = connection.remote_id();
            let handle = ConnectionHandle(CONNECTIONS.insert(RawConnection::new(connection)));
            guarded_callback(|| on_connection(handle, remote_id));
        }
        guarded_callback(|| on_close(None));
    });
    Ok(ListenerHandle(LISTENERS.insert(RawListener {
        _task: AbortOnDropHandle::new(task),
    })))
}

/// Stops a listener started with [`stream_listen`].
///
/// Idempotent, and deliberately not a cascade: connections the listener already
/// delivered belong to the host and stay open.
pub fn stop_stream_listen(listener: ListenerHandle) {
    LISTENERS.remove(listener.raw()).ok();
}

/// Dials the peer described by `remote_addr_json` on `alpn` and completes with
/// the new connection's handle.
///
/// `remote_addr_json` is one `EndpointAddr` JSON object, the same shape gossip
/// takes for a bootstrap peer. Any transport addresses it carries are seeded
/// into the endpoint's address lookup, which is what makes a dial possible
/// without a discovery service; an object carrying only an id relies on the
/// endpoint's discovery to resolve it.
pub fn stream_connect(
    endpoint: EndpointHandle,
    remote_addr_json: &str,
    alpn: String,
    on_complete: impl FnOnce(Result<ConnectionHandle>) + Send + 'static,
) {
    let state = match endpoint_state(endpoint) {
        Ok(state) => state,
        Err(err) => {
            guarded_callback(move || on_complete(Err(err)));
            return;
        }
    };
    let addr = match parse_endpoint_addr(remote_addr_json) {
        Ok(addr) => addr,
        Err(detail) => {
            let err = IrohError::StreamConnect(format!("remote {detail}"));
            guarded_callback(move || on_complete(Err(err)));
            return;
        }
    };
    let remote = addr.id;
    if !addr.addrs.is_empty() {
        state.bootstrap_lookup.add_endpoint_info(addr);
    }
    let endpoint = state.endpoint.clone();
    spawn_completing(
        async move {
            let connection = endpoint
                .connect(remote, alpn.as_bytes())
                .await
                .map_err(|e| IrohError::StreamConnect(e.to_string()))?;
            Ok(ConnectionHandle(
                CONNECTIONS.insert(RawConnection::new(connection)),
            ))
        },
        on_complete,
    );
}

/// Fixes the connection's [`Framing`] and starts accepting the bidirectional
/// streams the peer opens on it.
///
/// Nothing is accepted before this call, so a host that subscribes as soon as it
/// has the handle cannot miss a stream. `on_close` fires exactly once, with
/// `None` for an orderly shutdown by either side.
pub fn stream_connection_subscribe(
    connection: ConnectionHandle,
    framing: Framing,
    on_stream: impl Fn(StreamHandle) + Send + Sync + 'static,
    on_close: impl Fn(Option<IrohError>) + Send + Sync + 'static,
) -> Result<()> {
    let state = CONNECTIONS.get(connection.raw())?;
    *state.framing.lock().unwrap_or_else(|e| e.into_inner()) = framing;
    let quic = state.connection.clone();
    let task = runtime().spawn(async move {
        loop {
            match quic.accept_bi().await {
                Ok((send, recv)) => {
                    let handle = StreamHandle(STREAMS.insert(RawStream::new(send, recv, framing)));
                    guarded_callback(|| on_stream(handle));
                }
                Err(err) => {
                    let reason = connection_close_reason(err);
                    guarded_callback(|| on_close(reason));
                    return;
                }
            }
        }
    });
    *state.accept_task.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(AbortOnDropHandle::new(task));
    Ok(())
}

/// Opens a bidirectional stream on the connection.
///
/// QUIC does not announce a stream until it carries bytes, so the peer sees it
/// on the first [`stream_send`], not here.
pub fn stream_open_stream(
    connection: ConnectionHandle,
    on_complete: impl FnOnce(Result<StreamHandle>) + Send + 'static,
) {
    let state = match CONNECTIONS.get(connection.raw()) {
        Ok(state) => state,
        Err(err) => {
            guarded_callback(move || on_complete(Err(err)));
            return;
        }
    };
    let framing = *state.framing.lock().unwrap_or_else(|e| e.into_inner());
    spawn_completing(
        async move {
            let (send, recv) = state
                .connection
                .open_bi()
                .await
                .map_err(|e| IrohError::StreamOpen(e.to_string()))?;
            Ok(StreamHandle(
                STREAMS.insert(RawStream::new(send, recv, framing)),
            ))
        },
        on_complete,
    );
}

/// Closes a connection and, through it, every stream on it. Idempotent.
pub fn stream_close_connection(connection: ConnectionHandle) {
    if let Ok(state) = CONNECTIONS.remove(connection.raw()) {
        state
            .connection
            .close(VarInt::from_u32(CLOSE_CODE), b"closed by host");
    }
}

/// Starts reading `stream`, delivering each chunk to `on_data` and firing
/// `on_close` exactly once when the stream ends.
pub fn stream_subscribe(
    stream: StreamHandle,
    on_data: impl Fn(Vec<u8>) + Send + Sync + 'static,
    on_close: impl Fn(Option<IrohError>) + Send + Sync + 'static,
) -> Result<()> {
    let state = STREAMS.get(stream.raw())?;
    let recv = state
        .recv
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or_else(|| IrohError::Internal("stream is already being read".into()))?;
    let framing = state.framing;
    let task = runtime().spawn(async move {
        let outcome = match framing {
            Framing::Framed => read_framed(recv, &on_data).await,
            Framing::Raw => read_raw(recv, &on_data).await,
        };
        guarded_callback(|| on_close(outcome));
    });
    *state.read_task.lock().unwrap_or_else(|e| e.into_inner()) = Some(AbortOnDropHandle::new(task));
    Ok(())
}

/// Writes `data` to the stream: length-prefixed under [`Framing::Framed`],
/// verbatim under [`Framing::Raw`]. Concurrent sends serialize.
pub fn stream_send(
    stream: StreamHandle,
    data: Vec<u8>,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) {
    let state = match STREAMS.get(stream.raw()) {
        Ok(state) => state,
        Err(err) => {
            guarded_callback(move || on_complete(Err(err)));
            return;
        }
    };
    if state.framing == Framing::Framed && data.len() > MAX_FRAME_SIZE {
        let err = IrohError::StreamFrameTooLarge(format!(
            "{} bytes exceeds the {MAX_FRAME_SIZE}-byte frame limit",
            data.len()
        ));
        guarded_callback(move || on_complete(Err(err)));
        return;
    }
    let framing = state.framing;
    let send = Arc::clone(&state.send);
    spawn_completing(
        async move {
            let mut send = send.lock().await;
            if framing == Framing::Framed {
                let prefix = (data.len() as u32).to_be_bytes();
                send.write_all(&prefix).await.map_err(write_error)?;
            }
            send.write_all(&data).await.map_err(write_error)
        },
        on_complete,
    );
}

/// Finishes the stream's send side, stops reading it, and releases it.
/// Idempotent.
pub fn stream_close(stream: StreamHandle) {
    let Ok(state) = STREAMS.remove(stream.raw()) else {
        return;
    };
    let send = Arc::clone(&state.send);
    // `finish` needs the send half exclusively, which a concurrent send may
    // still hold; take it on the runtime rather than blocking the caller.
    runtime().spawn(async move {
        send.lock().await.finish().ok();
    });
}

impl RawConnection {
    fn new(connection: Connection) -> Self {
        Self {
            connection,
            framing: Mutex::new(Framing::default()),
            accept_task: Mutex::new(None),
        }
    }
}

impl RawStream {
    fn new(send: SendStream, recv: RecvStream, framing: Framing) -> Self {
        Self {
            send: Arc::new(tokio::sync::Mutex::new(send)),
            recv: Mutex::new(Some(recv)),
            framing,
            read_task: Mutex::new(None),
        }
    }
}

/// Reads length-prefixed frames until the stream ends, delivering each whole
/// frame as one chunk.
async fn read_framed(
    mut recv: RecvStream,
    on_data: &(impl Fn(Vec<u8>) + Send + Sync),
) -> Option<IrohError> {
    loop {
        let mut prefix = [0u8; 4];
        match recv.read_exact(&mut prefix).await {
            Ok(()) => {}
            // Nothing at all arrived before the end: an orderly finish on a
            // frame boundary, as opposed to a frame truncated mid-flight.
            Err(ReadExactError::FinishedEarly(0)) => return None,
            Err(ReadExactError::FinishedEarly(read)) => {
                return Some(IrohError::StreamClosed(format!(
                    "stream ended {read} bytes into a frame header"
                )))
            }
            Err(ReadExactError::ReadError(err)) => return read_close_reason(err),
        }
        let len = u32::from_be_bytes(prefix) as usize;
        if len > MAX_FRAME_SIZE {
            return Some(IrohError::StreamFrameTooLarge(format!(
                "peer announced a {len}-byte frame, over the {MAX_FRAME_SIZE}-byte limit"
            )));
        }
        let mut payload = vec![0u8; len];
        match recv.read_exact(&mut payload).await {
            Ok(()) => guarded_callback(|| on_data(payload)),
            Err(ReadExactError::FinishedEarly(read)) => {
                return Some(IrohError::StreamClosed(format!(
                    "stream ended {read} bytes into a {len}-byte frame"
                )))
            }
            Err(ReadExactError::ReadError(err)) => return read_close_reason(err),
        }
    }
}

/// Reads the stream verbatim, delivering whatever each read produces.
async fn read_raw(
    mut recv: RecvStream,
    on_data: &(impl Fn(Vec<u8>) + Send + Sync),
) -> Option<IrohError> {
    let mut buffer = vec![0u8; RAW_READ_CHUNK];
    loop {
        match recv.read(&mut buffer).await {
            Ok(Some(read)) => {
                let chunk = buffer[..read].to_vec();
                guarded_callback(|| on_data(chunk));
            }
            Ok(None) => return None,
            Err(err) => return read_close_reason(err),
        }
    }
}

/// Classifies why a read stopped: `None` when either side shut the connection
/// down deliberately, an error otherwise.
fn read_close_reason(err: ReadError) -> Option<IrohError> {
    match err {
        ReadError::ConnectionLost(err) => connection_close_reason(err),
        other => Some(IrohError::StreamClosed(other.to_string())),
    }
}

/// Classifies why a connection ended, mapping both sides' deliberate closes to
/// `None` so an orderly shutdown is not reported to the host as a failure.
fn connection_close_reason(err: ConnectionError) -> Option<IrohError> {
    match err {
        ConnectionError::LocallyClosed | ConnectionError::ApplicationClosed(_) => None,
        other => Some(IrohError::StreamClosed(other.to_string())),
    }
}

/// Maps a write failure onto the taxonomy: a peer or transport that ended the
/// stream is [`IrohError::StreamClosed`], anything else a genuine send failure.
fn write_error(err: WriteError) -> IrohError {
    match err {
        WriteError::ClosedStream | WriteError::Stopped(_) | WriteError::ConnectionLost(_) => {
            IrohError::StreamClosed(err.to_string())
        }
        other => IrohError::StreamSend(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    use crate::{
        endpoint::endpoint_addr,
        test_support::{close_endpoint_blocking, create_minimal_endpoint_with_alpns, TIMEOUT},
    };

    const ALPN: &str = "iroh-rn/test/1";

    #[test]
    fn validate_alpns_accepts_distinct_custom_names() {
        assert!(validate_alpns(&[]).is_ok());
        assert!(validate_alpns(&["a/1".into(), "b/1".into()]).is_ok());
    }

    #[test]
    fn validate_alpns_rejects_empty_oversized_duplicate_and_reserved() {
        let cases = vec![
            vec![String::new()],
            vec!["x".repeat(256)],
            vec!["dup".into(), "dup".into()],
            vec![String::from_utf8(iroh_blobs::ALPN.to_vec()).expect("blobs alpn is utf-8")],
            vec![String::from_utf8(iroh_gossip::net::GOSSIP_ALPN.to_vec())
                .expect("gossip alpn is utf-8")],
            // The docs ALPN (`/iroh-sync/1`) is reserved too, so a custom accept
            // cannot shadow doc sync.
            vec![String::from_utf8(iroh_docs::ALPN.to_vec()).expect("docs alpn is utf-8")],
        ];
        for case in cases {
            assert!(
                matches!(validate_alpns(&case), Err(IrohError::EndpointBind(_))),
                "expected {case:?} to be rejected"
            );
        }
    }

    #[test]
    fn listen_on_unknown_endpoint_is_invalid_handle() {
        let result = stream_listen(EndpointHandle::from_raw(u64::MAX), ALPN, |_, _| {}, |_| {});
        assert!(matches!(result, Err(IrohError::InvalidHandle(_))));
    }

    #[test]
    fn listen_on_an_undeclared_alpn_is_rejected() {
        let endpoint = create_minimal_endpoint_with_alpns(None, vec![ALPN.into()]);
        let result = stream_listen(endpoint, "never/declared", |_, _| {}, |_| {});
        assert!(matches!(result, Err(IrohError::StreamListen(_))));
        close_endpoint_blocking(endpoint).expect("close");
    }

    /// One ALPN carries one listener at a time, and stopping it hands the ALPN
    /// back rather than burning it for the endpoint's lifetime.
    #[test]
    fn one_listener_per_alpn_at_a_time() {
        let endpoint = create_minimal_endpoint_with_alpns(None, vec![ALPN.into()]);
        let first = stream_listen(endpoint, ALPN, |_, _| {}, |_| {}).expect("first listener");
        assert!(matches!(
            stream_listen(endpoint, ALPN, |_, _| {}, |_| {}),
            Err(IrohError::StreamListen(_))
        ));

        stop_stream_listen(first);
        // Stopping is idempotent.
        stop_stream_listen(first);
        let second = wait_for_relisten(endpoint);
        stop_stream_listen(second);
        close_endpoint_blocking(endpoint).expect("close");
    }

    #[test]
    fn connect_rejects_a_malformed_remote_address() {
        let endpoint = create_minimal_endpoint_with_alpns(None, vec![ALPN.into()]);
        let (tx, rx) = mpsc::channel();
        stream_connect(endpoint, "not json", ALPN.into(), move |result| {
            tx.send(result).ok();
        });
        assert!(matches!(
            rx.recv_timeout(TIMEOUT).expect("completion fired"),
            Err(IrohError::StreamConnect(_))
        ));
        close_endpoint_blocking(endpoint).expect("close");
    }

    #[test]
    fn operations_on_unknown_handles_report_invalid_handle() {
        assert!(matches!(
            stream_connection_subscribe(
                ConnectionHandle::from_raw(u64::MAX),
                Framing::Framed,
                |_| {},
                |_| {},
            ),
            Err(IrohError::InvalidHandle(_))
        ));
        assert!(matches!(
            stream_subscribe(StreamHandle::from_raw(u64::MAX), |_| {}, |_| {}),
            Err(IrohError::InvalidHandle(_))
        ));
        assert!(matches!(
            send_blocking(StreamHandle::from_raw(u64::MAX), b"hi".to_vec()),
            Err(IrohError::InvalidHandle(_))
        ));
        // Both closes are idempotent on handles that never existed.
        stream_close(StreamHandle::from_raw(u64::MAX));
        stream_close_connection(ConnectionHandle::from_raw(u64::MAX));
    }

    /// End-to-end over two minimal-preset endpoints on loopback: the dialer
    /// opens one framed stream, and every send arrives as exactly one chunk in
    /// both directions. Frame boundaries are the whole point of the mode, so
    /// the payload sizes deliberately differ.
    #[test]
    fn framed_roundtrip_preserves_message_boundaries() {
        let server = create_minimal_endpoint_with_alpns(None, vec![ALPN.into()]);
        let client = create_minimal_endpoint_with_alpns(None, vec![]);
        let (listener, connections, _listener_closed) = listen_collecting(server, ALPN);

        let client_conn = connect_blocking(client, &addr_json(server), ALPN).expect("dial");
        let (_client_streams, _client_closed) = subscribe_connection(client_conn, Framing::Framed);
        let client_stream = open_blocking(client_conn).expect("stream opened");
        let (client_chunks, _client_stream_closed) = subscribe_stream(client_stream);

        let payloads: Vec<Vec<u8>> = vec![b"one".to_vec(), vec![7u8; 5000], Vec::new()];
        for payload in &payloads {
            send_blocking(client_stream, payload.clone()).expect("send");
        }

        let (server_conn, remote_id) = connections.recv_timeout(TIMEOUT).expect("connection");
        assert_eq!(
            remote_id.to_string(),
            crate::endpoint::endpoint_id(client).expect("client id")
        );
        let (server_streams, _server_closed) = subscribe_connection(server_conn, Framing::Framed);
        let server_stream = server_streams
            .recv_timeout(TIMEOUT)
            .expect("stream accepted");
        let (server_chunks, server_stream_closed) = subscribe_stream(server_stream);

        for expected in &payloads {
            assert_eq!(
                &server_chunks.recv_timeout(TIMEOUT).expect("frame"),
                expected
            );
        }

        // The reply proves the stream is bidirectional, not just readable.
        send_blocking(server_stream, b"pong".to_vec()).expect("reply");
        assert_eq!(
            client_chunks.recv_timeout(TIMEOUT).expect("reply frame"),
            b"pong".to_vec()
        );

        // Finishing the dialer's send half ends the peer's read as an orderly
        // close, not an error.
        stream_close(client_stream);
        assert!(server_stream_closed
            .recv_timeout(TIMEOUT)
            .expect("close reported")
            .is_none());

        // Unused streams have no ceremony: closing twice is a no-op.
        stream_close(client_stream);
        stream_close(server_stream);
        stream_close_connection(client_conn);
        stop_stream_listen(listener);
        close_endpoint_blocking(client).expect("close client");
        close_endpoint_blocking(server).expect("close server");
    }

    /// Under raw framing the peer sees a byte stream with no boundaries, so the
    /// assertion is on the concatenation rather than on chunk shape.
    #[test]
    fn raw_roundtrip_delivers_the_byte_stream() {
        let server = create_minimal_endpoint_with_alpns(None, vec![ALPN.into()]);
        let client = create_minimal_endpoint_with_alpns(None, vec![]);
        let (listener, connections, _listener_closed) = listen_collecting(server, ALPN);

        let client_conn = connect_blocking(client, &addr_json(server), ALPN).expect("dial");
        let (_client_streams, _client_closed) = subscribe_connection(client_conn, Framing::Raw);
        let client_stream = open_blocking(client_conn).expect("stream opened");
        send_blocking(client_stream, b"hello ".to_vec()).expect("send");
        send_blocking(client_stream, b"world".to_vec()).expect("send");

        let (server_conn, _remote_id) = connections.recv_timeout(TIMEOUT).expect("connection");
        let (server_streams, _server_closed) = subscribe_connection(server_conn, Framing::Raw);
        let server_stream = server_streams
            .recv_timeout(TIMEOUT)
            .expect("stream accepted");
        let (server_chunks, _server_stream_closed) = subscribe_stream(server_stream);

        let mut received = Vec::new();
        while received != b"hello world" {
            received.extend(server_chunks.recv_timeout(TIMEOUT).expect("bytes"));
            assert!(
                b"hello world".starts_with(&received),
                "unexpected bytes: {received:?}"
            );
        }

        stream_close_connection(client_conn);
        stop_stream_listen(listener);
        close_endpoint_blocking(client).expect("close client");
        close_endpoint_blocking(server).expect("close server");
    }

    /// Closing a connection ends the peer's stream-accept loop as an orderly
    /// close, which is how the host learns the session is over.
    #[test]
    fn closing_a_connection_ends_the_peers_accept_loop() {
        let server = create_minimal_endpoint_with_alpns(None, vec![ALPN.into()]);
        let client = create_minimal_endpoint_with_alpns(None, vec![]);
        let (listener, connections, _listener_closed) = listen_collecting(server, ALPN);

        let client_conn = connect_blocking(client, &addr_json(server), ALPN).expect("dial");
        let (_client_streams, _client_closed) = subscribe_connection(client_conn, Framing::Framed);
        let client_stream = open_blocking(client_conn).expect("stream opened");
        send_blocking(client_stream, b"hi".to_vec()).expect("send");

        let (server_conn, _remote_id) = connections.recv_timeout(TIMEOUT).expect("connection");
        let (_server_streams, server_closed) = subscribe_connection(server_conn, Framing::Framed);

        stream_close_connection(client_conn);
        // Closing is idempotent.
        stream_close_connection(client_conn);
        assert!(server_closed
            .recv_timeout(TIMEOUT)
            .expect("close reported")
            .is_none());

        stop_stream_listen(listener);
        close_endpoint_blocking(client).expect("close client");
        close_endpoint_blocking(server).expect("close server");
    }

    #[test]
    fn framed_send_rejects_an_oversized_payload() {
        let server = create_minimal_endpoint_with_alpns(None, vec![ALPN.into()]);
        let client = create_minimal_endpoint_with_alpns(None, vec![]);
        let (listener, _connections, _listener_closed) = listen_collecting(server, ALPN);

        let client_conn = connect_blocking(client, &addr_json(server), ALPN).expect("dial");
        let (_streams, _closed) = subscribe_connection(client_conn, Framing::Framed);
        let stream = open_blocking(client_conn).expect("stream opened");
        assert!(matches!(
            send_blocking(stream, vec![0u8; MAX_FRAME_SIZE + 1]),
            Err(IrohError::StreamFrameTooLarge(_))
        ));

        stream_close_connection(client_conn);
        stop_stream_listen(listener);
        close_endpoint_blocking(client).expect("close client");
        close_endpoint_blocking(server).expect("close server");
    }

    /// Dialing an ALPN the peer never declared fails the dial rather than
    /// producing a connection that silently never carries anything.
    #[test]
    fn connect_on_an_unaccepted_alpn_fails() {
        let server = create_minimal_endpoint_with_alpns(None, vec![ALPN.into()]);
        let client = create_minimal_endpoint_with_alpns(None, vec![]);
        assert!(matches!(
            connect_blocking(client, &addr_json(server), "iroh-rn/absent/1"),
            Err(IrohError::StreamConnect(_))
        ));
        close_endpoint_blocking(client).expect("close client");
        close_endpoint_blocking(server).expect("close server");
    }

    type Connections = mpsc::Receiver<(ConnectionHandle, EndpointId)>;
    type Closures = mpsc::Receiver<Option<IrohError>>;

    fn listen_collecting(
        endpoint: EndpointHandle,
        alpn: &str,
    ) -> (ListenerHandle, Connections, Closures) {
        let (conn_tx, conn_rx) = mpsc::channel();
        let (close_tx, close_rx) = mpsc::channel();
        let listener = stream_listen(
            endpoint,
            alpn,
            move |connection, remote_id| {
                conn_tx.send((connection, remote_id)).ok();
            },
            move |reason| {
                close_tx.send(reason).ok();
            },
        )
        .expect("listener started");
        (listener, conn_rx, close_rx)
    }

    /// Retries `stream_listen` until the aborted listener's task has actually
    /// released the ALPN's queue, which happens on the runtime rather than
    /// synchronously inside `stop_stream_listen`.
    fn wait_for_relisten(endpoint: EndpointHandle) -> ListenerHandle {
        let deadline = std::time::Instant::now() + TIMEOUT;
        loop {
            match stream_listen(endpoint, ALPN, |_, _| {}, |_| {}) {
                Ok(listener) => return listener,
                Err(err) => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "alpn was never released: {err}"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }
    }

    fn subscribe_connection(
        connection: ConnectionHandle,
        framing: Framing,
    ) -> (mpsc::Receiver<StreamHandle>, Closures) {
        let (stream_tx, stream_rx) = mpsc::channel();
        let (close_tx, close_rx) = mpsc::channel();
        stream_connection_subscribe(
            connection,
            framing,
            move |stream| {
                stream_tx.send(stream).ok();
            },
            move |reason| {
                close_tx.send(reason).ok();
            },
        )
        .expect("connection subscribed");
        (stream_rx, close_rx)
    }

    fn subscribe_stream(stream: StreamHandle) -> (mpsc::Receiver<Vec<u8>>, Closures) {
        let (data_tx, data_rx) = mpsc::channel();
        let (close_tx, close_rx) = mpsc::channel();
        stream_subscribe(
            stream,
            move |chunk| {
                data_tx.send(chunk).ok();
            },
            move |reason| {
                close_tx.send(reason).ok();
            },
        )
        .expect("stream subscribed");
        (data_rx, close_rx)
    }

    fn connect_blocking(
        endpoint: EndpointHandle,
        remote_addr_json: &str,
        alpn: &str,
    ) -> Result<ConnectionHandle> {
        let (tx, rx) = mpsc::channel();
        stream_connect(endpoint, remote_addr_json, alpn.to_owned(), move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT).expect("connect completed")
    }

    fn open_blocking(connection: ConnectionHandle) -> Result<StreamHandle> {
        let (tx, rx) = mpsc::channel();
        stream_open_stream(connection, move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT).expect("open completed")
    }

    fn send_blocking(stream: StreamHandle, data: Vec<u8>) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        stream_send(stream, data, move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT).expect("send completed")
    }

    fn addr_json(endpoint: EndpointHandle) -> String {
        let info = endpoint_addr(endpoint).expect("addr");
        serde_json::json!({
            "id": info.id,
            "relayUrls": info.relay_urls,
            "directAddrs": info.direct_addrs,
        })
        .to_string()
    }
}
