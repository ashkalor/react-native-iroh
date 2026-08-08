# react-native-iroh

iroh for React Native: direct Rust bindings to the
[iroh](https://github.com/n0-computer/iroh) peer-to-peer networking stack.

iroh lets any device dial any other device on the planet by its endpoint id:
QUIC connections that hole-punch through NATs when a direct path exists and
fall back to relays when it does not. This package puts the real thing
inside your React Native app: the actual iroh 1.x Rust crates (`iroh`
1.0.3, `iroh-blobs` 0.103.0, `iroh-gossip` 0.101.0) compiled into your build and bound to
JavaScript through [Nitro](https://github.com/mrousavy/nitro) with direct
Rust-to-C++ bindings, not a JS reimplementation.

```bash
npm install react-native-iroh react-native-nitro-modules
```

A few things worth knowing up front:

- The official [iroh-ffi](https://github.com/n0-computer/iroh-ffi) bindings
  expose no React Native path, and their 1.x line currently ships no blobs
  support. This package fills that gap.
- The runtime rides Nitro/JSI directly: calls go JS to C++ to Rust in
  process, with no JSON serialization bridge and synchronous access where
  the API allows it. Consumers never run codegen: all generated bindings
  ship committed in the package.
- The surface is deliberately small and honest: an `Endpoint` (the iroh node)
  plus the protocols bound so far, `iroh-blobs` and `iroh-gossip`. More land as
  the binding surface grows; see [Protocols](#protocols).

## The Endpoint

Everything in iroh hangs off an `Endpoint`, and so does everything in this
package. An endpoint is an iroh node running inside your app:

- **Identity**: every endpoint has an `id`, the public key other devices
  use to reach it. It is stable for the endpoint's lifetime and cached at
  creation, so reading it never touches native code.
- **Lifecycle**: `Endpoint.create()` binds sockets and loads the blob
  store; `close()` shuts down the router, sockets, and store with
  well-defined one-shot semantics, and `await using` binds that close to a
  scope. `isOpen` tells you where you are in between.
- **Network presets** (iroh's `presets`): `n0` uses n0's relay and
  discovery infrastructure (the production default); `minimal` uses only
  the mandatory configuration, for tests and LAN-only setups where peers
  are reachable only via direct addresses embedded in tickets.
- **Storage**: pass `blobStoreDir` for a persistent on-disk blob store,
  or omit it to keep blobs in memory for the endpoint's lifetime.

The full option and method reference is under
[API reference](#api-reference); a graded set of runnable snippets lives in
[docs/examples](./docs/examples).

## Protocols

iroh itself is the connection layer; what runs over a connection is a
protocol. This package ships protocols as their bindings mature.

### iroh-blobs (available now)

Content-addressed blob transfer with BLAKE3-verified streaming, namespaced
under `endpoint.blobs`. The complete protocol surface:

- `blobs.share(path)` imports a file into the endpoint's blob store and
  returns a `BlobTicket` (hash plus dialable addresses) that any other
  endpoint can download from while the sharer is open.
- `blobs.download(ticket, destPath, options?)` returns a `Transfer` handle
  synchronously: a settlement promise (`done`), live progress as either a
  callback subscription or an async iterable, idempotent `cancel()`, and
  optional `AbortSignal` integration.
- Downloads are capped per endpoint (default 32, `Infinity` to disable) and
  queued FIFO beyond the cap; progress events are coalesced natively so slow
  consumers never buffer unboundedly.
- `blobs.shareCollection(paths)` bundles several files under one ticket;
  `blobs.downloadCollection(ticket, destDir)` fetches them all with a live
  per-file progress breakdown.
- Every failure (sync throw or rejection) is a typed `IrohError` with a
  stable numeric `code` and discriminated `kind`.

### iroh-gossip (available now)

Epidemic pub/sub: peers that subscribe to the same topic form a swarm and
broadcast messages to one another, namespaced under `endpoint.gossip`.

- `gossip.subscribe(topic, options?)` joins the topic derived from a free-form
  label (its BLAKE3 hash) and returns a `GossipSubscription` synchronously: a
  `joined` promise, an async-iterable `messages` log, an async-iterable
  `neighbors` stream, `broadcast(text)`, and `unsubscribe()`.
- The join completes asynchronously, so `await sub.joined` is how you know the
  subscription is live. Do not infer it from the first message: the first peer
  on a topic joins successfully and then sits alone until someone else arrives.
  If the join fails, `joined` rejects with kind `"gossip-subscribe"` and both
  streams end with that error.
- `messages` is a bounded FIFO (non-conflating, unlike the address stream):
  every message is delivered in order, and under overflow the oldest unread
  messages are dropped so the live tail keeps flowing (a `lagged` signal is
  logged). Configure the buffer with `options.capacity`. It is one shared
  stream: consuming a message removes it, so fan out yourself if several
  consumers each need every message.
- `broadcast(text)` sends UTF-8 up to 4096 bytes per message; oversize payloads
  reject with kind `"gossip-message-too-large"`. Gossip payloads are strings in
  both directions, so send binary as base64 (or another text encoding) and
  budget for the encoding's size overhead against the 4096-byte limit. For
  binary at any size, use a raw stream instead: those carry `Uint8Array`
  directly.
- On the `"minimal"` preset supply `options.bootstrap` peers (their
  `EndpointAddr`s) so endpoints can find each other; on `"n0"` discovery can
  resolve peers without one.
- A topic is not access-controlled: anyone who knows the label (and can reach a
  swarm member) can join it and read what is broadcast, and `from` identifies
  the neighbor that relayed a message, not its author. Treat the label as a
  channel name, not a secret, and put your own authentication or encryption in
  the payload if a topic carries anything sensitive.

### Raw QUIC streams (available now)

The layer the two protocols above are themselves built on, exposed under
`endpoint.streams` so you can define your own protocol instead of waiting for
one to be bound here.

- Declare the ALPNs you accept when you create the endpoint
  (`Endpoint.create({ alpns: ["myapp/1"] })`), then `streams.listen(alpn)` for
  an async-iterable of inbound `Connection`s. The ALPN set is fixed at creation
  because iroh's router fixes its own when it spawns; dialling has no such
  constraint.
- `streams.connect(peer, alpn)` dials out, by `EndpointId` where discovery can
  resolve the peer, or by full `EndpointAddr` where it cannot (the `minimal`
  preset, LAN-only setups).
- A `Connection` multiplexes any number of bidirectional `Stream`s:
  `openStream()` for ones you start, the `incoming` async-iterable for ones the
  peer starts. Each stream is `send(bytes)` plus a `data` async-iterable of
  `Uint8Array` chunks.
- Choose the framing per connection. `"framed"` (the default) length-prefixes
  every send natively and reassembles whole frames on the other side, so one
  `send` arrives as exactly one chunk. `"raw"` writes and delivers bytes
  verbatim, for wire formats you do not control. Both peers must agree: framing
  is part of the protocol the ALPN names.
- Payloads are bytes, not strings, so binary protocols need no base64 detour.
  Framed payloads are capped at 16 MiB; raw streams have no cap.
- Overflow is fatal rather than lossy: if a consumer falls behind its buffer
  (`options.capacity`), the stream fails with kind `"stream-overflow"` instead
  of quietly dropping bytes and corrupting the protocol.

### iroh-docs (available now)

Multi-writer replicated key/value documents, namespaced under `endpoint.docs`.
Each document is a set-reconciled replica of signed entries; entry values live
out-of-band in the blob store, addressed by hash, so a document syncs metadata
cheaply and content is fetched only when you ask for it.

- Enable it per endpoint with `Endpoint.create({ docs: true })`. It is off by
  default, so an endpoint that does not use documents pays no docs cost (no
  store, no ALPN, no engine); every `endpoint.docs` call on a docs-disabled
  endpoint rejects with kind `"docs-disabled"`.
- `docs.create()` mints a new document; `docs.import(ticket)` registers one a
  peer shared; `docs.open(id)`, `docs.list()`, and `docs.dropDoc(id)` manage the
  documents this node holds.
- Entries are signed by an author. `docs.authors.default()` is this node's
  identity (stable across restarts on a persistent store); `create`, `list`, and
  `import(secretKey)` manage additional authors, the last of which moves an
  identity between devices.
- `doc.setBytes(author, key, value)` writes an `ArrayBuffer` and returns its
  content hash; `doc.getExact` / `doc.getOne` / `doc.getMany` read entry
  metadata (never the bytes), and `doc.getContent(entry)` is the opt-in fetch
  that reads a value out of the blob store.
- `doc.subscribe()` returns a live `DocSubscription` (an async-iterable of
  `DocLiveEvent`s plus a `started` promise); `doc.startSync(peers?)` drives set
  reconciliation and joins the document's gossip swarm, so a subscriber sees
  remote inserts and content-ready events as they land.
- `doc.share(mode?)` mints a `DocTicket` (`"write"` by default, `"read"` for
  read-only). `doc.deletePrefix(author, prefix)` is prefix-scoped, mirroring
  upstream: it removes every key that equals or starts with `prefix`.
- Documents persist when you pass `docsStoreDir`; omit it to keep them in memory
  for the endpoint's lifetime.

### Roadmap

No further protocols are scheduled publicly right now. If one matters to you,
open an issue.

## Status

This is a 0.x release. The API is small and deliberate but may change between
minor versions: while the major version is 0, breaking changes bump the minor
version and features bump the patch version. Pin accordingly.

## Requirements

- React Native 0.76 or newer (New Architecture; Nitro requires it)
- `react-native-nitro-modules` `^0.36.1` (peer dependency)
- Android: minSdk 24 (Android 7.0), NDK r27, ABIs `arm64-v8a`,
  `armeabi-v7a`, `x86_64`, `x86`
- iOS: the minimum iOS version of your React Native release (15.1 for
  RN 0.86); visionOS 1.0 is declared in the podspec
- A Rust toolchain on the machine that builds your app (see below)

### Rust toolchain prerequisite

This package currently builds its native core from source inside your app's
Gradle/Xcode build: the build glue invokes `cargo` for the target being
built. The machine (or CI runner) that compiles your app therefore needs:

- Rust via [rustup](https://rustup.rs) (Rust 1.91 or newer)
- For Android builds, the Android targets:

  ```bash
  rustup target add aarch64-linux-android armv7-linux-androideabi \
    x86_64-linux-android i686-linux-android
  ```

- For iOS builds, the Apple targets:

  ```bash
  rustup target add aarch64-apple-ios aarch64-apple-ios-sim
  # Intel Macs building for the simulator also need: x86_64-apple-ios
  ```

`cargo` is expected at `$HOME/.cargo/bin` (the rustup default); the Android
CMake glue and the iOS build phase both add it to `PATH` themselves. The
first build compiles the whole iroh dependency tree and takes a while;
afterwards Cargo's incremental cache makes rebuilds cheap. Devices running
the app do not need Rust; only the build machine does.

## Installation

```bash
npm install react-native-iroh react-native-nitro-modules
# or
yarn add react-native-iroh react-native-nitro-modules
# or
bun add react-native-iroh react-native-nitro-modules
```

Then, for iOS:

```bash
cd ios && pod install
```

Android links automatically through Gradle autolinking. No further setup is
required on either platform.

## Quickstart

A complete share/download roundtrip between two devices:

<!-- The snippets below are type-checked verbatim by
     src/__tests__/quickstart.test-d.ts (part of `bun run typecheck`);
     update both together. -->

```ts
import { Endpoint } from "react-native-iroh";

// Any absolute directory inside your app's sandbox, e.g.
// RNFS.DocumentDirectoryPath (react-native-fs) or an expo-file-system path.
declare const DocumentDir: string;

// Device A: create an endpoint and share a file
const a = await Endpoint.create({ blobStoreDir: `${DocumentDir}/iroh` });
console.log(`I am ${a.id}`);
const ticket = await a.blobs.share(`${DocumentDir}/photo.jpg`);
// Send `ticket` (a string) to device B out of band: QR code, chat, etc.

// Device B: download it
const b = await Endpoint.create({ blobStoreDir: `${DocumentDir}/iroh` });
const transfer = b.blobs.download(ticket, `${DocumentDir}/photo.jpg`);

const stopListening = transfer.onProgress(({ bytesReceived }) => {
  console.log(`received ${bytesReceived} bytes`);
});

try {
  await transfer.done; // resolves when the download completes
} finally {
  stopListening();
}

// When done with an endpoint, close it:
await a.close();
await b.close();
```

Progress can also be consumed as an async iterable; the two styles can be
mixed freely:

```ts
const transfer = b.blobs.download(ticket, destPath);
for await (const { bytesReceived } of transfer.progress) {
  updateUi(bytesReceived);
}
// The loop ends on completion and throws the terminal IrohError on
// failure or cancellation.
```

More, in ladder order (each teaches one concept):
[docs/examples](./docs/examples).

Paths must be absolute paths inside your app's sandbox (for example from
`react-native-fs` or `expo-file-system`). The ticket string encodes the blob
hash and the sharing endpoint's addresses; anyone holding it can fetch the
blob while the sharing endpoint is open.

## API reference

Everything below is exported from `react-native-iroh`. All failures (sync
throws and Promise rejections) are `IrohError` instances.

### Endpoint

An iroh endpoint: a network identity plus a blob store.

#### `Endpoint.create(options?): Promise<Endpoint>`

Creates an endpoint: binds sockets and loads the blob store.

`EndpointOptions` (all fields optional):

| Option                   | Type                                                           | Default        | Meaning                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`                 | `"n0" \| "minimal"`                                            | `"n0"`         | Which of iroh's endpoint presets to bind with. `n0` uses n0's relay and discovery infrastructure (production). `minimal` uses only the mandatory configuration: peers are only reachable via direct addresses embedded in tickets.                                                                                      |
| `relayMode`              | `"default" \| "disabled" \| "staging" \| { custom: string[] }` | preset default | Overrides which relay servers the endpoint uses (discovery is left to the preset). `"disabled"` runs a LAN-only endpoint reachable only through direct addresses; `{ custom: [...] }` supplies HTTPS relay URLs (at least one). Omit to inherit the preset's relays.                                                    |
| `blobStoreDir`           | `string`                                                       | in-memory      | Absolute directory path for the persistent blob store. Omit to keep blobs in memory; they are lost when the endpoint closes.                                                                                                                                                                                            |
| `maxConcurrentDownloads` | `number`                                                       | `4`            | Cap on concurrently active downloads for this endpoint; further downloads wait in a FIFO queue. Values below 1 are clamped to 1, non-integers are floored, and non-finite values (`NaN`, `Infinity`) fall back to the default.                                                                                          |
| `alpns`                  | `readonly string[]`                                            | none           | Custom ALPN protocol names this endpoint accepts inbound connections on (see `endpoint.streams`). Fixed here because iroh's router fixes its ALPN set when it spawns. An empty name, one over 255 bytes, a duplicate, or one shadowing the built-in blobs or gossip ALPNs rejects creation with kind `"endpoint-bind"`. |

`create` also accepts a second, advanced `binding` parameter (an
`IrohBinding`) that substitutes the native module, primarily for tests.

#### `endpoint.id: EndpointId`

The endpoint's id (its public key), as a branded string. Stable for the
endpoint's lifetime; cached at creation, so reading it never touches native
code and stays valid after `close()`.

#### `endpoint.isOpen: boolean`

Whether the endpoint is live (created and not yet closed).

#### `endpoint.addr: EndpointAddr`

A synchronous snapshot of the endpoint's current address: its `id` plus the
`relayUrls` and `directAddrs` (`host:port` strings) it is currently reachable
through. The value evolves over time as relays connect and interfaces change;
observe it live with `watchAddr` / `addrChanges`.

#### `endpoint.watchAddr(listener): () => void`

Subscribes to `EndpointAddr` changes. The listener fires with the current
address soon after subscribing and again on each change. Returns an
unsubscribe function (idempotent). The underlying native watch runs only while
at least one subscriber (listener or `addrChanges` iterator) is attached, and
is torn down on `close()`.

#### `endpoint.addrChanges: AsyncIterable<EndpointAddr>`

An `AsyncIterable` of address changes. Each `for await` gets an independent,
latest-value-conflating iterator (a slow consumer observes only the newest
address); iteration ends when the endpoint closes. Break out of the loop to
detach early.

#### `endpoint.remoteInfo(remoteId): Promise<RemoteInfo | undefined>`

What this endpoint currently knows about the peer `remoteId`, or `undefined`
if it knows nothing about it (never connected, or since forgotten). Each entry
in `addrs` is `{ addr, kind, active }`, where `kind` is `"relay"` or `"ip"`.

This is how you tell whether traffic to a peer is flowing directly or through
a relay: `addr` above describes what _this_ endpoint advertises, which says
nothing about the path in use. Only the entries with `active: true` are
carrying traffic; iroh retains every address it has ever learned for a remote,
so the inactive ones name paths that may never have been used.

The result is a snapshot, not a live view. Sample it while a transfer is still
warm, since a remote is forgotten some time after its last traffic.

```ts
const info = await endpoint.remoteInfo(providerId);
const active = info?.addrs.filter((a) => a.active) ?? [];
const viaRelay = active.some((a) => a.kind === "relay");
```

#### `endpoint.online(options?): Promise<void>`

Resolves once the endpoint has a connected home relay, rejecting with an
`IrohError` (kind `"endpoint-bind"`) if the wait exceeds `options.timeoutMs`
(default `DEFAULT_ONLINE_TIMEOUT_MS`, 10s). On relay-less endpoints
(`relayMode: "disabled"`, or the `minimal` preset) no home relay can connect,
so this always rejects on timeout.

#### `endpoint.blobs.share(path: string): Promise<BlobTicket>`

Imports the file at absolute `path` into the endpoint's blob store and
resolves with a shareable `BlobTicket`. On the `n0` preset this waits
(bounded) for the endpoint to come online first, so the ticket contains
dialable addresses.

#### `endpoint.blobs.download(ticket, destPath, options?): Transfer`

Starts downloading the blob described by `ticket` (a `BlobTicket` or a
plain string, which is validated with `validateTicketShape` first) into absolute
`destPath` and synchronously returns a `Transfer` handle. At most
`maxConcurrentDownloads` downloads run natively at once; additional ones
wait in a FIFO queue. `options.signal` accepts a standard `AbortSignal`:
aborting it cancels the transfer (aborting after settle is a no-op).

An existing file at `destPath` is replaced, so downloading twice to the same
path works. A `destPath` that is a directory is rejected (kind
`"blob-export"`) rather than being deleted.

#### `endpoint.blobs.shareCollection(paths): Promise<BlobTicket>`

Bundles several absolute file paths into one collection (an iroh-blobs
HashSeq) and resolves with a single `BlobTicket` covering all of them. Each
child is named after its source file's base name. `paths` must be non-empty.

#### `endpoint.blobs.downloadCollection(ticket, destDir, options?): CollectionTransfer`

Fetches every child of a collection ticket into absolute `destDir`, writing
each to `destDir/<name>`, and synchronously returns a `CollectionTransfer`:
everything a `Transfer` has, plus a `files` array of per-child
`FileProgress` (`{ name, bytesReceived, totalBytes?, done }`) alongside the
aggregate progress. Children are fetched through the same per-endpoint
download queue and cap as `download`.

Child names come from whoever shared the collection, so they are validated
before anything is written: a name that is not a single path segment (one
containing `/`, `\`, or a `..` parent reference) fails the whole transfer with
kind `"invalid-path"` and no file is written. A collection therefore cannot
place a file outside `destDir`.

#### `endpoint.gossip.subscribe(topic, options?): GossipSubscription`

Subscribes to the gossip topic derived from `topic` (a free-form label; peers
that pass the same label join the same topic) and returns a `GossipSubscription`
synchronously. `options.bootstrap` is a list of peer `EndpointAddr`s to seed the
swarm with (required on the `minimal` preset; optional on `n0`, where discovery
can resolve peers), and `options.capacity` sizes the message buffer. Throws an
`IrohError` synchronously for a stale endpoint (kind `"invalid-handle"`) or a
malformed bootstrap address (kind `"gossip-subscribe"`).

`GossipSubscription` members:

| Member            | Type                                 | Meaning                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `joined`          | `Promise<void>`                      | Resolves once the topic is actually joined and the subscription is live. Rejects with kind `"gossip-subscribe"` if the join fails, or if the subscription is torn down before it started.                                        |
| `messages`        | `AsyncIterable<GossipMessage>`       | Received messages, in arrival order. A bounded FIFO (non-conflating): under overflow the oldest unread messages are dropped so the live tail keeps flowing. One shared stream: consuming a message removes it. Ends on teardown. |
| `neighbors`       | `AsyncIterable<GossipNeighborEvent>` | Swarm membership changes (`{ type: "up" \| "down"; endpointId }`). Ends on teardown.                                                                                                                                             |
| `broadcast(text)` | `(text: string) => Promise<void>`    | Broadcasts UTF-8 `text` (up to 4096 bytes) to every peer; rejects with kind `"gossip-message-too-large"` if oversize, or `"gossip-broadcast"` on failure.                                                                        |
| `unsubscribe()`   | `() => void`                         | Leaves the topic and ends both iterators. Idempotent; also run automatically when the endpoint closes.                                                                                                                           |

`GossipMessage` has `text` (the UTF-8 payload) and `from` (the id of the
neighbor that delivered it). Messages are also capped at 4096 bytes per the
gossip protocol's default.

#### `endpoint.streams.listen(alpn, options?): StreamListener`

Starts accepting inbound connections that negotiated `alpn`, which must be one
of the endpoint's `alpns`. Returns synchronously. Throws an `IrohError` of kind
`"stream-listen"` for an ALPN that was not declared or is already being listened
on, or `"invalid-handle"` for a closed endpoint.

`StreamOptions` (shared with `connect`): `framing` (`"framed"` by default, or
`"raw"`) and `capacity` (how many received chunks a stream buffers before the
consumer is declared too slow; defaults to 1024).

`StreamListener` members:

| Member        | Type                        | Meaning                                                                                                                                                                      |
| ------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alpn`        | `string`                    | The ALPN this listener accepts.                                                                                                                                              |
| `connections` | `AsyncIterable<Connection>` | Accepted connections. Ends when the listener or its endpoint closes, and throws on failure. One shared stream. Connections left unconsumed beyond 64 are closed, not queued. |
| `close()`     | `() => void`                | Stops accepting and frees the ALPN for a later `listen`. Idempotent. Not a cascade: connections already handed to you stay open.                                             |

#### `endpoint.streams.connect(peer, alpn, options?): Promise<Connection>`

Dials `peer` on `alpn`. Pass a full `EndpointAddr` when the peer cannot be
discovered (the `minimal` preset, or a LAN-only setup): its addresses are
registered so the dial can reach it, exactly as a gossip bootstrap peer's are.
A bare `EndpointId` leaves resolution to discovery, which needs the `n0` preset.
Rejects with kind `"stream-connect"` if the peer is unreachable or does not
accept `alpn`.

#### `endpoint.close(): Promise<void>`

Closes the endpoint: shuts down its router, sockets and blob store.
One-shot: the native side invalidates the handle at the first close call, so
the first call's outcome (success or failure) is final. Concurrent and
repeated calls all return the same promise; the native close runs at most
once. When the native close settles (regardless of outcome: the endpoint
is unusable either way), downloads still waiting in the queue are cancelled
(their promises reject with kind `"cancelled"`); actively running downloads
are settled by the native shutdown. On failure the promise rejects with an
`IrohError`.

#### `endpoint[Symbol.asyncDispose](): Promise<void>`

An alias of `close()` that makes endpoints usable with
`await using endpoint = await Endpoint.create(...)`: the endpoint closes
automatically when the binding goes out of scope.

### Connection

One QUIC connection to a peer on a custom ALPN, carrying any number of
independent streams in both directions.

| Member         | Type                    | Meaning                                                                                                                                               |
| -------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `remoteId`     | `EndpointId`            | The peer's endpoint id.                                                                                                                               |
| `alpn`         | `string`                | The ALPN this connection negotiated.                                                                                                                  |
| `framing`      | `"framed" \| "raw"`     | The framing every stream on this connection uses.                                                                                                     |
| `incoming`     | `AsyncIterable<Stream>` | Streams the peer opened. Ends when the connection closes, throws on failure. One shared stream; streams left unconsumed beyond 64 are closed.         |
| `closed`       | `Promise<void>`         | Settles once: resolves on an orderly close by either side, rejects with an `IrohError` on failure. Pre-observed.                                      |
| `isClosed`     | `boolean`               | Whether the connection has closed.                                                                                                                    |
| `openStream()` | `() => Promise<Stream>` | Opens a bidirectional stream. QUIC does not announce a stream until it carries bytes, so the peer's `incoming` does not fire until your first `send`. |
| `close()`      | `() => void`            | Closes the connection and every stream on it. Idempotent; also run automatically when the endpoint closes.                                            |

### Stream

One bidirectional QUIC stream: bytes in, bytes out, closed once.

| Member        | Type                                  | Meaning                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`        | `AsyncIterable<Uint8Array>`           | Received chunks, in order. Under `"framed"` each chunk is exactly one peer `send`; under `"raw"` the boundaries are whatever the network produced. Ends on close, throws on failure. One shared stream.                                                        |
| `closed`      | `Promise<void>`                       | Settles once: resolves when either side finishes the stream, rejects with an `IrohError` on failure. Pre-observed.                                                                                                                                             |
| `isClosed`    | `boolean`                             | Whether the stream has ended.                                                                                                                                                                                                                                  |
| `send(bytes)` | `(data: Uint8Array) => Promise<void>` | Writes to the peer, resolving once the bytes reach the QUIC send buffer (not a delivery receipt). Concurrent sends are serialized natively. Rejects with kind `"stream-closed"`, `"stream-frame-too-large"` (framed payloads over 16 MiB), or `"stream-send"`. |
| `close()`     | `() => void`                          | Finishes this side's writes and stops reading. Idempotent; the peer sees an orderly end of stream.                                                                                                                                                             |

Text protocols encode their own bytes: `data` always yields `Uint8Array`, and
`send` always takes one, so nothing guesses an encoding on your behalf. Use
`TextEncoder` / `TextDecoder` (or your own codec) at the edges.

### Docs

`endpoint.docs` is the document API (`DocsApi`): author identity plus document
CRUD over the iroh-docs meta-protocol. It is present on every endpoint, but
active only when the endpoint was created with `docs: true`; otherwise every call
rejects with kind `"docs-disabled"`. Values persist to `docsStoreDir` when set,
or live in memory for the endpoint's lifetime when it is omitted.

`DocsApi` members:

| Member           | Type                           | Meaning                                                                                                                |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `authors`        | `Authors`                      | Author identity (below).                                                                                               |
| `create()`       | `() => Promise<Doc>`           | Creates a new document.                                                                                                |
| `open(id)`       | `(id) => Promise<Doc \| null>` | Opens a document this node holds, or `null` if it does not have it.                                                    |
| `import(ticket)` | `(ticket) => Promise<Doc>`     | Registers the document and peers a `DocTicket` names; rejects with kind `"docs-invalid-ticket"` on a malformed ticket. |
| `list()`         | `() => Promise<NamespaceId[]>` | Every document on this node.                                                                                           |
| `dropDoc(id)`    | `(id) => Promise<void>`        | Removes a document and all its entries from this node.                                                                 |

`Authors` (`endpoint.docs.authors`): `default()` is this node's identity, created
on first use and stable across restarts on a persistent store; `create()` makes a
new one; `list()` returns every author this node can write as; `import(secretKey)`
adds an author from its secret key (hex), which is how one identity moves between
devices (rejects with kind `"docs-invalid-id"` on a malformed secret).

`Doc` members:

| Member                       | Type                                            | Meaning                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                         | `NamespaceId`                                   | This document's namespace id (64 hex chars).                                                                                                                                         |
| `setBytes(author, key, val)` | `(author, key, ArrayBuffer) => Promise<string>` | Writes `val` under `key` as `author`, stores the bytes in the blob store, and resolves with the content hash. Values are `ArrayBuffer`, so binary needs no encoding detour.          |
| `getExact(author, key)`      | `(author, key) => Promise<DocEntry \| null>`    | The entry for `author`+`key`, or `null`. Returns metadata (including the content hash), never the bytes.                                                                             |
| `getOne(query?)`             | `(DocQuery?) => Promise<DocEntry \| null>`      | The first entry matching `query` (all entries if omitted).                                                                                                                           |
| `getMany(query?)`            | `(DocQuery?) => Promise<DocEntry[]>`            | Every entry matching `query`.                                                                                                                                                        |
| `getContent(entry)`          | `(DocEntry) => Promise<ArrayBuffer>`            | The opt-in fetch: reads an entry's value out of the blob store. No read pulls content implicitly.                                                                                    |
| `deletePrefix(author, pfx)`  | `(author, prefix) => Promise<number>`           | Deletes every entry for `author` whose key equals **or starts with** `prefix`, returning the count. See the caveat below.                                                            |
| `share(mode?)`               | `("write" \| "read") => Promise<DocTicket>`     | Mints a shareable ticket; `"write"` (read/write) by default, `"read"` for read-only.                                                                                                 |
| `subscribe(options?)`        | `(DocSubscribeOptions?) => DocSubscription`     | Live events for this document (below). Returns synchronously; holds the replica open for the subscription's lifetime. Subscribing does not start sync.                               |
| `startSync(peers?)`          | `(EndpointAddr[]?) => Promise<void>`            | Starts (or refreshes) live sync: reconciles with `peers` and joins the document's gossip swarm. Omit `peers` to sync with peers already known (e.g. those an imported ticket named). |
| `leave()`                    | `() => Promise<void>`                           | Stops live sync and leaves the gossip swarm.                                                                                                                                         |

`DocSubscription` has `events` (an `AsyncIterable<DocLiveEvent>` in arrival
order, one shared bounded stream), a `started` promise (resolves once the
subscription is live, rejects if it fails to start), and `unsubscribe()`.
`DocLiveEvent` is a discriminated union keyed by `type`: `insert-local`,
`insert-remote` (carries the peer `from`, the `entry`, and a `contentStatus`),
`content-ready` (the entry's bytes finished downloading), `sync-finished`,
`neighbor-up` / `neighbor-down`, and `pending-content-ready`. To observe an
imported document's first sync without missing an event, subscribe first, then
call `startSync`.

**`deletePrefix` is prefix-scoped.** iroh-docs has no exact-delete primitive, so
`deletePrefix(author, "note")` also removes `"note-draft"` and every other key
with `"note"` as a prefix. To delete exactly one key, ensure no other key shares
it as a prefix. Prefix-siblings can be authored by remote peers (their content
may not even be local), so there is no safe way to delete one key while restoring
the rest.

### Transfer

Handle for one download started with `blobs.download`.

| Member                 | Type                                                           | Meaning                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `done`                 | `Promise<void>`                                                | Settles exactly once: resolves on completion, rejects with an `IrohError` on failure or cancellation. Rejections are pre-observed, so watching only `progress` does not cause unhandled-rejection warnings.                                                              |
| `promise`              | `Promise<void>`                                                | Alias of `done` (the identical promise object); both names are documented and stable.                                                                                                                                                                                    |
| `progress`             | `AsyncIterable<ProgressEvent>`                                 | Each `for await` gets an independent iterator that receives events from that point on, ends on completion, and throws the terminal `IrohError` on failure or cancellation. Latest-value conflation keeps buffering O(1); breaking out of the loop detaches the iterator. |
| `isSettled`            | `boolean`                                                      | Whether the transfer has settled (completed, failed, or cancelled).                                                                                                                                                                                                      |
| `cancel()`             | `() => void`                                                   | Requests cancellation. Idempotent and safe at any point: a queued transfer fails immediately with kind `"cancelled"`; an active transfer is cancelled natively and rejects with code `3003`. No-op after settling.                                                       |
| `onProgress(listener)` | `(event: ProgressEvent) => void` listener; returns unsubscribe | Subscribes to progress events. Called synchronously on the JS thread with already-coalesced events, so keep it cheap. Subscribing after settling is a no-op.                                                                                                             |

`ProgressEvent` has `bytesReceived` (cumulative payload bytes received so far,
monotonically non-decreasing) and an optional `totalBytes`. iroh's download
stream reports only cumulative bytes with no advertised total, and this library
does not add a pre-download size probe, so `totalBytes` is currently always
`undefined`; the field is wired end-to-end so a future native total can flow
through without an API change.

### IrohError

The error type thrown (and used for Promise rejections) by every public
API.

- `instanceof IrohError` works and narrows `unknown` to this type.
- `code` and `kind` form a discriminated union (`IrohErrorCase`): narrowing
  on one narrows the other, for example `error.kind === "invalid-ticket"`
  narrows `error.code` to `1002`.
- `message` preserves the original native message, including the
  `[iroh:<code>] <detail>` prefix when present.
- `IrohError.from(value)` converts any thrown value into an `IrohError`;
  unknown codes and untagged errors map to code `1000` / kind
  `"internal"`.

Error codes are stable across releases:

| Code   | Kind                       | Meaning                                                             |
| ------ | -------------------------- | ------------------------------------------------------------------- |
| `1000` | `internal`                 | Unclassified native failure (also the fallback for untagged errors) |
| `1001` | `invalid-handle`           | Operation on an unknown or already-closed endpoint handle           |
| `1002` | `invalid-ticket`           | Ticket string failed to parse                                       |
| `1003` | `invalid-path`             | Path is not usable (not absolute, not readable, ...)                |
| `2000` | `endpoint-bind`            | Endpoint failed to bind its sockets / come online                   |
| `3000` | `blob-import`              | Importing a file into the blob store failed                         |
| `3001` | `blob-download`            | Download failed                                                     |
| `3002` | `blob-export`              | Writing the downloaded blob to `destPath` failed                    |
| `3003` | `cancelled`                | Transfer was cancelled                                              |
| `4000` | `gossip-subscribe`         | Subscribing to a gossip topic failed (e.g. a bad bootstrap address) |
| `4001` | `gossip-broadcast`         | Broadcasting a gossip message failed                                |
| `4002` | `gossip-message-too-large` | Gossip payload exceeded the 4096-byte per-message limit             |
| `5000` | `stream-listen`            | Listening on a custom ALPN failed (undeclared, or already listened) |
| `5001` | `stream-connect`           | Dialling a peer on a custom ALPN failed                             |
| `5002` | `stream-open`              | Opening a bidirectional stream on a connection failed               |
| `5003` | `stream-send`              | Writing to a stream failed                                          |
| `5004` | `stream-closed`            | The stream or its connection is closed                              |
| `5005` | `stream-frame-too-large`   | Framed payload exceeded the 16 MiB frame limit                      |
| `5006` | `stream-overflow`          | The stream consumer fell behind its buffer, so bytes would be lost  |
| `6000` | `docs-disabled`            | A docs call on an endpoint not created with `docs: true`            |
| `6001` | `docs`                     | A docs operation failed (sync, store, or engine error)              |
| `6002` | `docs-invalid-id`          | A namespace, author, or secret-key string failed to parse           |
| `6003` | `docs-invalid-ticket`      | A document ticket string failed to parse                            |

Exported error types: `IrohErrorCode` (union of the numeric codes),
`IrohErrorKind` (union of the kind strings), `IrohErrorCase` (the
discriminated `code`/`kind` pairing).

### Other exports

| Export                                                                                           | Kind           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_MAX_CONCURRENT_DOWNLOADS`                                                               | `const` (`32`) | Default download-concurrency cap per endpoint. Pass `Infinity` to `maxConcurrentDownloads` for no cap.                                                                                                                                                                                                                                                                                                                    |
| `IROH_VERSION`                                                                                   | `const`        | The exact version of the iroh Rust crate compiled into this package (e.g. `"1.0.3"`). A unit test pins it to the crate manifest, so it cannot drift.                                                                                                                                                                                                                                                                      |
| `parseTicket(s)`                                                                                 | function       | Decodes a ticket natively into a `TicketInfo` (`{ hash, format, nodeId, size? }`); throws `IrohError` kind `"invalid-ticket"` on failure. Changed in 0.2.0: it previously returned the ticket string. Use `validateTicketShape` for the old cheap shape check.                                                                                                                                                            |
| `validateTicketShape(s)`                                                                         | function       | Validates a string's blob-ticket shape (`blob` prefix, base32 charset, minimum length) and returns it as a `BlobTicket` without decoding it; throws `IrohError` kind `"invalid-ticket"` on failure. `blobs.download` runs the same check on plain strings.                                                                                                                                                                |
| `TicketInfo`, `BlobFormat`                                                                       | types          | The decoded ticket `parseTicket` returns, and its `format` field (`"raw"` for a single blob, `"hashSeq"` for a collection).                                                                                                                                                                                                                                                                                               |
| `CollectionTransfer`, `FileProgress`                                                             | types          | The handle `blobs.downloadCollection` returns and its per-child progress entries.                                                                                                                                                                                                                                                                                                                                         |
| `getIrohErrorCode(error)`                                                                        | function       | Extracts the numeric code from a raw-bridge error message, or `undefined`. Retained for users of the raw escape hatch; the class API throws `IrohError`, which carries `code`/`kind` directly.                                                                                                                                                                                                                            |
| `getIroh()`                                                                                      | function       | Unstable escape hatch: returns the raw Nitro hybrid object with the full native surface (`createEndpoint`, `endpointId`, `isEndpointOpen`, `closeEndpoint`, `shareBlob`, `downloadBlob`, `cancelDownload`), without the queueing, error typing, or lifecycle handling of `Endpoint`. The binding is created lazily on first call (never at import). Its errors carry `[iroh:<code>]` message prefixes. Prefer `Endpoint`. |
| `IrohSpec`                                                                                       | type           | The interface of the raw hybrid object.                                                                                                                                                                                                                                                                                                                                                                                   |
| `IrohBinding`                                                                                    | type           | The structural subset of `IrohSpec` that `Endpoint` depends on; implement it to mock the native layer in tests.                                                                                                                                                                                                                                                                                                           |
| `EndpointId`, `BlobTicket`                                                                       | types          | Branded strings: an endpoint's public key and a validated blob ticket. Both are assignable to `string`; plain strings only become tickets through `validateTicketShape` (or `blobs.share`).                                                                                                                                                                                                                               |
| `EndpointConfig`, `NetworkPreset`                                                                | types          | The raw bridge's endpoint configuration types (`NetworkPreset` is `"n0" \| "minimal"`).                                                                                                                                                                                                                                                                                                                                   |
| `Blobs`, `DownloadOptions`, `AbortSignalLike`                                                    | types          | The `endpoint.blobs` namespace interface and its download options (`AbortSignalLike` is the structural subset of `AbortSignal` the option accepts).                                                                                                                                                                                                                                                                       |
| `Gossip`, `GossipSubscription`, `GossipMessage`, `GossipNeighborEvent`, `GossipSubscribeOptions` | types          | The `endpoint.gossip` namespace interface and its subscription, message, neighbor-event, and options types.                                                                                                                                                                                                                                                                                                               |
| `Streams`, `StreamListener`, `Connection`, `Stream`, `StreamOptions`, `StreamFraming`            | types          | The `endpoint.streams` namespace interface and its listener, connection, stream, options, and framing types.                                                                                                                                                                                                                                                                                                              |
| `parseDocTicket(s)`, `validateDocTicketShape(s)`                                                 | functions      | Decode a document ticket into its `DocTicketInfo` (namespace, capability, peer ids), or cheaply validate its shape and return it as a `DocTicket`; both throw `IrohError` kind `"docs-invalid-ticket"` on failure.                                                                                                                                                                                                        |
| `DocsApi`, `Authors`, `Doc`, `DocEntry`, `DocQuery`, `DocSubscription`, `DocSubscribeOptions`    | types          | The `endpoint.docs` namespace interface, its author identity and document handles, entry and query shapes, and the live subscription and its options.                                                                                                                                                                                                                                                                     |
| `DocLiveEvent` (and its variants), `DocContentStatus`, `DocShareMode`, `DocTicketInfo`           | types          | The live document event union (`insert-local`, `insert-remote`, `content-ready`, `sync-finished`, `neighbor-up` / `neighbor-down`, `pending-content-ready`), the per-entry content availability, the share mode, and the decoded-ticket shape.                                                                                                                                                                            |
| `NamespaceId`, `AuthorId`, `DocTicket`                                                           | types          | Branded strings: a document's namespace id, an author id, and a validated document ticket. All assignable to `string`.                                                                                                                                                                                                                                                                                                    |
| `DEFAULT_STREAM_BACKLOG`                                                                         | `const` (`64`) | How many inbound connections (on a listener) or peer-opened streams (on a connection) are held for a consumer that has not picked them up yet; beyond this the oldest is closed.                                                                                                                                                                                                                                          |
| `EndpointOptions`, `Transfer`, `ProgressEvent`                                                   | types          | Described above.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EndpointAddr`, `RelayMode`                                                                      | types          | The address snapshot returned by `endpoint.addr` / delivered by `watchAddr` / `addrChanges`, and the `relayMode` option's type.                                                                                                                                                                                                                                                                                           |
| `RemoteInfo`, `RemoteAddr`, `RemoteAddrKind`                                                     | types          | The peer snapshot returned by `endpoint.remoteInfo()`, its per-address entries, and the `"relay" \| "ip"` transport tag.                                                                                                                                                                                                                                                                                                  |
| `DEFAULT_ONLINE_TIMEOUT_MS`                                                                      | `const` (10s)  | Default timeout for `endpoint.online()`.                                                                                                                                                                                                                                                                                                                                                                                  |

## React hooks

Optional React bindings live on the `react-native-iroh/hooks` subpath, kept off
the root entry point so importing the library never pulls in `react`. Each hook
is a thin wrapper that reflects an imperative lifecycle as component state and
tears its resource down on unmount.

```ts
import { useEndpoint, useGossip, useTransfer } from "react-native-iroh/hooks";
```

| Hook                                   | Returns                                                                                    | Notes                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useEndpoint(options?)`                | `{ endpoint, status, error }`                                                              | Creates an endpoint on mount and closes it on unmount. `status` is `"creating" \| "ready" \| "error" \| "closed"`; `endpoint` is `null` until ready.                         |
| `useTransfer(transfer)`                | `{ progress, files, status, error }`                                                       | Subscribes to a `Transfer`'s progress and settles with it. Pass `null` to reset.                                                                                             |
| `useDownload(endpoint, ticket, dest?)` | `{ transfer, ...useTransfer state }`                                                       | Starts a download when its arguments become non-null and tracks it, cancelling on unmount.                                                                                   |
| `useGossip(endpoint, topic, options?)` | `{ messages, neighbors, broadcast, status, error }`                                        | Subscribes for the component's lifetime, draining both streams into capped arrays (`options.retain`, default 500). `broadcast` is stable.                                    |
| `useDocs(endpoint)`                    | `{ docs, create, import, open, dropDoc, refresh, error }`                                  | Lists the endpoint's documents on mount and after each mutation. The list is not push-based; call `refresh` to pick up outside changes.                                      |
| `useDoc(doc, options?)`                | `{ entries, events, status, setBytes, deletePrefix, getContent, startSync, leave, error }` | Reflects a `Doc` as reactive state: seeds `entries` from a read and keeps them current from live events (subscribing for the component's lifetime). Pass `null` to hold off. |

Pass `null` for `endpoint` while it is still being created, so a hook chain
composes without conditional hook calls:

```tsx
const { endpoint } = useEndpoint();
const { messages, broadcast, status } = useGossip(endpoint, "my-app/lobby");
```

## Performance

- Downloads are bridged asynchronously (a native completion callback settles the
  Promise), so an in-flight download holds no native thread. The per-endpoint cap
  (default 32, `Infinity` for unlimited) is therefore an application-level
  throttle rather than a hardware limit; work beyond it queues FIFO.
- Progress events are throttled natively to roughly 30 per second, and the
  latest value is always delivered before the download's Promise settles.
  `onProgress` listeners run synchronously on the JS thread, so keep them
  cheap.
- The `progress` async iterable conflates to the latest value per iterator: a
  slow consumer sees fewer, fresher events instead of a growing buffer, so its
  memory use stays O(1) regardless of consumer speed.
- `id` and `isOpen` are synchronous; `id` never crosses into native code
  after creation.

For a sense of scale: the repo's benchmark harness (`bun run bench`) runs a
provider endpoint and a consumer endpoint in one app process on a single
Android emulator (minimal preset, loopback QUIC), completing a full
share/download roundtrip of 100 files in under 2 seconds and sustaining 50-67
MiB/s on large blobs. Those are loopback numbers (real networks are dominated
by path quality), but they bound the overhead of the binding itself.

## Platform support

| Platform | Minimum                         | Notes                                                                          |
| -------- | ------------------------------- | ------------------------------------------------------------------------------ |
| Android  | API 24 (Android 7.0)            | ABIs: `arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`. 16 KB page sizes supported. |
| iOS      | RN's minimum (15.1 for RN 0.86) | Device and simulator (Apple Silicon and Intel).                                |
| visionOS | 1.0                             | Declared in the podspec; not exercised by the maintainers' CI.                 |

Approximate native size cost, measured on release builds with symbols
stripped: 15-25 MB of `libIroh.so` per Android ABI (21 MB on `arm64-v8a`);
an all-ABI AAR is about 36 MB. Use Android App Bundles so each device
downloads only its own ABI. The iOS static library adds a comparable
single-architecture cost after App Store thinning.

For an honest, per-feature view of what has actually been validated on each
platform (as opposed to merely compiling), see the
[support matrix](./docs/support-matrix.md).

## Example app

`example/` contains a complete share/download app: device A shares a file
and shows the ticket as a QR code and copyable string; device B pastes the
ticket, downloads with live progress, and verifies integrity by re-sharing
the downloaded file and comparing ticket hashes. It also demonstrates
collections, gossip chat, and the `react-native-iroh/hooks` layer, and is the
vehicle for the end-to-end suite in `e2e/`.

It additionally carries a **Two-Device Test** section: pair two devices by
endpoint id and the app runs a full cross-device suite by itself (blob and
collection transfer, content-hash verification, the network path the traffic
took, and the peer's own verdict), reporting pass or fail on both screens. That
is how the device rows in the [support matrix](./docs/support-matrix.md) are
established on real hardware.

## Acknowledgements

- [iroh](https://github.com/n0-computer/iroh) by n0-computer: the
  networking stack this package binds.
- [Nitro](https://github.com/mrousavy/nitro) by Marc Rousavy (mrousavy):
  the native-module framework powering the bindings.
- Rust codegen for Nitro by boorad: this package's Rust binding layer is
  generated with the Rust support proposed upstream in
  [nitro PR #1229](https://github.com/mrousavy/nitro/pull/1229), maintained in
  the [`ashkalor/nitro` fork](https://github.com/ashkalor/nitro/tree/feat/rust-codegen)
  this repo builds from (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
- Bootstrapped with
  [create-nitro-module](https://github.com/patrickkabwe/create-nitro-module)
  by Patrick Kabwe.

Third-party license notices for the statically linked Rust dependency tree
are listed in `THIRD-PARTY-NOTICES.md`.

## License

MIT. See `LICENSE`.

## Contributing

This library exists because I needed iroh inside a React Native app I am
building, and open-sourcing it means nobody has to build the same binding
twice. Contributions are genuinely welcome: bug reports, pull requests, and
protocol bindings from the roadmap. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the dev-environment setup, the
threading and packaging internals, and the repo conventions. For anything
substantial, opening an issue first is a good way to compare notes.
