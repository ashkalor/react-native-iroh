/**
 * A bounded FIFO async-iterable: a non-conflating, single-stream primitive for
 * discrete events that must each be delivered (chat messages, neighbor events).
 *
 * How it differs from {@link Watchable}: a {@link Watchable} is a
 * latest-value-conflating fan-out (a slow consumer sees only the newest value,
 * older ones are discarded). That is right for state (an address, a progress
 * total) but wrong for a message log, where dropping an intermediate value
 * loses a chat line. A {@link MessageQueue} instead buffers every pushed value
 * in order and delivers them one by one. It stays bounded by a capacity: on
 * overflow it drops the OLDEST buffered value (so the live tail always gets
 * through) and surfaces a lagged signal via the {@link MessageQueueOptions.onLagged}
 * hook and the {@link MessageQueue.dropped} count.
 *
 * It is a single logical stream (its own `AsyncIterableIterator`): iterating it
 * consumes values. It reuses {@link Watchable}'s FIFO-waiter resolution pattern
 * (pending `next()` calls resolved in order) but not its conflation.
 *
 * Not part of the public API surface.
 */

import { DONE, WaiterQueue } from "./waiter-queue";

/** Default capacity: how many undelivered values a queue buffers before it
 * starts dropping the oldest. */
export const DEFAULT_MESSAGE_QUEUE_CAPACITY = 1024;

/** Construction options for a {@link MessageQueue}. */
export interface MessageQueueOptions {
  /**
   * Maximum number of undelivered values buffered before the queue drops the
   * oldest on each further push. Defaults to
   * {@link DEFAULT_MESSAGE_QUEUE_CAPACITY}. Values below 1 are clamped to 1.
   */
  capacity?: number;
  /**
   * Invoked whenever the queue falls behind and a value is dropped: either its
   * own buffer overflowed (drop-oldest) or an upstream source reported a lag
   * ({@link MessageQueue.markLagged}). Receives the running total dropped. Must
   * not throw.
   */
  onLagged?(totalDropped: number): void;
}

/**
 * A bounded FIFO async-iterable. Push values in; iterate them out in order.
 * Overflow drops the oldest buffered value. Terminate with {@link close}.
 */
export class MessageQueue<T> implements AsyncIterableIterator<T> {
  private readonly capacity: number;
  private readonly onLagged?: (totalDropped: number) => void;
  private readonly buffer: T[] = [];
  private readonly consumers = new WaiterQueue<T>();
  private droppedCount = 0;

  constructor(options: MessageQueueOptions = {}) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_MESSAGE_QUEUE_CAPACITY));
    this.onLagged = options.onLagged;
  }

  /** Whether the queue has been closed (settled). */
  get isClosed(): boolean {
    return this.consumers.isSettled;
  }

  /** Running total of values dropped to overflow or upstream lag. */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Enqueues a value. If a consumer is awaiting `next()`, it is delivered
   * directly (FIFO); otherwise it is buffered. When the buffer is already at
   * capacity, the oldest buffered value is dropped to make room and the lag is
   * surfaced. No-op once closed.
   */
  push(value: T): void {
    if (this.consumers.isSettled) {
      return;
    }
    // Invariant: consumers park only while the buffer is empty (next() drains
    // the buffer before parking), so at most one of the two ever holds
    // anything. Hand off to the oldest waiter first, preserving order.
    if (this.consumers.handOff(value)) {
      return;
    }
    this.buffer.push(value);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
      this.recordDrop();
    }
  }

  /**
   * Records that an upstream source dropped values (e.g. native gossip
   * `Lagged`), surfacing it exactly like a local overflow. Does not itself
   * discard a buffered value; it only advances the dropped count and signal.
   */
  markLagged(): void {
    if (this.consumers.isSettled) {
      return;
    }
    this.recordDrop();
  }

  /**
   * Terminates the stream. A non-null `error` is thrown by the next (or a
   * pending) `next()` exactly once, then iteration ends; `null` ends
   * gracefully. Any buffered-but-undelivered values are discarded. Idempotent.
   */
  close(error: unknown | null = null): void {
    if (this.consumers.isSettled) {
      return;
    }
    this.buffer.length = 0;
    this.consumers.settle(error);
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift() as T, done: false });
    }
    return this.consumers.settledResult() ?? this.consumers.park();
  }

  /** Detaches the consumer (e.g. `break` out of a `for await`): closes the
   * queue gracefully. */
  return(): Promise<IteratorResult<T, undefined>> {
    this.close();
    return Promise.resolve(DONE);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  private recordDrop(): void {
    this.droppedCount += 1;
    try {
      this.onLagged?.(this.droppedCount);
    } catch (error) {
      // A throwing lag handler must not break the producing native callback.
      console.error("react-native-iroh: message-queue onLagged handler threw", error);
    }
  }
}
