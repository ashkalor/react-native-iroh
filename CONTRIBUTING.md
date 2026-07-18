# Contributing to react-native-iroh

Thanks for being here.

This library exists because I needed iroh inside a React Native app I am
building, so it is used in a real app rather than written as a demo. I
open-sourced it so that nobody else has to build the same binding twice. That
is the whole motivation, and it means contributions are genuinely welcome:
bug reports, pull requests, documentation fixes, and especially the protocol
bindings on the roadmap (Collections, Gossip, Docs). If a protocol or a
platform detail matters to you, open an issue and let's compare notes before
you sink time into a big change.

There are no promised turnaround times here, just a project that is actively
used and happy to grow with the people who use it.

## Development environment

### Prerequisites

- [Bun](https://bun.sh) (the repo's package manager and test runner)
- Rust via [rustup](https://rustup.rs), Rust 1.91 or newer
- For Android work: the Android SDK, NDK r27, and a device or emulator
- For iOS work: a Mac with Xcode and CocoaPods

Add the Rust targets you plan to build for. Android:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi \
  x86_64-linux-android i686-linux-android
```

iOS (macOS only):

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
# Intel Macs building for the simulator also need: x86_64-apple-ios
```

### Setup

```bash
git clone https://github.com/ashkalor/react-native-iroh.git
cd react-native-iroh
bun install
```

The repo is a Bun workspace, so this also installs the `example/` app.

### Quality gates

```bash
bun run typecheck        # tsc --noEmit
bun run lint             # oxlint
bun run format:check     # oxfmt --check
bun test src             # TypeScript unit tests

cargo fmt --check && cargo clippy && cargo test
```

### Building

```bash
# TypeScript build (react-native-builder-bob -> lib/)
bun run build

# Rust static libs for all four Android ABIs / Apple targets
bun run build:rust:android
bun run build:rust:ios
```

`build:rust:android` needs the four Android rustup targets above.
`build:rust:ios` (macOS only) packages an XCFramework and needs all three
Apple targets (`aarch64-apple-ios`, `aarch64-apple-ios-sim`, and
`x86_64-apple-ios`), regardless of the host Mac's architecture.

### Running the example app

The `example/` app is a complete share/download UI and the vehicle for the
end-to-end and benchmark suites. Start Metro and launch it:

```bash
cd example
bun run start                    # Metro bundler
bun run android                  # build and run on Android
bun run ios                      # build and run on iOS (runs `bun run pod` first if needed)
```

### Regenerating bindings (nitrogen codegen)

The Rust binding codegen lives in a maintained fork of nitrogen:
[`ashkalor/nitro`, branch `feat/rust-codegen`](https://github.com/ashkalor/nitro/tree/feat/rust-codegen).
This is the checkout to build from. It carries the Rust support originally
proposed upstream in [nitro PR #1229](https://github.com/mrousavy/nitro/pull/1229)
and keeps it current, so prefer it over the upstream PR branch, which has
fallen behind.

Codegen is a dev-time-only concern: all generated output under
`nitrogen/generated/` is committed, so consumers and CI never run it. To
regenerate after editing `src/specs/iroh.nitro.ts`, clone the fork and point
`NITROGEN_FORK` at it:

```bash
git clone -b feat/rust-codegen https://github.com/ashkalor/nitro.git
NITROGEN_FORK=/path/to/nitro bun run codegen
```

### End-to-end tests

E2E drives the example app on two Android devices/emulators with Maestro
(share on A, download on B, integrity check via re-share). It runs locally,
not in CI:

```bash
bun run e2e
```

The harness takes `adb` from `PATH`. When it is not there (typical on WSL,
where the Android platform tools live on the Windows side), set
`ADB=/path/to/adb`. A Windows `adb.exe` under `/mnt/c` works from WSL; APK
paths are converted for it automatically:

```bash
ADB=/mnt/c/Android/platform-tools/adb.exe bun run e2e
```

See `e2e/run-e2e.sh` for the full requirements and environment overrides
(`ADB`, `MAESTRO`, `APK`, `FILE_MB`, `E2E_ARTIFACTS`, `SKIP_INSTALL`).

### Benchmarks

```bash
bun run bench
```

The benchmark runs a provider endpoint and a consumer endpoint in one app
process on a single Android emulator (minimal preset, loopback QUIC), so it
measures the library stack (import, BLAKE3 hashing, QUIC, blob store, export,
native thread pool, TS download queue) rather than relay infrastructure. See
`e2e/run-bench.sh` for the run matrix and overrides.

## Internals

These are the implementation details a contributor needs and a consumer does
not. The README keeps only the consumer-visible consequences.

### Threading model

The Rust core runs a lazily-initialized multi-thread tokio runtime shared by
the whole core (`rust/iroh-rn-core/src/runtime.rs`); async work and the core's
completion callbacks execute on its worker threads. Native methods are invoked
by the C++ side on Nitro's Promise thread pool, which grows from 3 to at most
10 threads. Each in-flight native operation occupies one pool thread, which is
why downloads are capped (default 4) and queued FIFO per endpoint; keeping
`maxConcurrentDownloads` well below 10 avoids starving the pool.

### Progress coalescing

The core emits one progress value per transfer chunk, far more than JS can
usefully render. A native `Coalescer` (`rust/iroh-rn-core/src/coalesce.rs`)
rate-limits the stream before it crosses the bridge, at
`PROGRESS_MIN_INTERVAL = 34ms` (about 30 events per second, set in
`hybrid_iroh.rs`): the first value passes through immediately, later values
are suppressed until the interval elapses, and the most recent suppressed
value is flushed so the last progress state always reaches JS before the
terminal event. On the TypeScript side the `progress` async iterable
additionally conflates to the latest value per iterator, keeping a slow
consumer's buffering at O(1).

### Why `panic = "unwind"`

Every host callback is wrapped in `catch_unwind` guards at the FFI boundary
so a panic can never unwind across the C ABI or kill a tokio worker. That
requires the release profile to keep the default `panic = "unwind"`; do not
set `panic = "abort"` in `Cargo.toml`. The rest of the release profile (fat
LTO, `codegen-units = 1`, `strip = "symbols"`) is tuned to shrink the static
library for mobile.

### Source-build packaging

The published package builds its native core from source inside the
consumer's Gradle/Xcode build (the build glue invokes `cargo` for the target
being built) rather than shipping prebuilt binaries. This keeps the package
free of large per-ABI binaries and lets the exact iroh crates compile against
the consumer's toolchain. The tradeoff is that the build machine needs a Rust
toolchain and the first build compiles the whole iroh dependency tree (Cargo's
incremental cache makes later builds cheap). All nitrogen-generated bindings
under `nitrogen/generated/` are committed, so consumers and CI never run
codegen.

## Repo conventions

- **Conventional commits** are required: `type(scope): summary`. Releases and
  the changelog are derived from commit history by semantic-release, cut
  manually via a `workflow_dispatch` GitHub Actions workflow.
- **0-based versioning**: while the major version is 0, breaking changes bump
  the minor version and features bump the patch version. Pin accordingly.
- **No emoji** in authored code or docs, and no em-dashes in prose.
- **Device tests use Maestro**; flows live under `e2e/flows/`.

## License

By contributing, you agree that your contributions are licensed under the
MIT License. See `LICENSE`.
