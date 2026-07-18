import { getRawIroh } from "./native";

export { DEFAULT_MAX_CONCURRENT_DOWNLOADS, Endpoint } from "./endpoint";
export type {
  AbortSignalLike,
  Blobs,
  DownloadOptions,
  EndpointId,
  EndpointOptions,
} from "./endpoint";
export { getIrohErrorCode, IrohError } from "./errors";
export type { IrohErrorCase, IrohErrorCode, IrohErrorKind } from "./errors";
export type { IrohBinding } from "./native";
export type { EndpointConfig, Iroh as IrohSpec, NetworkPreset } from "./specs/iroh.nitro";
export { parseTicket } from "./ticket";
export type { BlobTicket } from "./ticket";
export type { ProgressEvent, Transfer } from "./transfer";
export { IROH_VERSION } from "./version";

/**
 * Unstable escape hatch: the raw `Iroh` hybrid object: the full native
 * bridge surface, without the queueing, error typing, or lifecycle handling
 * of the {@link Endpoint} class API.
 *
 * Rejected Promises / thrown errors carry messages of the form
 * `[iroh:<code>] <detail>`; use {@link getIrohErrorCode} to recover the
 * stable numeric code. Prefer {@link Endpoint} for application code.
 */
export const Iroh = getRawIroh();
