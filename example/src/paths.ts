/**
 * The example app's private files directory. Hardcoded because the bare
 * example app has no filesystem module; matches applicationId "com.irohexample".
 */
export const FILES_DIR = "/data/user/0/com.irohexample/files";

/**
 * Test file provisioned by the E2E harness (via `adb shell run-as ... dd`).
 * When present it is preferred as the share source, so the harness controls
 * the transfer size. It never exists in normal interactive use.
 */
export const E2E_SHARE_FILE = `${FILES_DIR}/e2e-share.bin`;

/**
 * Pre-existing, world-readable files to share when no harness-provisioned
 * test file exists. Fonts are ideal: large enough (~1MB) to produce progress
 * events. Candidates are tried in order; the first readable one wins.
 */
export const SYSTEM_FILE_CANDIDATES = [
  "/system/fonts/Roboto-Regular.ttf",
  "/system/fonts/NotoSans-Regular.ttf",
  "/system/fonts/NotoSerif-Regular.ttf",
  "/system/etc/fonts.xml",
  "/system/etc/hosts",
];

/** Share source candidates: harness file first, then system fallbacks. */
export const SHARE_CANDIDATES = [E2E_SHARE_FILE, ...SYSTEM_FILE_CANDIDATES];

/** Outcome of {@link shareFirstReadable}. */
export type ShareAttempt =
  | { ok: true; ticket: string; source: string }
  | { ok: false; lastError: string };

/**
 * Tries the share candidates in order; the first readable one wins. Returns
 * the ticket plus the winning source path, or (when every candidate fails)
 * the last failure rendered as a string.
 */
export async function shareFirstReadable(
  endpoint: { shareBlob(path: string): Promise<string> },
  candidates: readonly string[],
): Promise<ShareAttempt> {
  let lastError = "no readable share candidate found";
  for (const candidate of candidates) {
    try {
      return { ok: true, ticket: await endpoint.shareBlob(candidate), source: candidate };
    } catch (error) {
      // Candidate missing/unreadable on this device; try the next one.
      lastError = String(error);
    }
  }
  return { ok: false, lastError };
}

/**
 * Where downloads land. Directly inside FILES_DIR (which always exists)
 * because the native layer does not create missing parent directories.
 */
export const DOWNLOAD_DEST = `${FILES_DIR}/downloaded.bin`;

/** Blob store directory for the app's main endpoint. */
export const APP_STORE_DIR = `${FILES_DIR}/iroh-app-store`;
