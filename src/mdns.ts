import type { EndpointId } from "./endpoint";
import { IrohError } from "./errors";
import { MessageQueue } from "./message-queue";
import { getIroh, type IrohBinding } from "./native";

/**
 * A peer appeared on the local network (or its address information was
 * updated), discovered over mDNS (`_irohv1._udp.local`).
 */
export interface MdnsDiscoveredEvent {
  readonly type: "discovered";
  /** The discovered peer's endpoint id. */
  readonly endpointId: EndpointId;
  /** Home-relay URLs the peer advertised over mDNS (usually empty on a LAN). */
  readonly relayUrls: readonly string[];
  /** Direct socket addresses (`host:port`) the peer advertised over mDNS. */
  readonly directAddrs: readonly string[];
}

/**
 * A previously discovered peer expired: it went inactive, unreachable, or
 * otherwise stopped advertising on the LAN.
 */
export interface MdnsExpiredEvent {
  readonly type: "expired";
  /** The endpoint id of the peer that expired. */
  readonly endpointId: EndpointId;
}

/**
 * One live mDNS discovery event, a discriminated union keyed by `type`.
 * Surfaced from {@link Mdns.subscribe}; mirrors iroh-mdns-address-lookup's
 * {@link https://docs.rs/iroh-mdns-address-lookup/0.4.0/iroh_mdns_address_lookup/enum.DiscoveryEvent.html DiscoveryEvent}.
 */
export type DiscoveryEvent = MdnsDiscoveredEvent | MdnsExpiredEvent;

/** Options for {@link Mdns.subscribe}. */
export interface MdnsSubscribeOptions {
  /**
   * How many discovery events to buffer before the oldest are dropped (a lagged
   * warning is logged when that happens). Defaults to the message-queue default
   * (1024).
   */
  capacity?: number;
}

/**
 * A live subscription to an endpoint's mDNS discovery stream: an async-iterable
 * event stream, a readiness promise, and teardown. Obtain one from
 * {@link Endpoint.mdns}`.subscribe`.
 */
export interface MdnsSubscription {
  /**
   * An `AsyncIterable` of {@link DiscoveryEvent}s in arrival order
   * (`for await (const e of sub.events)`). Buffering is bounded (see
   * {@link MdnsSubscribeOptions.capacity}); under overflow the oldest unread
   * events are dropped. Iteration ends when the subscription is torn down
   * ({@link unsubscribe} or the endpoint closing).
   *
   * This is ONE shared stream: consuming an event removes it, and `break`ing out
   * of the loop ends the subscription. Fan out in your own code if more than one
   * consumer needs every event.
   */
  readonly events: AsyncIterable<DiscoveryEvent>;
  /**
   * Resolves once the subscription is live (the discovery stream is attached).
   * Rejects with an {@link IrohError} if the subscription fails to start (e.g.
   * mDNS is not enabled on the endpoint, or the build was compiled without mDNS:
   * kind `"mdns-unavailable"`) or is torn down before it started.
   */
  readonly started: Promise<void>;
  /** Ends the subscription and its {@link events} iterator. Idempotent. */
  unsubscribe(): void;
}

/**
 * mDNS LAN discovery over an endpoint: peers on the same network resolve each
 * other by endpoint id with no relay and no seeded addresses. Namespaced as
 * {@link Endpoint.mdns}.
 *
 * Available only on an endpoint created with `discovery: { mdns: true }`, and
 * only in a build compiled with mDNS ({@link mdnsSupported}). On a build without
 * it, or an endpoint without mDNS, {@link subscribe} throws an {@link IrohError}
 * of kind `"mdns-unavailable"`.
 *
 * @see https://docs.rs/iroh-mdns-address-lookup/0.4.0/iroh_mdns_address_lookup/
 */
export interface Mdns {
  /**
   * Subscribes to this endpoint's live mDNS discovery stream and returns an
   * {@link MdnsSubscription}. Throws an {@link IrohError} of kind
   * `"mdns-unavailable"` synchronously if the endpoint was not created with mDNS
   * enabled, or if this build was compiled without mDNS.
   */
  subscribe(options?: MdnsSubscribeOptions): MdnsSubscription;
}

/**
 * The native mDNS calls a {@link MdnsSubscriptionController} needs, injected by
 * {@link Endpoint} so the controller stays testable in isolation.
 */
export interface MdnsSubscriptionBinding {
  /** Starts the native subscription; `onStart` fires with the subscription id. */
  startSubscribe(
    onStart: (subId: number) => void,
    onEvent: (event: string) => void,
    onClose: (event: string) => void,
  ): void;
  /** Ends a started subscription (idempotent natively). */
  unsubscribe(subId: number): void;
  /** Optional capacity for the event buffer. */
  capacity?: number;
  /** Invoked once the controller is torn down, so the owner can drop it. */
  onDispose?(): void;
}

/** Parses one native mDNS event line (a JSON {@link DiscoveryEvent}). */
function parseDiscoveryEvent(json: string): DiscoveryEvent {
  return JSON.parse(json) as DiscoveryEvent;
}

/**
 * Parses a native subscription close line (`"end"` or `"error <detail>"`) into
 * either a graceful end (`null`) or the typed {@link IrohError} that ended it.
 */
function parseCloseReason(event: string): IrohError | null {
  if (event === "end") {
    return null;
  }
  const detail = event.startsWith("error ") ? event.slice("error ".length) : event;
  return IrohError.from(new Error(detail));
}

/**
 * Internal implementation of {@link MdnsSubscription}. Bridges the native
 * onStart/onEvent/onClose callbacks to a {@link MessageQueue} of parsed events,
 * and settles `started` once the subscription id arrives (or rejects if it never
 * does). Not part of the public API surface.
 */
export class MdnsSubscriptionController implements MdnsSubscription {
  private readonly binding: MdnsSubscriptionBinding;
  private readonly queue: MessageQueue<DiscoveryEvent>;
  private subId: number | null = null;
  private disposed = false;
  /** Resolves with the subscription id once onStart fires. */
  private readonly ready: Promise<number>;
  readonly started: Promise<void>;
  private resolveReady!: (subId: number) => void;
  private rejectReady!: (error: unknown) => void;

  constructor(binding: MdnsSubscriptionBinding) {
    this.binding = binding;
    this.queue = new MessageQueue<DiscoveryEvent>({
      capacity: binding.capacity,
      onLagged: (dropped) => {
        console.warn(`react-native-iroh: mdns events lagging, ${dropped} dropped`);
      },
    });
    this.ready = new Promise<number>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // The readiness rejection must be observed somewhere even if the caller
    // ignores `started`; mark both handled here.
    this.ready.catch(() => undefined);
    this.started = this.ready.then(() => undefined);
    this.started.catch(() => undefined);
    // May throw synchronously (stale endpoint handle, mDNS not enabled, feature
    // compiled out): let it propagate to the subscribe() caller.
    this.binding.startSubscribe(
      (subId) => this.onStart(subId),
      (event) => this.queue.push(parseDiscoveryEvent(event)),
      (event) => this.onClose(event),
    );
  }

  get events(): AsyncIterable<DiscoveryEvent> {
    return this.queue;
  }

  unsubscribe(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.subId !== null) {
      this.unsubscribeNativeIgnoringTeardownRaces(this.subId);
    } else {
      // The id has not arrived yet; settle `started` and tear down natively once
      // onStart eventually fires (see onStart).
      this.rejectReady(new IrohError(7000, "mdns subscription ended before it started"));
    }
    this.queue.close();
    this.binding.onDispose?.();
  }

  private onStart(subId: number): void {
    this.subId = subId;
    if (this.disposed) {
      // Unsubscribed while the subscription was still starting: tear the native
      // side down now that we have its id.
      this.unsubscribeNativeIgnoringTeardownRaces(subId);
      return;
    }
    this.resolveReady(subId);
  }

  private onClose(event: string): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const error = parseCloseReason(event);
    if (this.subId === null) {
      // Close before start: the subscription never became live, so settle
      // `started` with the failure (or a generic one for a graceful pre-start
      // close, which should not happen but must not hang).
      this.rejectReady(error ?? new IrohError(7000, "mdns subscription closed before it started"));
    }
    this.queue.close(error);
    this.binding.onDispose?.();
  }

  /** Native unsubscribe is idempotent, and teardown can race an endpoint the
   * subscription is being closed out from under; either way nothing to recover. */
  private unsubscribeNativeIgnoringTeardownRaces(subId: number): void {
    try {
      this.binding.unsubscribe(subId);
    } catch {}
  }
}

/**
 * Whether this native build supports mDNS discovery, i.e. whether it was
 * compiled with the `mdns` Cargo feature. `false` on a build compiled out of
 * mDNS (every Apple build until the consumer holds the multicast entitlement),
 * where `discovery: { mdns: true }` and {@link Mdns.subscribe} both fail with an
 * {@link IrohError} of kind `"mdns-unavailable"`.
 *
 * This is the `MDNS_SUPPORTED` runtime value. It is a function rather than a
 * `const` on purpose: the answer comes from the native module, and reading it as
 * a top-level constant would force the native bridge to instantiate at import
 * time, breaking the guarantee that importing this package is side-effect-free
 * (and usable where the native module is absent). Call it once at startup and
 * cache the result yourself if you need a stable value.
 *
 * @param binding Advanced: an alternative native binding, primarily for tests.
 *   App code should omit it to use the real native module.
 */
export function mdnsSupported(binding: IrohBinding = getIroh()): boolean {
  try {
    return binding.mdnsSupported();
  } catch (error) {
    throw IrohError.from(error);
  }
}
