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
export { parseTicket, validateTicketShape } from "./ticket";
export type { BlobFormat, BlobTicket, TicketInfo } from "./ticket";
export type { CollectionTransfer, FileProgress, ProgressEvent, Transfer } from "./transfer";
export { IROH_VERSION } from "./version";

/**
 * Unstable escape hatch returning the raw `Iroh` hybrid object; see
 * {@link getIroh} for details. Prefer {@link Endpoint} for application code.
 */
export { getIroh } from "./native";
