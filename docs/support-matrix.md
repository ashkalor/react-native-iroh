# Support matrix

An honest, per-feature view of what has actually been validated on each
platform. It is deliberately conservative: a cell claims support only where the
behavior has been exercised and observed to pass, not merely where the code
compiles. (This is the iroh-ffi lesson: untested does not mean working.)

## Legend

- Validated: exercised on a real device or emulator and observed to pass
  (the Android emulator gate, or the maintainer's iOS device/simulator session).
- Code-complete, roundtrip pending: implemented and covered by unit tests, but
  the on-device peer-to-peer roundtrip has not been run yet.
- Not yet validated: implemented, but not yet exercised on this platform.

## Features

| Feature                                                 | Android                          | iOS                      |
| ------------------------------------------------------- | -------------------------------- | ------------------------ |
| Endpoint create / close                                 | Validated (device + emulator)    | Validated (device + sim) |
| Blob share / download (`blobs.share` / `.download`)     | Validated (device + emulator)    | Validated (device + sim) |
| Collections (`shareCollection` / `downloadCollection`)  | Validated (emulator)             | Not yet validated        |
| Relay mode (`relayMode`)                                | Validated (emulator)             | Validated (simulator)    |
| Address observability (`addr` / `watchAddr` / `online`) | Validated (emulator)             | Not yet validated        |
| Gossip (`gossip.subscribe` / `broadcast`)               | Code-complete, roundtrip pending | Not yet validated        |

### Cross-platform transfer

An iOS device and an Android device have transferred a blob between them, in
that direction, on real hardware: the iPhone shared a 1 MiB file and the Android
phone downloaded it, observed progress, then re-shared what it received so the
two BLAKE3 content hashes could be compared. They matched, so the received bytes
were verified identical rather than merely present. This is the one test that
exercises both native builds against each other instead of against themselves.

## What "validated" means here

Android support is validated on the emulator gate the maintainers run in-session:
endpoint lifecycle, blob and collection transfer, relay-mode selection, and the
address / online observability surface all passed a real loopback (and, where
applicable, cross-emulator) run. Gossip is code-complete and unit-tested, but its
device-to-device roundtrip has not been driven through the gate yet, so it is
listed as roundtrip pending rather than validated.

iOS is validated on the maintainer's Mac, not by CI (iOS runners are billed at
10x). The rows marked "Validated (simulator)" were exercised on an iOS simulator
by the same in-app smoke suite the Android gate runs: two endpoints created with
relays disabled, a full loopback share / download / integrity roundtrip between
them, cancellation and close semantics, all reporting ALL PASS. iroh itself binds
and reports online through Network.framework there.

Both platforms are validated against apps compiled from the committed sources,
including the Rust core, rather than a previously installed binary with fresh
JavaScript loaded over Metro.

Two limits are worth stating plainly. First, this is the simulator: a run on
physical iOS hardware (which needs one-time signing and device trust) has not
happened yet, so NAT traversal and radio behavior are unproven on iOS. Second,
collections, address observability, and gossip have their own device flows that
have only been driven on Android so far. The code paths are platform-agnostic
Rust plus the shared TypeScript layer, so they are expected to work, but
"expected" is not "validated" and the matrix reflects that.

## React hooks

The `react-native-iroh/hooks` layer (`useEndpoint`, `useTransfer`, `useDownload`,
`useGossip`) is pure TypeScript over the APIs above, with no native code of its
own. It is validated by renderer and unit tests (mocking the native binding), so
on any given platform a hook inherits exactly the status of the feature it wraps
from the table above.
