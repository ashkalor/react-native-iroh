import type { HybridObject } from "react-native-nitro-modules";

/**
 * Which of iroh's endpoint presets an endpoint binds with.
 *
 * - `n0`: n0's production relay and discovery infrastructure (the default).
 * - `minimal`: only the mandatory configuration; no relays, no discovery.
 *   Peers are only reachable via direct addresses embedded in tickets
 *   (tests / LAN-only setups).
 *
 * @see https://docs.rs/iroh/1.0.3/iroh/endpoint/presets/index.html
 */
export type NetworkPreset = "n0" | "minimal";

/**
 * How a raw QUIC stream splits its byte stream into the chunks the host sees.
 *
 * - `framed`: each send is written as a big-endian `u32` byte length followed
 *   by the payload, and the reader reassembles whole frames, so one send is
 *   delivered as exactly one chunk.
 * - `raw`: bytes are written and delivered verbatim, with no message
 *   boundaries (a QUIC stream is a byte stream, so chunk boundaries are
 *   whatever the network produced).
 *
 * Both peers on a stream must agree; the mode is part of the protocol the ALPN
 * names.
 */
export type StreamFraming = "framed" | "raw";

/**
 * Configuration for {@link Iroh.createEndpoint}.
 */
export interface EndpointConfig {
  /** Network infrastructure preset. */
  preset: NetworkPreset;
  /**
   * Absolute directory path for the persistent blob store. Omit to keep
   * blobs in memory (they are lost when the endpoint closes).
   */
  blobStoreDir?: string;
  /**
   * Enable the iroh-docs meta-protocol on this endpoint. Docs layers over the
   * same endpoint as blobs and gossip, sharing one router. Omit (or `false`) to
   * pay zero docs cost: no docs store, no ALPN, no background engine.
   */
  docs?: boolean;
  /**
   * Absolute directory path for the persistent docs store, used only when
   * {@link EndpointConfig.docs} is enabled. Omit to keep docs (replicas and
   * authors) in memory (they are lost when the endpoint closes).
   */
  docsStoreDir?: string;
  /**
   * Enable mDNS LAN discovery (`_irohv1._udp.local`) on this endpoint, so peers
   * on the same network resolve each other by endpoint id with no relay and no
   * seeded addresses. Omit (or `false`) for no mDNS.
   *
   * Requires a build compiled with the `mdns` Cargo feature (Android ships it;
   * Apple builds are compiled out until the consumer holds the multicast
   * entitlement). On a build without it, `true` rejects endpoint creation with
   * an mDNS-unavailable error (code 7000) rather than silently doing nothing;
   * check {@link Iroh.mdnsSupported} first.
   */
  discoveryMdns?: boolean;
  /**
   * Relay configuration, carried as a single delimited string (the Phase 2
   * convention for structured bridge inputs, matching newline-joined paths):
   *
   * - the bare words `"default"`, `"disabled"`, or `"staging"` select a
   *   preset relay map;
   * - `"custom\n<url>\n<url>..."` (the literal tag `custom` followed by one
   *   or more newline-separated HTTPS relay URLs) supplies a custom map.
   *
   * Omit to inherit the network preset's default relay behavior. When set it
   * overrides the preset's relays while leaving discovery untouched. Parse
   * failures surface as an endpoint-bind error (code 2000).
   */
  relayMode?: string;
  /**
   * Opt-in blob garbage collection interval, in seconds. Omit (or pass a
   * non-positive value) to keep GC OFF: nothing is ever reclaimed, exactly
   * today's retention. When set, the store spawns a mark-and-sweep loop at this
   * interval that reclaims untagged blobs; tagged blobs (see the tag lifecycle)
   * always survive. Carried as a flat number to keep the bridge primitive.
   */
  gcIntervalSecs?: number;
  /**
   * Custom ALPN protocol names this endpoint accepts inbound connections on,
   * newline-joined (the same convention as {@link EndpointConfig.relayMode}).
   * Omit for none.
   *
   * They must be declared here rather than registered later because iroh's
   * router fixes its ALPN set when it spawns, which happens during
   * {@link Iroh.createEndpoint}. {@link Iroh.streamListen} then attaches to one
   * of the names declared here. An empty name, one longer than 255 bytes, a
   * duplicate, or one colliding with the built-in blobs/gossip ALPNs is an
   * endpoint-bind error (code 2000).
   */
  alpns?: string;
}

/**
 * The react-native-iroh native bridge.
 *
 * Errors: every rejected Promise (and every thrown sync error) carries a
 * message of the form `[iroh:<code>] <detail>`, where `<code>` is a stable
 * numeric error code (1000-1003 generic, 2000 endpoint, 3000-3003 blobs,
 * 4000-4002 gossip, 5000-5006 raw streams, 6000-6003 docs, 7000 mDNS). Parse it
 * with `/\[iroh:(\d+)\]/`.
 */
// The published react-native-nitro-modules@0.36.1 types don't include "rust"
// in PlatformSpec yet. Only the nitrogen fork's Rust codegen understands it.
// Types-only skew; the native runtime is unaffected.
// @ts-expect-error TS2344: "rust" is not in the pinned PlatformSpec union
export interface Iroh extends HybridObject<{ ios: "rust"; android: "rust" }> {
  /**
   * Creates an endpoint (binds sockets, loads the blob store) and resolves
   * with its opaque handle. Handles are never `0` and never reused.
   */
  createEndpoint(config: EndpointConfig): Promise<number>;
  /** Returns the endpoint's id (its public key) as a string. Cheap and synchronous. */
  endpointId(endpoint: number): string;
  /** Whether `endpoint` refers to a live (not yet closed) endpoint. */
  isEndpointOpen(endpoint: number): boolean;
  /**
   * Returns the endpoint's current address as a JSON object string
   * `{ id, relayUrls, directAddrs }` (see the `EndpointAddr` TS type).
   * Synchronous: a snapshot of the latest observed address, no network I/O.
   */
  endpointAddr(endpoint: number): string;
  /**
   * Registers a watcher for the endpoint's address. `onStart` fires once,
   * synchronously, with the watch's numeric handle (pass it to
   * {@link stopWatchAddr}); `onChange` then fires with each new address as a
   * JSON `EndpointAddr` string. Mirrors {@link downloadBlob}'s `onStart`
   * (f64 handle) + {@link stopWatchAddr} (cancel by id) primitives. Throws
   * (code 1001) if the endpoint handle is stale.
   */
  watchAddr(
    endpoint: number,
    onStart: (watchId: number) => void,
    onChange: (addr: string) => void,
  ): void;
  /**
   * Stops a watcher started with {@link watchAddr}, aborting its background
   * task. Idempotent: stopping an already-stopped or unknown watch is a no-op.
   */
  stopWatchAddr(watchId: number): void;
  /**
   * Returns what this endpoint currently knows about the remote `remoteId`, as
   * a JSON object string `{ id, addrs: [{ addr, kind, active }] }` (see the
   * `RemoteInfo` TS type), or the JSON literal `null` if the remote is unknown.
   *
   * `kind` is `"relay"` or `"ip"`, and `active` marks the addresses actually
   * carrying traffic. This is the only way to observe whether a transfer went
   * direct or through a relay: {@link endpointAddr} reports what the *local*
   * endpoint advertises, which says nothing about the path in use. Rejects
   * (code 2000) if `remoteId` is not a valid endpoint id.
   */
  remoteInfo(endpoint: number, remoteId: string): Promise<string>;
  /**
   * Resolves once the endpoint has a connected home relay, or rejects (code
   * 2000) if `timeoutMs` elapses first. On relay-less endpoints (the
   * `disabled` relay mode, or a `minimal` preset) it always times out, since
   * no home relay can ever connect.
   */
  endpointOnline(endpoint: number, timeoutMs: number): Promise<void>;
  /**
   * Closes an endpoint: shuts down its router, sockets and blob store. The
   * handle is invalid from this point on.
   */
  closeEndpoint(endpoint: number): Promise<void>;
  /**
   * Imports the file at absolute `path` into the endpoint's blob store and
   * resolves with a shareable ticket string. On the `n0` preset this waits
   * (bounded) for the endpoint to come online first, so the ticket contains
   * dialable addresses.
   */
  shareBlob(endpoint: number, path: string): Promise<string>;
  /**
   * Downloads the blob described by `ticket` into absolute `destPath`.
   *
   * `onStart` fires once with the transfer's handle (usable with
   * {@link cancelDownload}) before any progress is reported. `onProgress`
   * reports cumulative payload bytes received; events are coalesced natively
   * to at most ~30 per second, the latest value is always flushed before the
   * Promise settles, and the total size is unknown in v0.1.0. The returned
   * Promise settles exactly once: resolved on success, rejected on failure
   * or cancellation (code 3003).
   */
  downloadBlob(
    endpoint: number,
    ticket: string,
    destPath: string,
    onStart: (transferId: number) => void,
    onProgress: (bytesReceived: number) => void,
  ): Promise<void>;
  /**
   * Requests cancellation of an in-flight download. Idempotent: calling it
   * on an already-finished (or unknown) transfer is a no-op. A cancelled
   * transfer's Promise rejects with code 3003.
   */
  cancelDownload(transferId: number): void;
  /**
   * Bundles the files named in `pathsJoined` (absolute paths, joined with a
   * single `"\n"`) into an iroh-blobs Collection and resolves with one
   * shareable HashSeq ticket string. Like {@link Iroh.shareBlob} it waits
   * (bounded) for the endpoint to come online on the `n0` preset.
   *
   * Structured data crosses the bridge as delimited/JSON strings to keep the
   * native surface to the primitive shapes the Rust bridge already supports.
   *
   * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/format/collection/struct.Collection.html
   */
  shareCollection(endpoint: number, pathsJoined: string): Promise<string>;
  /**
   * Fetches only the manifest of the collection described by `ticket` (its
   * HashSeq root plus metadata blob, not the child payloads) and resolves with
   * a JSON array string of `{ name, ticket }` objects: one per child, each
   * `ticket` a standalone raw-blob ticket dialable through
   * {@link Iroh.downloadBlob}. Rejects (code 1002) if `ticket` is not a
   * collection (HashSeq) ticket.
   */
  collectionManifest(endpoint: number, ticket: string): Promise<string>;
  /**
   * Decodes `ticket` and returns a JSON object string
   * `{ hash, format, nodeId, size? }` (see the `TicketInfo` TS type).
   * Synchronous and side-effect-free: a pure parse of the ticket wire format,
   * no network or store access. Throws (code 1002) on a malformed ticket.
   */
  parseTicket(ticket: string): string;
  /**
   * Reports the local presence of the blob `hash` (64-hex) in the endpoint's
   * store as a JSON discriminated union string (see the `BlobStatus` TS type):
   * `{"state":"notFound"}`, `{"state":"partial","size"?:number}`, or
   * `{"state":"complete","size":number}`. A `partial` blob is one an
   * interrupted {@link downloadBlob} left behind; re-issuing the download
   * fetches only the missing ranges. Rejects (code 3004) on a malformed hash.
   */
  blobStatus(endpoint: number, hash: string): Promise<string>;
  /**
   * Whether the store holds the blob `hash` (64-hex) complete and
   * BLAKE3-verified. A partially-present blob resolves `false`. Rejects
   * (code 3004) on a malformed hash.
   */
  blobHas(endpoint: number, hash: string): Promise<boolean>;
  /**
   * Lists the complete blobs in the endpoint's store as a JSON array string of
   * `{ hash, size }` objects (see the `BlobInfo` TS type).
   */
  blobList(endpoint: number): Promise<string>;
  /**
   * Imports the in-memory `data` into the endpoint's blob store and resolves
   * with a shareable ticket string, the in-memory counterpart of
   * {@link shareBlob}. On the `n0` preset it waits (bounded) for the endpoint
   * to come online first. Rejects (code 3000) if the import fails.
   */
  addBytes(endpoint: number, data: ArrayBuffer): Promise<string>;
  /**
   * Lists every tag in the endpoint's store as a JSON array string of
   * `{ name, hash, format }` objects (see the `TagInfo` TS type). Tags are the
   * sanctioned retention mechanism: a tagged blob survives GC.
   */
  tagsList(endpoint: number): Promise<string>;
  /**
   * Creates (or overwrites) the tag `name`, pinning the blob `hash` (64-hex) in
   * `format` (`"raw"` or `"hashSeq"`) so GC keeps it. Rejects (code 3004) on a
   * malformed hash or an unknown format.
   */
  tagsCreate(endpoint: number, name: string, hash: string, format: string): Promise<void>;
  /**
   * Deletes the tag `name`. The blob it pinned is not removed here; it becomes
   * GC-eligible and is reclaimed only if (and when) a GC loop runs. Deletion
   * stays GC-only by design. Deleting an absent tag is not an error.
   */
  tagsDelete(endpoint: number, name: string): Promise<void>;
  /**
   * Renames the tag `from` to `to` atomically. Rejects (code 3004) if `from`
   * does not exist.
   */
  tagsRename(endpoint: number, from: string, to: string): Promise<void>;
  /**
   * Subscribes to the gossip topic derived from `topic` (its BLAKE3 hash) on
   * `endpoint`. `bootstrapJoined` is a possibly-empty newline-joined list of
   * bootstrap peer `EndpointAddr` JSON strings (the same shape
   * {@link Iroh.endpointAddr} returns); their addresses seed the swarm so it
   * can dial them by id.
   *
   * Set-up is validated synchronously (a stale endpoint handle throws code
   * 1001; a malformed bootstrap address throws code 4000). Once the topic is
   * joined, `onStart` fires once with the subscription's numeric handle (pass
   * it to {@link gossipBroadcast} / {@link gossipUnsubscribe}). `onMessage`
   * then fires per received message as `"<delivered-from-id> <utf8-payload>"`
   * (split on the first space), and `onNeighbor` per swarm event: `"up <id>"`,
   * `"down <id>"`, or `"lagged"` (the receiver fell behind and dropped
   * messages).
   *
   * Mirrors {@link watchAddr}'s onStart-returns-handle primitive; structured
   * inputs/outputs cross the bridge as delimited/JSON strings.
   */
  gossipSubscribe(
    endpoint: number,
    topic: string,
    bootstrapJoined: string,
    onStart: (subId: number) => void,
    onMessage: (message: string) => void,
    onNeighbor: (event: string) => void,
  ): void;
  /**
   * Broadcasts `payload` (UTF-8) to every peer in the subscription's swarm.
   * Rejects with code 4002 if the payload exceeds the per-message size limit
   * (4096 bytes), code 1001 if the subscription is unknown/already ended, or
   * code 4001 if the swarm broadcast fails. Resolves once the message has been
   * handed to the swarm (peer delivery is best effort).
   */
  gossipBroadcast(subId: number, payload: string): Promise<void>;
  /**
   * Ends a subscription started with {@link gossipSubscribe}, leaving the
   * topic's swarm. Idempotent: ending an unknown or already-ended subscription
   * is a no-op.
   */
  gossipUnsubscribe(subId: number): void;
  /**
   * Starts delivering inbound connections that negotiated `alpn`, and returns
   * the listener's numeric handle (pass it to {@link stopStreamListen}).
   *
   * `alpn` must be one of the names declared in {@link EndpointConfig.alpns};
   * anything else, or a second listener on the same name, throws code 5000. A
   * stale endpoint handle throws code 1001.
   *
   * `onConnection` fires per accepted connection as
   * `"<connection-id> <remote-endpoint-id>"` (split on the first space).
   * `onClose` fires once when the listener stops delivering, as `"end"` (the
   * listener or its endpoint was shut down) or `"error <detail>"`.
   *
   * Connections accepted while the host has not consumed earlier ones are held
   * in a bounded native backlog; once it is full further connection attempts
   * are refused rather than queued without limit.
   */
  streamListen(
    endpoint: number,
    alpn: string,
    onConnection: (connection: string) => void,
    onClose: (event: string) => void,
  ): number;
  /**
   * Stops a listener started with {@link streamListen}. Idempotent, and does
   * not close connections it already delivered.
   */
  stopStreamListen(listenerId: number): void;
  /**
   * Dials the peer described by `remoteAddr` on `alpn` and resolves with the
   * new connection's numeric handle.
   *
   * `remoteAddr` is one `EndpointAddr` JSON object (the shape
   * {@link endpointAddr} returns); any addresses it carries are seeded into the
   * endpoint's address lookup, exactly as a gossip bootstrap peer is, so a dial
   * works without a discovery service. An object carrying only an id leaves
   * resolution to the endpoint's discovery.
   *
   * Rejects with code 1001 for a stale endpoint, or 5001 for a malformed
   * address or a dial that fails (unreachable peer, or a peer that does not
   * accept `alpn`).
   */
  streamConnect(endpoint: number, remoteAddr: string, alpn: string): Promise<number>;
  /**
   * Fixes the connection's {@link StreamFraming} and starts accepting the
   * bidirectional streams the peer opens on it. Nothing is accepted before this
   * call, so the host cannot miss a stream by subscribing late.
   *
   * `onStream` fires with each accepted stream's numeric handle; `onClose`
   * fires once as `"end"` or `"error <detail>"` when the connection ends.
   * Throws code 1001 if the connection handle is unknown.
   */
  streamConnectionSubscribe(
    connectionId: number,
    framing: StreamFraming,
    onStream: (streamId: number) => void,
    onClose: (event: string) => void,
  ): void;
  /**
   * Opens a bidirectional stream on the connection and resolves with its
   * numeric handle. Rejects with code 1001 for an unknown connection or 5002 if
   * the peer or the transport refuses the stream.
   */
  streamOpenStream(connectionId: number): Promise<number>;
  /**
   * Closes a connection and every stream on it. Idempotent.
   */
  streamCloseConnection(connectionId: number): void;
  /**
   * Starts reading the stream, delivering each chunk to `onData` as an
   * `ArrayBuffer` (whole frames under `framed`, whatever arrives under `raw`).
   * No bytes are read before this call. `onClose` fires exactly once as
   * `"end"` (the peer finished the stream) or `"error <detail>"`. Throws code
   * 1001 if the stream handle is unknown.
   */
  streamSubscribe(
    streamId: number,
    onData: (chunk: ArrayBuffer) => void,
    onClose: (event: string) => void,
  ): void;
  /**
   * Writes `data` to the stream, resolving once it is handed to the QUIC send
   * buffer (which is not a delivery receipt). Concurrent sends on one stream
   * are serialized, so a `framed` payload is never interleaved with another.
   * Rejects with code 5005 if a `framed` payload exceeds the 16 MiB frame
   * limit, 1001 for an unknown stream, or 5003 if the write fails.
   */
  streamSend(streamId: number, data: ArrayBuffer): Promise<void>;
  /**
   * Finishes the stream's send side, stops reading it, and releases it.
   * Idempotent.
   */
  streamClose(streamId: number): void;
  /**
   * Returns this node's default author id (hex), creating it on first use.
   * Rejects with code 6000 if the endpoint was created without docs enabled.
   */
  authorsDefault(endpoint: number): Promise<string>;
  /** Creates a new author and resolves with its id (hex). */
  authorsCreate(endpoint: number): Promise<string>;
  /**
   * Resolves with the ids (hex) of every author this node holds a secret key
   * for, newline-joined (empty string when there are none).
   */
  authorsList(endpoint: number): Promise<string>;
  /**
   * Imports an author from its secret key (hex) and resolves with its id (hex).
   * Rejects with code 6002 if the secret is malformed.
   */
  authorsImport(endpoint: number, secretKey: string): Promise<string>;
  /** Creates a new document and resolves with its namespace id (hex). */
  docsCreate(endpoint: number): Promise<string>;
  /**
   * Whether a document with `namespaceId` (hex) is known to this node. Backs
   * `open() -> Doc | null`. Rejects with code 6002 for a malformed id.
   */
  docsOpen(endpoint: number, namespaceId: string): Promise<boolean>;
  /**
   * Imports a document from a `DocTicket` string, joining the peers it names,
   * and resolves with its namespace id (hex). Live sync is not started here.
   * Rejects with code 6003 for a malformed ticket.
   */
  docsImport(endpoint: number, ticket: string): Promise<string>;
  /**
   * Resolves with the namespace ids (hex) of every document on this node,
   * newline-joined (empty string when there are none).
   */
  docsList(endpoint: number): Promise<string>;
  /** Removes a document and its entries from this node. */
  docsDrop(endpoint: number, namespaceId: string): Promise<void>;
  /**
   * Writes `value` under `key` for `author` in the document (bytes go to the
   * shared blob store) and resolves with the content hash (hex).
   */
  docsSetBytes(
    endpoint: number,
    namespaceId: string,
    authorId: string,
    key: string,
    value: ArrayBuffer,
  ): Promise<string>;
  /**
   * Resolves with the entry for `author` + `key` as a JSON object string
   * `{ author, key, hash, size, timestamp }` (see the `DocEntry` TS type), or
   * the JSON literal `null` if there is none (a deleted entry reads as absent).
   * The content hash is included; the bytes are not.
   */
  docsGetExact(
    endpoint: number,
    namespaceId: string,
    authorId: string,
    key: string,
  ): Promise<string>;
  /**
   * Resolves with a JSON array string of `DocEntry` objects matching
   * `queryJson` (a JSON object `{ author?, keyExact?, keyPrefix? }`; empty
   * string matches all). Each entry carries its content hash; bytes are not
   * fetched.
   */
  docsGetMany(endpoint: number, namespaceId: string, queryJson: string): Promise<string>;
  /**
   * Deletes every entry for `author` whose key equals `prefix` OR starts with
   * it, and resolves with the number removed. Prefix-scoped: iroh-docs has no
   * exact-delete primitive, so this also removes any prefix-siblings.
   */
  docsDeletePrefix(
    endpoint: number,
    namespaceId: string,
    authorId: string,
    prefix: string,
  ): Promise<number>;
  /**
   * Mints a shareable `DocTicket` string for the document. `mode` is `"read"`
   * or `"write"`.
   */
  docsShare(endpoint: number, namespaceId: string, mode: string): Promise<string>;
  /**
   * Resolves an entry's content by its `hash` (hex), reading the bytes out of
   * the endpoint's shared blob store as an `ArrayBuffer`. This is the opt-in
   * content fetch: reads never pull bytes on their own.
   */
  docsGetContent(endpoint: number, hash: string): Promise<ArrayBuffer>;
  /**
   * Subscribes to the live {@link https://docs.rs/iroh-docs/0.101.0/iroh_docs/engine/enum.LiveEvent.html LiveEvent}
   * stream of the document `namespaceId`, holding the replica open for the
   * subscription's lifetime.
   *
   * Set-up is validated synchronously (a stale endpoint handle throws code 1001;
   * a docs-disabled endpoint throws code 6000). Once the replica is open and the
   * stream is live, `onStart` fires once with the subscription's numeric handle
   * (pass it to {@link docsUnsubscribe}). `onEvent` then fires per event with a
   * JSON discriminated union `{ type, ... }` (see the `DocLiveEvent` TS type):
   * `insert-local`, `insert-remote`, `content-ready`, `pending-content-ready`,
   * `neighbor-up`, `neighbor-down`, `sync-finished`.
   *
   * `onClose` fires exactly once when the subscription ends, as the tagged line
   * `"end"` (the stream finished, e.g. the endpoint closed) or `"error <detail>"`
   * (opening the replica or the stream failed, in which case `onStart` never
   * fires). Subscribing does NOT start live sync; drive sync with
   * {@link docsStartSync}.
   */
  docsSubscribe(
    endpoint: number,
    namespaceId: string,
    onStart: (subId: number) => void,
    onEvent: (event: string) => void,
    onClose: (event: string) => void,
  ): void;
  /**
   * Ends a subscription started with {@link docsSubscribe}, closing the replica
   * handle it held open. Idempotent: ending an unknown or already-ended
   * subscription is a no-op.
   */
  docsUnsubscribe(subId: number): void;
  /**
   * Starts (or refreshes) live sync of the document `namespaceId` with the peers
   * in `peersJoined` (a possibly-empty newline-joined list of `EndpointAddr`
   * JSON strings, the same convention as {@link gossipSubscribe}'s
   * bootstrap). Non-empty peers do an initial set-reconciliation with each and
   * join the document's gossip swarm; their addresses are seeded into the
   * endpoint's lookup so they are dialable on the `minimal` preset. An empty
   * list syncs with already-known peers.
   */
  docsStartSync(endpoint: number, namespaceId: string, peersJoined: string): Promise<void>;
  /**
   * Stops the live sync for the document `namespaceId` and leaves its gossip
   * swarm.
   */
  docsLeave(endpoint: number, namespaceId: string): Promise<void>;
  /**
   * Decodes `ticket` and returns a JSON object string
   * `{ namespace, capability, nodeIds }` (see the `DocTicketInfo` TS type).
   * Synchronous and side-effect-free. Throws code 6003 on a malformed ticket.
   */
  parseDocTicket(ticket: string): string;
  /**
   * Whether this native build was compiled with mDNS discovery (the `mdns`
   * Cargo feature). `false` on a build compiled out of mDNS (every Apple build
   * until the consumer holds the multicast entitlement); the JS layer surfaces
   * this as `MDNS_SUPPORTED`. When `false`, {@link EndpointConfig.discoveryMdns}
   * and {@link mdnsSubscribe} both fail with an mDNS-unavailable error (7000).
   * Cheap and synchronous.
   */
  mdnsSupported(): boolean;
  /**
   * Subscribes to `endpoint`'s live mDNS discovery stream (peers on the LAN
   * appearing and expiring). The endpoint must have been created with
   * {@link EndpointConfig.discoveryMdns}.
   *
   * Set-up is validated synchronously (a stale endpoint handle throws code
   * 1001; an endpoint without mDNS, or a build compiled without the feature,
   * throws code 7000). Once the stream is live, `onStart` fires once with the
   * subscription's numeric handle (pass it to {@link mdnsUnsubscribe}). `onEvent`
   * then fires per event with a JSON discriminated union `{ type, ... }` (see the
   * `DiscoveryEvent` TS type): `discovered` (with `endpointId`, `relayUrls`,
   * `directAddrs`) or `expired` (with `endpointId`). `onClose` fires exactly once
   * when the subscription ends, as `"end"` or `"error <detail>"`.
   */
  mdnsSubscribe(
    endpoint: number,
    onStart: (subId: number) => void,
    onEvent: (event: string) => void,
    onClose: (event: string) => void,
  ): void;
  /**
   * Ends a subscription started with {@link mdnsSubscribe}. Idempotent: ending
   * an unknown or already-ended subscription is a no-op.
   */
  mdnsUnsubscribe(subId: number): void;
}
