import { useCallback, useEffect, useRef, useState } from "react";

import type { Endpoint } from "../endpoint";
import type {
  GossipMessage,
  GossipNeighborEvent,
  GossipSubscribeOptions,
  GossipSubscription,
} from "../gossip";
import { appendCapped, DEFAULT_RETAINED, toError } from "./internal";

/** Lifecycle phase of a {@link useGossip} subscription. */
export type GossipStatus = "joining" | "joined" | "error";

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
   * Broadcasts `text` to the topic. Rejects if called before the subscription
   * is active, or with an {@link import("../errors").IrohError} on a swarm
   * failure (e.g. the message exceeds the size limit).
   */
  readonly broadcast: (text: string) => Promise<void>;
  /**
   * `"joining"` until the swarm is live (the first message or neighbor-up
   * arrives), then `"joined"`; `"error"` if subscribing or the stream fails.
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
    const retain = optionsRef.current?.retain ?? DEFAULT_RETAINED;
    const markJoined = (): void => {
      setStatus((prev) => (prev === "error" ? prev : "joined"));
    };
    const fail = (value: unknown): void => {
      if (!active) {
        return;
      }
      setStatus("error");
      setError(toError(value));
    };

    let subscription: GossipSubscription;
    try {
      subscription = endpoint.gossip.subscribe(topic, optionsRef.current);
    } catch (subscribeError) {
      fail(subscribeError);
      return;
    }
    subscriptionRef.current = subscription;

    void (async () => {
      try {
        for await (const message of subscription.messages) {
          if (!active) {
            break;
          }
          markJoined();
          setMessages((prev) => appendCapped(prev, message, retain));
        }
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
      throw new Error("react-native-iroh: gossip subscription is not active");
    }
    await subscription.broadcast(text);
  }, []);

  return { messages, neighbors, broadcast, status, error };
}
