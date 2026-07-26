/**
 * The E2E/SMOKE marker grammar, in one place.
 *
 * The harness (e2e/run-e2e.sh) greps device logcat for these exact strings,
 * so every marker the app emits goes through this module. Never hand-roll
 * an `E2E:`/`SMOKE:` console.log elsewhere. Changing any format here
 * requires updating the harness's grep patterns in lockstep.
 *
 * Every marker is also mirrored to {@link MARKER_LOG_PATH}. Android reads
 * markers straight from logcat, but React Native's bridgeless runtime does not
 * forward `console.log` to the iOS system log, so on iOS the file is the only
 * way to recover markers off-device (pull it with
 * `xcrun devicectl device copy from --domain-type appDataContainer`). It works
 * on release builds too, where `run-as` and Metro are both unavailable.
 */
import { File, Paths } from "expo-file-system";

const MARKER_LOG_URI = `${Paths.document.uri.replace(/\/+$/, "")}/iroh-markers.log`;

/** Absolute path of the mirrored marker log, inside the app's documents dir. */
export const MARKER_LOG_PATH = decodeURIComponent(MARKER_LOG_URI.replace(/^file:\/\//, ""));

/**
 * Buffer of this session's markers. The whole file is rewritten on each
 * marker: expo-file-system has no append primitive, and a run emits a few
 * dozen markers at most, so the cost is irrelevant next to the network I/O
 * being measured.
 */
let emitted: string[] = [];

/** Writes a marker to the console and mirrors the session's log to disk. */
function emit(line: string): void {
  console.log(line);
  emitted.push(line);
  try {
    new File(MARKER_LOG_URI).write(`${emitted.join("\n")}\n`);
  } catch {
    // Diagnostics must never break a run: a device with no writable documents
    // dir still gets console markers, which is all Android needs.
  }
}

/**
 * Clears the mirrored marker log. Called once at app start so a pulled log
 * always describes the current session rather than accumulating across runs.
 */
export function resetMarkerLog(): void {
  emitted = [];
  try {
    const file = new File(MARKER_LOG_URI);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // See emit(): diagnostics are best-effort.
  }
}

/** `E2E: PASS <name> <detail>` / `E2E: FAIL <name> <detail>` assertion marker. */
export function e2eReport(name: string, ok: boolean, detail: string): void {
  emit(`E2E: ${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
}

/** `E2E: TICKET <ticket>` - the harness extracts the ticket after this tag. */
export function e2eTicket(ticket: string): void {
  emit(`E2E: TICKET ${ticket}`);
}

/** `E2E: READY <endpointId>` - app booted; the harness waits for this before driving UI. */
export function e2eReady(endpointId: string): void {
  emit(`E2E: READY ${endpointId}`);
}

/**
 * `E2E: GOSSIP_ADDR <endpointAddr-json>` - the harness extracts the JSON after
 * this tag (like {@link e2eTicket}) and hands it to the other device as the
 * gossip bootstrap peer.
 */
export function e2eGossipAddr(addrJson: string): void {
  emit(`E2E: GOSSIP_ADDR ${addrJson}`);
}

/**
 * `E2E: PATH <remoteInfo-json>` - the network path a just-finished transfer
 * used, as the `RemoteInfo` for the peer we pulled from. Entries with
 * `active: true` are the addresses actually carrying traffic, so their `kind`
 * ("relay" or "ip") is what distinguishes a relayed transfer from a direct one.
 */
export function e2ePath(remoteInfoJson: string): void {
  emit(`E2E: PATH ${remoteInfoJson}`);
}

/** `E2E: <event>` bare lifecycle marker (e.g. `DOWNLOAD_START`). */
export function e2eEvent(event: string): void {
  emit(`E2E: ${event}`);
}

/**
 * `BENCH: <TAG> <detail>` machine-readable benchmark marker. Tags in use:
 * START, SHARE, DOWNLOAD, CONCURRENCY, INTEGRITY, ERROR (see
 * example/src/bench.ts); the detail is space-separated `key=value` pairs the
 * harness parses.
 */
export function benchReport(tag: string, detail: string): void {
  emit(`BENCH: ${tag} ${detail}`);
}

/** `BENCH: RESULT <runId> PASS|FAIL` - run verdict; the harness waits for this line. */
export function benchResult(runId: string, ok: boolean): void {
  emit(`BENCH: RESULT ${runId} ${ok ? "PASS" : "FAIL"}`);
}

/** `SMOKE: PASS <name> - <detail>` / `SMOKE: FAIL <name> - <detail>` check marker. */
export function smokeReport(name: string, ok: boolean, detail: string): void {
  emit(`SMOKE: ${ok ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

/** `SMOKE: RESULT ALL PASS` / `SMOKE: RESULT FAILED` suite verdict. */
export function smokeResult(allPass: boolean): void {
  emit(`SMOKE: RESULT ${allPass ? "ALL PASS" : "FAILED"}`);
}

/** `SMOKE: SUITE ABORTED - <detail>` - a failed check stopped the suite early. */
export function smokeAborted(detail: string): void {
  emit(`SMOKE: SUITE ABORTED - ${detail}`);
}
