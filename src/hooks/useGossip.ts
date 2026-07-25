import { useCallback, useEffect, useRef, useState } from "react";

import type { Endpoint } from "../endpoint";
import { IrohError } from "../errors";
import type {
  GossipMessage,
  GossipNeighborEvent,
  GossipSubscribeOptions,
  GossipSubscription,
} from "../gossip";
import { appendCapped, DEFAULT_RETAINED, toError } from "./internal";

/** Lifecycle phase of a {@link useGossip} subscription. */
export type GossipStatus = "joining" | "joined" | "closed" | "error";

/** The reactive result of {@link useGossip}. */
export interface UseGossipResult {
  /**
   * Messages received on the topic, oldest first, capped at the most recent
   * {@link UseGossipOptions.retain} (default 500) so a chatty topic stays
   * bounded in memory.
   */
  readonly messages: GossipMessage[];
  /** Neighbor up/down events, oldest first, capped like {@link messages}. */
  readonly neighbors: GossipNeighborEvent[];
  /**
   * Broadcasts `text` to the topic. Always rejects with an
   * {@link import("../errors").IrohError}: kind `"invalid-handle"` when no
   * subscription is active (before joining, or after it closed), and the swarm
   * failure's own kind otherwise (e.g. `"gossip-message-too-large"`).
   */
  readonly broadcast: (text: string) => Promise<void>;
  /**
   * `"joining"` until the topic is actually joined, then `"joined"` (this
   * tracks the native join, so the first peer on a topic reaches `"joined"`
   * while still alone). Becomes `"closed"` if the subscription ends
   * underneath the component (the usual cause is the endpoint being closed
   * while this component stays mounted), after which {@link broadcast}
   * rejects. `"error"` if subscribing or the stream fails.
   */
  readonly status: GossipStatus;
  /** The failure, present only when `status` is `"error"`. */
  readonly error?: Error;
}

/** Options for {@link useGossip}: the underlying subscribe options plus how
 * many messages/neighbors to retain. */
export interface UseGossipOptions extends GossipSubscribeOptions {
  /**
   * Maximum retained messages and neighbor events. Older entries are dropped
   * past this cap. Defaults to {@link DEFAULT_RETAINED} (500).
   */
  retain?: number;
}

/**
 * Subscribes to a gossip `topic` over `endpoint` for the lifetime of the
 * calling component, draining the message and neighbor streams into reactive
 * state arrays and exposing a stable {@link UseGossipResult.broadcast}. It
 * subscribes on mount (and whenever `endpoint`, `topic`, or the options change)
 * and unsubscribes on unmount / change; no state is set after unmount.
 *
 * Pass `null` for `endpoint` (e.g. while it is still being created by
 * {@link useEndpoint}) to hold off subscribing; the result stays empty and
 * `"joining"` until an endpoint is provided.
 */
export function useGossip(
  endpoint: Endpoint | null,
  topic: string,
  options?: UseGossipOptions,
): UseGossipResult {
  const [messages, setMessages] = useState<GossipMessage[]>([]);
  const [neighbors, setNeighbors] = useState<GossipNeighborEvent[]>([]);
  const [status, setStatus] = useState<GossipStatus>("joining");
  const [error, setError] = useState<Error | undefined>(undefined);

  // The live subscription, held in a ref so `broadcast` stays referentially
  // stable across renders while still reaching the current subscription.
  const subscriptionRef = useRef<GossipSubscription | null>(null);

  // Deep-compare options so an inline object does not re-subscribe every
  // render; the effect reads the latest object through a ref.
  const optionsKey = JSON.stringify(options ?? {});
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    setMessages([]);
    setNeighbors([]);
    setStatus("joining");
    setError(undefined);
    if (endpoint === null) {
      return;
    }

    let active = true;
    let joinedOnce = false;
    const retain = optionsRef.current?.retain ?? DEFAULT_RETAINED;
    // Guarded: without it every received message schedules a redundant status
    // update for the whole life of a chatty subscription.
    const markJoined = (): void => {
      if (joinedOnce) {
        return;
      }
      joinedOnce = true;
      setStatus((prev) => (prev === "error" ? prev : "joined"));
    };
    const fail = (value: unknown): void => {
      if (!active) {
        return;
      }
      setStatus("error");
      setError(toError(value));
    };
    // Both streams end together when the subscription is torn down. If that
    // happens while this component is still mounted (endpoint.close(), say),
    // the hook must stop claiming to be joined and stop routing broadcasts to
    // a subscription that no longer exists.
    const markClosed = (): void => {
      if (!active) {
        return;
      }
      subscriptionRef.current = null;
      setStatus((prev) => (prev === "error" ? prev : "closed"));
    };

    let subscription: GossipSubscription;
    try {
      subscription = endpoint.gossip.subscribe(topic, optionsRef.current);
    } catch (subscribeError) {
      fail(subscribeError);
      return;
    }
    subscriptionRef.current = subscription;

    // The authoritative liveness signal. Traffic also marks the subscription
    // joined below, because a message can race ahead of the join callback, but
    // a lone first peer on a topic never sees traffic at all.
    void subscription.joined.then(
      () => {
        if (active) {
          markJoined();
        }
      },
      () => undefined,
    );

    void (async () => {
      try {
        for await (const message of subscription.messages) {
          if (!active) {
            break;
          }
          markJoined();
          setMessages((prev) => appendCapped(prev, message, retain));
        }
        markClosed();
      } catch (streamError) {
        fail(streamError);
      }
    })();

    void (async () => {
      try {
        for await (const event of subscription.neighbors) {
          if (!active) {
            break;
          }
          if (event.type === "up") {
            markJoined();
          }
          setNeighbors((prev) => appendCapped(prev, event, retain));
        }
      } catch (streamError) {
        fail(streamError);
      }
    })();

    return () => {
      active = false;
      subscriptionRef.current = null;
      subscription.unsubscribe();
    };
  }, [endpoint, topic, optionsKey]);

  const broadcast = useCallback(async (text: string): Promise<void> => {
    const subscription = subscriptionRef.current;
    if (subscription === null) {
      throw new IrohError(1001, "gossip subscription is not active");
    }
    await subscription.broadcast(text);
  }, []);

  return { messages, neighbors, broadcast, status, error };
}
