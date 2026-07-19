import { IrohError } from "./errors";
import { getIroh, type IrohBinding } from "./native";

declare const BlobTicketBrand: unique symbol;

/**
 * A token containing everything needed to get a blob from a provider:
 * the blob's BLAKE3 hash plus the sharing endpoint's dialable addresses.
 * A branded string: obtain one from {@link Blobs.share} or by validating an
 * externally received string with {@link validateTicketShape}.
 *
 * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/ticket/struct.BlobTicket.html
 */
export type BlobTicket = string & { readonly [BlobTicketBrand]: "BlobTicket" };

/**
 * The traversal format a ticket's hash names:
 *
 * - `"raw"`: a single content-addressed blob.
 * - `"hashSeq"`: a hash sequence, e.g. the root of a {@link Blobs.shareCollection}
 *   collection (a sequence of child blob hashes plus a metadata blob).
 *
 * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/enum.BlobFormat.html
 */
export type BlobFormat = "raw" | "hashSeq";

/**
 * The decoded contents of a blob ticket, from {@link parseTicket}.
 */
export interface TicketInfo {
  /** The blob's BLAKE3 content hash, 64 lowercase hex characters. */
  readonly hash: string;
  /** Whether the hash names a single blob (`"raw"`) or a collection (`"hashSeq"`). */
  readonly format: BlobFormat;
  /** The sharing endpoint's id (its public key) as a string. */
  readonly nodeId: string;
  /**
   * The blob's payload size in bytes, when knowable without downloading. A
   * bare ticket does not encode a size, so this is currently always
   * `undefined` (reserved: reported only when the blob is already local).
   */
  readonly size?: number;
}

/**
 * Wire shape of an iroh blob ticket: the kind prefix `blob` followed by
 * lowercase RFC 4648 base32 (no padding). The decoded byte stream ends with
 * the 32-byte content hash, so at least 33 bytes (hash plus a non-empty
 * address) must be encoded: ceil(33 * 8 / 5) = 53 base32 characters.
 */
const TICKET_SHAPE = /^blob[a-z2-7]{53,}$/;

/**
 * Validates that `ticket` has the shape of an iroh blob ticket and returns it
 * as a {@link BlobTicket}.
 *
 * This is a cheap syntactic check (prefix, base32 charset, minimum length):
 * it catches pasted garbage early without a native round-trip, but only the
 * native side proves that a ticket fully decodes (see {@link parseTicket}).
 * Throws an {@link IrohError} with kind `"invalid-ticket"` (code `1002`) on
 * failure.
 */
export function validateTicketShape(ticket: string): BlobTicket {
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

/**
 * Decodes a blob ticket string into its {@link TicketInfo} (hash, format,
 * node id). Synchronous and native-backed: it fully parses the ticket wire
 * format without any network or store access.
 *
 * Throws an {@link IrohError} with kind `"invalid-ticket"` (code `1002`) if
 * the string is not a valid ticket.
 *
 * @param binding Advanced: an alternative native binding, primarily for tests.
 *   App code should omit it to use the real native module.
 *
 * @see https://docs.rs/iroh-blobs/0.103.0/iroh_blobs/ticket/struct.BlobTicket.html
 */
export function parseTicket(ticket: string, binding: IrohBinding = getIroh()): TicketInfo {
  // Cheap prefilter: reject obvious garbage with a precise error before the
  // native decode (which would otherwise report a less specific parse failure).
  validateTicketShape(ticket);
  try {
    return JSON.parse(binding.parseTicket(ticket)) as TicketInfo;
  } catch (error) {
    throw IrohError.from(error);
  }
}
