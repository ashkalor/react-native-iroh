/**
 * Content-hash extraction from iroh blob tickets, in pure JS.
 *
 * Wire format (iroh-tickets + iroh-blobs): the string is the kind prefix
 * "blob" followed by lowercase RFC 4648 base32 (no padding) of a postcard
 * byte stream whose final field is the 32-byte BLAKE3 content hash. The hash
 * is therefore always the last 32 bytes of the decoded stream, regardless of
 * the variable-length node address that precedes it.
 *
 * This lets the app compare *content* across devices: tickets embed node
 * addresses, so re-sharing identical bytes from a different endpoint yields a
 * different ticket string but an identical trailing hash. Validated on-device
 * by the "cross-endpoint hash equality" smoke check.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const CHAR_VALUES = new Map<string, number>();
for (let index = 0; index < BASE32_ALPHABET.length; index += 1) {
  CHAR_VALUES.set(BASE32_ALPHABET.charAt(index), index);
}

const HASH_BYTES = 32;

/**
 * Returns the blob's BLAKE3 content hash as 64 lowercase hex chars, or null
 * if `ticket` is not a syntactically valid iroh blob ticket.
 */
export function extractTicketHash(ticket: string): string | null {
  const trimmed = ticket.trim();
  if (!trimmed.startsWith("blob")) {
    return null;
  }
  const encoded = trimmed.slice(4).toUpperCase();
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const char of encoded) {
    const value = CHAR_VALUES.get(char);
    if (value === undefined) {
      return null;
    }
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  if (bytes.length <= HASH_BYTES) {
    return null;
  }
  return bytes
    .slice(-HASH_BYTES)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
