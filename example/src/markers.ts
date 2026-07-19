/**
 * The E2E/SMOKE logcat marker grammar, in one place.
 *
 * The harness (e2e/run-e2e.sh) greps device logcat for these exact strings,
 * so every marker the app emits goes through this module. Never hand-roll
 * an `E2E:`/`SMOKE:` console.log elsewhere. Changing any format here
 * requires updating the harness's grep patterns in lockstep.
 */

/** `E2E: PASS <name> <detail>` / `E2E: FAIL <name> <detail>` assertion marker. */
export function e2eReport(name: string, ok: boolean, detail: string): void {
  console.log(`E2E: ${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
}

/** `E2E: TICKET <ticket>` - the harness extracts the ticket after this tag. */
export function e2eTicket(ticket: string): void {
  console.log(`E2E: TICKET ${ticket}`);
}

/** `E2E: READY <endpointId>` - app booted; the harness waits for this before driving UI. */
export function e2eReady(endpointId: string): void {
  console.log(`E2E: READY ${endpointId}`);
}

/** `E2E: <event>` bare lifecycle marker (e.g. `DOWNLOAD_START`). */
export function e2eEvent(event: string): void {
  console.log(`E2E: ${event}`);
}

/**
 * `BENCH: <TAG> <detail>` machine-readable benchmark marker. Tags in use:
 * START, SHARE, DOWNLOAD, INTEGRITY, ERROR (see example/src/bench.ts); the
 * detail is space-separated `key=value` pairs the harness parses.
 */
export function benchReport(tag: string, detail: string): void {
  console.log(`BENCH: ${tag} ${detail}`);
}

/** `BENCH: RESULT <runId> PASS|FAIL` - run verdict; the harness waits for this line. */
export function benchResult(runId: string, ok: boolean): void {
  console.log(`BENCH: RESULT ${runId} ${ok ? "PASS" : "FAIL"}`);
}

/** `SMOKE: PASS <name> - <detail>` / `SMOKE: FAIL <name> - <detail>` check marker. */
export function smokeReport(name: string, ok: boolean, detail: string): void {
  console.log(`SMOKE: ${ok ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

/** `SMOKE: RESULT ALL PASS` / `SMOKE: RESULT FAILED` suite verdict. */
export function smokeResult(allPass: boolean): void {
  console.log(`SMOKE: RESULT ${allPass ? "ALL PASS" : "FAILED"}`);
}

/** `SMOKE: SUITE ABORTED - <detail>` - a failed check stopped the suite early. */
export function smokeAborted(detail: string): void {
  console.log(`SMOKE: SUITE ABORTED - ${detail}`);
}
