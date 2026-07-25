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

| Feature                                                 | Android                       | iOS                      |
| ------------------------------------------------------- | ----------------------------- | ------------------------ |
| Endpoint create / close                                 | Validated (device + emulator) | Validated (device + sim) |
| Blob share / download (`blobs.share` / `.download`)     | Validated (device + emulator) | Validated (device + sim) |
| Collections (`shareCollection` / `downloadCollection`)  | Validated (emulator)          | Not yet validated        |
| Relay mode (`relayMode`)                                | Validated (emulator)          | Validated (simulator)    |
| Address observability (`addr` / `watchAddr` / `online`) | Validated (emulator)          | Not yet validated        |
| Gossip (`gossip.subscribe` / `broadcast`)               | Validated (device)            | Validated (device)       |

### Cross-platform transfer

An iOS device and an Android device have transferred a blob between them, in
that direction, on real hardware: the iPhone shared a 1 MiB file and the Android
phone downloaded it, observed progress, then re-shared what it received so the
two BLAKE3 content hashes could be compared. They matched, so the received bytes
were verified identical rather than merely present. This is the one test that
exercises both native builds against each other instead of against themselves.

### Cross-platform gossip

The same two devices have also joined a shared gossip topic and exchanged
messages. The iPhone joined first and the Android phone bootstrapped to it, both
by pasting the full `EndpointAddr` and, separately, by supplying only the
endpoint id and letting n0's discovery resolve its addresses. Both worked.

Gossip topic membership is created only by a local join, so the second device
cannot bootstrap into a topic the first has not joined yet: an inbound join for
an unknown topic is dropped rather than refused. That ordering is a property of
the protocol, not of this example.

The automated two-device gossip flow in `e2e/` has still never been driven to
completion; the validation above was performed by hand.

## What "validated" means here

Android support is validated on the emulator gate the maintainers run in-session:
endpoint lifecycle, blob and collection transfer, relay-mode selection, and the
address / online observability surface all passed a real loopback (and, where
applicable, cross-emulator) run. Gossip is the exception to the emulator rule: it
was validated by hand between two physical devices rather than through the gate,
because the automated flow has never been driven to completion.

iOS is validated on the maintainer's Mac, not by CI (iOS runners are billed at
10x). The rows marked "Validated (simulator)" were exercised on an iOS simulator
by the same in-app smoke suite the Android gate runs: two endpoints created with
relays disabled, a full loopback share / download / integrity roundtrip between
them, cancellation and close semantics, all reporting ALL PASS. iroh itself binds
and reports online through Network.framework there.

Both platforms are validated against apps compiled from the committed sources,
including the Rust core, rather than a previously installed binary with fresh
JavaScript loaded over Metro.

The device rows are narrower than the simulator and emulator rows, and the
difference matters. On physical hardware the maintainers have exercised endpoint
creation, a blob transfer, and a gossip topic between an iPhone and an Android
phone, and nothing else. Collections, relay-mode selection and address
observability have only been driven on the emulator and simulator. The code paths
are platform-agnostic Rust plus the shared TypeScript layer, so they are expected
to work, but "expected" is not "validated" and the matrix reflects that.

The network path the cross-platform transfer actually took (a direct hole-punched
route, or a relay) was not recorded, so relay fallback and NAT traversal remain
uncharacterised on real networks.

## React hooks

The `react-native-iroh/hooks` layer (`useEndpoint`, `useTransfer`, `useDownload`,
`useGossip`) is pure TypeScript over the APIs above, with no native code of its
own. It is validated by renderer and unit tests (mocking the native binding), so
on any given platform a hook inherits exactly the status of the feature it wraps
from the table above.
