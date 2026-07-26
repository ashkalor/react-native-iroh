# Contributing to react-native-iroh

Thanks for being here.

This library exists because I needed iroh inside a React Native app I am
building, so it is used in a real app rather than written as a demo. I
open-sourced it so that nobody else has to build the same binding twice. That
is the whole motivation, and it means contributions are genuinely welcome:
bug reports, pull requests, documentation fixes, and especially the protocol
bindings still on the roadmap (Docs; blobs, collections and gossip already
ship, see `docs/support-matrix.md`). If a protocol or a
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
bun run build            # typecheck + bob build (root and ./hooks entry points)

cargo fmt --check && cargo clippy && cargo test
```

Per-feature platform support is tracked in `docs/support-matrix.md`. Keep it
honest when a feature's verification status changes: it records what has
actually been run on each platform, not what is expected to work.

### iOS example build

Three settings in `example/ios/IrohExample.xcodeproj` exist for reasons that are
not obvious from the file, and removing any of them breaks the build outright:

- `IPHONEOS_DEPLOYMENT_TARGET = 16.4` matches the Podfile. The Expo pods declare
  a 16.4 minimum, so a lower app target fails with "module 'Expo' has a minimum
  deployment target of iOS 16.4". This is the example only; the library podspec
  keeps its lower minimum.
- `REACT_NATIVE_PATH` points at the workspace-root `node_modules`. The "Bundle
  React Native code and images" phase interpolates it, and nothing else in the
  project or the CocoaPods xcconfigs defines it, so without it the phase runs
  `/scripts/xcode/with-environment.sh` and fails.
- `SWIFT_ENABLE_EXPLICIT_MODULES = NO`. Xcode's explicit Swift module builds do
  not resolve `React_RCTAppDelegate` against RN 0.86's prebuilt React Core plus
  the Expo umbrella, failing with "unable to resolve module dependency".
- `SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG`, on the Debug configuration
  only. `AppDelegate.swift` picks the Metro URL inside `#if DEBUG`, and Swift
  reads that from this setting rather than from clang's `-DDEBUG`. Without it a
  Debug build silently takes the release path, looks for an embedded
  `main.jsbundle` that debug builds never produce, and dies at launch with "No
  script URL provided".

Build the simulator app arm64-only. The pod's nitrogen cargo phase builds a
single Rust slice keyed on `$ARCHS`, so a generic or multi-arch simulator
destination fails to link:

```bash
xcodebuild -workspace IrohExample.xcworkspace -scheme IrohExample \
  -configuration Debug -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=iPhone 17" \
  ONLY_ACTIVE_ARCH=YES ARCHS=arm64 EXCLUDED_ARCHS=x86_64 build
```

### Packaging

The package ships a CommonJS build and a real ESM build, each with its own type
definitions, selected through `exports`. Two constraints are easy to break and
are pinned by `src/__tests__/packaging.test.ts`:

- `require` must stay listed before `import`. Node treats them as mutually
  exclusive so their order is irrelevant there, but Metro enables both at once
  and takes the first match, so putting `import` first silently moves React
  Native onto the ESM build.
- The `module` target must keep `esm: true`. That option is what emits
  `lib/module/package.json` (`{"type":"module"}`) and the explicit `.js`
  specifiers Node's ESM resolver requires; without it the output parses as
  CommonJS and no ESM consumer can load it.

`bob build` prints one advisory warning ("the esm option is disabled, but the
exports['.'].require field is set"). It is expected: silencing it means emitting
`.cjs` for the CommonJS target, which would change the entry point every
existing consumer resolves. The CommonJS output is already unambiguous via its
own `{"type":"commonjs"}` marker.

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

E2E drives the example app on two Android devices/emulators with Maestro:
single-blob share/download with an integrity check via re-share, a collection
roundtrip, the endpoint smoke suite (relay mode, address, online), and a gossip
chat roundtrip across both devices. It runs locally, not in CI:

```bash
bun run e2e
```

Both harnesses (`run-e2e.sh` and `run-bench.sh`) share their setup plumbing
(logging, tool discovery, device listing, app install, Metro) from
`e2e/lib.sh`; each script owns only its own device-selection and assertions.

The harness takes `adb` from `PATH`. When it is not there (typical on WSL,
where the Android platform tools live on the Windows side), set
`ADB=/path/to/adb`. A Windows `adb.exe` under `/mnt/c` works from WSL; APK
paths are converted for it automatically:

```bash
ADB=/mnt/c/Android/platform-tools/adb.exe bun run e2e
```

See `e2e/run-e2e.sh` for the full requirements and environment overrides
(`ADB`, `MAESTRO`, `APK`, `FILE_MB`, `E2E_ARTIFACTS`, `SKIP_INSTALL`,
`E2E_DEVICES`).

The harness reinstalls the app and wipes its data on every device it selects,
and by default it selects every device `adb` can see. Name the targets
explicitly whenever a phone that is not a test device might be attached:

```bash
E2E_DEVICES="emulator-5554 emulator-5556" bun run e2e
```

### Two-device test (manual, no harness)

The `e2e/` harness needs two emulators and a wired-up host. When what you want
is evidence from real hardware (including across platforms), the example app
carries a **Two-Device Test** section that runs the same ground the harness
covers, driven by hand from both screens and reporting on-screen.

Install the app on two devices and open the section on each. Press "Wait For
Other Device" on the first, then give the second that device's endpoint id
(scan the QR with the system camera app, or long-press the id to copy) and
press Connect. Order matters: a gossip topic exists only where it has been
joined locally, and an inbound join for an unknown topic is dropped, so the
waiting device has to go first. Both devices then run the identical script and
display the same checks, covering the blob and collection transfers, the
content-hash verification, the network path the traffic actually took, and the
peer's own verdict.

Each device seeds its files from its own endpoint id, so the two sides can never
share a content hash: a "transfer" that quietly returned local bytes cannot pass
the integrity check. Pairing carries only an endpoint id, so a successful
handshake is also evidence that discovery resolved the peer's addresses.

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
