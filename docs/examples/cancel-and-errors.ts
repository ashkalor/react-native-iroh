/**
 * cancel-and-errors: stop a transfer, and know exactly why anything failed.
 *
 * One concept: every failure in this package is an IrohError whose `kind`
 * and stable numeric `code` form a discriminated union - switch on `kind`
 * and TypeScript narrows `code` for free. Cancellation is just another
 * kind: "cancelled" (code 3003).
 */
import { Endpoint, IrohError } from "react-native-iroh";
import type { BlobTicket } from "react-native-iroh";

// Any absolute directory inside your app's sandbox, e.g.
// RNFS.DocumentDirectoryPath (react-native-fs) or an expo-file-system path.
declare const DocumentDir: string;

export async function downloadWithTimeout(
  endpoint: Endpoint,
  ticket: BlobTicket,
  timeoutMs: number,
): Promise<boolean> {
  const transfer = endpoint.blobs.download(ticket, `${DocumentDir}/download.bin`);
  // cancel() is idempotent and safe at any point; downloads also accept an
  // AbortSignal via the third argument: blobs.download(t, dest, { signal }).
  const timer = setTimeout(() => transfer.cancel(), timeoutMs);
  try {
    await transfer.done;
    return true;
  } catch (error) {
    explain(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function explain(error: unknown): void {
  if (!(error instanceof IrohError)) {
    throw error; // not from iroh; let it propagate
  }
  switch (error.kind) {
    case "cancelled":
      console.log("transfer cancelled (the timeout above hit)");
      break;
    case "invalid-ticket":
      console.log(`ticket did not parse (code ${error.code}): ${error.message}`);
      break;
    case "blob-download":
      console.log("provider unreachable or transfer failed; worth a retry");
      break;
    case "invalid-path":
      console.log("destination path must be absolute and writable");
      break;
    default:
      console.log(`iroh error ${error.code} (${error.kind}): ${error.message}`);
  }
}
