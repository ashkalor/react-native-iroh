//! mDNS LAN discovery, behind the `mdns` Cargo feature.
//!
//! With the feature on, an endpoint created with `discovery.mdns` builds an
//! [`MdnsAddressLookup`] (n0's DNS-SD `_irohv1._udp.local` service, over
//! `swarm-discovery`), registers it on the endpoint's address-lookup chain next
//! to the bootstrap [`MemoryLookup`], and on Android holds a Wi-Fi
//! [`MulticastLock`](crate::multicast_lock) for its lifetime. Peers on the same
//! LAN then resolve each other by [`EndpointId`] with no relay and no seeded
//! addresses. [`mdns_subscribe`] surfaces the live discovery stream (peers
//! appearing and expiring) as a subscription modeled on [`crate::docs`].
//!
//! With the feature OFF (the default build, and every Apple build until the
//! consumer holds the multicast entitlement), the machinery is compiled out:
//! [`MDNS_SUPPORTED`] is `false`, requesting `discovery.mdns` at creation fails
//! with [`IrohError::MdnsUnavailable`], and [`mdns_subscribe`] fails the same
//! way. The path is a hard error, never a silent no-op, so a caller can never
//! believe discovery is running when it is not.
//!
//! Teardown limitation (iroh #3945): `swarm-discovery` advertising does not stop
//! cleanly on demand. There is no mid-session disable here; discovery is fixed at
//! creation and torn down only when the endpoint closes, at which point the
//! lookup handle and the multicast lock are dropped (best effort).

use crate::{
    endpoint::EndpointHandle,
    error::{IrohError, Result},
};

/// Whether this build was compiled with the `mdns` feature, i.e. whether mDNS
/// discovery is actually available. Read across the bridge so JS can expose the
/// same value as `MDNS_SUPPORTED`.
pub const MDNS_SUPPORTED: bool = cfg!(feature = "mdns");

/// Opaque handle to a live mDNS discovery subscription. `0` is never valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MdnsSubHandle(u64);

impl MdnsSubHandle {
    /// Reconstructs a handle from its raw FFI representation.
    pub fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    /// The raw numeric value passed across the FFI boundary.
    pub fn raw(self) -> u64 {
        self.0
    }
}

#[cfg(feature = "mdns")]
mod imp {
    use std::sync::LazyLock;

    use iroh::{address_lookup::EndpointInfo, Endpoint, EndpointAddr, TransportAddr};
    use iroh_mdns_address_lookup::{DiscoveryEvent, MdnsAddressLookup};
    use n0_future::{task::AbortOnDropHandle, StreamExt};

    use super::MdnsSubHandle;
    use crate::{
        endpoint::{endpoint_state, EndpointHandle},
        error::{IrohError, Result},
        guarded_callback,
        multicast_lock::{acquire as acquire_multicast_lock, MulticastLockGuard},
        registry::Registry,
        runtime::runtime,
    };

    /// The mDNS discovery running on an endpoint: the lookup handle (kept alive so
    /// its background task and this endpoint's advertising survive) plus the
    /// Android multicast lock held for its lifetime. Dropped on endpoint close.
    pub(crate) struct MdnsState {
        lookup: MdnsAddressLookup,
        _multicast_lock: Option<MulticastLockGuard>,
    }

    impl std::fmt::Debug for MdnsState {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("MdnsState").finish_non_exhaustive()
        }
    }

    /// Builds the mDNS lookup for `endpoint` when `enabled`, registering it on the
    /// endpoint's address-lookup chain and acquiring the multicast lock. Returns
    /// `None` when mDNS was not requested (a zero-cost, unaffected endpoint).
    pub(crate) fn build_mdns(endpoint: &Endpoint, enabled: bool) -> Result<Option<MdnsState>> {
        if !enabled {
            return Ok(None);
        }
        // `build` needs the current tokio runtime (it spawns the discoverer); it
        // runs inside the endpoint-create future, which is already on the runtime.
        let lookup = MdnsAddressLookup::builder()
            .build(endpoint.id())
            .map_err(|e| IrohError::MdnsUnavailable(format!("could not start mDNS: {e}")))?;
        endpoint
            .address_lookup()
            .map_err(|e| IrohError::MdnsUnavailable(format!("address lookup unavailable: {e}")))?
            .add(lookup.clone());
        // Best-effort on Android; `None` (no lock needed / could not take one)
        // everywhere else. Held for the subscription's whole lifetime.
        let multicast_lock = acquire_multicast_lock();
        Ok(Some(MdnsState {
            lookup,
            _multicast_lock: multicast_lock,
        }))
    }

    /// A live discovery subscription: the abort-on-drop task forwarding
    /// [`DiscoveryEvent`]s into the host callback. Dropping it (via
    /// [`mdns_unsubscribe`]) aborts the task and drops the receiver.
    struct MdnsSubscription {
        _task: AbortOnDropHandle<()>,
    }

    static MDNS_SUBS: LazyLock<Registry<MdnsSubscription>> = LazyLock::new(Registry::new);

    /// Splits an [`EndpointInfo`]'s addresses into the relay and direct lists the
    /// bridge exposes, matching the `EndpointAddr` JSON shape the JS layer parses.
    fn split_addrs(info: &EndpointInfo) -> (Vec<String>, Vec<String>) {
        let addr: EndpointAddr = info.to_endpoint_addr();
        let mut relay_urls = Vec::new();
        let mut direct_addrs = Vec::new();
        for transport in &addr.addrs {
            match transport {
                TransportAddr::Relay(url) => relay_urls.push(url.to_string()),
                TransportAddr::Ip(socket) => direct_addrs.push(socket.to_string()),
                _ => {}
            }
        }
        (relay_urls, direct_addrs)
    }

    /// Serializes a [`DiscoveryEvent`] as the JS discriminated-union JSON the
    /// bridge forwards, or `None` for a variant the JS layer does not model (the
    /// event enum is `#[non_exhaustive]`).
    fn event_to_json(event: &DiscoveryEvent) -> Option<String> {
        let value = match event {
            DiscoveryEvent::Discovered { endpoint_info, .. } => {
                let (relay_urls, direct_addrs) = split_addrs(endpoint_info);
                serde_json::json!({
                    "type": "discovered",
                    "endpointId": endpoint_info.endpoint_id.to_string(),
                    "relayUrls": relay_urls,
                    "directAddrs": direct_addrs,
                })
            }
            DiscoveryEvent::Expired { endpoint_id } => serde_json::json!({
                "type": "expired",
                "endpointId": endpoint_id.to_string(),
            }),
            _ => return None,
        };
        Some(value.to_string())
    }

    /// Subscribes to `endpoint`'s live mDNS discovery stream. Validated
    /// synchronously (stale endpoint, or mDNS not enabled on it), then the stream
    /// is attached asynchronously: once live, `on_start` fires with the handle,
    /// thereafter `on_event` per discovery event, and `on_close` once when the
    /// stream ends (the endpoint closed).
    pub(crate) fn mdns_subscribe(
        endpoint: EndpointHandle,
        on_start: impl Fn(MdnsSubHandle) + Send + Sync + 'static,
        on_event: impl Fn(String) + Send + Sync + 'static,
        on_close: impl Fn(Option<IrohError>) + Send + Sync + 'static,
    ) -> Result<()> {
        let state = endpoint_state(endpoint)?;
        let lookup = state
            .mdns
            .as_ref()
            .map(|mdns| mdns.lookup.clone())
            .ok_or_else(|| {
                IrohError::MdnsUnavailable("create the endpoint with discovery.mdns first".into())
            })?;

        runtime().spawn(async move {
            let mut events = lookup.subscribe().await;
            let forward = runtime().spawn(async move {
                while let Some(event) = events.next().await {
                    if let Some(json) = event_to_json(&event) {
                        guarded_callback(|| on_event(json));
                    }
                }
                guarded_callback(move || on_close(None));
            });
            let handle = MDNS_SUBS.insert(MdnsSubscription {
                _task: AbortOnDropHandle::new(forward),
            });
            guarded_callback(|| on_start(MdnsSubHandle(handle)));
        });

        Ok(())
    }

    /// Ends a subscription started with [`mdns_subscribe`], aborting its task.
    /// Idempotent: an unknown or already-ended subscription is a no-op.
    pub(crate) fn mdns_unsubscribe(sub: MdnsSubHandle) {
        MDNS_SUBS.remove(sub.raw()).ok();
    }
}

#[cfg(feature = "mdns")]
pub(crate) use imp::{build_mdns, MdnsState};

/// Placeholder mDNS state for a build compiled without the feature. Uninhabited:
/// [`build_mdns`] never returns one, so the endpoint's `Option<MdnsState>` field
/// is always `None` here.
#[cfg(not(feature = "mdns"))]
#[derive(Debug)]
pub(crate) enum MdnsState {}

/// Feature-off: mDNS was not compiled in. Requesting it is a hard error, never a
/// silent no-op, so a caller can never mistake a compiled-out build for a working
/// one.
#[cfg(not(feature = "mdns"))]
pub(crate) fn build_mdns(_endpoint: &iroh::Endpoint, enabled: bool) -> Result<Option<MdnsState>> {
    if enabled {
        return Err(IrohError::MdnsUnavailable(
            "this build was compiled without the mdns feature".into(),
        ));
    }
    Ok(None)
}

/// Subscribes to an endpoint's mDNS discovery stream. With the feature on this
/// forwards the live stream; with it off it fails with
/// [`IrohError::MdnsUnavailable`].
pub fn mdns_subscribe(
    endpoint: EndpointHandle,
    on_start: impl Fn(MdnsSubHandle) + Send + Sync + 'static,
    on_event: impl Fn(String) + Send + Sync + 'static,
    on_close: impl Fn(Option<IrohError>) + Send + Sync + 'static,
) -> Result<()> {
    #[cfg(feature = "mdns")]
    {
        imp::mdns_subscribe(endpoint, on_start, on_event, on_close)
    }
    #[cfg(not(feature = "mdns"))]
    {
        let _ = (endpoint, on_start, on_event, on_close);
        Err(IrohError::MdnsUnavailable(
            "this build was compiled without the mdns feature".into(),
        ))
    }
}

/// Ends a subscription started with [`mdns_subscribe`]. Idempotent; a no-op on a
/// build compiled without the feature.
pub fn mdns_unsubscribe(sub: MdnsSubHandle) {
    #[cfg(feature = "mdns")]
    {
        imp::mdns_unsubscribe(sub);
    }
    #[cfg(not(feature = "mdns"))]
    {
        let _ = sub;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mdns_supported_matches_the_feature() {
        assert_eq!(MDNS_SUPPORTED, cfg!(feature = "mdns"));
    }

    /// The compiled-out contract (the default build, and every Apple build): mDNS
    /// is a hard error, never a silent no-op. This is what normal `cargo test`
    /// and CI run.
    #[cfg(not(feature = "mdns"))]
    #[test]
    fn subscribe_without_the_feature_reports_unavailable() {
        use crate::test_support::{close_endpoint_blocking, create_minimal_endpoint};

        let endpoint = create_minimal_endpoint(None);
        let result = mdns_subscribe(endpoint, |_| {}, |_| {}, |_| {});
        assert!(matches!(result, Err(IrohError::MdnsUnavailable(_))));
        // Unsubscribe on a compiled-out build is a harmless no-op.
        mdns_unsubscribe(MdnsSubHandle::from_raw(1));
        close_endpoint_blocking(endpoint).expect("close");
    }

    /// The compiled-out contract at creation: requesting `discovery.mdns` without
    /// the feature must fail creation rather than pretend discovery is running.
    #[cfg(not(feature = "mdns"))]
    #[test]
    fn creating_with_discovery_mdns_without_the_feature_reports_unavailable() {
        use crate::{
            endpoint::{EndpointConfig, NetworkPreset},
            test_support::create_endpoint_blocking,
        };

        let result = create_endpoint_blocking(EndpointConfig {
            preset: NetworkPreset::Minimal,
            blob_store_dir: None,
            gc: None,
            docs: false,
            docs_store_dir: None,
            discovery_mdns: true,
            relay_mode: None,
            alpns: Vec::new(),
        });
        assert!(matches!(result, Err(IrohError::MdnsUnavailable(_))));
    }

    /// The mechanism, with the feature on: an endpoint created with
    /// `discovery.mdns` builds and registers the mDNS lookup, and a subscription
    /// goes live (its `on_start` fires) even before any peer appears. Multicast
    /// reception between two endpoints is exercised separately (and is #[ignore]d
    /// because it needs a real LAN / device, not this sandbox).
    #[cfg(feature = "mdns")]
    #[test]
    fn mdns_endpoint_builds_registers_and_subscription_goes_live() {
        use std::sync::mpsc;

        use crate::{
            endpoint::endpoint_state,
            test_support::{close_endpoint_blocking, create_minimal_endpoint_with_mdns, TIMEOUT},
        };

        let endpoint = create_minimal_endpoint_with_mdns();
        assert!(
            endpoint_state(endpoint)
                .expect("live endpoint")
                .mdns
                .is_some(),
            "discovery.mdns must register an mDNS handle in the endpoint state"
        );

        let (start_tx, start_rx) = mpsc::channel();
        mdns_subscribe(
            endpoint,
            move |handle| {
                start_tx.send(handle).ok();
            },
            |_event| {},
            |_reason| {},
        )
        .expect("subscribe started");
        let handle = start_rx
            .recv_timeout(TIMEOUT)
            .expect("on_start fired: the discovery stream went live");

        mdns_unsubscribe(handle);
        // Unsubscribe is idempotent.
        mdns_unsubscribe(handle);
        close_endpoint_blocking(endpoint).expect("close");
    }

    /// Two endpoints on the same LAN discover each other by EndpointId over
    /// multicast with no relay and no seeded addresses. Ignored: multicast join
    /// is not available in this sandbox, so this is validated on a real LAN /
    /// device session, not here.
    #[cfg(feature = "mdns")]
    #[test]
    #[ignore = "needs real LAN multicast (device/two-machine session); sandbox blocks multicast join"]
    fn two_endpoints_discover_each_other_over_multicast() {
        use std::sync::mpsc;

        use crate::{
            endpoint::endpoint_id,
            test_support::{close_endpoint_blocking, create_minimal_endpoint_with_mdns, TIMEOUT},
        };

        let alice = create_minimal_endpoint_with_mdns();
        let bob = create_minimal_endpoint_with_mdns();
        let bob_id = endpoint_id(bob).expect("bob id");

        let (event_tx, event_rx) = mpsc::channel();
        mdns_subscribe(
            alice,
            |_handle| {},
            move |json| {
                event_tx.send(json).ok();
            },
            |_reason| {},
        )
        .expect("alice subscribe");

        // Alice must observe Bob discovered by his EndpointId.
        let deadline = std::time::Instant::now() + TIMEOUT;
        loop {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .expect("discovered bob within timeout");
            let json = event_rx.recv_timeout(remaining).expect("a discovery event");
            let value: serde_json::Value = serde_json::from_str(&json).expect("valid json");
            if value["type"].as_str() == Some("discovered")
                && value["endpointId"].as_str() == Some(bob_id.as_str())
            {
                break;
            }
        }

        close_endpoint_blocking(alice).expect("close alice");
        close_endpoint_blocking(bob).expect("close bob");
    }
}
