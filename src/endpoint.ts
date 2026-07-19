import { IrohError } from "./errors";
import { getIroh, type IrohBinding } from "./native";
import { validateTicketShape, type BlobTicket } from "./ticket";
import {
  CollectionTransferController,
  TransferController,
  type CollectionTransfer,
  type Transfer,
} from "./transfer";
import { Watchable } from "./watchable";
import type { EndpointConfig, NetworkPreset } from "./specs/iroh.nitro";

/**
 * Default cap on concurrently active downloads per endpoint. See
 * {@link EndpointOptions.maxConcurrentDownloads}.
 */
export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 32;

/**
 * Default bound (10s) on how long {@link Endpoint.online} waits for a home
 * relay to connect before rejecting. Matches the native share/online wait.
 */
export const DEFAULT_ONLINE_TIMEOUT_MS = 10_000;

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
 * Which relay servers an endpoint uses, an additive override of the network
 * {@link EndpointOptions.preset}'s default relays (discovery is unaffected):
 *
 * - `"default"`: n0's production relay map.
 * - `"disabled"`: no relays; peers must be reachable via direct addresses.
 * - `"staging"`: n0's staging relay map.
 * - `{ custom: [...] }`: a custom map built from the given HTTPS relay URLs
 *   (at least one required).
 *
 * @see https://docs.rs/iroh/1.0.2/iroh/endpoint/enum.RelayMode.html
 */
export type RelayMode = "default" | "disabled" | "staging" | { readonly custom: readonly string[] };

/**
 * A snapshot of an endpoint's network address: its id plus the relay and
 * direct addresses it is currently reachable through. Obtain the current value
 * from {@link Endpoint.addr}, or observe changes via {@link Endpoint.watchAddr}
 * / {@link Endpoint.addrChanges}.
 *
 * @see https://docs.rs/iroh/1.0.2/iroh/struct.EndpointAddr.html
 */
export interface EndpointAddr {
  /** The endpoint's id (its public key). */
  readonly id: EndpointId;
  /** Home-relay URLs the endpoint is reachable through. */
  readonly relayUrls: readonly string[];
  /** Direct socket addresses (`host:port`) the endpoint is reachable through. */
  readonly directAddrs: readonly string[];
}

/**
 * Serializes a {@link RelayMode} to the single delimited string the bridge
 * accepts (see {@link EndpointConfig.relayMode}). Throws for an empty custom
 * list, which iroh would reject at bind time.
 */
function serializeRelayMode(mode: RelayMode): string {
  if (typeof mode === "string") {
    return mode;
  }
  const urls = mode.custom;
  if (urls.length === 0) {
    throw new IrohError(2000, "relayMode custom requires at least one relay URL");
  }
  // The native side splits on newlines; the leading "custom" tag disambiguates
  // it from the bare-keyword modes.
  return ["custom", ...urls].join("\n");
}

/** Parses the bridge's JSON `EndpointAddr` string into a typed value. */
function parseEndpointAddr(json: string): EndpointAddr {
  const raw = JSON.parse(json) as {
    id: string;
    relayUrls?: string[];
    directAddrs?: string[];
  };
  return {
    id: raw.id as EndpointId,
    relayUrls: raw.relayUrls ?? [],
    directAddrs: raw.directAddrs ?? [],
  };
}

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
  /**
   * Bundles the files at the given absolute `paths` into a single iroh-blobs
   * collection and resolves with one shareable {@link BlobTicket} (a HashSeq
   * ticket). Each file becomes a named child (its source base name); the
   * receiver gets them all from the one ticket via {@link downloadCollection}.
   * Like {@link share}, it waits (bounded) for the endpoint to come online on
   * the `"n0"` preset. `paths` must be non-empty.
   *
   * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/format/collection/struct.Collection.html
   */
  shareCollection(paths: string[]): Promise<BlobTicket>;
  /**
   * Downloads the collection described by `ticket`, writing each child to
   * `destDir/<name>`, and synchronously returns a {@link CollectionTransfer}:
   * the same handle shape as {@link download} (aggregate `done` / `progress` /
   * `onProgress` / `cancel`) plus a live per-file breakdown in
   * {@link CollectionTransfer.files}.
   *
   * Children fan out through the same FIFO download queue as {@link download},
   * so at most {@link EndpointOptions.maxConcurrentDownloads} run natively at
   * once and each child progresses (and can fail) independently; the first
   * child failure fails the whole collection and cancels the rest. `destDir`
   * must be an existing absolute directory (the native layer does not create
   * missing parents).
   */
  downloadCollection(
    ticket: BlobTicket | string,
    destDir: string,
    options?: DownloadOptions,
  ): CollectionTransfer;
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
   * Which relay servers this endpoint uses. Omit to inherit the
   * {@link EndpointOptions.preset}'s default relays. Setting it overrides only
   * the relays (discovery is left to the preset); e.g. `"disabled"` runs a
   * LAN-only endpoint that reaches peers purely through direct addresses.
   *
   * @see {@link RelayMode}
   */
  relayMode?: RelayMode;
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
  // The address fan-out and its backing native watch id. Both are created
  // lazily on the first watchAddr/addrChanges consumer and torn down on close;
  // the native watch is (re)started only while there is at least one consumer.
  private addressWatch: Watchable<EndpointAddr> | null = null;
  private addressWatchId: number | null = null;

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
      shareCollection: (paths) => this.shareCollection(paths),
      downloadCollection: (ticket, destDir, options) =>
        this.downloadCollection(ticket, destDir, options),
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
    const config: EndpointConfig = { preset };
    if (options.blobStoreDir !== undefined) {
      config.blobStoreDir = options.blobStoreDir;
    }
    if (options.relayMode !== undefined) {
      // Throws a typed IrohError synchronously for an empty custom list.
      config.relayMode = serializeRelayMode(options.relayMode);
    }
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

  /**
   * The endpoint's current {@link EndpointAddr}: its id plus the relay and
   * direct addresses currently known. A synchronous snapshot (no network I/O);
   * the value changes over time as relays connect and interfaces come and go
   * (observe it live with {@link watchAddr} / {@link addrChanges}).
   *
   * @see https://docs.rs/iroh/1.0.2/iroh/endpoint/struct.Endpoint.html#method.addr
   */
  get addr(): EndpointAddr {
    try {
      return parseEndpointAddr(this.binding.endpointAddr(this.handle));
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /**
   * Subscribes to this endpoint's {@link EndpointAddr} changes. The listener
   * fires with the current address soon after subscribing and again on each
   * change (relay connects, interface roams). Returns an unsubscribe function;
   * the native watch runs only while at least one subscriber (listener or
   * {@link addrChanges} iterator) is attached, and is torn down on
   * {@link close}. Unsubscribe is idempotent.
   */
  watchAddr(listener: (addr: EndpointAddr) => void): () => void {
    return this.addressWatchable().listen(listener);
  }

  /**
   * An `AsyncIterable` of this endpoint's {@link EndpointAddr} changes. Each
   * `for await` gets an independent latest-value-conflating iterator (a slow
   * consumer observes only the newest address). The iteration ends when the
   * endpoint is closed; break out of the loop to detach early.
   */
  get addrChanges(): AsyncIterable<EndpointAddr> {
    return this.addressWatchable().stream;
  }

  /**
   * Resolves once the endpoint has a connected home relay, rejecting with an
   * {@link IrohError} (kind `"endpoint-bind"`) if the wait exceeds
   * `options.timeoutMs` (default {@link DEFAULT_ONLINE_TIMEOUT_MS}). On
   * relay-less endpoints (`relayMode: "disabled"`, or the `"minimal"` preset)
   * no home relay can connect, so this always rejects on timeout.
   *
   * @see https://docs.rs/iroh/1.0.2/iroh/endpoint/struct.Endpoint.html#method.online
   */
  async online(options: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_ONLINE_TIMEOUT_MS;
    try {
      await this.binding.endpointOnline(this.handle, timeoutMs);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /**
   * The address fan-out, created lazily. Its {@link Watchable} hooks start the
   * native watch when the first consumer attaches and stop it when the last
   * one detaches, so an endpoint whose address is never observed costs nothing.
   */
  private addressWatchable(): Watchable<EndpointAddr> {
    if (this.addressWatch === null) {
      this.addressWatch = new Watchable<EndpointAddr>({
        onActive: () => this.startNativeAddrWatch(),
        onIdle: () => this.stopNativeAddrWatch(),
      });
    }
    return this.addressWatch;
  }

  /** Starts the native address watch feeding {@link addressWatch}. */
  private startNativeAddrWatch(): void {
    if (this.addressWatchId !== null) {
      return;
    }
    try {
      this.binding.watchAddr(
        this.handle,
        (watchId) => {
          this.addressWatchId = watchId;
        },
        (json) => {
          const watchable = this.addressWatch;
          if (watchable === null) {
            return;
          }
          try {
            watchable.push(parseEndpointAddr(json));
          } catch {
            // A malformed address payload is dropped rather than tearing the
            // stream down; the next well-formed change supersedes it.
          }
        },
      );
    } catch (error) {
      // The watch could not start (e.g. a stale handle): close the fan-out so
      // pending iterators reject and listeners stop, rather than hanging.
      this.addressWatch?.close(IrohError.from(error));
    }
  }

  /** Stops the native address watch, if one is running. Idempotent. */
  private stopNativeAddrWatch(): void {
    if (this.addressWatchId === null) {
      return;
    }
    const watchId = this.addressWatchId;
    this.addressWatchId = null;
    try {
      this.binding.stopWatchAddr(watchId);
    } catch {
      // stopWatchAddr is idempotent natively; ignore teardown races.
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
    const transfer = this.createDownload(ticket, destPath);
    // Wire the signal before the queue pump: an already-aborted signal must
    // settle the transfer as cancelled without ever reaching native.
    this.wireAbortSignal(transfer, options?.signal);
    this.enqueueDownload(transfer);
    return transfer;
  }

  /** See {@link Blobs.shareCollection}. */
  private async shareCollection(paths: string[]): Promise<BlobTicket> {
    try {
      // Paths cross the bridge newline-joined (see the native spec).
      return (await this.binding.shareCollection(this.handle, paths.join("\n"))) as BlobTicket;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Blobs.downloadCollection}. */
  private downloadCollection(
    ticket: BlobTicket | string,
    destDir: string,
    options?: DownloadOptions,
  ): CollectionTransfer {
    // Cheap shape check up front so pasted garbage fails synchronously.
    const collectionTicket = validateTicketShape(ticket);
    const dir = destDir.replace(/\/+$/, "");
    const transfer = new CollectionTransferController(
      async () => {
        const manifest = await this.binding.collectionManifest(this.handle, collectionTicket);
        return JSON.parse(manifest) as { name: string; ticket: string }[];
      },
      (childTicket, name) => {
        const child = this.createDownload(childTicket, `${dir}/${name}`);
        this.enqueueDownload(child);
        return child;
      },
    );
    this.wireAbortSignal(transfer, options?.signal);
    return transfer;
  }

  /**
   * Builds a queued single-blob download for `ticket` -> `destPath`, reused by
   * both {@link download} and each child of {@link downloadCollection}. The
   * returned controller is not yet enqueued (see {@link enqueueDownload}).
   */
  private createDownload(ticket: BlobTicket | string, destPath: string): TransferController {
    // Cheap shape validation up front: pasted garbage fails here with a
    // typed IrohError instead of a native round-trip.
    const validated = validateTicketShape(ticket);
    return new TransferController(
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
  }

  /** Adds a transfer to the FIFO queue and pumps the concurrency gate. */
  private enqueueDownload(transfer: TransferController): void {
    this.downloadQueue.push(transfer);
    this.pumpDownloads();
  }

  /**
   * Binds an `AbortSignal` to a transfer's cancellation: an already-aborted
   * signal cancels immediately; a later abort cancels once. The listener is
   * detached when the transfer settles so a long-lived signal cannot leak it.
   */
  private wireAbortSignal(transfer: Transfer, signal: AbortSignalLike | undefined): void {
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      transfer.cancel();
      return;
    }
    const onAbort = (): void => {
      transfer.cancel();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const detach = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    transfer.done.then(detach, detach);
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
        // Stop the native address watch and end any addrChanges iterators.
        this.stopNativeAddrWatch();
        this.addressWatch?.close();
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
