import { IrohError } from "./errors";
import { getRawIroh, type IrohBinding } from "./native";
import { TransferController, type Transfer } from "./transfer";
import type { EndpointConfig, NetworkProfile } from "./specs/iroh.nitro";

/**
 * Default cap on concurrently active downloads per endpoint. See
 * {@link EndpointOptions.maxConcurrentDownloads}.
 */
export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 4;

/**
 * Options for {@link Endpoint.create}. All fields are optional.
 */
export interface EndpointOptions {
  /**
   * Network infrastructure profile. Defaults to `"standard"` (n0 relay
   * servers and address lookup). Use `"isolated"` for tests or LAN-only
   * setups where peers are reachable only via addresses embedded in tickets.
   */
  profile?: NetworkProfile;
  /**
   * Absolute directory path for the persistent blob store. Omit to keep
   * blobs in memory (they are lost when the endpoint closes).
   */
  blobStoreDir?: string;
  /**
   * Cap on concurrently active downloads for this endpoint; further
   * downloads wait in a FIFO queue. Defaults to
   * {@link DEFAULT_MAX_CONCURRENT_DOWNLOADS} (values below 1 are clamped to
   * 1, non-integers are floored).
   *
   * Rationale: each in-flight native operation occupies a thread in the
   * native Promise thread pool (which grows from 3 to at most 10 threads),
   * so many concurrent long transfers would starve other native calls. Keep
   * this well below 10 unless you know your workload.
   */
  maxConcurrentDownloads?: number;
}

/**
 * An iroh endpoint: a network identity plus a blob store.
 *
 * Create one with {@link Endpoint.create}; call {@link Endpoint.close} when
 * done. All methods reject (or throw) {@link IrohError} exclusively.
 */
export class Endpoint {
  private readonly binding: IrohBinding;
  private readonly handle: number;
  private readonly cachedNodeId: string;
  private readonly maxConcurrentDownloads: number;
  private readonly downloadQueue: TransferController[] = [];
  private activeDownloads = 0;
  private closePromise: Promise<void> | null = null;

  private constructor(
    binding: IrohBinding,
    handle: number,
    nodeId: string,
    maxConcurrentDownloads: number,
  ) {
    this.binding = binding;
    this.handle = handle;
    this.cachedNodeId = nodeId;
    this.maxConcurrentDownloads = maxConcurrentDownloads;
  }

  /**
   * Creates an endpoint: binds sockets and loads the blob store.
   *
   * @param options Optional configuration; defaults to the `"standard"`
   *   profile with an in-memory blob store.
   * @param binding Advanced: an alternative native binding, primarily for
   *   tests. App code should omit it to use the real native module.
   */
  static async create(
    options: EndpointOptions = {},
    binding: IrohBinding = getRawIroh(),
  ): Promise<Endpoint> {
    const profile = options.profile ?? "standard";
    const maxConcurrentDownloads = Math.max(
      1,
      Math.floor(options.maxConcurrentDownloads ?? DEFAULT_MAX_CONCURRENT_DOWNLOADS),
    );
    const config: EndpointConfig =
      options.blobStoreDir === undefined
        ? { profile }
        : { profile, blobStoreDir: options.blobStoreDir };
    try {
      const handle = await binding.createEndpoint(config);
      const nodeId = binding.nodeId(handle);
      return new Endpoint(binding, handle, nodeId, maxConcurrentDownloads);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /**
   * The endpoint's node id (its public key). Stable for the endpoint's
   * lifetime; cached at creation, so reading it never touches native code
   * and stays valid after {@link close}.
   */
  get nodeId(): string {
    return this.cachedNodeId;
  }

  /** Whether the endpoint is live (created and not yet closed). */
  get isOpen(): boolean {
    try {
      return this.binding.isEndpointOpen(this.handle);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /**
   * Imports the file at absolute `path` into the endpoint's blob store and
   * resolves with a shareable ticket string. On the `"standard"` profile
   * this waits (bounded) for the endpoint to come online first, so the
   * ticket contains dialable addresses.
   */
  async shareBlob(path: string): Promise<string> {
    try {
      return await this.binding.shareBlob(this.handle, path);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /**
   * Starts downloading the blob described by `ticket` into absolute
   * `destPath` and synchronously returns a {@link Transfer} handle exposing
   * completion (`promise`), progress (`onProgress` / `progress`), and
   * `cancel()`.
   *
   * At most {@link EndpointOptions.maxConcurrentDownloads} downloads run
   * natively at once; additional ones wait in a FIFO queue (a queued
   * transfer's `promise` settles once it has run, or immediately if it is
   * cancelled while queued).
   */
  downloadBlob(ticket: string, destPath: string): Transfer {
    const transfer = new TransferController(
      (onStart, onProgress) =>
        this.binding.downloadBlob(this.handle, ticket, destPath, onStart, onProgress),
      (transferId) => {
        try {
          this.binding.cancelDownload(transferId);
        } catch (error) {
          throw IrohError.from(error);
        }
      },
    );
    this.downloadQueue.push(transfer);
    this.pumpDownloads();
    return transfer;
  }

  /**
   * Closes the endpoint: shuts down its router, sockets and blob store.
   *
   * One-shot: the native side invalidates the handle at the first close
   * call, so the first call's outcome (success or failure) is final.
   * Concurrent and repeated calls all return the same promise; the native
   * close runs at most once. When the native close settles (regardless of
   * outcome: the endpoint is unusable either way), downloads still waiting
   * in the queue are cancelled (their promises reject with kind
   * `"cancelled"`); actively running downloads are settled by the native
   * shutdown. On failure the promise rejects with an {@link IrohError}.
   */
  close(): Promise<void> {
    if (this.closePromise === null) {
      const cancelQueued = (): void => {
        for (const queued of this.downloadQueue.splice(0)) {
          queued.cancel();
        }
      };
      this.closePromise = this.binding.closeEndpoint(this.handle).then(
        () => {
          cancelQueued();
        },
        (error: unknown) => {
          cancelQueued();
          throw IrohError.from(error);
        },
      );
    }
    return this.closePromise;
  }

  /** Starts queued transfers while concurrency slots are available. */
  private pumpDownloads(): void {
    while (this.activeDownloads < this.maxConcurrentDownloads) {
      const next = this.downloadQueue.shift();
      if (next === undefined) {
        return;
      }
      if (next.isSettled) {
        // Cancelled while queued; it never occupied a slot.
        continue;
      }
      this.activeDownloads += 1;
      // `begin()` never rejects: it resolves when the transfer settles.
      void next.begin().then(() => {
        this.activeDownloads -= 1;
        this.pumpDownloads();
      });
    }
  }
}
