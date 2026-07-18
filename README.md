# react-native-iroh

iroh for React Native: direct Rust bindings to the
[iroh](https://github.com/n0-computer/iroh) peer-to-peer networking stack.

iroh lets any device dial any other device on the planet by its node id:
QUIC connections that hole-punch through NATs when a direct path exists and
fall back to relays when it does not. This package puts the real thing
inside your React Native app: the actual iroh 1.x Rust crates (`iroh`
1.0.2, `iroh-blobs` 0.103.0) compiled into your build and bound to
JavaScript through [Nitro](https://github.com/mrousavy/nitro) with direct
Rust-to-C++ bindings, not a JS reimplementation.

```bash
npm install react-native-iroh react-native-nitro-modules
```

A few things worth knowing up front:

- This is the only React Native binding for iroh. The official
  [iroh-ffi](https://github.com/n0-computer/iroh-ffi) bindings' 1.x line
  currently ships no blobs support and has no React Native path.
- The runtime rides Nitro/JSI directly: calls go JS to C++ to Rust in
  process, with no JSON serialization bridge and synchronous access where
  the API allows it. Consumers never run codegen: all generated bindings
  ship committed in the package.
- The v0.1 surface is deliberately small and honest: an `Endpoint` (the
  iroh node) plus the first protocol, `iroh-blobs`. More protocols land as
  the binding surface grows; see [Protocols](#protocols).

## The Endpoint

Everything in iroh hangs off an `Endpoint`, and so does everything in this
package. An endpoint is an iroh node running inside your app:

- **Identity**: every endpoint has a `nodeId`, the public key other
  devices use to reach it. It is stable for the endpoint's lifetime and
  cached at creation, so reading it never touches native code.
- **Lifecycle**: `Endpoint.create()` binds sockets and loads the blob
  store; `close()` shuts down the router, sockets, and store with
  well-defined one-shot semantics. `isOpen` tells you where you are in
  between.
- **Network profiles**: `standard` uses n0's relay servers and address
  lookup (the production default); `isolated` uses neither, for tests and
  LAN-only setups where peers are reachable only via direct addresses
  embedded in tickets.
- **Storage**: pass `blobStoreDir` for a persistent on-disk blob store,
  or omit it to keep blobs in memory for the endpoint's lifetime.

The full option and method reference is under
[API reference](#api-reference).

## Protocols

iroh itself is the connection layer; what runs over a connection is a
protocol. This package ships protocols as their bindings mature.

### iroh-blobs (available now)

Content-addressed blob transfer with BLAKE3-verified streaming. The
complete v0.1 protocol surface:

- `shareBlob(path)` imports a file into the endpoint's blob store and
  returns a ticket string (hash plus dialable addresses) that any other
  endpoint can download from while the sharer is open.
- `downloadBlob(ticket, destPath)` returns a `Transfer` handle
  synchronously: a settlement `promise`, live progress as either a
  callback subscription or an async iterable, and idempotent `cancel()`.
- Downloads are capped per endpoint (default 4) and queued FIFO beyond the
  cap; progress events are coalesced natively so slow consumers never
  buffer unboundedly.
- Every failure (sync throw or rejection) is a typed `IrohError` with a
  stable numeric `code` and discriminated `kind`.

### Roadmap

Planned protocol work, honestly labeled: none of this exists in v0.1, and
no dates are attached.

- **Collections** (iroh-blobs hash sequences): share a set of files under
  a single ticket.
- **Gossip** (`iroh-gossip`): epidemic pub/sub broadcast overlays.
- **Docs** (`iroh-docs`): multi-writer replicated key-value documents.

Raw QUIC connections and custom ALPN protocols are likewise not exposed in
v0.1: today's API is `Endpoint` plus `iroh-blobs`. If a protocol matters
to you, open an issue.

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

// Device A: share a file
const a = await Endpoint.create({ blobStoreDir: `${DocumentDir}/iroh` });
const ticket = await a.shareBlob(`${DocumentDir}/photo.jpg`);
// Send `ticket` (a string) to device B out of band: QR code, chat, etc.

// Device B: download it
const b = await Endpoint.create({ blobStoreDir: `${DocumentDir}/iroh` });
const transfer = b.downloadBlob(ticket, `${DocumentDir}/photo.jpg`);

const stopListening = transfer.onProgress(({ bytesReceived }) => {
  console.log(`received ${bytesReceived} bytes`);
});

try {
  await transfer.promise; // resolves when the download completes
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
const transfer = b.downloadBlob(ticket, destPath);
for await (const { bytesReceived } of transfer.progress) {
  updateUi(bytesReceived);
}
// The loop ends on completion and throws the terminal IrohError on
// failure or cancellation.
```

Paths must be absolute paths inside your app's sandbox (for example from
`react-native-fs` or `expo-file-system`). The ticket string encodes the blob
hash and the sharing node's addresses; anyone holding it can fetch the blob
while the sharing endpoint is open.

## API reference

Everything below is exported from `react-native-iroh`. All failures (sync
throws and Promise rejections) are `IrohError` instances.

### Endpoint

An iroh endpoint: a network identity plus a blob store.

#### `Endpoint.create(options?): Promise<Endpoint>`

Creates an endpoint: binds sockets and loads the blob store.

`EndpointOptions` (all fields optional):

| Option                   | Type                       | Default      | Meaning                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`                | `"standard" \| "isolated"` | `"standard"` | Network infrastructure profile. `standard` uses n0 relay servers and address lookup (production). `isolated` uses no relays and no address lookup: peers are only reachable via direct addresses embedded in tickets (tests, LAN-only setups). |
| `blobStoreDir`           | `string`                   | in-memory    | Absolute directory path for the persistent blob store. Omit to keep blobs in memory; they are lost when the endpoint closes.                                                                                                                   |
| `maxConcurrentDownloads` | `number`                   | `4`          | Cap on concurrently active downloads for this endpoint; further downloads wait in a FIFO queue. Values below 1 are clamped to 1, non-integers are floored.                                                                                     |

`create` also accepts a second, advanced `binding` parameter (an
`IrohBinding`) that substitutes the native module, primarily for tests.

#### `endpoint.nodeId: string`

The endpoint's node id (its public key). Stable for the endpoint's lifetime;
cached at creation, so reading it never touches native code and stays valid
after `close()`.

#### `endpoint.isOpen: boolean`

Whether the endpoint is live (created and not yet closed).

#### `endpoint.shareBlob(path: string): Promise<string>`

Imports the file at absolute `path` into the endpoint's blob store and
resolves with a shareable ticket string. On the `standard` profile this
waits (bounded) for the endpoint to come online first, so the ticket
contains dialable addresses.

#### `endpoint.downloadBlob(ticket: string, destPath: string): Transfer`

Starts downloading the blob described by `ticket` into absolute `destPath`
and synchronously returns a `Transfer` handle. At most
`maxConcurrentDownloads` downloads run natively at once; additional ones
wait in a FIFO queue.

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

### Transfer

Handle for one download started with `downloadBlob`.

| Member                 | Type                                                           | Meaning                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `promise`              | `Promise<void>`                                                | Settles exactly once: resolves on completion, rejects with an `IrohError` on failure or cancellation. Rejections are pre-observed, so watching only `progress` does not cause unhandled-rejection warnings.                                                              |
| `progress`             | `AsyncIterable<ProgressEvent>`                                 | Each `for await` gets an independent iterator that receives events from that point on, ends on completion, and throws the terminal `IrohError` on failure or cancellation. Latest-value conflation keeps buffering O(1); breaking out of the loop detaches the iterator. |
| `isSettled`            | `boolean`                                                      | Whether the transfer has settled (completed, failed, or cancelled).                                                                                                                                                                                                      |
| `cancel()`             | `() => void`                                                   | Requests cancellation. Idempotent and safe at any point: a queued transfer fails immediately with kind `"cancelled"`; an active transfer is cancelled natively and rejects with code `3003`. No-op after settling.                                                       |
| `onProgress(listener)` | `(event: ProgressEvent) => void` listener; returns unsubscribe | Subscribes to progress events. Called synchronously on the JS thread with already-coalesced events, so keep it cheap. Subscribing after settling is a no-op.                                                                                                             |

`ProgressEvent` has a single field, `bytesReceived`: cumulative payload
bytes received so far, monotonically non-decreasing. The blob's total size
is not reported in v0.1.0.

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

| Code   | Kind             | Meaning                                                             |
| ------ | ---------------- | ------------------------------------------------------------------- |
| `1000` | `internal`       | Unclassified native failure (also the fallback for untagged errors) |
| `1001` | `invalid-handle` | Operation on an unknown or already-closed endpoint handle           |
| `1002` | `invalid-ticket` | Ticket string failed to parse                                       |
| `1003` | `invalid-path`   | Path is not usable (not absolute, not readable, ...)                |
| `2000` | `endpoint-bind`  | Endpoint failed to bind its sockets / come online                   |
| `3000` | `blob-import`    | Importing a file into the blob store failed                         |
| `3001` | `blob-download`  | Download failed                                                     |
| `3002` | `blob-export`    | Writing the downloaded blob to `destPath` failed                    |
| `3003` | `cancelled`      | Transfer was cancelled                                              |

Exported error types: `IrohErrorCode` (union of the numeric codes),
`IrohErrorKind` (union of the kind strings), `IrohErrorCase` (the
discriminated `code`/`kind` pairing).

### Other exports

| Export                                         | Kind          | Meaning                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_MAX_CONCURRENT_DOWNLOADS`             | `const` (`4`) | Default download-concurrency cap per endpoint.                                                                                                                                                                                                                                                                                                 |
| `getIrohErrorCode(error)`                      | function      | Extracts the numeric code from a raw-bridge error message, or `undefined`. Retained for users of the raw escape hatch; the class API throws `IrohError`, which carries `code`/`kind` directly.                                                                                                                                                 |
| `Iroh`                                         | const         | Unstable escape hatch: the raw Nitro hybrid object with the full native surface (`createEndpoint`, `nodeId`, `isEndpointOpen`, `closeEndpoint`, `shareBlob`, `downloadBlob`, `cancelDownload`), without the queueing, error typing, or lifecycle handling of `Endpoint`. Its errors carry `[iroh:<code>]` message prefixes. Prefer `Endpoint`. |
| `IrohSpec`                                     | type          | The interface of the raw hybrid object.                                                                                                                                                                                                                                                                                                        |
| `IrohBinding`                                  | type          | The structural subset of `IrohSpec` that `Endpoint` depends on; implement it to mock the native layer in tests.                                                                                                                                                                                                                                |
| `EndpointConfig`, `NetworkProfile`             | types         | The raw bridge's endpoint configuration types.                                                                                                                                                                                                                                                                                                 |
| `EndpointOptions`, `Transfer`, `ProgressEvent` | types         | Described above.                                                                                                                                                                                                                                                                                                                               |

## Threading and performance notes

- Native calls run on Nitro's Promise thread pool, which grows from 3 to at
  most 10 threads. Each in-flight native operation occupies one thread; that
  is why downloads are capped (default 4) and queued FIFO per endpoint.
  Keep `maxConcurrentDownloads` well below 10 unless you know your workload.
- Progress events are coalesced natively to at most about 30 per second,
  and the latest value is always flushed before the download's Promise
  settles. `onProgress` listeners run synchronously on the JS thread, so
  they should stay cheap.
- The `progress` async iterable additionally conflates to the latest value
  per iterator: a slow consumer sees fewer, fresher events instead of a
  growing buffer, and memory use is O(1) regardless of consumer speed.
- `nodeId` and `isOpen` are synchronous; `nodeId` never crosses into native
  code after creation.

For a sense of scale: the repo's benchmark harness (`bun run bench`, two
Android emulators on one host) completes a full share/download roundtrip of
100 files in under 2 seconds, and sustains 50-67 MiB/s on large blobs.
Those are loopback numbers (real networks are dominated by path quality),
but they bound the overhead of the binding itself.

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

## Example app

`example/` contains a complete share/download app: device A shares a file
and shows the ticket as a QR code and copyable string; device B pastes the
ticket, downloads with live progress, and verifies integrity by re-sharing
the downloaded file and comparing ticket hashes. It is also the vehicle for
the end-to-end suite in `e2e/`.

## Development

Working on react-native-iroh itself (not needed to use the package):

```bash
bun install

# TypeScript build (react-native-builder-bob -> lib/)
bun run build

# Quality gates
bun run typecheck
bun run lint          # oxlint
bun run format:check  # oxfmt
bun test src          # TS unit tests (bun test runner)
cargo fmt --check && cargo clippy && cargo test

# Rust static libs for all four Android ABIs / Apple targets
bun run build:rust:android
bun run build:rust:ios
```

`build:rust:android` needs the four Android rustup targets listed under
Requirements. `build:rust:ios` (macOS only) packages an XCFramework and
needs all three Apple targets (`aarch64-apple-ios`, `aarch64-apple-ios-sim`,
and `x86_64-apple-ios`), regardless of the host Mac's architecture.

Nitrogen codegen: the Rust binding codegen lives in a fork of nitrogen and
is a dev-time-only concern. All generated output under
`nitrogen/generated/` is committed, so consumers and CI never run it. To
regenerate after editing `src/specs/iroh.nitro.ts`, point `NITROGEN_FORK`
at a checkout of the fork and run:

```bash
NITROGEN_FORK=/path/to/nitro-fork bun run codegen
```

End-to-end tests drive the example app on two Android devices/emulators
with Maestro (share on A, download on B, integrity check via re-share):

```bash
bun run e2e
```

The harness takes `adb` from `PATH`; when it is not there (typical on WSL,
where the Android platform tools live on the Windows side), set
`ADB=/path/to/adb` (a Windows `adb.exe` under `/mnt/c` works from WSL; APK
paths are converted for it automatically):

```bash
ADB=/mnt/c/Android/platform-tools/adb.exe bun run e2e
```

See `e2e/run-e2e.sh` for the full requirements and environment overrides
(`ADB`, `MAESTRO`, `APK`, `FILE_MB`, `E2E_ARTIFACTS`, `SKIP_INSTALL`).

## Versioning

This package uses 0-based versioning: while the major version is 0,
breaking changes bump the minor version and features bump the patch
version. Releases are cut manually via a `workflow_dispatch` GitHub Actions
workflow using semantic-release with conventional commits.

## Acknowledgements

- [iroh](https://github.com/n0-computer/iroh) by n0-computer: the
  networking stack this package binds.
- [Nitro](https://github.com/mrousavy/nitro) by Marc Rousavy (mrousavy):
  the native-module framework powering the bindings.
- Rust codegen for Nitro by boorad: this package's Rust binding layer is
  generated with the Rust support proposed upstream in
  [nitro PR #1229](https://github.com/mrousavy/nitro/pull/1229).
- Bootstrapped with
  [create-nitro-module](https://github.com/patrickkabwe/create-nitro-module)
  by Patrick Kabwe.

Third-party license notices for the statically linked Rust dependency tree
are listed in `THIRD-PARTY-NOTICES.md`.

## License

MIT. See `LICENSE`.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to
discuss what you would like to change. Conventional commit messages are
required.
