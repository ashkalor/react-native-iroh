import { IrohError } from "./errors";

/**
 * A single progress report for an in-flight download.
 */
export interface ProgressEvent {
  /**
   * Cumulative payload bytes received so far. Monotonically non-decreasing.
   * The blob's total size is unknown in v0.1.0.
   */
  readonly bytesReceived: number;
}

/**
 * Handle for one download started with {@link Blobs.download}.
 *
 * Progress can be observed two ways, and both may be used at once:
 *
 * - Callback subscription: {@link Transfer.onProgress}.
 * - `for await (const event of transfer.progress)`: each iteration of
 *   {@link Transfer.progress} yields conflated {@link ProgressEvent}s: if
 *   the consumer is slower than the (already native-side throttled) event
 *   stream, intermediate values are dropped and only the latest is delivered,
 *   so memory use is O(1) regardless of consumer speed.
 */
export interface Transfer {
  /**
   * Settles exactly once: resolves when the download completes, rejects with
   * an {@link IrohError} on failure or cancellation (kind `"cancelled"`).
   *
   * Rejections are internally marked as observed, so consumers that watch
   * only the `progress` iterator (which rethrows the terminal error) do not
   * trigger unhandled-rejection warnings.
   */
  readonly promise: Promise<void>;
  /**
   * Alias of {@link Transfer.promise}: the same settlement Promise under the
   * name most call sites read best (`await transfer.done`). Both are
   * documented and stable; use whichever fits.
   */
  readonly done: Promise<void>;
  /**
   * Async-iterable view of the progress stream. Each `for await` gets an
   * independent iterator that receives events from that point on, ends when
   * the download completes, and throws the terminal {@link IrohError} if the
   * download fails or is cancelled. Latest-value conflation keeps buffering
   * bounded; breaking out of the loop detaches the iterator.
   */
  readonly progress: AsyncIterable<ProgressEvent>;
  /** Whether the transfer has already settled (completed, failed, or cancelled). */
  readonly isSettled: boolean;
  /**
   * Requests cancellation. Idempotent and safe at any point: a transfer still
   * waiting in the download queue is failed immediately with kind
   * `"cancelled"`; an active transfer is cancelled natively and its promise
   * rejects with code `3003`. No-op after the transfer has settled.
   */
  cancel(): void;
  /**
   * Subscribes to progress events. The listener is invoked synchronously on
   * the JS thread with already-coalesced native events (at most ~30/s), so it
   * should stay cheap. Returns an unsubscribe function; subscribing after the
   * transfer settled is a no-op.
   */
  onProgress(listener: (event: ProgressEvent) => void): () => void;
}

/** Starts the native download; provided by {@link Endpoint}. */
type StartDownload = (
  onStart: (transferId: number) => void,
  onProgress: (bytesReceived: number) => void,
) => Promise<void>;

interface Waiter {
  resolve(result: IteratorResult<ProgressEvent, undefined>): void;
  reject(error: IrohError): void;
}

const DONE: IteratorReturnResult<undefined> = { value: undefined, done: true };

/**
 * Latest-value-conflating async iterator over a transfer's progress stream.
 * At most one undelivered event is retained per iterator; a newer event
 * overwrites it. Pending `next()` calls are resolved in FIFO order.
 */
class ProgressIterator implements AsyncIterableIterator<ProgressEvent> {
  private pending: ProgressEvent | null = null;
  private readonly waiters: Waiter[] = [];
  private terminal: { error: IrohError | null } | null = null;
  private errorDelivered = false;

  constructor(private readonly detach: () => void) {}

  /** Delivers an event: hands it to the oldest waiter, or conflates. */
  push(event: ProgressEvent): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.pending = event;
      return;
    }
    waiter.resolve({ value: event, done: false });
  }

  /** Marks the stream terminal; the first waiter observes a failure, the rest end. */
  finish(error: IrohError | null): void {
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

  next(): Promise<IteratorResult<ProgressEvent, undefined>> {
    if (this.pending !== null) {
      const event = this.pending;
      this.pending = null;
      return Promise.resolve({ value: event, done: false });
    }
    if (this.terminal !== null) {
      if (this.terminal.error !== null && !this.errorDelivered) {
        this.errorDelivered = true;
        return Promise.reject(this.terminal.error);
      }
      return Promise.resolve(DONE);
    }
    return new Promise<IteratorResult<ProgressEvent, undefined>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  return(): Promise<IteratorResult<ProgressEvent, undefined>> {
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

  [Symbol.asyncIterator](): AsyncIterableIterator<ProgressEvent> {
    return this;
  }
}

/**
 * Internal implementation of {@link Transfer}. Constructed by
 * {@link Blobs.download}; {@link TransferController.begin} is invoked
 * by the endpoint's download queue when a concurrency slot frees up.
 *
 * Not part of the public API surface.
 */
export class TransferController implements Transfer {
  readonly promise: Promise<void>;
  readonly done: Promise<void>;
  readonly progress: AsyncIterable<ProgressEvent>;

  private resolvePromise!: () => void;
  private rejectPromise!: (error: IrohError) => void;
  private settled = false;
  private started = false;
  private cancelRequested = false;
  private terminalError: IrohError | null = null;
  private nativeTransferId: number | null = null;
  private readonly listeners = new Set<(event: ProgressEvent) => void>();
  private readonly iterators = new Set<ProgressIterator>();

  constructor(
    private readonly startDownload: StartDownload,
    private readonly requestNativeCancel: (transferId: number) => void,
  ) {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
    // Mark rejections as observed: the terminal error is also surfaced
    // through the progress iterators, so consumers are not forced to attach
    // their own handler to `promise` to avoid unhandled-rejection noise.
    this.promise.catch(() => undefined);
    this.done = this.promise;
    this.progress = {
      [Symbol.asyncIterator]: () => this.createIterator(),
    };
  }

  get isSettled(): boolean {
    return this.settled;
  }

  /**
   * Starts the native download. Called exactly once by the endpoint's queue.
   * The returned promise settles (always resolves) when the transfer does,
   * which is what the queue uses to free the concurrency slot.
   */
  begin(): Promise<void> {
    this.started = true;
    if (this.settled) {
      return Promise.resolve();
    }
    let downloading: Promise<void>;
    try {
      downloading = this.startDownload(
        (transferId) => {
          this.nativeTransferId = transferId;
          if (this.cancelRequested) {
            this.requestNativeCancel(transferId);
          }
        },
        (bytesReceived) => {
          this.dispatchProgress(bytesReceived);
        },
      );
    } catch (error) {
      this.settle(IrohError.from(error));
      return Promise.resolve();
    }
    return downloading.then(
      () => {
        this.settle(null);
      },
      (error: unknown) => {
        this.settle(IrohError.from(error));
      },
    );
  }

  cancel(): void {
    if (this.settled) {
      return;
    }
    this.cancelRequested = true;
    if (!this.started) {
      // Still waiting in the FIFO queue: fail locally, never touch native.
      this.settle(new IrohError(3003, "download cancelled before it started"));
      return;
    }
    if (this.nativeTransferId !== null) {
      this.requestNativeCancel(this.nativeTransferId);
    }
    // Otherwise the native download has not reported its transfer id yet;
    // the onStart callback observes `cancelRequested` and cancels then.
  }

  onProgress(listener: (event: ProgressEvent) => void): () => void {
    if (this.settled) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private createIterator(): ProgressIterator {
    const iterator = new ProgressIterator(() => {
      this.iterators.delete(iterator);
    });
    if (this.settled) {
      iterator.finish(this.terminalError);
    } else {
      this.iterators.add(iterator);
    }
    return iterator;
  }

  private dispatchProgress(bytesReceived: number): void {
    if (this.settled) {
      return;
    }
    const event: ProgressEvent = { bytesReceived };
    // Set iteration tolerates delete-during-iteration, so an unsubscribe (or
    // iterator detach) from inside a callback needs no defensive copy.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // A throwing listener must not break other consumers or the native
        // callback; surface it without propagating.
        console.error("react-native-iroh: onProgress listener threw", error);
      }
    }
    for (const iterator of this.iterators) {
      iterator.push(event);
    }
  }

  private settle(error: IrohError | null): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.terminalError = error;
    this.listeners.clear();
    const iterators = [...this.iterators];
    this.iterators.clear();
    for (const iterator of iterators) {
      iterator.finish(error);
    }
    if (error !== null) {
      this.rejectPromise(error);
    } else {
      this.resolvePromise();
    }
  }
}
