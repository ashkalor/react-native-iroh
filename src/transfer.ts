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

/**
 * Live progress of one file within a {@link CollectionTransfer}.
 */
export interface FileProgress {
  /** The child's name within the collection (its source file's base name). */
  readonly name: string;
  /** Cumulative payload bytes received for this file. Non-decreasing. */
  readonly bytesReceived: number;
  /**
   * This file's total size in bytes, when known. Currently always `undefined`
   * (the per-blob transfer does not report a total; see {@link ProgressEvent}).
   */
  readonly totalBytes?: number;
  /** Whether this file has finished downloading. */
  readonly done: boolean;
}

/**
 * A {@link Transfer} for a whole collection: the aggregate progress stream
 * (`bytesReceived` summed across all files) plus a live per-file breakdown in
 * {@link CollectionTransfer.files}. Every ergonomic of a single-blob transfer
 * (`done` / `promise`, `progress`, `onProgress`, `cancel`, `isSettled`)
 * behaves identically, measured over the collection as a whole.
 */
export interface CollectionTransfer extends Transfer {
  /**
   * A snapshot of each file's progress, in collection order. The array
   * identity and its entries update in place as the download proceeds; read it
   * whenever you render (e.g. inside an `onProgress` callback).
   */
  readonly files: FileProgress[];
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
 * The progress fan-out shared by every transfer: the settlement Promise
 * (`promise` / `done`), the callback listeners, and the conflating async
 * iterators. It owns the `Transfer` "read side" so that both a single-blob
 * {@link TransferController} and an aggregate {@link CollectionTransfer} share
 * one implementation of it rather than each reimplementing the plumbing.
 *
 * Not part of the public API surface.
 */
class ProgressHub {
  readonly promise: Promise<void>;
  readonly done: Promise<void>;
  readonly progress: AsyncIterable<ProgressEvent>;

  private resolvePromise!: () => void;
  private rejectPromise!: (error: IrohError) => void;
  private settled = false;
  private terminalError: IrohError | null = null;
  private readonly listeners = new Set<(event: ProgressEvent) => void>();
  private readonly iterators = new Set<ProgressIterator>();

  constructor() {
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

  onProgress(listener: (event: ProgressEvent) => void): () => void {
    if (this.settled) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Delivers a progress event to every listener and iterator. */
  dispatch(event: ProgressEvent): void {
    if (this.settled) {
      return;
    }
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

  /** Terminates the stream: resolves on success, rejects with `error`. */
  settle(error: IrohError | null): void {
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
}

/**
 * Internal implementation of {@link Transfer}. Constructed by
 * {@link Blobs.download}; {@link TransferController.begin} is invoked
 * by the endpoint's download queue when a concurrency slot frees up.
 *
 * Not part of the public API surface.
 */
export class TransferController implements Transfer {
  private readonly hub = new ProgressHub();
  private started = false;
  private cancelRequested = false;
  private nativeTransferId: number | null = null;

  constructor(
    private readonly startDownload: StartDownload,
    private readonly requestNativeCancel: (transferId: number) => void,
  ) {}

  get promise(): Promise<void> {
    return this.hub.promise;
  }

  get done(): Promise<void> {
    return this.hub.done;
  }

  get progress(): AsyncIterable<ProgressEvent> {
    return this.hub.progress;
  }

  get isSettled(): boolean {
    return this.hub.isSettled;
  }

  /**
   * Starts the native download. Called exactly once by the endpoint's queue.
   * The returned promise settles (always resolves) when the transfer does,
   * which is what the queue uses to free the concurrency slot.
   */
  begin(): Promise<void> {
    this.started = true;
    if (this.hub.isSettled) {
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
          this.hub.dispatch({ bytesReceived });
        },
      );
    } catch (error) {
      this.hub.settle(IrohError.from(error));
      return Promise.resolve();
    }
    return downloading.then(
      () => {
        this.hub.settle(null);
      },
      (error: unknown) => {
        this.hub.settle(IrohError.from(error));
      },
    );
  }

  cancel(): void {
    if (this.hub.isSettled) {
      return;
    }
    this.cancelRequested = true;
    if (!this.started) {
      // Still waiting in the FIFO queue: fail locally, never touch native.
      this.hub.settle(new IrohError(3003, "download cancelled before it started"));
      return;
    }
    if (this.nativeTransferId !== null) {
      this.requestNativeCancel(this.nativeTransferId);
    }
    // Otherwise the native download has not reported its transfer id yet;
    // the onStart callback observes `cancelRequested` and cancels then.
  }

  onProgress(listener: (event: ProgressEvent) => void): () => void {
    return this.hub.onProgress(listener);
  }
}

/** One child's fetch, provided by {@link Endpoint}. */
type StartCollectionChild = (childTicket: string, name: string) => Transfer;

/** Fetches the collection manifest, provided by {@link Endpoint}. */
type FetchManifest = () => Promise<ReadonlyArray<{ name: string; ticket: string }>>;

interface MutableFileProgress {
  name: string;
  bytesReceived: number;
  totalBytes?: number;
  done: boolean;
}

/**
 * Internal implementation of {@link CollectionTransfer}. Fetches the
 * collection manifest, then downloads each child through the endpoint's
 * ordinary per-blob download queue, aggregating their progress into one
 * transfer while exposing each file's progress in {@link files}.
 *
 * Not part of the public API surface.
 */
export class CollectionTransferController implements CollectionTransfer {
  private readonly hub = new ProgressHub();
  private readonly fileStates: MutableFileProgress[] = [];
  private readonly children: Transfer[] = [];
  private childrenStarted = false;
  private cancelRequested = false;

  constructor(fetchManifest: FetchManifest, startChild: StartCollectionChild) {
    // Self-starts: unlike a single blob, a collection is not queued as one
    // unit; each of its children flows through the endpoint's download queue.
    this.begin(fetchManifest, startChild);
  }

  get promise(): Promise<void> {
    return this.hub.promise;
  }

  get done(): Promise<void> {
    return this.hub.done;
  }

  get progress(): AsyncIterable<ProgressEvent> {
    return this.hub.progress;
  }

  get isSettled(): boolean {
    return this.hub.isSettled;
  }

  get files(): FileProgress[] {
    return this.fileStates.map((file) => ({ ...file }));
  }

  onProgress(listener: (event: ProgressEvent) => void): () => void {
    return this.hub.onProgress(listener);
  }

  cancel(): void {
    if (this.hub.isSettled) {
      return;
    }
    this.cancelRequested = true;
    for (const child of this.children) {
      child.cancel();
    }
    if (!this.childrenStarted) {
      // The manifest is still in flight (or produced no children yet): fail
      // now. When the manifest resolves, `begin` sees `cancelRequested` and
      // never starts any child.
      this.hub.settle(new IrohError(3003, "collection download cancelled before it started"));
    }
    // Otherwise each child's cancellation drives the aggregate to settle.
  }

  private begin(fetchManifest: FetchManifest, startChild: StartCollectionChild): void {
    fetchManifest().then(
      (entries) => {
        if (this.cancelRequested || this.hub.isSettled) {
          return;
        }
        for (const entry of entries) {
          const fileState: MutableFileProgress = {
            name: entry.name,
            bytesReceived: 0,
            done: false,
          };
          this.fileStates.push(fileState);
          const child = startChild(entry.ticket, entry.name);
          this.children.push(child);
          child.onProgress((event) => {
            fileState.bytesReceived = event.bytesReceived;
            this.recomputeAggregate();
          });
          child.done.then(
            () => {
              fileState.done = true;
              this.recomputeAggregate();
              this.checkAllDone();
            },
            (error: unknown) => {
              this.onChildError(IrohError.from(error));
            },
          );
        }
        this.childrenStarted = true;
        // An empty collection is complete the moment its (empty) manifest lands.
        this.checkAllDone();
      },
      (error: unknown) => {
        this.hub.settle(IrohError.from(error));
      },
    );
  }

  private recomputeAggregate(): void {
    if (this.hub.isSettled) {
      return;
    }
    let total = 0;
    for (const file of this.fileStates) {
      total += file.bytesReceived;
    }
    this.hub.dispatch({ bytesReceived: total });
  }

  private checkAllDone(): void {
    if (this.hub.isSettled || !this.childrenStarted) {
      return;
    }
    if (this.fileStates.every((file) => file.done)) {
      this.hub.settle(null);
    }
  }

  private onChildError(error: IrohError): void {
    if (this.hub.isSettled) {
      return;
    }
    // One child failing fails the whole collection: cancel the rest so no
    // orphaned downloads keep running, then settle with the first error.
    for (const child of this.children) {
      child.cancel();
    }
    this.hub.settle(error);
  }
}
