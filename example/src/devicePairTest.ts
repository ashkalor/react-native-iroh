import {
  parseTicket,
  type Endpoint,
  type EndpointId,
  type GossipSubscription,
  type RemoteInfo,
} from "react-native-iroh";
import { fileSizesIn, PAIR_COLLECTION_SIZES, resetPairDirs } from "./paths";
import { parseBootstrapPeer } from "./peers";

/** The topic both devices join to coordinate the run. */
const CONTROL_TOPIC = "react-native-iroh-device-pair-v1";

/** How long any single step may take before it is failed rather than left hanging. */
const STEP_TIMEOUT_MS = 120_000;

/** Grace period for the peer's verdict once this device has finished its own work. */
const PEER_VERDICT_TIMEOUT_MS = 60_000;

/** Gap between the repeated hellos that let a late-joining peer notice us. */
const HELLO_INTERVAL_MS = 2_000;

export type CheckStatus = "pending" | "running" | "pass" | "fail";

export interface Check {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/**
 * The run's checks in display order. Every one needs the *other* device, which
 * is the whole point: these are exactly the claims a single-device run cannot
 * substantiate.
 */
const CHECK_LABELS: readonly (readonly [string, string])[] = [
  ["online", "Endpoint online"],
  ["joined", "Control topic joined"],
  ["handshake", "Peer found by id and greeted"],
  ["blob", "Peer's file downloaded"],
  ["integrity", "Transferred bytes verified"],
  ["path", "Network path observed"],
  ["collection", "Peer's collection downloaded"],
  ["contents", "Collection contents verified"],
  ["peer-ok", "Peer reported its own result"],
];

/** Checks this device can settle on its own once a peer is present. */
const LOCAL_CHECK_IDS = ["blob", "integrity", "path", "collection", "contents"] as const;

export type Phase = "idle" | "running" | "passed" | "failed";

export interface PairTestState {
  readonly phase: Phase;
  readonly checks: readonly Check[];
  readonly peerId: EndpointId | null;
  readonly error: string | null;
}

function freshChecks(): Check[] {
  return CHECK_LABELS.map(([id, label]) => ({ id, label, status: "pending", detail: "" }));
}

export const INITIAL_PAIR_STATE: PairTestState = {
  phase: "idle",
  checks: freshChecks(),
  peerId: null,
  error: null,
};

/** Control-plane messages the two devices exchange over the gossip topic. */
type Wire =
  | { v: 1; t: "hello"; from: EndpointId }
  | { v: 1; t: "blob"; from: EndpointId; ticket: string; hash: string }
  | { v: 1; t: "collection"; from: EndpointId; ticket: string }
  | { v: 1; t: "verdict"; from: EndpointId; pass: boolean; detail: string };

function isWire(value: unknown): value is Wire {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { v?: unknown; t?: unknown; from?: unknown };
  return candidate.v === 1 && typeof candidate.t === "string" && typeof candidate.from === "string";
}

/**
 * Renders the addresses actually carrying traffic to the peer, which is what
 * says whether the transfer went direct or through a relay. Inactive addresses
 * are omitted: iroh keeps every address it has ever learned for a remote, and
 * listing those would suggest paths that were never used.
 */
function describePath(remote: RemoteInfo | undefined): string {
  if (remote === undefined) {
    return "unknown (peer already forgotten)";
  }
  const active = remote.addrs.filter((addr) => addr.active);
  if (active.length === 0) {
    return "unknown (no active address)";
  }
  return active.map((addr) => `${addr.kind === "ip" ? "direct" : "relay"} ${addr.addr}`).join(", ");
}

/** How far a transfer got, so a failure can be placed on the timeline. */
interface TransferProgress {
  events: number;
  bytes: number;
}

function describeProgress({ events, bytes }: TransferProgress): string {
  const kib = (bytes / 1024).toFixed(1);
  return `${bytes} bytes (${kib} KiB) over ${events} progress events`;
}

function withTimeout<T>(work: Promise<T>, label: string, ms = STEP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** A handle for the caller to stop a run and release the subscription. */
export interface PairTestRun {
  cancel(): void;
}

export interface PairTestOptions {
  readonly endpoint: Endpoint;
  /**
   * The peer's endpoint id, scanned or pasted from the other device, or empty to
   * join the topic and wait to be dialled.
   *
   * Gossip has no directory, so a topic exists only where it has been joined
   * locally and an inbound join for an unknown topic is dropped. Exactly one of
   * the two devices therefore has to join first and wait; the other supplies its
   * id and dials in. Only that second device needs to scan anything.
   */
  readonly peer: string;
  readonly onState: (state: PairTestState) => void;
}

/**
 * Runs the two-device suite against `peer` and reports progress through
 * `onState`.
 *
 * Both devices run this identical script; there is no host and no guest. Each
 * shares its own seeded file and collection, announces the tickets on the
 * control topic, downloads whatever the other announces, and finally broadcasts
 * its own verdict. Symmetry is what removes the need for leader election, and it
 * means each screen ends up showing both directions of every transfer.
 *
 * This engine owns the authoritative state and pushes whole snapshots outward.
 * It never reads state back from the caller, because a React setState is not
 * readable synchronously and the control flow below depends on knowing what has
 * already settled.
 */
export function runPairTest({ endpoint, peer, onState }: PairTestOptions): PairTestRun {
  let cancelled = false;
  let subscription: GossipSubscription | null = null;
  let helloTimer: ReturnType<typeof setInterval> | null = null;
  let verdictTimer: ReturnType<typeof setTimeout> | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  let state: PairTestState = { phase: "running", checks: freshChecks(), peerId: null, error: null };
  const emit = (): void => onState(state);
  const patch = (fields: Partial<PairTestState>): void => {
    state = { ...state, ...fields };
    emit();
  };
  const set = (id: string, status: CheckStatus, detail = ""): void => {
    state = {
      ...state,
      checks: state.checks.map((check) => (check.id === id ? { ...check, status, detail } : check)),
    };
    emit();
  };
  const statusOf = (id: string): CheckStatus =>
    state.checks.find((check) => check.id === id)?.status ?? "pending";

  const clearTimers = (): void => {
    if (helloTimer !== null) {
      clearInterval(helloTimer);
      helloTimer = null;
    }
    if (verdictTimer !== null) {
      clearTimeout(verdictTimer);
      verdictTimer = null;
    }
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  };

  const stop = (): void => {
    clearTimers();
    subscription?.unsubscribe();
    subscription = null;
  };

  const run = async (): Promise<void> => {
    const peerAddr = peer.trim() === "" ? null : parseBootstrapPeer(peer);
    if (peerAddr !== null) {
      patch({ peerId: peerAddr.id });
    }

    const dirs = resetPairDirs(endpoint.id);

    set("online", "running");
    await withTimeout(endpoint.online({ timeoutMs: STEP_TIMEOUT_MS }), "endpoint online");
    set("online", "pass", endpoint.addr.relayUrls[0] ?? "no relay url");
    if (cancelled) {
      return;
    }

    set("joined", "running");
    // When we were given an id, that id is all we have: bootstrapping from it
    // alone is what proves n0 discovery resolved the peer's addresses, because
    // nothing here supplies them. The waiting side passes no bootstrap at all.
    subscription = endpoint.gossip.subscribe(
      CONTROL_TOPIC,
      peerAddr === null ? undefined : { bootstrap: [peerAddr] },
    );
    const topic = subscription;
    await withTimeout(topic.joined, "topic join");
    set("joined", "pass", peerAddr === null ? `${CONTROL_TOPIC} (waiting)` : CONTROL_TOPIC);
    if (cancelled) {
      return;
    }

    const send = (message: Wire): void => {
      topic.broadcast(JSON.stringify(message)).catch(() => undefined);
    };
    const hello: Wire = { v: 1, t: "hello", from: endpoint.id };

    set("handshake", "running", "waiting for the other device");
    // The first device to join sits alone until the second arrives, so a single
    // hello can be sent to nobody. Repeat until the peer answers.
    send(hello);
    helloTimer = setInterval(() => send(hello), HELLO_INTERVAL_MS);

    const blobTicket = await endpoint.blobs.share(dirs.blobSource);
    const collectionTicket = await endpoint.blobs.shareCollection([...dirs.collectionSources]);

    let greeted = false;
    // Two devices both left waiting would otherwise block here forever, since
    // neither ever dials the other. Fail loudly and name the likely cause.
    handshakeTimer = setTimeout(() => {
      if (!greeted) {
        set(
          "handshake",
          "fail",
          peerAddr === null
            ? "no peer within 120s: the other device needs to scan this code"
            : "no peer within 120s: the other device needs to press Wait first",
        );
        stop();
      }
    }, STEP_TIMEOUT_MS);

    let blobHandled = false;
    let collectionHandled = false;
    let verdictSent = false;
    let peerVerdict: boolean | null = null;
    let progress: TransferProgress = { events: 0, bytes: 0 };

    const localWorkDone = (): boolean => blobHandled && collectionHandled;
    const localPassed = (): boolean => LOCAL_CHECK_IDS.every((id) => statusOf(id) === "pass");

    const maybeFinish = (): void => {
      if (!localWorkDone()) {
        return;
      }
      if (!verdictSent) {
        verdictSent = true;
        const pass = localPassed();
        send({
          v: 1,
          t: "verdict",
          from: endpoint.id,
          pass,
          detail: pass ? "all local checks passed" : "a local check failed",
        });
        // Ending the subscription ends the message loop below, so give the peer
        // a bounded window to report before calling it a failure.
        verdictTimer = setTimeout(() => {
          if (peerVerdict === null) {
            set("peer-ok", "fail", "peer did not report within 60s");
          }
          stop();
        }, PEER_VERDICT_TIMEOUT_MS);
      }
      if (peerVerdict !== null) {
        stop();
      }
    };

    for await (const message of topic.messages) {
      if (cancelled) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.text);
      } catch {
        continue;
      }
      if (!isWire(parsed) || parsed.from === endpoint.id) {
        continue;
      }

      // ANY message settles the handshake, not just a hello. Gossip does not
      // guarantee ordering, so a ticket can overtake the hello meant to precede
      // it; keying this on hello alone would leave the check unresolved through
      // an otherwise perfect run, and the run is failed if anything is left
      // unresolved.
      if (!greeted) {
        greeted = true;
        if (helloTimer !== null) {
          clearInterval(helloTimer);
          helloTimer = null;
        }
        if (handshakeTimer !== null) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        patch({ peerId: parsed.from });
        set(
          "handshake",
          "pass",
          peerAddr === null
            ? `dialled in by ${parsed.from.slice(0, 12)}`
            : `peer ${parsed.from.slice(0, 12)} resolved from its id alone`,
        );
        // Answer once so a peer that joined before us also settles, then
        // announce what we have for it to fetch.
        send(hello);
        send({
          v: 1,
          t: "blob",
          from: endpoint.id,
          ticket: blobTicket,
          hash: parseTicket(blobTicket).hash,
        });
        send({ v: 1, t: "collection", from: endpoint.id, ticket: collectionTicket });
      }

      if (parsed.t === "hello") {
        continue;
      }

      if (parsed.t === "blob" && !blobHandled) {
        blobHandled = true;
        try {
          set("blob", "running");
          const dest = `${dirs.blobDest}/peer.bin`;
          const transfer = endpoint.blobs.download(parsed.ticket, dest);
          // Tracked outside the try/catch reporting so a failure can say how far
          // the transfer got. "nothing ever arrived" and "died mid-stream" have
          // completely different causes, and the error alone cannot tell them
          // apart: iroh reports a truncated stream as an opaque I/O error.
          progress = { events: 0, bytes: 0 };
          const unsubscribe = transfer.onProgress((event) => {
            progress.events += 1;
            progress.bytes = event.bytesReceived;
          });
          await withTimeout(transfer.done, "blob download");
          unsubscribe();
          set("blob", "pass", `${describeProgress(progress)} received`);

          set("integrity", "running");
          const reShared = parseTicket(await endpoint.blobs.share(dest)).hash;
          const matches = reShared === parsed.hash;
          set(
            "integrity",
            matches ? "pass" : "fail",
            matches
              ? `content hash ${reShared.slice(0, 16)}... matches`
              : `expected ${parsed.hash} got ${reShared}`,
          );

          // Sampled while the connection is still warm: iroh forgets a remote
          // some time after the last traffic.
          set("path", "running");
          set("path", "pass", describePath(await endpoint.remoteInfo(parsed.from)));
        } catch (error) {
          set("blob", "fail", `${String(error)} [after ${describeProgress(progress)}]`);
          set("integrity", "fail", "skipped: download failed");
          set("path", "fail", "skipped: download failed");
        }
        maybeFinish();
        continue;
      }

      if (parsed.t === "collection" && !collectionHandled) {
        collectionHandled = true;
        try {
          set("collection", "running");
          const transfer = endpoint.blobs.downloadCollection(parsed.ticket, dirs.collectionDest);
          progress = { events: 0, bytes: 0 };
          const unsubscribe = transfer.onProgress((event) => {
            progress.events += 1;
            progress.bytes = event.bytesReceived;
          });
          await withTimeout(transfer.done, "collection download");
          unsubscribe();
          set(
            "collection",
            "pass",
            `${transfer.files.length} children, ${describeProgress(progress)}`,
          );

          set("contents", "running");
          const present = Object.values(fileSizesIn(dirs.collectionDest)).sort((a, z) => a - z);
          const expected = [...PAIR_COLLECTION_SIZES].sort((a, z) => a - z);
          const ok =
            present.length === expected.length &&
            present.every((size, index) => size === expected[index]);
          set(
            "contents",
            ok ? "pass" : "fail",
            ok
              ? `sizes ${present.join(", ")}`
              : `expected ${expected.join(", ")} got ${present.join(", ")}`,
          );
        } catch (error) {
          set("collection", "fail", `${String(error)} [after ${describeProgress(progress)}]`);
          set("contents", "fail", "skipped: download failed");
        }
        maybeFinish();
        continue;
      }

      if (parsed.t === "verdict") {
        peerVerdict = parsed.pass;
        set("peer-ok", parsed.pass ? "pass" : "fail", parsed.detail);
        maybeFinish();
      }
    }

    clearTimers();
    const failed = state.checks.some((check) => check.status === "fail");
    const incomplete = state.checks.some(
      (check) => check.status === "pending" || check.status === "running",
    );
    patch({ phase: failed || incomplete ? "failed" : "passed" });
  };

  emit();
  run()
    .catch((error: unknown) => {
      if (cancelled) {
        return;
      }
      patch({ phase: "failed", error: String(error) });
    })
    .finally(stop);

  return {
    cancel(): void {
      cancelled = true;
      stop();
      patch({ phase: "idle" });
    },
  };
}
