/**
 * Compile-time proof that the README "Quickstart" code is real. The function
 * bodies below mirror README.md's Quickstart snippets verbatim (only the
 * top-level `await`s are wrapped in exported functions so both snippets can
 * share one module) and are type-checked by `bun run typecheck`.
 *
 * Like `api.test-d.ts`, this file is never executed (its name intentionally
 * does not match the test runner's `*.test.ts` pattern) and is excluded from
 * builds. The `react-native-iroh` import resolves to `src/index.ts` via the
 * `paths` mapping in tsconfig.json, so the snippet exercises the exact import
 * specifier consumers use.
 *
 * If this file needs a change to keep compiling, update README.md's
 * Quickstart section to match — and vice versa.
 */
import { Endpoint } from "react-native-iroh";

// Any absolute directory inside your app's sandbox, e.g.
// RNFS.DocumentDirectoryPath (react-native-fs) or an expo-file-system path.
declare const DocumentDir: string;

/** README Quickstart: a complete share/download roundtrip between two devices. */
export async function quickstart(): Promise<void> {
  // Device A: share a file
  const a = await Endpoint.create({ blobStoreDir: `${DocumentDir}/iroh` });
  const ticket = await a.shareBlob(`${DocumentDir}/photo.jpg`);
  // Send `ticket` (a string) to device B out of band: QR code, chat, etc.

  // Device B: download it
  const b = await Endpoint.create({ blobStoreDir: `${DocumentDir}/iroh` });
  const transfer = b.downloadBlob(ticket, `${DocumentDir}/photo.jpg`);

  const stopListening = transfer.onProgress(({ bytesReceived }) => {
    console.log(`received ${bytesReceived} bytes`);
  });

  try {
    await transfer.promise; // resolves when the download completes
  } finally {
    stopListening();
  }

  // When done with an endpoint, close it:
  await a.close();
  await b.close();
}

declare const destPath: string;
declare function updateUi(bytesReceived: number): void;

/** README Quickstart: progress consumed as an async iterable. */
export async function quickstartProgressIteration(b: Endpoint, ticket: string): Promise<void> {
  const transfer = b.downloadBlob(ticket, destPath);
  for await (const { bytesReceived } of transfer.progress) {
    updateUi(bytesReceived);
  }
  // The loop ends on completion and throws the terminal IrohError on
  // failure or cancellation.
}
