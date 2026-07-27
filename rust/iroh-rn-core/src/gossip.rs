//! Gossip: publish/subscribe messaging over a shared topic.
//!
//! A topic is identified by the BLAKE3 hash of a caller-chosen label. Peers
//! that subscribe to the same topic form a swarm and broadcast UTF-8 messages
//! to one another. This module mirrors the address-watch machinery in
//! [`crate::endpoint`]: a subscription is an abort-on-drop background task that
//! forwards swarm events into host callbacks, addressed by an opaque handle in
//! a process-wide [`Registry`].
//!
//! The gossip protocol is registered as a second ALPN on the endpoint's
//! existing [`iroh::protocol::Router`] (see [`crate::endpoint`]); this module
//! drives the [`Gossip`] instance that router accepts connections into.

use std::sync::LazyLock;

use bytes::Bytes;
use iroh::{EndpointAddr, EndpointId};
use iroh_gossip::{
    api::{Event, GossipSender},
    proto::{TopicId, DEFAULT_MAX_MESSAGE_SIZE},
};
use n0_future::{task::AbortOnDropHandle, StreamExt};

use crate::{
    endpoint::{endpoint_state, parse_endpoint_addr, EndpointHandle},
    error::{IrohError, Result},
    guarded_callback,
    registry::Registry,
    runtime::runtime,
    spawn_completing,
};

/// The largest gossip payload accepted by [`gossip_broadcast`], in bytes.
///
/// This is iroh-gossip's default per-message limit. The endpoint's [`Gossip`]
/// is built with default configuration, so this is the effective cap. The wire
/// frame adds a little postcard overhead, so a payload right at the limit may
/// still be rejected by the protocol; this pre-check rejects the clearly-oversized
/// case early with a precise error.
///
/// [`Gossip`]: iroh_gossip::net::Gossip
const MAX_MESSAGE_SIZE: usize = DEFAULT_MAX_MESSAGE_SIZE;

/// Opaque handle to a live gossip subscription. `0` is never a valid handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct GossipHandle(u64);

impl GossipHandle {
    /// Reconstructs a handle from its raw FFI representation.
    pub fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    /// The raw numeric value passed across the FFI boundary.
    pub fn raw(self) -> u64 {
        self.0
    }
}

/// A live gossip subscription: the broadcast sender plus the abort-on-drop task
/// that forwards received events into the host callbacks. Dropping the state
/// (via [`gossip_unsubscribe`]) aborts the task, which drops the receiver and
/// leaves the swarm for that topic.
#[derive(Debug)]
struct GossipSubscription {
    sender: GossipSender,
    _task: AbortOnDropHandle<()>,
}

static GOSSIP_SUBS: LazyLock<Registry<GossipSubscription>> = LazyLock::new(Registry::new);

/// Derives a [`TopicId`] from a caller-chosen label: the 32-byte BLAKE3 hash of
/// the label's UTF-8 bytes. Deterministic, so peers that pass the same label
/// join the same topic.
fn topic_id_from(topic: &str) -> TopicId {
    TopicId::from_bytes(*blake3::hash(topic.as_bytes()).as_bytes())
}

/// Parses the newline-joined bootstrap `EndpointAddr` JSON strings (the shape
/// the bridge emits for an endpoint address: `{ id, relayUrls, directAddrs }`)
/// into [`EndpointAddr`]s. Empty segments are ignored, so a stray separator is
/// harmless. Any malformed entry fails the whole subscribe with a precise
/// [`IrohError::GossipSubscribe`].
fn parse_bootstrap(joined: &str) -> Result<Vec<EndpointAddr>> {
    joined
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            parse_endpoint_addr(line)
                .map_err(|detail| IrohError::GossipSubscribe(format!("bootstrap {detail}")))
        })
        .collect()
}

/// Subscribes to the gossip topic derived from `topic` on `endpoint`.
///
/// `bootstrap_joined` is a (possibly empty) newline-joined list of bootstrap
/// peer `EndpointAddr` JSON strings; their addresses are seeded into a memory
/// address lookup so the swarm can dial them by id, and their ids become the
/// initial swarm peers. Subscription set-up (address parsing, seeding, handle
/// validity) is validated synchronously: a bad bootstrap address or stale
/// endpoint returns an error immediately (nothing is spawned).
///
/// The join itself completes asynchronously. Once the topic is joined,
/// `on_start` fires once with the subscription's [`GossipHandle`] (pass it to
/// [`gossip_broadcast`] / [`gossip_unsubscribe`]); thereafter `on_message`
/// fires for each received message (as `"<delivered-from-id> <utf8-payload>"`)
/// and `on_neighbor` for each swarm event (`"up <id>"`, `"down <id>"`,
/// `"lagged"` when the receiver fell behind and dropped messages, or
/// `"error <detail>"` when the join itself failed).
///
/// If the join fails, `on_neighbor` receives exactly one `"error <detail>"` and
/// `on_start` never fires: the subscription is dead and the host should settle
/// anything waiting on it. This is the only failure signal, because the join
/// completes long after this function has returned `Ok`.
pub fn gossip_subscribe(
    endpoint: EndpointHandle,
    topic: String,
    bootstrap_joined: String,
    on_start: impl Fn(GossipHandle) + Send + Sync + 'static,
    on_message: impl Fn(String) + Send + Sync + 'static,
    on_neighbor: impl Fn(String) + Send + Sync + 'static,
) -> Result<()> {
    let state = endpoint_state(endpoint)?;
    let gossip = state.gossip.clone();
    let topic_id = topic_id_from(&topic);
    let bootstrap = parse_bootstrap(&bootstrap_joined)?;
    let peer_ids: Vec<EndpointId> = bootstrap.iter().map(|addr| addr.id).collect();

    // Seed the bootstrap peers' addresses so gossip can dial them by id even
    // without discovery (e.g. minimal-preset / LAN-only endpoints). The
    // endpoint owns one lookup for the host's whole lifetime, so repeated
    // subscribes update it in place instead of growing its lookup chain.
    for addr in bootstrap {
        state.bootstrap_lookup.add_endpoint_info(addr);
    }

    runtime().spawn(async move {
        let topic = match gossip.subscribe(topic_id, peer_ids).await {
            Ok(topic) => topic,
            Err(e) => {
                // The join failed after synchronous validation passed. on_start
                // will never fire, so the host must be told through the only
                // channel it is still listening on, or a caller awaiting the
                // join (or a broadcast queued behind it) would wait forever.
                tracing::error!("gossip subscribe failed: {e}");
                guarded_callback(|| on_neighbor(format!("error {e}")));
                return;
            }
        };
        let (sender, mut receiver) = topic.split();

        // Forward swarm events into the host callbacks until the subscription
        // is dropped (which aborts this task) or the receiver stream ends.
        let forward = runtime().spawn(async move {
            while let Some(event) = receiver.next().await {
                match event {
                    Ok(Event::Received(message)) => {
                        let payload = String::from_utf8_lossy(&message.content);
                        let line = format!("{} {payload}", message.delivered_from);
                        guarded_callback(|| on_message(line));
                    }
                    Ok(Event::NeighborUp(id)) => {
                        let line = format!("up {id}");
                        guarded_callback(|| on_neighbor(line));
                    }
                    Ok(Event::NeighborDown(id)) => {
                        let line = format!("down {id}");
                        guarded_callback(|| on_neighbor(line));
                    }
                    Ok(Event::Lagged) => {
                        guarded_callback(|| on_neighbor("lagged".to_owned()));
                    }
                    Err(e) => {
                        tracing::warn!("gossip receiver stream errored: {e}");
                        break;
                    }
                }
            }
        });

        let handle = GOSSIP_SUBS.insert(GossipSubscription {
            sender,
            _task: AbortOnDropHandle::new(forward),
        });
        guarded_callback(|| on_start(GossipHandle(handle)));
    });

    Ok(())
}

/// Broadcasts `payload` (UTF-8) to every peer in the subscription's swarm.
///
/// Rejects with [`IrohError::GossipMessageTooLarge`] if the payload exceeds
/// [`MAX_MESSAGE_SIZE`], or [`IrohError::InvalidHandle`] if the subscription is
/// unknown or already unsubscribed. Otherwise `on_complete` fires when the
/// broadcast has been handed to the swarm (delivery to peers is best effort).
pub fn gossip_broadcast(
    sub: GossipHandle,
    payload: String,
    on_complete: impl FnOnce(Result<()>) + Send + 'static,
) {
    let subscription = match GOSSIP_SUBS.get(sub.raw()) {
        Ok(subscription) => subscription,
        Err(err) => {
            guarded_callback(move || on_complete(Err(err)));
            return;
        }
    };
    let bytes = payload.into_bytes();
    if bytes.len() > MAX_MESSAGE_SIZE {
        let err = IrohError::GossipMessageTooLarge(format!(
            "{} bytes exceeds the {MAX_MESSAGE_SIZE}-byte per-message limit",
            bytes.len()
        ));
        guarded_callback(move || on_complete(Err(err)));
        return;
    }
    spawn_completing(
        async move {
            subscription
                .sender
                .broadcast(Bytes::from(bytes))
                .await
                .map_err(|e| IrohError::GossipBroadcast(e.to_string()))
        },
        on_complete,
    );
}

/// Ends a gossip subscription started with [`gossip_subscribe`], leaving the
/// swarm for that topic.
///
/// Idempotent: unsubscribing an unknown or already-ended subscription is a
/// no-op. Dropping the subscription state aborts its forwarding task (via
/// [`AbortOnDropHandle`]) and drops the receiver, which leaves the topic.
pub fn gossip_unsubscribe(sub: GossipHandle) {
    GOSSIP_SUBS.remove(sub.raw()).ok();
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    use crate::{
        endpoint::endpoint_addr,
        test_support::{close_endpoint_blocking, create_minimal_endpoint, TIMEOUT},
    };

    #[test]
    fn topic_id_is_deterministic_and_label_sensitive() {
        assert_eq!(topic_id_from("chat"), topic_id_from("chat"));
        assert_ne!(topic_id_from("chat"), topic_id_from("chat "));
    }

    #[test]
    fn parse_bootstrap_reads_id_relays_and_direct_addrs() {
        let id = create_and_take_id();
        let json = format!(
            r#"{{"id":"{id}","relayUrls":["https://relay.example./"],"directAddrs":["127.0.0.1:1234"]}}"#
        );
        let addrs = parse_bootstrap(&json).expect("bootstrap parses");
        assert_eq!(addrs.len(), 1);
        assert_eq!(addrs[0].id.to_string(), id);
        assert_eq!(addrs[0].addrs.len(), 2);
    }

    #[test]
    fn parse_bootstrap_skips_blank_lines_and_rejects_garbage() {
        assert!(parse_bootstrap("").expect("empty is ok").is_empty());
        assert!(parse_bootstrap("\n\n").expect("blank is ok").is_empty());
        assert!(matches!(
            parse_bootstrap("not json"),
            Err(IrohError::GossipSubscribe(_))
        ));
    }

    /// Repeated subscribes must accumulate bootstrap addresses in the
    /// endpoint's single lookup rather than stacking a new lookup onto its
    /// resolver chain per subscribe.
    #[test]
    fn repeated_subscribes_share_one_bootstrap_lookup() {
        let endpoint = create_minimal_endpoint(None);
        let (first, second) = (create_and_take_addr(), create_and_take_addr());

        for addr_json in [&first.1, &second.1] {
            gossip_subscribe(
                endpoint,
                "chat".into(),
                addr_json.clone(),
                |_| {},
                |_| {},
                |_| {},
            )
            .expect("subscribe started");
        }

        let lookup = &endpoint_state(endpoint).expect("state").bootstrap_lookup;
        for (id, _) in [&first, &second] {
            assert!(
                lookup.get_endpoint_info(*id).is_some(),
                "both subscribes' bootstrap peers resolve from the same lookup"
            );
        }
        close_endpoint_blocking(endpoint).expect("close");
    }

    #[test]
    fn broadcast_on_unknown_subscription_reports_invalid_handle() {
        let (tx, rx) = mpsc::channel();
        gossip_broadcast(GossipHandle::from_raw(u64::MAX), "hi".into(), move |r| {
            tx.send(r).ok();
        });
        assert!(matches!(
            rx.recv_timeout(TIMEOUT).unwrap(),
            Err(IrohError::InvalidHandle(_))
        ));
    }

    #[test]
    fn subscribe_on_unknown_endpoint_is_invalid_handle() {
        let result = gossip_subscribe(
            EndpointHandle::from_raw(u64::MAX),
            "chat".into(),
            String::new(),
            |_| {},
            |_| {},
            |_| {},
        );
        assert!(matches!(result, Err(IrohError::InvalidHandle(_))));
    }

    #[test]
    fn subscribe_rejects_a_bad_bootstrap_address() {
        let endpoint = create_minimal_endpoint(None);
        let result = gossip_subscribe(
            endpoint,
            "chat".into(),
            "{\"id\":\"not-an-endpoint-id\"}".into(),
            |_| {},
            |_| {},
            |_| {},
        );
        assert!(matches!(result, Err(IrohError::GossipSubscribe(_))));
        close_endpoint_blocking(endpoint).expect("close");
    }

    /// End-to-end swarm over two minimal-preset endpoints on loopback: B
    /// bootstraps to A's seeded address, both broadcast, and each observes the
    /// other's message. Also exercises the oversized-payload guard.
    #[test]
    fn two_endpoint_broadcast_roundtrip() {
        let alice = create_minimal_endpoint(None);
        let bob = create_minimal_endpoint(None);

        let (alice_handle, alice_msgs, alice_neighbors) = subscribe_collecting(alice, "");
        // Bootstrap B to A using A's current address.
        let alice_addr_json = addr_json(alice);
        let (bob_handle, bob_msgs, _bob_neighbors) = subscribe_collecting(bob, &alice_addr_json);

        // A must see B as a neighbor before broadcasting, so the message is not
        // sent into an empty swarm (gossip is not store-and-forward).
        wait_for(&alice_neighbors, "up");

        broadcast_blocking(alice_handle, "hello from alice").expect("alice broadcast");
        let received = bob_msgs
            .recv_timeout(TIMEOUT)
            .expect("bob received a message");
        assert!(
            received.ends_with("hello from alice"),
            "unexpected payload: {received}"
        );

        broadcast_blocking(bob_handle, "hi from bob").expect("bob broadcast");
        let received = alice_msgs
            .recv_timeout(TIMEOUT)
            .expect("alice received a message");
        assert!(
            received.ends_with("hi from bob"),
            "unexpected payload: {received}"
        );

        // Oversized payloads are rejected before touching the swarm.
        let oversized = "x".repeat(MAX_MESSAGE_SIZE + 1);
        assert!(matches!(
            broadcast_blocking(alice_handle, &oversized),
            Err(IrohError::GossipMessageTooLarge(_))
        ));

        gossip_unsubscribe(alice_handle);
        gossip_unsubscribe(bob_handle);
        // Unsubscribe is idempotent.
        gossip_unsubscribe(alice_handle);
        close_endpoint_blocking(alice).expect("close alice");
        close_endpoint_blocking(bob).expect("close bob");
    }

    type Collected = (GossipHandle, mpsc::Receiver<String>, mpsc::Receiver<String>);

    /// Subscribes and returns the handle plus channels of received messages and
    /// neighbor events. Blocks until `on_start` fires.
    fn subscribe_collecting(endpoint: EndpointHandle, bootstrap: &str) -> Collected {
        let (start_tx, start_rx) = mpsc::channel();
        let (msg_tx, msg_rx) = mpsc::channel();
        let (neighbor_tx, neighbor_rx) = mpsc::channel();
        gossip_subscribe(
            endpoint,
            "roundtrip".into(),
            bootstrap.to_owned(),
            move |handle| {
                start_tx.send(handle).ok();
            },
            move |message| {
                msg_tx.send(message).ok();
            },
            move |event| {
                neighbor_tx.send(event).ok();
            },
        )
        .expect("subscribe started");
        let handle = start_rx.recv_timeout(TIMEOUT).expect("on_start fired");
        (handle, msg_rx, neighbor_rx)
    }

    fn addr_json(endpoint: EndpointHandle) -> String {
        let info = endpoint_addr(endpoint).expect("addr");
        let directs: Vec<String> = info.direct_addrs.iter().map(|a| format!("{a:?}")).collect();
        format!(
            "{{\"id\":\"{}\",\"relayUrls\":[],\"directAddrs\":[{}]}}",
            info.id,
            directs.join(",")
        )
    }

    /// Blocks until a neighbor event with the given `kind` (`"up"`/`"down"`)
    /// arrives.
    fn wait_for(neighbors: &mpsc::Receiver<String>, kind: &str) {
        let deadline = std::time::Instant::now() + TIMEOUT;
        loop {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .expect("neighbor event within timeout");
            let event = neighbors
                .recv_timeout(remaining)
                .expect("neighbor event arrived");
            if event.starts_with(kind) {
                return;
            }
        }
    }

    fn broadcast_blocking(sub: GossipHandle, payload: &str) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        gossip_broadcast(sub, payload.to_owned(), move |result| {
            tx.send(result).ok();
        });
        rx.recv_timeout(TIMEOUT).expect("broadcast completed")
    }

    fn create_and_take_id() -> String {
        let endpoint = create_minimal_endpoint(None);
        let id = crate::endpoint::endpoint_id(endpoint).expect("id");
        close_endpoint_blocking(endpoint).expect("close");
        id
    }

    /// A closed endpoint's id paired with the bootstrap JSON naming it.
    fn create_and_take_addr() -> (EndpointId, String) {
        let endpoint = create_minimal_endpoint(None);
        let id: EndpointId = endpoint_addr(endpoint)
            .expect("addr")
            .id
            .parse()
            .expect("endpoint id parses");
        let json = addr_json(endpoint);
        close_endpoint_blocking(endpoint).expect("close");
        (id, json)
    }
}
