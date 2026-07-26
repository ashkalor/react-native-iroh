/**
 * The parked-consumer and terminal-state core shared by the library's
 * async-iterable primitives.
 *
 * {@link Watchable}'s iterators and {@link MessageQueue} differ only in their
 * BUFFERING POLICY (conflate to the latest value, versus a bounded FIFO). The
 * rest is identical and subtle enough to be worth having exactly one of: park
 * consumers in FIFO order, hand each new value to the oldest waiter, and on
 * termination deliver the error to exactly one consumer while every other
 * parked consumer ends gracefully. That last rule had two independent
 * implementations, each separately re-proved by its own tests.
 *
 * Owners keep their buffering policy and delegate the rest here.
 *
 * Not part of the public API surface.
 */

/** The result an ended iterator yields, shared to avoid re-allocating it. */
export const DONE: IteratorReturnResult<undefined> = { value: undefined, done: true };

interface Waiter<T> {
  resolve(result: IteratorResult<T, undefined>): void;
  reject(error: unknown): void;
}

/** FIFO parked consumers plus the stream's terminal state. */
export class WaiterQueue<T> {
  private readonly waiters: Waiter<T>[] = [];
  private terminal: { error: unknown } | null = null;
  private errorDelivered = false;

  /** Whether the stream has terminated. */
  get isSettled(): boolean {
    return this.terminal !== null;
  }

  /**
   * Hands `value` to the longest-parked consumer. Returns `false` when nobody
   * was waiting, leaving the caller to apply its own buffering policy.
   */
  handOff(value: T): boolean {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      return false;
    }
    waiter.resolve({ value, done: false });
    return true;
  }

  /** Parks a consumer until a value arrives or the stream settles. */
  park(): Promise<IteratorResult<T, undefined>> {
    return new Promise<IteratorResult<T, undefined>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Terminates the stream. A non-null `error` is rejected into the first parked
   * consumer and never re-delivered; every other parked consumer ends
   * gracefully, as does `null`. Idempotent.
   */
  settle(error: unknown | null): void {
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

  /**
   * What a settled stream owes the consumer calling `next()`, or `null` while
   * it is still live. The terminal error is thrown exactly once across every
   * path that can observe it, including this one.
   */
  settledResult(): Promise<IteratorResult<T, undefined>> | null {
    if (this.terminal === null) {
      return null;
    }
    if (this.terminal.error !== null && !this.errorDelivered) {
      this.errorDelivered = true;
      return Promise.reject(this.terminal.error);
    }
    return Promise.resolve(DONE);
  }
}
