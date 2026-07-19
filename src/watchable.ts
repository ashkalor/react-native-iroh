/**
 * A reusable conflating latest-value fan-out.
 *
 * A {@link Watchable} broadcasts one stream of values to many consumers: any
 * number of callback listeners plus any number of independent async iterators.
 * Each iterator retains at most one undelivered value (latest-value
 * conflation): a consumer slower than the producer drops intermediate values
 * and observes only the newest, so memory stays O(1) per iterator regardless
 * of consumer speed.
 *
 * This is the single push / conflate / detach implementation shared by the
 * transfer progress stream (which layers a terminal settle/error decorator on
 * top) and the endpoint address stream (which is non-terminal until the
 * endpoint tears the watch down). Nothing here is transfer- or
 * address-specific.
 *
 * Not part of the public API surface.
 */

const DONE: IteratorReturnResult<undefined> = { value: undefined, done: true };

interface Waiter<T> {
  resolve(result: IteratorResult<T, undefined>): void;
  reject(error: unknown): void;
}

/**
 * A latest-value-conflating async iterator over a {@link Watchable}. At most
 * one undelivered value is retained; a newer value overwrites it. Pending
 * `next()` calls are resolved in FIFO order. The stream ends gracefully, or by
 * rethrowing a terminal error exactly once (the first waiter/`next()` observes
 * the error, the rest end).
 */
class ConflatingIterator<T> implements AsyncIterableIterator<T> {
  private pending: { value: T } | null = null;
  private readonly waiters: Waiter<T>[] = [];
  private terminal: { error: unknown } | null = null;
  private errorDelivered = false;

  constructor(private readonly detach: () => void) {}

  /** Delivers a value: hands it to the oldest waiter, or conflates. */
  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.pending = { value };
      return;
    }
    waiter.resolve({ value, done: false });
  }

  /**
   * Marks the stream terminal. A non-null `error` is rejected into the first
   * waiter (exactly once); every other waiter ends. `null` ends gracefully.
   */
  finish(error: unknown | null): void {
    if (this.terminal !== null) {
      return;
    }
    this.terminal = { error };
    for (const waiter of this.waiters.splice(0)) {
      if (error !== null && !this.errorDelivered) {
        this.errorDelivered = true;
        waiter.reject(error);
      } else {
        waiter.resolve(DONE);
      }
    }
  }

  next(): Promise<IteratorResult<T, undefined>> {
    if (this.pending !== null) {
      const { value } = this.pending;
      this.pending = null;
      return Promise.resolve({ value, done: false });
    }
    if (this.terminal !== null) {
      if (this.terminal.error !== null && !this.errorDelivered) {
        this.errorDelivered = true;
        return Promise.reject(this.terminal.error);
      }
      return Promise.resolve(DONE);
    }
    return new Promise<IteratorResult<T, undefined>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  return(): Promise<IteratorResult<T, undefined>> {
    this.detach();
    this.pending = null;
    if (this.terminal === null) {
      this.terminal = { error: null };
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(DONE);
    }
    return Promise.resolve(DONE);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

/**
 * Lifecycle hooks a {@link Watchable} fires as its active-subscriber count
 * transitions across zero: `onActive` when the first subscriber attaches (0 ->
 * 1), `onIdle` when the last one detaches (1 -> 0). They let an owner start and
 * stop an underlying source lazily. A graceful {@link Watchable.close} does not
 * fire `onIdle` (the owner is already tearing the source down).
 */
export interface WatchableHooks {
  onActive?(): void;
  onIdle?(): void;
}

/**
 * The generic conflating fan-out. Delivers each pushed value to every listener
 * and every attached {@link ConflatingIterator}; {@link close} ends all
 * iterators (gracefully, or by having one rethrow a terminal error).
 */
export class Watchable<T> {
  /** An `AsyncIterable` yielding a fresh conflating iterator per consumer. */
  readonly stream: AsyncIterable<T>;

  private closed = false;
  private terminalError: unknown | null = null;
  private subscribers = 0;
  private readonly listeners = new Set<(value: T) => void>();
  private readonly iterators = new Set<ConflatingIterator<T>>();

  constructor(private readonly hooks: WatchableHooks = {}) {
    this.stream = {
      [Symbol.asyncIterator]: () => this.createIterator(),
    };
  }

  /** Whether the stream has been closed (settled). */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Subscribes a callback listener. Returns an unsubscribe function;
   * subscribing after {@link close} is a no-op. Unsubscribe is idempotent.
   */
  listen(listener: (value: T) => void): () => void {
    if (this.closed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    this.retain();
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.listeners.delete(listener);
      this.release();
    };
  }

  /** Delivers a value to every listener and iterator. No-op once closed. */
  push(value: T): void {
    if (this.closed) {
      return;
    }
    // A Set tolerates delete-during-iteration, so an unsubscribe (or iterator
    // detach) triggered from inside a callback needs no defensive copy.
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch (error) {
        // A throwing listener must not break other consumers or the native
        // callback that drives this push; surface it without propagating.
        console.error("react-native-iroh: watchable listener threw", error);
      }
    }
    for (const iterator of this.iterators) {
      iterator.push(value);
    }
  }

  /**
   * Terminates the stream for all current and future consumers. A non-null
   * `error` is rethrown by exactly one waiting/next iterator; the rest end.
   * Idempotent.
   */
  close(error: unknown | null = null): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.terminalError = error;
    this.listeners.clear();
    const iterators = [...this.iterators];
    this.iterators.clear();
    for (const iterator of iterators) {
      iterator.finish(error);
    }
  }

  private createIterator(): ConflatingIterator<T> {
    if (this.closed) {
      const iterator = new ConflatingIterator<T>(() => undefined);
      iterator.finish(this.terminalError);
      return iterator;
    }
    let detached = false;
    const iterator = new ConflatingIterator<T>(() => {
      if (detached) {
        return;
      }
      detached = true;
      this.iterators.delete(iterator);
      this.release();
    });
    this.iterators.add(iterator);
    this.retain();
    return iterator;
  }

  private retain(): void {
    this.subscribers += 1;
    if (this.subscribers === 1) {
      this.hooks.onActive?.();
    }
  }

  private release(): void {
    this.subscribers -= 1;
    if (this.subscribers === 0) {
      this.hooks.onIdle?.();
    }
  }
}
