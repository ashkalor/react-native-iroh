import { Directory, File, Paths } from "expo-file-system";

/**
 * expo-file-system exposes locations as `file://` URIs, but the native iroh
 * layer takes plain absolute filesystem paths, so strip the scheme and decode.
 */
const fromFileUri = (uri: string): string =>
  decodeURIComponent(uri.replace(/^file:\/\//, "")).replace(/\/+$/, "");

/** The documents directory URI without a trailing slash, for building children. */
const DOC_BASE_URI = Paths.document.uri.replace(/\/+$/, "");

/**
 * The example app's private, writable files directory, resolved per platform
 * via expo-file-system: the iOS app-sandbox Documents directory, or the
 * Android app files directory. Everything the app stores hangs off this.
 */
export const FILES_DIR = fromFileUri(Paths.document.uri);

/**
 * Test file provisioned by the E2E harness (via `adb shell run-as ... dd`).
 * When present it is preferred as the share source, so the harness controls
 * the transfer size. It never exists in normal interactive use.
 */
export const E2E_SHARE_FILE = `${FILES_DIR}/e2e-share.bin`;

/**
 * Pre-existing, world-readable files to share when no harness-provisioned test
 * file exists. These exist only on Android; on iOS there is no equivalent, so
 * the app provisions its own source instead (see {@link ensureFallbackSource}).
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
 * Provisions (once) and returns a ~1 MB share source inside {@link FILES_DIR}.
 * The universal fallback when no pre-existing candidate is readable, which is
 * always the case on iOS. Large enough to yield several progress events.
 */
export function ensureFallbackSource(): string {
  // Provision inside a dedicated subdirectory, built from an explicit child
  // URI, so writing the source can never collide with the app's own storage
  // (the store directories and this file all live under the documents dir).
  const dir = new Directory(`${DOC_BASE_URI}/iroh-demo`);
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  const file = new File(`${DOC_BASE_URI}/iroh-demo/share-src.bin`);
  if (!file.exists) {
    const bytes = new Uint8Array(1024 * 1024);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = i & 0xff;
    }
    file.create();
    file.write(bytes);
  }
  return fromFileUri(file.uri);
}

/**
 * Wipes and recreates a demo's scratch directory under the documents dir,
 * returning its plain path.
 *
 * Demos build blob stores and export downloads under these. Re-running one
 * against the state an earlier run left behind does not merely dirty the
 * results, it breaks the run: the export step fails with an I/O error on
 * Android and the download hangs on iOS. App data survives `adb install -r`, so
 * a fresh build is not a fresh state and every demo has to clear its own
 * workspace before it starts.
 */
function resetWorkspace(name: string): string {
  const dir = new Directory(`${DOC_BASE_URI}/${name}`);
  if (dir.exists) {
    dir.delete();
  }
  dir.create({ intermediates: true });
  return fromFileUri(dir.uri);
}

/** Wipes and recreates the smoke suite's scratch directory. */
export function resetSmokeDir(): string {
  return resetWorkspace("iroh-smoke");
}

/** The collections demo's freshly reset directories. */
export interface CollectionsDirs {
  /** Root for the demo's blob stores. */
  readonly storeRoot: string;
  /** Existing, empty directory the collection's children are exported into. */
  readonly destDir: string;
}

/**
 * Wipes and recreates the collections demo's scratch directory, returning the
 * store root and a ready-to-use export target.
 *
 * The export target is created here rather than by the caller because the
 * native layer does not create missing parent directories, and is a
 * subdirectory rather than the workspace root so it contains nothing but the
 * collection's own children.
 */
export function resetCollectionsDir(): CollectionsDirs {
  const storeRoot = resetWorkspace("iroh-collections");
  const downloads = new Directory(`${DOC_BASE_URI}/iroh-collections/downloads`);
  downloads.create({ intermediates: true });
  return { storeRoot, destDir: fromFileUri(downloads.uri) };
}

/** Outcome of {@link shareFirstReadable}. */
export type ShareAttempt =
  | { ok: true; ticket: string; source: string }
  | { ok: false; lastError: string };

/**
 * Tries the share candidates in order; the first readable one wins. When none
 * are readable (e.g. iOS, which has no /system/fonts), falls back to a
 * self-provisioned source so the demo works on every platform.
 */
export async function shareFirstReadable(
  endpoint: { blobs: { share(path: string): Promise<string> } },
  candidates: readonly string[],
): Promise<ShareAttempt> {
  let lastError = "no readable share candidate found";
  for (const candidate of candidates) {
    try {
      return { ok: true, ticket: await endpoint.blobs.share(candidate), source: candidate };
    } catch (error) {
      // Candidate missing/unreadable on this device; try the next one.
      lastError = String(error);
    }
  }
  try {
    const source = ensureFallbackSource();
    return { ok: true, ticket: await endpoint.blobs.share(source), source };
  } catch (error) {
    lastError = String(error);
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
