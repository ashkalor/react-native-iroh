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

| Feature                                                 | Android                          | iOS               |
| ------------------------------------------------------- | -------------------------------- | ----------------- |
| Endpoint create / close                                 | Validated                        | Not yet validated |
| Blob share / download (`blobs.share` / `.download`)     | Validated                        | Not yet validated |
| Collections (`shareCollection` / `downloadCollection`)  | Validated                        | Not yet validated |
| Relay mode (`relayMode`)                                | Validated                        | Not yet validated |
| Address observability (`addr` / `watchAddr` / `online`) | Validated                        | Not yet validated |
| Gossip (`gossip.subscribe` / `broadcast`)               | Code-complete, roundtrip pending | Not yet validated |

## What "validated" means here

Android support is validated on the emulator gate the maintainers run in-session:
endpoint lifecycle, blob and collection transfer, relay-mode selection, and the
address / online observability surface all passed a real loopback (and, where
applicable, cross-emulator) run. Gossip is code-complete and unit-tested, but its
device-to-device roundtrip has not been driven through the gate yet, so it is
listed as roundtrip pending rather than validated.

iOS has not been validated on any feature yet: that pass runs on the maintainer's
Mac (iOS is not exercised by CI, which would be billed at 10x). The code paths are
platform-agnostic Rust plus the shared TypeScript layer, so they are expected to
work, but "expected" is not "validated" and the matrix reflects that until the Mac
session lands.

## React hooks

The `react-native-iroh/hooks` layer (`useEndpoint`, `useTransfer`, `useDownload`,
`useGossip`) is pure TypeScript over the APIs above, with no native code of its
own. It is validated by renderer and unit tests (mocking the native binding), so
on any given platform a hook inherits exactly the status of the feature it wraps
from the table above.
