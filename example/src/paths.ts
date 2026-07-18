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

/**
 * Where downloads land. Directly inside FILES_DIR (which always exists)
 * because the native layer does not create missing parent directories.
 */
export const DOWNLOAD_DEST = `${FILES_DIR}/downloaded.bin`;

/** Blob store directory for the app's main endpoint. */
export const APP_STORE_DIR = `${FILES_DIR}/iroh-app-store`;
