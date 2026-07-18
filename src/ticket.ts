import { IrohError } from "./errors";

declare const BlobTicketBrand: unique symbol;

/**
 * A token containing everything needed to get a blob from a provider:
 * the blob's BLAKE3 hash plus the sharing endpoint's dialable addresses.
 * A branded string: obtain one from {@link Blobs.share} or by validating an
 * externally received string with {@link parseTicket}.
 *
 * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/ticket/struct.BlobTicket.html
 */
export type BlobTicket = string & { readonly [BlobTicketBrand]: "BlobTicket" };

/**
 * Wire shape of an iroh blob ticket: the kind prefix `blob` followed by
 * lowercase RFC 4648 base32 (no padding). The decoded byte stream ends with
 * the 32-byte content hash, so at least 33 bytes (hash plus a non-empty
 * address) must be encoded: ceil(33 * 8 / 5) = 53 base32 characters.
 */
const TICKET_SHAPE = /^blob[a-z2-7]{53,}$/;

/**
 * Validates that `ticket` has the shape of an iroh blob ticket and returns
 * it as a {@link BlobTicket}.
 *
 * This is a cheap syntactic check (prefix, base32 charset, minimum length):
 * it catches pasted garbage early, but only the native side proves that a
 * ticket fully parses. Throws an {@link IrohError} with kind
 * `"invalid-ticket"` (code `1002`) on failure.
 *
 * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/ticket/struct.BlobTicket.html
 */
export function parseTicket(ticket: string): BlobTicket {
  if (!TICKET_SHAPE.test(ticket)) {
    throw new IrohError(
      1002,
      `invalid blob ticket: expected "blob" followed by at least 53 base32 characters, got ${JSON.stringify(
        ticket.length > 24 ? `${ticket.slice(0, 24)}...` : ticket,
      )}`,
    );
  }
  return ticket as BlobTicket;
}
