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

| Feature                                                                | Android                       | iOS                              |
| ---------------------------------------------------------------------- | ----------------------------- | -------------------------------- |
| Endpoint create / close                                                | Validated (device + emulator) | Validated (device + sim)         |
| Blob share / download (`blobs.share` / `.download`)                    | Validated (device + emulator) | Validated (device + sim)         |
| Collections (`shareCollection` / `downloadCollection`)                 | Validated (device + emulator) | Validated (device)               |
| Relay mode (`relayMode`)                                               | Validated (emulator)          | Validated (simulator)            |
| Address observability (`addr` / `watchAddr` / `online` / `remoteInfo`) | Validated (device + emulator) | Validated (device)               |
| Gossip (`gossip.subscribe` / `broadcast`)                              | Validated (device)            | Validated (device)               |
| Raw QUIC streams (`streams.listen` / `streams.connect`)                | Validated (emulator)          | Code-complete, roundtrip pending |
| Docs (`docs.create` / `set` / `getContent` / `subscribe`)              | Validated (emulator)          | Not yet validated                |
| Resumable download (`blobs.status` / `has`, resume of a partial)       | Code-complete, resume pending | Code-complete, resume pending    |
| Blob store mgmt (`blobs.list` / `addBytes` / `tags.*` / GC opt-in)     | Code-complete, device pending | Code-complete, device pending    |

### Raw QUIC streams

Added in 0.2.1. On Android this is now exercised on-device: the smoke suite
listens on a custom ALPN, dials it from a second in-process endpoint, opens one
bidirectional stream, sends two framed payloads (5 bytes and 5000 bytes), and
the listener echoes each back. Both directions are asserted for exact byte
equality and the two framed chunks arrive with their boundaries intact, so the
`ArrayBuffer` chunk path (the first use of a typed-array parameter in this
package's native surface) is proven across the Nitro bridge on the emulator. iOS
has not run this yet, which is why its cell stays "Code-complete, roundtrip
pending".

Also exercised off-device: the Rust core's own test suite drives a real loopback
roundtrip between two minimal-preset endpoints in process, covering both framing
modes, message-boundary preservation under `framed`, stream and connection
teardown in each direction, the frame-size limit, and a dial on an ALPN the peer
never declared. The TypeScript layer is covered by unit tests against a mocked
bridge.

What is still not covered on either platform is a two-_device_ streams roundtrip
over the relay (as opposed to the in-process loopback above): a stream between
two separate handsets, bytes compared on arrival, the way the cross-platform
transfer row is validated.

### Docs

Added in 0.2.3. On Android this is exercised on-device by the smoke suite: two
docs-enabled endpoints are created with relays disabled, so they can reach each
other only through the direct addresses in a ticket. One authors an entry, writes
its bytes, and mints a write ticket; the other imports the ticket, subscribes to
the document, and starts sync against the author's direct address. The subscriber
observes the remote insert (authored by the peer, not a local echo) and the
content download completing, then reads the synced value back out of its blob
store and compares it byte-for-byte with the origin write. All of that folds into
the suite's `SMOKE: RESULT ALL PASS`, so the emulator gate covers docs create /
set / share / import / subscribe / startSync / getContent in one loopback run.

Also exercised off-device: the Rust core's
`two_endpoint_loopback_sync_observes_remote_insert` test drives the same
reconciliation between two in-process minimal-preset endpoints, and the
TypeScript layer is covered by unit tests against a mocked bridge.

What is still not covered is a two-_device_ docs sync over the relay (two separate
handsets reconciling a document and comparing the synced bytes), and iOS has not
run docs at all yet, which is why its cell stays "Not yet validated".

### Resumable download

Added in 0.2.3. A download that was interrupted (cancelled, or a network change
mid-stream) leaves BLAKE3-verified ranges in the store, and re-issuing the same
download resumes: `Remote::fetch` computes what is already local
(`local_for_request` / `LocalInfo::missing`) and asks the provider for only the
missing ranges, never the whole blob again. `blobs.status(hash)` reports this as
`notFound` / `partial` / `complete`, and `blobs.has(hash)` is the complete-only
predicate.

Exercised off-device: the Rust core's
`interrupted_download_resumes_only_the_missing_ranges` test pre-seeds a genuine
partial (a bounded chunk-range get), asserts the store reports `partial` with a
size strictly below the full blob and that `LocalInfo` is incomplete, then runs a
full `blobs.download` and asserts the second pass moves strictly fewer payload
bytes than the whole blob (the proof that only the missing ranges crossed the
wire) and that the final file is BLAKE3-identical to the source. The TypeScript
layer is covered by unit tests against a mocked bridge.

What is still pending on both platforms is the on-device kill-and-resume: killing
a transfer midway on a handset and re-issuing it, observing fewer bytes on the
second pass. That is the device gate this row waits on.

### Blob store management

Added in 0.2.3. `blobs.list()` enumerates the store's blobs (hash + size);
`blobs.addBytes(data)` imports an in-memory `ArrayBuffer` and mints a ticket (the
counterpart of `blobs.share` for a file); and `blobs.tags` is the tag lifecycle
(`list` / `create` / `rename` / `delete`). Tags are the sanctioned retention
mechanism: garbage collection is opt-in (`gc: { intervalSecs }` at endpoint
creation, OFF by default so retention is unchanged), and when enabled a tagged
blob survives a GC pass while an untagged one is reclaimed. There is deliberately
no direct blob delete: "removing" a blob is dropping its tag and letting GC
reclaim it (deletion is GC-only, keeping the store the sole owner of every byte).

Exercised off-device: the Rust core covers the full tag lifecycle
(`tag_lifecycle_create_list_rename_delete`), the GC protect/reclaim behavior with
a real short-interval loop (`gc_reclaims_untagged_but_keeps_tagged_blobs`), that
GC stays off by default (`gc_off_by_default_retains_untagged_blobs`), and the
in-memory import round-trip (`add_bytes_imports_and_is_downloadable`). The
TypeScript layer is covered by unit tests against a mocked bridge.

What is still pending is exercising these on a handset through the example app's
smoke suite, which is why both cells stay "Code-complete, device pending".

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

## Reproducing the device rows

The example app carries a **Two-Device Test** section so the rows above can be
re-established on real hardware without the `e2e/` harness, which needs two
emulators and a wired-up host. Install the app on two devices, open the section
on both, press "Wait For Other Device" on the first, then give the second that
device's endpoint id: scan its QR code with the system camera app, or long-press
the id to copy it, and paste. Both devices then run the same script and display
the same checks:
endpoint online, control topic joined, peer resolved from its id alone, the
peer's blob downloaded, its bytes verified by content hash, the network path
that carried it, the peer's collection downloaded, its children verified by
size, and the peer's own verdict echoed back.

Two properties make the result meaningful rather than self-confirming. Each
device's files are seeded from its own endpoint id, so the two sides never share
a content hash and a "transfer" that quietly returned local bytes cannot pass.
And pairing carries only an endpoint id, because that is all the QR encodes, so
a successful handshake is also evidence that discovery resolved the peer's
addresses rather than them being handed over.

This is a manual test by design. It is driven from both screens by a person and
reports on-screen; nothing in CI runs it.

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
difference matters. On physical hardware an iPhone and an Android phone have
exercised endpoint creation, blob transfer, collections, address observability
including `remoteInfo`, and a gossip topic, via the example app's Two-Device
Test. **Relay-mode selection** is the exception: it has only ever been driven on
the emulator and simulator. Its code path is platform-agnostic Rust plus the
shared TypeScript layer, so it is expected to work, but "expected" is not
"validated" and the matrix reflects that.

The network path has now been recorded. `endpoint.remoteInfo()` reports the
addresses actually carrying traffic, and the Two-Device Test samples it after
every download. On real hardware a run reported a relay and a direct path both
active at once, the direct one over IPv6:

    relay https://aps1-1.relay.n0.iroh.link./, direct [2401:4900:...]:37476

Both devices were on the same LAN for that run, so the direct path says nothing
about NAT traversal: **relay fallback and hole punching across separate networks
remain uncharacterised.** A run with the two devices on different networks is
what would settle it, and the one attempt so far did not complete (see below).

### Known limitation: changing networks breaks the blob store

Switching a device between networks mid-session (Wi-Fi to cellular) has been
observed to leave `iroh-blobs`' filesystem store unusable: it reports
`failed to download blob: local failure` with zero bytes transferred, for every
subsequent transfer, and clearing app data is the only known recovery. The
underlying panic is `poisoned storage should not be used`, raised inside
`iroh_blobs` when loading a blob's state fails. The originating fault has not
been identified, no local reproduction exists, and the store's own error is
discarded upstream before it can be reported, so the cause is not yet known.
Gossip and discovery are unaffected and keep working across the same switch.

## React hooks

The `react-native-iroh/hooks` layer (`useEndpoint`, `useTransfer`, `useDownload`,
`useGossip`, `useDocs`, `useDoc`) is pure TypeScript over the APIs above, with no native code of its
own. It is validated by renderer and unit tests (mocking the native binding), so
on any given platform a hook inherits exactly the status of the feature it wraps
from the table above.
