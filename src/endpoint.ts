import {
  DocsController,
  type DocsApi,
  type DocsBinding,
  type DocSubscriptionController,
} from "./docs";
import { IrohError } from "./errors";
import {
  GossipSubscriptionController,
  type GossipSubscribeOptions,
  type GossipSubscription,
} from "./gossip";
import { getIroh, type IrohBinding } from "./native";
import {
  ConnectionController,
  StreamListenerController,
  type Connection,
  type StreamListener,
  type StreamOptions,
  type StreamsBinding,
} from "./streams";
import { validateTicketShape, type BlobFormat, type BlobTicket } from "./ticket";
import {
  CollectionTransferController,
  TransferController,
  type CollectionTransfer,
  type Transfer,
} from "./transfer";
import { Watchable } from "./watchable";
import type { EndpointConfig, NetworkPreset, StreamFraming } from "./specs/iroh.nitro";

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
 * @see https://docs.rs/iroh/1.0.3/iroh/type.EndpointId.html
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
 * @see https://docs.rs/iroh/1.0.3/iroh/endpoint/enum.RelayMode.html
 */
export type RelayMode = "default" | "disabled" | "staging" | { readonly custom: readonly string[] };

/**
 * A snapshot of an endpoint's network address: its id plus the relay and
 * direct addresses it is currently reachable through. Obtain the current value
 * from {@link Endpoint.addr}, or observe changes via {@link Endpoint.watchAddr}
 * / {@link Endpoint.addrChanges}.
 *
 * @see https://docs.rs/iroh/1.0.3/iroh/struct.EndpointAddr.html
 */
export interface EndpointAddr {
  /** The endpoint's id (its public key). */
  readonly id: EndpointId;
  /** Home-relay URLs the endpoint is reachable through. */
  readonly relayUrls: readonly string[];
  /** Direct socket addresses (`host:port`) the endpoint is reachable through. */
  readonly directAddrs: readonly string[];
}

/** Which transport a {@link RemoteAddr} belongs to. */
export type RemoteAddrKind = "relay" | "ip";

/**
 * One transport address a remote endpoint is known by, plus whether this
 * endpoint is actually using it.
 *
 * `active` is the field that matters for characterising a network path: iroh
 * retains every address it has learned for a remote, but only the active ones
 * carry traffic.
 */
export interface RemoteAddr {
  /** The address itself: a relay URL, or a `host:port` socket address. */
  readonly addr: string;
  /** Which transport the address belongs to. */
  readonly kind: RemoteAddrKind;
  /** Whether the address is in active use, as opposed to merely known. */
  readonly active: boolean;
}

/**
 * A snapshot of what an endpoint knows about a remote peer, from
 * {@link Endpoint.remoteInfo}.
 */
export interface RemoteInfo {
  /** The remote endpoint's id (its public key). */
  readonly id: EndpointId;
  /** Every transport address known for the remote, active or not. */
  readonly addrs: readonly RemoteAddr[];
}

/**
 * Parses the bridge's JSON `RemoteInfo` string, mapping the JSON literal
 * `null` (remote unknown) to `undefined`.
 */
function parseRemoteInfo(json: string): RemoteInfo | undefined {
  const raw = JSON.parse(json) as {
    id: string;
    addrs?: { addr: string; kind: RemoteAddrKind; active: boolean }[];
  } | null;
  if (raw === null) {
    return undefined;
  }
  return { id: raw.id as EndpointId, addrs: raw.addrs ?? [] };
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
 * Serializes an {@link EndpointAddr} to the same compact JSON shape the bridge
 * emits (`{ id, relayUrls, directAddrs }`), so it can be handed back as a
 * gossip bootstrap peer (see {@link Gossip.subscribe}).
 */
function serializeEndpointAddr(addr: EndpointAddr): string {
  return JSON.stringify({
    id: addr.id,
    relayUrls: addr.relayUrls,
    directAddrs: addr.directAddrs,
  });
}

/**
 * Rejects a collection child name that would escape the download destination
 * directory.
 *
 * Child names are chosen by whoever shared the collection, so a hostile
 * provider could otherwise name a child `../../…` and write the downloaded
 * blob anywhere the process can reach. A name is always a single path segment
 * ({@link Blobs.shareCollection} emits source file base names), so anything
 * carrying a separator or a parent reference is rejected outright rather than
 * silently rewritten.
 */
function requireContainedChildName(name: string): void {
  const contained =
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0");
  if (!contained) {
    throw new IrohError(
      1003,
      `collection child name ${JSON.stringify(name)} is not a single path segment`,
    );
  }
}

/**
 * Gossip publish/subscribe over an endpoint: peers that subscribe to the same
 * topic form a swarm and broadcast messages to one another. Namespaced as
 * {@link Endpoint.gossip}.
 *
 * @see https://docs.rs/iroh-gossip/0.101.0/iroh_gossip/
 */
export interface Gossip {
  /**
   * Subscribes to the topic identified by `topic` (a free-form label; peers
   * that pass the same label join the same topic) and returns a live
   * {@link GossipSubscription}: an async-iterable message log, a neighbor-event
   * stream, `broadcast(text)`, and `unsubscribe()`.
   *
   * On the `"minimal"` preset supply at least one {@link GossipSubscribeOptions.bootstrap}
   * peer so the endpoints can find each other; on `"n0"` discovery can resolve
   * peers without one. Throws an {@link IrohError} synchronously for a stale
   * endpoint (kind `"invalid-handle"`) or a malformed bootstrap address (kind
   * `"gossip-subscribe"`).
   */
  subscribe(topic: string, options?: GossipSubscribeOptions): GossipSubscription;
}

/**
 * Raw QUIC streams over an ALPN you choose: the layer the built-in protocols
 * are themselves built on, exposed so you can define your own. Namespaced as
 * {@link Endpoint.streams}.
 *
 * A {@link StreamListener} accepts inbound {@link Connection}s on one ALPN, and
 * {@link connect} dials one out; either way a connection carries any number of
 * independent bidirectional {@link Stream}s.
 *
 * The ALPNs an endpoint accepts are fixed at creation
 * ({@link EndpointOptions.alpns}), because iroh's router fixes its ALPN set
 * when it spawns. Dialling has no such constraint: any ALPN can be dialled at
 * any time.
 *
 * @see https://docs.rs/iroh/1.0.3/iroh/protocol/index.html
 */
export interface Streams {
  /**
   * Starts accepting inbound connections that negotiated `alpn`, which must be
   * one of the endpoint's {@link EndpointOptions.alpns}. Returns synchronously;
   * throws an {@link IrohError} of kind `"stream-listen"` for an ALPN that was
   * not declared or is already being listened on, or `"invalid-handle"` for a
   * closed endpoint.
   */
  listen(alpn: string, options?: StreamOptions): StreamListener;
  /**
   * Dials `peer` on `alpn` and resolves with the live {@link Connection}.
   *
   * Pass a full {@link EndpointAddr} when the peer cannot be discovered (the
   * `"minimal"` preset, or a LAN-only setup): its addresses are registered so
   * the dial can reach it, exactly as a gossip bootstrap peer's are. A bare
   * {@link EndpointId} leaves resolution to discovery, which needs the `"n0"`
   * preset.
   *
   * Rejects with an {@link IrohError} of kind `"stream-connect"` if the peer is
   * unreachable or does not accept `alpn`.
   */
  connect(
    peer: EndpointId | EndpointAddr,
    alpn: string,
    options?: StreamOptions,
  ): Promise<Connection>;
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
 * The local presence of a blob in an endpoint's store, from
 * {@link Blobs.status}. A discriminated union on `state`:
 *
 * - `"notFound"`: the blob is not stored at all.
 * - `"partial"`: some ranges are present but the blob is incomplete (an
 *   interrupted {@link Blobs.download} left it behind; re-issuing the download
 *   fetches only the missing ranges). `size` is the stored partial size when
 *   known.
 * - `"complete"`: the whole blob is present and BLAKE3-verified. `size` is its
 *   full size.
 *
 * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/api/blobs/enum.BlobStatus.html
 */
export type BlobStatus =
  | { readonly state: "notFound" }
  | { readonly state: "partial"; readonly size?: number }
  | { readonly state: "complete"; readonly size: number };

/**
 * One blob in an endpoint's store, from {@link Blobs.list}.
 */
export interface BlobInfo {
  /** The blob's BLAKE3 content hash, 64 lowercase hex characters. */
  readonly hash: string;
  /** The blob's size in bytes. */
  readonly size: number;
}

/**
 * One tag in an endpoint's store, from {@link Tags.list}. A tag pins a blob so
 * garbage collection keeps it (see {@link Tags}).
 */
export interface TagInfo {
  /** The tag's name. */
  readonly name: string;
  /** The tagged blob's BLAKE3 content hash. */
  readonly hash: string;
  /**
   * The format the tag protects: `"hashSeq"` also protects the sequence's
   * children from GC, `"raw"` protects a single blob.
   */
  readonly format: BlobFormat;
}

/**
 * The tag lifecycle for an endpoint's blob store, namespaced as
 * {@link Blobs.tags}.
 *
 * Tags are the sanctioned retention mechanism: with garbage collection enabled
 * ({@link EndpointOptions.gc}), a tagged blob survives while untagged blobs are
 * reclaimed. "Removing" a blob is dropping its tag and letting GC reclaim it;
 * there is deliberately no direct blob delete (deletion is GC-only).
 *
 * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/api/tags/struct.Tags.html
 */
export interface Tags {
  /** Lists every tag in the store. */
  list(): Promise<TagInfo[]>;
  /**
   * Creates (or overwrites) the tag `name`, pinning the blob `hash` (64-hex) so
   * GC keeps it. `format` defaults to `"raw"`; pass `"hashSeq"` to also protect
   * a hash sequence's children. Rejects (kind `"blob-store"`) on a malformed
   * hash or format.
   */
  create(name: string, hash: string, format?: BlobFormat): Promise<void>;
  /**
   * Deletes the tag `name`. The blob it pinned is not removed here; it becomes
   * GC-eligible and is reclaimed only if (and when) GC runs. Deleting an absent
   * tag is not an error.
   */
  delete(name: string): Promise<void>;
  /**
   * Renames the tag `from` to `to` atomically. Rejects (kind `"blob-store"`) if
   * `from` does not exist.
   */
  rename(from: string, to: string): Promise<void>;
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
   *
   * Retention: a completed download is tagged (like {@link share} and
   * {@link addBytes}) under a tag named after the blob's root hash, so with
   * opt-in GC ({@link EndpointOptions.gc}) enabled it is retained rather than
   * reclaimed. GC reclaims only untagged blobs; to reclaim a downloaded blob,
   * drop its tag with `blobs.tags.delete(hash)` (see {@link Tags}) and let a GC
   * pass run. The blob is protected throughout the transfer, so a partially
   * downloaded blob is never reclaimed mid-flight.
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
   *
   * Retention: the collection root is tagged (a `hashSeq` tag named after the
   * root hash), which retains the root and its children under opt-in GC, and
   * each child is additionally tagged as it downloads. Drop the root tag with
   * `blobs.tags.delete(rootHash)` to make the collection reclaimable.
   */
  downloadCollection(
    ticket: BlobTicket | string,
    destDir: string,
    options?: DownloadOptions,
  ): CollectionTransfer;
  /**
   * Reports the local presence of the blob `hash` (64-hex) in this endpoint's
   * store as a {@link BlobStatus}. A `"partial"` result means an interrupted
   * {@link download} left ranges behind; re-issuing the download fetches only
   * what is missing. Rejects (kind `"blob-store"`) on a malformed hash.
   */
  status(hash: string): Promise<BlobStatus>;
  /**
   * Whether the store holds the blob `hash` (64-hex) complete and
   * BLAKE3-verified. A partially-present blob resolves `false`.
   */
  has(hash: string): Promise<boolean>;
  /** Lists the complete blobs in this endpoint's store, each with its size. */
  list(): Promise<BlobInfo[]>;
  /**
   * Imports the in-memory `data` into this endpoint's blob store and resolves
   * with a shareable {@link BlobTicket}, the in-memory counterpart of
   * {@link share}. On the `"n0"` preset it waits (bounded) for the endpoint to
   * come online first.
   */
  addBytes(data: ArrayBuffer): Promise<BlobTicket>;
  /**
   * The tag lifecycle for this endpoint's store: the retention mechanism that
   * decides what survives garbage collection.
   */
  readonly tags: Tags;
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
   * @see https://docs.rs/iroh/1.0.3/iroh/endpoint/presets/index.html
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
   * Enable the iroh-docs meta-protocol on this endpoint, exposing
   * {@link Endpoint.docs} (author identity + document CRUD). Omit (or `false`)
   * to pay zero docs cost: no docs store, no ALPN, no background engine, and
   * every {@link Endpoint.docs} call rejects with kind `"docs-disabled"`.
   */
  docs?: boolean;
  /**
   * Absolute directory path for the persistent docs store (replicas and
   * authors), used only when {@link EndpointOptions.docs} is enabled. Omit to
   * keep docs in memory (they are lost when the endpoint closes).
   */
  docsStoreDir?: string;
  /**
   * Opt-in blob garbage collection. Omit to keep GC OFF (the default): nothing
   * is ever reclaimed, exactly today's retention. When set, the store runs a
   * mark-and-sweep loop every `intervalSecs` seconds that reclaims untagged
   * blobs; tagged blobs ({@link Blobs.tags}) always survive. An `intervalSecs`
   * of `0` or less is treated as off.
   */
  gc?: { intervalSecs: number };
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
  /**
   * Custom ALPN protocol names this endpoint accepts inbound connections on
   * (see {@link Endpoint.streams}). Omit for none.
   *
   * They belong here rather than on {@link Streams.listen} because iroh's
   * router fixes its ALPN set when it spawns, which happens while the endpoint
   * is being created. An empty name, one over 255 bytes, a duplicate, or one
   * that would shadow the built-in blobs or gossip protocols rejects creation
   * with kind `"endpoint-bind"`.
   */
  alpns?: readonly string[];
}

/**
 * An iroh endpoint: a network identity that establishes connections with
 * other endpoints, plus a blob store.
 *
 * Create one with {@link Endpoint.create}; call {@link Endpoint.close} when
 * done (or bind with `await using` to close automatically). All methods
 * reject (or throw) {@link IrohError} exclusively.
 *
 * @see https://docs.rs/iroh/1.0.3/iroh/endpoint/struct.Endpoint.html
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
  private readonly gossipSubscriptions = new Set<GossipSubscriptionController>();
  private readonly docSubscriptions = new Set<DocSubscriptionController>();
  private readonly streamListeners = new Set<StreamListenerController>();
  // Every live connection, however it was obtained (dialled or accepted), so
  // closing the endpoint tears all of them down through one path.
  private readonly streamConnections = new Set<ConnectionController>();

  /**
   * The endpoint's blob transfer API ({@link Blobs.share} /
   * {@link Blobs.download}): the iroh-blobs protocol running over this
   * endpoint.
   *
   * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/
   */
  readonly blobs: Blobs;

  /**
   * The endpoint's gossip pub/sub API ({@link Gossip.subscribe}): the
   * iroh-gossip protocol running over this endpoint.
   *
   * @see https://docs.rs/iroh-gossip/0.101.0/iroh_gossip/
   */
  readonly gossip: Gossip;

  /**
   * The endpoint's raw QUIC stream API ({@link Streams.listen} /
   * {@link Streams.connect}): custom ALPNs and byte streams, for protocols this
   * library does not implement for you.
   */
  readonly streams: Streams;

  /**
   * The endpoint's document API ({@link DocsApi}): author identity plus
   * document CRUD over the iroh-docs meta-protocol. Present always, but every
   * call rejects with kind `"docs-disabled"` unless the endpoint was created
   * with {@link EndpointOptions.docs} enabled.
   *
   * @see https://docs.rs/iroh-docs/0.101.0/iroh_docs/
   */
  readonly docs: DocsApi;

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
      status: (hash) => this.blobStatus(hash),
      has: (hash) => this.blobHas(hash),
      list: () => this.blobList(),
      addBytes: (data) => this.blobAddBytes(data),
      tags: {
        list: () => this.tagsList(),
        create: (name, hash, format) => this.tagsCreate(name, hash, format ?? "raw"),
        delete: (name) => this.tagsDelete(name),
        rename: (from, to) => this.tagsRename(from, to),
      },
    };
    this.gossip = {
      subscribe: (topic, options) => this.subscribeGossip(topic, options),
    };
    this.streams = {
      listen: (alpn, options) => this.listenStreams(alpn, options),
      connect: (peer, alpn, options) => this.connectStreams(peer, alpn, options),
    };
    this.docs = new DocsController(this.docsBinding());
  }

  /** Binds the native docs calls to this endpoint's handle for the docs API. */
  private docsBinding(): DocsBinding {
    const endpoint = this.handle;
    const binding = this.binding;
    return {
      authorsDefault: () => binding.authorsDefault(endpoint),
      authorsCreate: () => binding.authorsCreate(endpoint),
      authorsList: () => binding.authorsList(endpoint),
      authorsImport: (secretKey) => binding.authorsImport(endpoint, secretKey),
      docsCreate: () => binding.docsCreate(endpoint),
      docsOpen: (namespaceId) => binding.docsOpen(endpoint, namespaceId),
      docsImport: (ticket) => binding.docsImport(endpoint, ticket),
      docsList: () => binding.docsList(endpoint),
      docsDrop: (namespaceId) => binding.docsDrop(endpoint, namespaceId),
      docsSetBytes: (namespaceId, authorId, key, value) =>
        binding.docsSetBytes(endpoint, namespaceId, authorId, key, value),
      docsGetExact: (namespaceId, authorId, key) =>
        binding.docsGetExact(endpoint, namespaceId, authorId, key),
      docsGetMany: (namespaceId, queryJson) =>
        binding.docsGetMany(endpoint, namespaceId, queryJson),
      docsDeletePrefix: (namespaceId, authorId, prefix) =>
        binding.docsDeletePrefix(endpoint, namespaceId, authorId, prefix),
      docsShare: (namespaceId, mode) => binding.docsShare(endpoint, namespaceId, mode),
      docsGetContent: (hash) => binding.docsGetContent(endpoint, hash),
      docsSubscribe: (namespaceId, onStart, onEvent, onClose) =>
        binding.docsSubscribe(endpoint, namespaceId, onStart, onEvent, onClose),
      docsUnsubscribe: (subId) => binding.docsUnsubscribe(subId),
      docsStartSync: (namespaceId, peers) =>
        binding.docsStartSync(endpoint, namespaceId, peers.map(serializeEndpointAddr).join("\n")),
      docsLeave: (namespaceId) => binding.docsLeave(endpoint, namespaceId),
      adoptSubscription: (controller) => {
        this.docSubscriptions.add(controller);
      },
      releaseSubscription: (controller) => {
        this.docSubscriptions.delete(controller);
      },
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
    if (options.docs !== undefined) {
      config.docs = options.docs;
    }
    if (options.docsStoreDir !== undefined) {
      config.docsStoreDir = options.docsStoreDir;
    }
    // A non-positive interval is treated as off, so it is simply not forwarded.
    if (options.gc !== undefined && options.gc.intervalSecs > 0) {
      config.gcIntervalSecs = options.gc.intervalSecs;
    }
    if (options.relayMode !== undefined) {
      // Throws a typed IrohError synchronously for an empty custom list.
      config.relayMode = serializeRelayMode(options.relayMode);
    }
    if (options.alpns !== undefined && options.alpns.length > 0) {
      // Newline-joined, matching the collection paths and relay mode
      // conventions for structured bridge inputs.
      config.alpns = options.alpns.join("\n");
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
   * @see https://docs.rs/iroh/1.0.3/iroh/endpoint/struct.Endpoint.html#method.id
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
   * @see https://docs.rs/iroh/1.0.3/iroh/endpoint/struct.Endpoint.html#method.addr
   */
  get addr(): EndpointAddr {
    try {
      return parseEndpointAddr(this.binding.endpointAddr(this.handle));
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /**
   * What this endpoint currently knows about the remote endpoint `remoteId`,
   * or `undefined` if it knows nothing about it (never connected, or since
   * forgotten).
   *
   * This is how you tell whether traffic to a peer is flowing directly or
   * through a relay: {@link addr} describes what *this* endpoint advertises,
   * which says nothing about the path in use. Inspect
   * {@link RemoteInfo.addrs} for the entries with `active: true`.
   *
   * The result is a snapshot, not a live view; call again for a fresh one.
   *
   * @see https://docs.rs/iroh/1.0.3/iroh/endpoint/struct.Endpoint.html#method.remote_info
   */
  async remoteInfo(remoteId: EndpointId): Promise<RemoteInfo | undefined> {
    try {
      const json = await this.binding.remoteInfo(this.handle, remoteId);
      return parseRemoteInfo(json);
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
   * @see https://docs.rs/iroh/1.0.3/iroh/endpoint/struct.Endpoint.html#method.online
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

  /** See {@link Gossip.subscribe}; exposed as {@link Endpoint.gossip}`.subscribe`. */
  private subscribeGossip(topic: string, options?: GossipSubscribeOptions): GossipSubscription {
    // Bootstrap peers cross the bridge as newline-joined EndpointAddr JSON,
    // matching the collection paths convention for structured bridge inputs.
    const bootstrapJoined = (options?.bootstrap ?? []).map(serializeEndpointAddr).join("\n");
    try {
      const controller = new GossipSubscriptionController({
        startSubscribe: (onStart, onMessage, onNeighbor) => {
          this.binding.gossipSubscribe(
            this.handle,
            topic,
            bootstrapJoined,
            onStart,
            onMessage,
            onNeighbor,
          );
        },
        broadcast: (subId, payload) => this.binding.gossipBroadcast(subId, payload),
        unsubscribe: (subId) => this.binding.gossipUnsubscribe(subId),
        capacity: options?.capacity,
        onDispose: () => {
          this.gossipSubscriptions.delete(controller);
        },
      });
      this.gossipSubscriptions.add(controller);
      return controller;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Streams.listen}; exposed as {@link Endpoint.streams}`.listen`. */
  private listenStreams(alpn: string, options?: StreamOptions): StreamListener {
    const framing = options?.framing ?? "framed";
    try {
      const listener = new StreamListenerController(this.streamsBinding(), {
        alpn,
        createConnection: (connectionId, remoteId) =>
          this.adoptStreamConnection(connectionId, {
            remoteId,
            alpn,
            framing,
            capacity: options?.capacity,
          }),
        onDispose: () => {
          this.streamListeners.delete(listener);
        },
      });
      this.streamListeners.add(listener);
      return listener;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Streams.connect}; exposed as {@link Endpoint.streams}`.connect`. */
  private async connectStreams(
    peer: EndpointId | EndpointAddr,
    alpn: string,
    options?: StreamOptions,
  ): Promise<Connection> {
    // A bare id becomes an address with no transports, leaving resolution to
    // discovery; a full address seeds the peer's transports natively first.
    const addr: EndpointAddr =
      typeof peer === "string" ? { id: peer, relayUrls: [], directAddrs: [] } : peer;
    try {
      const connectionId = await this.binding.streamConnect(
        this.handle,
        serializeEndpointAddr(addr),
        alpn,
      );
      return this.adoptStreamConnection(connectionId, {
        remoteId: addr.id,
        alpn,
        framing: options?.framing ?? "framed",
        capacity: options?.capacity,
      });
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /**
   * Wraps one native connection and registers it for the endpoint's teardown.
   * Both the dialled and the accepted path go through here so `close()` has a
   * single set to cascade through.
   */
  private adoptStreamConnection(
    connectionId: number,
    init: { remoteId: EndpointId; alpn: string; framing: StreamFraming; capacity?: number },
  ): Connection {
    const connection = new ConnectionController(this.streamsBinding(), connectionId, {
      ...init,
      onDispose: () => {
        this.streamConnections.delete(connection);
      },
    });
    this.streamConnections.add(connection);
    return connection;
  }

  /** The raw-stream calls, bound to this endpoint's handle. */
  private streamsBinding(): StreamsBinding {
    return {
      listen: (alpn, onConnection, onClose) =>
        this.binding.streamListen(this.handle, alpn, onConnection, onClose),
      stopListen: (listenerId) => this.binding.stopStreamListen(listenerId),
      connect: (remoteAddrJson, alpn) =>
        this.binding.streamConnect(this.handle, remoteAddrJson, alpn),
      subscribeConnection: (connectionId, framing, onStream, onClose) =>
        this.binding.streamConnectionSubscribe(connectionId, framing, onStream, onClose),
      openStream: (connectionId) => this.binding.streamOpenStream(connectionId),
      closeConnection: (connectionId) => this.binding.streamCloseConnection(connectionId),
      subscribeStream: (streamId, onData, onClose) =>
        this.binding.streamSubscribe(streamId, onData, onClose),
      send: (streamId, data) => this.binding.streamSend(streamId, data),
      closeStream: (streamId) => this.binding.streamClose(streamId),
    };
  }

  /** See {@link Blobs.share}; exposed as {@link Endpoint.blobs}`.share`. */
  private async shareBlob(path: string): Promise<BlobTicket> {
    try {
      return (await this.binding.shareBlob(this.handle, path)) as BlobTicket;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Blobs.status}. */
  private async blobStatus(hash: string): Promise<BlobStatus> {
    try {
      return JSON.parse(await this.binding.blobStatus(this.handle, hash)) as BlobStatus;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Blobs.has}. */
  private async blobHas(hash: string): Promise<boolean> {
    try {
      return await this.binding.blobHas(this.handle, hash);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Blobs.list}. */
  private async blobList(): Promise<BlobInfo[]> {
    try {
      return JSON.parse(await this.binding.blobList(this.handle)) as BlobInfo[];
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Blobs.addBytes}. */
  private async blobAddBytes(data: ArrayBuffer): Promise<BlobTicket> {
    try {
      return (await this.binding.addBytes(this.handle, data)) as BlobTicket;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Tags.list}. */
  private async tagsList(): Promise<TagInfo[]> {
    try {
      return JSON.parse(await this.binding.tagsList(this.handle)) as TagInfo[];
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Tags.create}. */
  private async tagsCreate(name: string, hash: string, format: BlobFormat): Promise<void> {
    try {
      await this.binding.tagsCreate(this.handle, name, hash, format);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Tags.delete}. */
  private async tagsDelete(name: string): Promise<void> {
    try {
      await this.binding.tagsDelete(this.handle, name);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  /** See {@link Tags.rename}. */
  private async tagsRename(from: string, to: string): Promise<void> {
    try {
      await this.binding.tagsRename(this.handle, from, to);
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
        const entries = JSON.parse(manifest) as { name: string; ticket: string }[];
        for (const entry of entries) {
          requireContainedChildName(entry.name);
        }
        return entries;
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
        for (const subscription of [...this.gossipSubscriptions]) {
          subscription.unsubscribe();
        }
        for (const subscription of [...this.docSubscriptions]) {
          subscription.unsubscribe();
        }
        for (const listener of [...this.streamListeners]) {
          listener.close();
        }
        for (const connection of [...this.streamConnections]) {
          connection.close();
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
