export { DEFAULT_MAX_CONCURRENT_DOWNLOADS, DEFAULT_ONLINE_TIMEOUT_MS, Endpoint } from "./endpoint";
export type {
  AbortSignalLike,
  BlobInfo,
  Blobs,
  BlobStatus,
  DownloadOptions,
  EndpointAddr,
  EndpointId,
  EndpointOptions,
  Gossip,
  RelayMode,
  RemoteAddr,
  RemoteAddrKind,
  RemoteInfo,
  Streams,
  TagInfo,
  Tags,
} from "./endpoint";
export { parseDocTicket, validateDocTicketShape } from "./docs";
export type {
  AuthorId,
  Authors,
  Doc,
  DocContentReadyEvent,
  DocContentStatus,
  DocEntry,
  DocInsertLocalEvent,
  DocInsertRemoteEvent,
  DocLiveEvent,
  DocNeighborDownEvent,
  DocNeighborUpEvent,
  DocPendingContentReadyEvent,
  DocQuery,
  DocShareMode,
  DocsApi,
  DocSubscribeOptions,
  DocSubscription,
  DocSyncFinishedEvent,
  DocTicket,
  DocTicketInfo,
  NamespaceId,
} from "./docs";
export { getIrohErrorCode, IrohError } from "./errors";
// The hook functions live behind the `react-native-iroh/hooks` subpath so the
// root entry stays free of any `react` import; only their (react-free) public
// result types are surfaced here for convenience.
export type {
  DocEntryView,
  DocStatus,
  EndpointStatus,
  GossipStatus,
  TransferStatus,
  UseDocOptions,
  UseDocResult,
  UseDocsResult,
  UseEndpointResult,
  UseGossipOptions,
  UseGossipResult,
  UseTransferState,
} from "./hooks";
export type {
  GossipMessage,
  GossipNeighborEvent,
  GossipSubscribeOptions,
  GossipSubscription,
} from "./gossip";
export { mdnsSupported } from "./mdns";
export type {
  DiscoveryEvent,
  Mdns,
  MdnsDiscoveredEvent,
  MdnsExpiredEvent,
  MdnsSubscribeOptions,
  MdnsSubscription,
} from "./mdns";
export type { IrohErrorCase, IrohErrorCode, IrohErrorKind } from "./errors";
export type { IrohBinding } from "./native";
export type {
  EndpointConfig,
  Iroh as IrohSpec,
  NetworkPreset,
  StreamFraming,
} from "./specs/iroh.nitro";
export { DEFAULT_STREAM_BACKLOG } from "./streams";
export type { Connection, Stream, StreamListener, StreamOptions } from "./streams";
export { parseTicket, validateTicketShape } from "./ticket";
export type { BlobFormat, BlobTicket, TicketInfo } from "./ticket";
export type { CollectionTransfer, FileProgress, ProgressEvent, Transfer } from "./transfer";
export { IROH_VERSION } from "./version";

/**
 * Unstable escape hatch returning the raw `Iroh` hybrid object; see
 * {@link getIroh} for details. Prefer {@link Endpoint} for application code.
 */
export { getIroh } from "./native";
