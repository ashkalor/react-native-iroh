/**
 * share-file: import a local file into the blob store, get a ticket.
 *
 * One concept: blobs.share() returns a BlobTicket - a string carrying the
 * blob's BLAKE3 hash plus your endpoint's dialable addresses. Anyone holding
 * it can fetch the blob while this endpoint stays open.
 */
import { Endpoint } from "react-native-iroh";
import type { BlobTicket } from "react-native-iroh";

// Any absolute directory inside your app's sandbox, e.g.
// RNFS.DocumentDirectoryPath (react-native-fs) or an expo-file-system path.
declare const DocumentDir: string;

export async function shareFile(endpoint: Endpoint): Promise<BlobTicket> {
  const ticket = await endpoint.blobs.share(`${DocumentDir}/photo.jpg`);
  // Hand the ticket to the other device out of band: QR code, chat, NFC.
  // Keep the endpoint open while peers download from you.
  console.log(`ticket: ${ticket}`);
  return ticket;
}
