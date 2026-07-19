import { IrohError } from "./errors";
import { getIroh, type IrohBinding } from "./native";
import { parseTicket, type BlobTicket } from "./ticket";
import { TransferController, type Transfer } from "./transfer";
import type { EndpointConfig, NetworkPreset } from "./specs/iroh.nitro";

/**
 * Default cap on concurrently active downloads per endpoint. See
 * {@link EndpointOptions.maxConcurrentDownloads}.
 */
export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 32;

/**
 * `Symbol.asyncDispose`, with a `Symbol.for` fallback for engines that lack
 * native explicit-resource-management support (Babel and TypeScript downlevel
 * helpers look the alias up under the same registry key).
 */
const ASYNC_DISPOSE: typeof Symbol.asyncDispose =
  Symbol.asyncDispose ?? (Symbol.for("Symbol.asyncDispose") as typeof Symbol.asyncDispose);

declare const EndpointIdBrand: unique symbol;

/**
 * The identifier of an endpoint: the public key other devices use to reach
 * it. A branded string; read one from {@link Endpoint.id}.
 *
 * @see https://docs.rs/iroh/1.0.2/iroh/type.EndpointId.html
 */
export type EndpointId = string & { readonly [EndpointIdBrand]: "EndpointId" };

/**
 * The subset of the standard `AbortSignal` interface used by
 * {@link DownloadOptions.signal}. Any real `AbortSignal` satisfies it; it is
 * declared structurally so this package does not require DOM type libs.
 */
export interface AbortSignalLike {
  /** Whether the signal has already been aborted. */
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/**
 * Options for {@link Blobs.download}.
 */
export interface DownloadOptions {
  /**
   * Standard `AbortSignal` integration: aborting the signal cancels the
   * transfer (equivalent to calling {@link Transfer.cancel}). A signal that
   * is already aborted cancels immediately; aborting after the transfer has
   * settled is a no-op.
   */
  signal?: AbortSignalLike;
}

/**
 * Blob transfer over an endpoint: content-addressed blobs, fetched with
 * BLAKE3-verified streaming. The iroh-blobs protocol surface, namespaced as
 * {@link Endpoint.blobs}.
 *
 * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/
 */
export interface Blobs {
  /**
   * Imports the file at absolute `path` into the endpoint's blob store and
   * resolves with a shareable {@link BlobTicket}. On the `"n0"` preset this
   * waits (bounded) for the endpoint to come online first, so the ticket
   * contains dialable addresses.
   *
   * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/ticket/struct.BlobTicket.html
   */
  share(path: string): Promise<BlobTicket>;
  /**
   * Starts downloading the blob described by `ticket` into absolute
   * `destPath` and synchronously returns a {@link Transfer} handle exposing
   * completion (`done` / `promise`), progress (`onProgress` / `progress`),
   * and `cancel()`. Plain strings are validated with {@link parseTicket}
   * first (throws kind `"invalid-ticket"` on garbage).
   *
   * At most {@link EndpointOptions.maxConcurrentDownloads} downloads run
   * natively at once; additional ones wait in a FIFO queue (a queued
   * transfer's `done` settles once it has run, or immediately if it is
   * cancelled while queued).
   */
  download(ticket: BlobTicket | string, destPath: string, options?: DownloadOptions): Transfer;
}

/**
 * Options for {@link Endpoint.create}. All fields are optional.
 */
export interface EndpointOptions {
  /**
   * Which of iroh's endpoint presets to bind with. Defaults to `"n0"` (n0's
   * production relay and discovery infrastructure). Use `"minimal"` for
   * tests or LAN-only setups where peers are reachable only via addresses
   * embedded in tickets.
   *
   * @see https://docs.rs/iroh/1.0.2/iroh/endpoint/presets/index.html
   */
  preset?: NetworkPreset;
  /**
   * Absolute directory path for the persistent blob store. Omit to keep
   * blobs in memory (they are lost when the endpoint closes).
   */
  blobStoreDir?: string;
  /**
   * Optional app-level throttle on concurrently active downloads for this
   * endpoint; further downloads wait in a FIFO queue. Defaults to
   * {@link DEFAULT_MAX_CONCURRENT_DOWNLOADS}. Values below 1 are clamped to 1
   * and non-integers are floored; `Infinity` means unlimited (no gate), while
   * `NaN` falls back to the default.
   *
   * Rationale: native downloads no longer each occupy a blocking thread in the
   * native Promise pool. The bridge now completes Promises via callbacks off
   * the JS thread, so there is no native concurrency cap to guard against.
   * This remains purely as an application-level throttle for pacing many
   * concurrent long transfers; pass `Infinity` to disable it entirely.
   */
  maxConcurrentDownloads?: number;
}

/**
 * An iroh endpoint: a network identity that establishes connections with
 * other endpoints, plus a blob store.
 *
 * Create one with {@link Endpoint.create}; call {@link Endpoint.close} when
 * done (or bind with `await using` to close automatically). All methods
 * reject (or throw) {@link IrohError} exclusively.
 *
 * @see https://docs.rs/iroh/1.0.2/iroh/endpoint/struct.Endpoint.html
 */
export class Endpoint {
  private readonly binding: IrohBinding;
  private readonly handle: number;
  private readonly cachedId: EndpointId;
  private readonly maxConcurrentDownloads: number;
  private readonly downloadQueue: TransferController[] = [];
  private activeDownloads = 0;
  private closePromise: Promise<void> | null = null;

  /**
   * The endpoint's blob transfer API ({@link Blobs.share} /
   * {@link Blobs.download}): the iroh-blobs protocol running over this
   * endpoint.
   *
   * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/
   */
  readonly blobs: Blobs;

  private constructor(
    binding: IrohBinding,
    handle: number,
    id: EndpointId,
    maxConcurrentDownloads: number,
  ) {
    this.binding = binding;
    this.handle = handle;
    this.cachedId = id;
    this.maxConcurrentDownloads = maxConcurrentDownloads;
    this.blobs = {
      share: (path) => this.shareBlob(path),
      download: (ticket, destPath, options) => this.downloadBlob(ticket, destPath, options),
    };
  }

  /**
   * Creates an endpoint: binds sockets and loads the blob store.
   *
   * @param options Optional configuration; defaults to the `"n0"` preset
   *   with an in-memory blob store.
   * @param binding Advanced: an alternative native binding, primarily for
   *   tests. App code should omit it to use the real native module.
   */
  static async create(
    options: EndpointOptions = {},
    binding: IrohBinding = getIroh(),
  ): Promise<Endpoint> {
    const preset = options.preset ?? "n0";
    const requestedMax = options.maxConcurrentDownloads ?? DEFAULT_MAX_CONCURRENT_DOWNLOADS;
    // `Infinity` is an explicit opt-out: an unlimited gate (`active < Infinity`
    // is always true) pumps every queued transfer immediately. `NaN` would
    // instead deadlock the queue (`active < NaN` is never true), so it falls
    // back to the default. Finite values are floored and clamped to at least 1.
    const maxConcurrentDownloads =
      requestedMax === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Number.isFinite(requestedMax)
          ? Math.max(1, Math.floor(requestedMax))
          : DEFAULT_MAX_CONCURRENT_DOWNLOADS;
    const config: EndpointConfig =
      options.blobStoreDir === undefined
        ? { preset }
        : { preset, blobStoreDir: options.blobStoreDir };
    try {
      const handle = await binding.createEndpoint(config);
      const id = binding.endpointId(handle) as EndpointId;
      return new Endpoint(binding, handle, id, maxConcurrentDownloads);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /**
   * The endpoint's id: the public key other devices use to reach it. Stable
   * for the endpoint's lifetime; cached at creation, so reading it never
   * touches native code and stays valid after {@link close}.
   *
   * @see https://docs.rs/iroh/1.0.2/iroh/endpoint/struct.Endpoint.html#method.id
   */
  get id(): EndpointId {
    return this.cachedId;
  }

  /** Whether the endpoint is live (created and not yet closed). */
  get isOpen(): boolean {
    try {
      return this.binding.isEndpointOpen(this.handle);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Blobs.share}; exposed as {@link Endpoint.blobs}`.share`. */
  private async shareBlob(path: string): Promise<BlobTicket> {
    try {
      return (await this.binding.shareBlob(this.handle, path)) as BlobTicket;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Blobs.download}; exposed as {@link Endpoint.blobs}`.download`. */
  private downloadBlob(
    ticket: BlobTicket | string,
    destPath: string,
    options?: DownloadOptions,
  ): Transfer {
    // Cheap shape validation up front: pasted garbage fails here with a
    // typed IrohError instead of a native round-trip.
    const validated = parseTicket(ticket);
    const transfer = new TransferController(
      (onStart, onProgress) =>
        this.binding.downloadBlob(this.handle, validated, destPath, onStart, onProgress),
      (transferId) => {
        try {
          this.binding.cancelDownload(transferId);
        } catch (error) {
          throw IrohError.from(error);
        }
      },
    );
    // Wire the signal before the queue pump: an already-aborted signal must
    // settle the transfer as cancelled without ever reaching native.
    const signal = options?.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        transfer.cancel();
      } else {
        const onAbort = (): void => {
          transfer.cancel();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        // Detach once settled so a long-lived signal cannot leak listeners;
        // an abort arriving after settle is a no-op either way.
        const detach = (): void => {
          signal.removeEventListener("abort", onAbort);
        };
        transfer.done.then(detach, detach);
      }
    }
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

  /**
   * Alias of {@link close} enabling `await using endpoint = await
   * Endpoint.create(...)`: the endpoint is closed automatically when the
   * binding goes out of scope. `close()` remains public for explicit
   * lifecycle control.
   */
  [ASYNC_DISPOSE](): Promise<void> {
    return this.close();
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
