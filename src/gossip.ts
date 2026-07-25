import type { EndpointAddr, EndpointId } from "./endpoint";
import { IrohError } from "./errors";
import { MessageQueue } from "./message-queue";

/**
 * One message received on a gossip topic.
 */
export interface GossipMessage {
  /** The message text (UTF-8). */
  readonly text: string;
  /**
   * The id of the endpoint that delivered this message to us. This is the
   * neighbor we received it from, which for multi-hop gossip is not necessarily
   * the original author.
   */
  readonly from: EndpointId;
}

/**
 * A change in the set of direct neighbors on a gossip topic's swarm.
 */
export interface GossipNeighborEvent {
  /** `"up"` when a direct neighbor joined, `"down"` when one left. */
  readonly type: "up" | "down";
  /** The neighbor endpoint's id. */
  readonly endpointId: EndpointId;
}

/**
 * Options for {@link Gossip.subscribe}.
 */
export interface GossipSubscribeOptions {
  /**
   * Bootstrap peers to seed the swarm with: their addresses are registered so
   * the topic can dial them by id, and their ids become the initial peers.
   * Omit (or pass an empty list) to rely purely on discovery (which needs the
   * `"n0"` preset). On the `"minimal"` preset at least one bootstrap peer is
   * required for two endpoints to find each other.
   */
  bootstrap?: readonly EndpointAddr[];
  /**
   * How many received messages to buffer before the oldest are dropped (a
   * `"lagged"` signal is logged when that happens). Defaults to the
   * message-queue default (1024). Raise it for bursty topics a slow consumer
   * must not miss.
   */
  capacity?: number;
}

/**
 * A live subscription to a gossip topic: an async-iterable message log, an
 * async-iterable neighbor-event stream, a broadcast method, and teardown.
 * Obtain one from {@link Endpoint.gossip}`.subscribe`.
 *
 * @see https://docs.rs/iroh-gossip/0.101.0/iroh_gossip/
 */
export interface GossipSubscription {
  /**
   * An `AsyncIterable` of {@link GossipMessage}s received on the topic, in
   * arrival order (`for await (const m of sub.messages)`). Buffering is bounded
   * (see {@link GossipSubscribeOptions.capacity}): under overflow the oldest
   * unread messages are dropped so the live tail keeps flowing. Iteration ends
   * when the subscription is torn down ({@link unsubscribe} or the endpoint
   * closing); break out of the loop to stop consuming.
   *
   * This is ONE shared stream, not a re-iterable collection: consuming a
   * message removes it. Two concurrent `for await` loops split the messages
   * between them rather than each seeing every message, and `break`ing out of
   * a loop ends the subscription. Fan out in your own code (push into state,
   * or an event emitter) if more than one consumer needs every message.
   */
  readonly messages: AsyncIterable<GossipMessage>;
  /**
   * An `AsyncIterable` of {@link GossipNeighborEvent}s (neighbors joining and
   * leaving the swarm). Ends with the subscription. One shared stream, with the
   * same single-consumer semantics as {@link messages}.
   */
  readonly neighbors: AsyncIterable<GossipNeighborEvent>;
  /**
   * Resolves once the topic has actually been joined and the subscription is
   * live, which is the moment {@link broadcast} stops having to wait.
   *
   * Prefer this over inferring liveness from the first message or neighbor
   * event: the first peer on a topic joins successfully and then sits alone,
   * so no traffic arrives until someone else shows up. Rejects if the
   * subscription is torn down before it ever started.
   */
  readonly joined: Promise<void>;
  /**
   * Broadcasts `text` (UTF-8) to every peer on the topic. Resolves once the
   * message is handed to the swarm (peer delivery is best effort); rejects with
   * an {@link IrohError} of kind `"gossip-message-too-large"` if `text` exceeds
   * the 4096-byte per-message limit, or `"gossip-broadcast"` on a swarm
   * failure. If called before the topic has finished joining, it waits for the
   * join to complete first.
   */
  broadcast(text: string): Promise<void>;
  /**
   * Leaves the topic and ends the {@link messages} / {@link neighbors}
   * iterators. Idempotent.
   */
  unsubscribe(): void;
}

/** The native calls a {@link GossipSubscriptionController} needs, injected by
 * {@link Endpoint} so the controller stays testable in isolation. */
export interface GossipBinding {
  /** Starts the native subscription; `onStart` fires with the subscription id. */
  startSubscribe(
    onStart: (subId: number) => void,
    onMessage: (message: string) => void,
    onNeighbor: (event: string) => void,
  ): void;
  /** Broadcasts a payload on a started subscription. */
  broadcast(subId: number, payload: string): Promise<void>;
  /** Ends a started subscription (idempotent natively). */
  unsubscribe(subId: number): void;
  /** Optional capacity for the message buffer. */
  capacity?: number;
  /** Invoked once the controller is torn down, so the owner can drop it. */
  onDispose?(): void;
}

/**
 * Splits one native callback line into its leading tag and the remainder.
 *
 * Every gossip line the Rust core emits is `"<tag> <rest>"` (`"<from-id>
 * <utf8-text>"` for a message, `"up <id>"` / `"down <id>"` for a neighbor
 * event). Only the FIRST space is a delimiter, so a payload containing spaces
 * survives intact. A line with no space has no rest.
 */
function splitTagged(line: string): { tag: string; rest: string; delimited: boolean } {
  const space = line.indexOf(" ");
  if (space === -1) {
    return { tag: line, rest: "", delimited: false };
  }
  return { tag: line.slice(0, space), rest: line.slice(space + 1), delimited: true };
}

/** Parses the native `onMessage` payload into a {@link GossipMessage}. An
 * undelimited line is taken as text from an unknown sender rather than
 * discarded, so a message is never silently lost. */
function parseMessage(line: string): GossipMessage {
  const { tag, rest, delimited } = splitTagged(line);
  return delimited
    ? { from: tag as EndpointId, text: rest }
    : { from: "" as EndpointId, text: line };
}

/**
 * Internal implementation of {@link GossipSubscription}. Bridges the native
 * onStart/onMessage/onNeighbor callbacks to two {@link MessageQueue}s and
 * defers broadcasts until the topic has joined (the subscription id arrives via
 * onStart).
 *
 * Not part of the public API surface.
 */
export class GossipSubscriptionController implements GossipSubscription {
  private readonly binding: GossipBinding;
  private readonly messageQueue: MessageQueue<GossipMessage>;
  private readonly neighborQueue: MessageQueue<GossipNeighborEvent>;
  private subId: number | null = null;
  private disposed = false;
  /** Resolves with the subscription id once onStart fires (for broadcast). */
  private readonly ready: Promise<number>;
  readonly joined: Promise<void>;
  private resolveReady!: (subId: number) => void;
  private rejectReady!: (error: unknown) => void;

  constructor(binding: GossipBinding) {
    this.binding = binding;
    this.messageQueue = new MessageQueue<GossipMessage>({
      capacity: binding.capacity,
      onLagged: (dropped) => {
        console.warn(`react-native-iroh: gossip messages lagging, ${dropped} dropped`);
      },
    });
    this.neighborQueue = new MessageQueue<GossipNeighborEvent>();
    this.ready = new Promise<number>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A broadcast issued before the id arrives awaits `ready`; if the
    // subscription is never established, that rejection must be observed
    // somewhere, so mark it handled here (and on the public `joined` view,
    // which callers are free to ignore).
    this.ready.catch(() => undefined);
    this.joined = this.ready.then(() => undefined);
    this.joined.catch(() => undefined);
    // May throw synchronously (stale endpoint handle, bad bootstrap address):
    // let it propagate to the subscribe() caller.
    this.binding.startSubscribe(
      (subId) => this.onStart(subId),
      (message) => this.messageQueue.push(parseMessage(message)),
      (event) => this.onNeighbor(event),
    );
  }

  get messages(): AsyncIterable<GossipMessage> {
    return this.messageQueue;
  }

  get neighbors(): AsyncIterable<GossipNeighborEvent> {
    return this.neighborQueue;
  }

  async broadcast(text: string): Promise<void> {
    try {
      const subId = this.subId ?? (await this.ready);
      await this.binding.broadcast(subId, text);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  unsubscribe(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // If the id has not arrived yet, unblock any pending broadcast; the native
    // side is unsubscribed once onStart eventually fires (see onStart).
    if (this.subId !== null) {
      this.unsubscribeNativeIgnoringTeardownRaces(this.subId);
    } else {
      this.rejectReady(new IrohError(1001, "gossip subscription ended before it started"));
    }
    this.messageQueue.close();
    this.neighborQueue.close();
    this.binding.onDispose?.();
  }

  private onStart(subId: number): void {
    this.subId = subId;
    if (this.disposed) {
      // Unsubscribed while the join was still in flight: tear the native
      // subscription down now that we have its id.
      this.unsubscribeNativeIgnoringTeardownRaces(subId);
      return;
    }
    this.resolveReady(subId);
  }

  private onNeighbor(event: string): void {
    if (event === "lagged") {
      // Native receiver fell behind: surface it through the message queue's
      // lagged signal, the same channel a local overflow uses.
      this.messageQueue.markLagged();
      return;
    }
    const { tag, rest, delimited } = splitTagged(event);
    if (delimited && (tag === "up" || tag === "down")) {
      this.neighborQueue.push({ type: tag, endpointId: rest as EndpointId });
    }
  }

  /** Native unsubscribe is idempotent, and teardown can race a subscription
   * the endpoint is closing out from under us; either way there is nothing to
   * recover from here. */
  private unsubscribeNativeIgnoringTeardownRaces(subId: number): void {
    try {
      this.binding.unsubscribe(subId);
    } catch {}
  }
}
