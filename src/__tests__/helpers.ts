import type { EndpointConfig } from "../specs/iroh.nitro";
import type { IrohBinding } from "../native";
import type { TicketInfo } from "../ticket";

/** A promise with its resolve/reject functions exposed. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes pending microtasks and timers so async chains settle. */
export function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Builds a syntactically valid blob ticket ("blob" + base32, long enough to
 * pass `parseTicket`); `seed` keeps tickets distinct across calls.
 */
export function testTicket(seed: string): string {
  const safe = seed.toLowerCase().replace(/[^a-z2-7]/g, "a");
  return `blob${safe}`.padEnd(60, "a");
}

/** One recorded native downloadBlob call, fully controllable by the test. */
export interface DownloadCall {
  endpoint: number;
  ticket: string;
  destPath: string;
  onStart: (transferId: number) => void;
  onProgress: (bytesReceived: number) => void;
  deferred: Deferred<void>;
}

/** One recorded native watchAddr subscription, drivable by the test. */
export interface WatchCall {
  endpoint: number;
  watchId: number;
  onStart: (watchId: number) => void;
  onChange: (addr: string) => void;
}

/** One recorded native endpointOnline call, resolvable by the test. */
export interface OnlineCall {
  endpoint: number;
  timeoutMs: number;
  deferred: Deferred<void>;
}

/** One recorded native remoteInfo call. */
export interface RemoteInfoCall {
  endpoint: number;
  remoteId: string;
}

/** One recorded native gossipSubscribe call, drivable by the test. */
export interface GossipSubscribeCall {
  endpoint: number;
  topic: string;
  bootstrapJoined: string;
  subId: number;
  onStart: (subId: number) => void;
  onMessage: (message: string) => void;
  onNeighbor: (event: string) => void;
}

/** One recorded native gossipBroadcast call, resolvable by the test. */
export interface GossipBroadcastCall {
  subId: number;
  payload: string;
  deferred: Deferred<void>;
}

export interface MockBinding {
  binding: IrohBinding;
  configs: EndpointConfig[];
  endpointIdCalls: number[];
  closeCalls: number[];
  downloads: DownloadCall[];
  cancelled: number[];
  shareCalls: { endpoint: number; path: string }[];
  shareCollectionCalls: { endpoint: number; pathsJoined: string }[];
  manifestCalls: { endpoint: number; ticket: string }[];
  parseTicketCalls: string[];
  addrCalls: number[];
  watches: WatchCall[];
  stoppedWatches: number[];
  onlineCalls: OnlineCall[];
  gossipSubscribes: GossipSubscribeCall[];
  gossipBroadcasts: GossipBroadcastCall[];
  gossipUnsubscribes: number[];
  /** When false, gossipSubscribe does not auto-fire onStart (the test drives it). */
  autoStartGossip: boolean;
  /** JSON string that {@link IrohBinding.endpointAddr} returns. */
  addrJson: string;
  /** JSON string that {@link IrohBinding.remoteInfo} resolves with. */
  remoteInfoJson: string;
  remoteInfoCalls: RemoteInfoCall[];
  /** Ticket string that {@link IrohBinding.shareCollection} resolves with. */
  collectionTicket: string;
  /** JSON that {@link IrohBinding.collectionManifest} resolves with. */
  manifestJson: string;
  /** Info that {@link IrohBinding.parseTicket} returns (encoded as JSON). */
  ticketInfo: TicketInfo;
  /** Overridable per test to make calls fail. */
  failures: {
    createEndpoint?: Error;
    isEndpointOpen?: Error;
    endpointAddr?: Error;
    watchAddr?: Error;
    endpointOnline?: Error;
    remoteInfo?: Error;
    closeEndpoint?: Error;
    shareBlob?: Error;
    shareCollection?: Error;
    collectionManifest?: Error;
    parseTicket?: Error;
    gossipSubscribe?: Error;
  };
}

/** Builds a fully controllable in-memory implementation of the native bridge. */
export function createMockBinding(): MockBinding {
  let nextHandle = 1;
  let nextWatchId = 1;
  let nextSubId = 1;
  const open = new Set<number>();
  const mock: MockBinding = {
    binding: {
      createEndpoint: (config) => {
        if (mock.failures.createEndpoint !== undefined) {
          return Promise.reject(mock.failures.createEndpoint);
        }
        mock.configs.push(config);
        const handle = nextHandle;
        nextHandle += 1;
        open.add(handle);
        return Promise.resolve(handle);
      },
      endpointId: (endpoint) => {
        mock.endpointIdCalls.push(endpoint);
        return `endpoint-${endpoint}`;
      },
      isEndpointOpen: (endpoint) => {
        if (mock.failures.isEndpointOpen !== undefined) {
          throw mock.failures.isEndpointOpen;
        }
        return open.has(endpoint);
      },
      endpointAddr: (endpoint) => {
        mock.addrCalls.push(endpoint);
        if (mock.failures.endpointAddr !== undefined) {
          throw mock.failures.endpointAddr;
        }
        return mock.addrJson;
      },
      watchAddr: (endpoint, onStart, onChange) => {
        if (mock.failures.watchAddr !== undefined) {
          throw mock.failures.watchAddr;
        }
        const watchId = nextWatchId;
        nextWatchId += 1;
        mock.watches.push({ endpoint, watchId, onStart, onChange });
        // Native watchAddr delivers the subscription id synchronously.
        onStart(watchId);
      },
      stopWatchAddr: (watchId) => {
        mock.stoppedWatches.push(watchId);
      },
      remoteInfo: (endpoint, remoteId) => {
        mock.remoteInfoCalls.push({ endpoint, remoteId });
        if (mock.failures.remoteInfo !== undefined) {
          return Promise.reject(mock.failures.remoteInfo);
        }
        return Promise.resolve(mock.remoteInfoJson);
      },
      endpointOnline: (endpoint, timeoutMs) => {
        if (mock.failures.endpointOnline !== undefined) {
          return Promise.reject(mock.failures.endpointOnline);
        }
        const call: OnlineCall = { endpoint, timeoutMs, deferred: deferred<void>() };
        mock.onlineCalls.push(call);
        return call.deferred.promise;
      },
      closeEndpoint: (endpoint) => {
        mock.closeCalls.push(endpoint);
        if (mock.failures.closeEndpoint !== undefined) {
          return Promise.reject(mock.failures.closeEndpoint);
        }
        open.delete(endpoint);
        return Promise.resolve();
      },
      shareBlob: (endpoint, path) => {
        mock.shareCalls.push({ endpoint, path });
        if (mock.failures.shareBlob !== undefined) {
          return Promise.reject(mock.failures.shareBlob);
        }
        return Promise.resolve(`ticket-${path}`);
      },
      downloadBlob: (endpoint, ticket, destPath, onStart, onProgress) => {
        const call: DownloadCall = {
          endpoint,
          ticket,
          destPath,
          onStart,
          onProgress,
          deferred: deferred<void>(),
        };
        mock.downloads.push(call);
        return call.deferred.promise;
      },
      cancelDownload: (transferId) => {
        mock.cancelled.push(transferId);
      },
      shareCollection: (endpoint, pathsJoined) => {
        mock.shareCollectionCalls.push({ endpoint, pathsJoined });
        if (mock.failures.shareCollection !== undefined) {
          return Promise.reject(mock.failures.shareCollection);
        }
        return Promise.resolve(mock.collectionTicket);
      },
      collectionManifest: (endpoint, ticket) => {
        mock.manifestCalls.push({ endpoint, ticket });
        if (mock.failures.collectionManifest !== undefined) {
          return Promise.reject(mock.failures.collectionManifest);
        }
        return Promise.resolve(mock.manifestJson);
      },
      parseTicket: (ticket) => {
        mock.parseTicketCalls.push(ticket);
        if (mock.failures.parseTicket !== undefined) {
          throw mock.failures.parseTicket;
        }
        return JSON.stringify(mock.ticketInfo);
      },
      gossipSubscribe: (endpoint, topic, bootstrapJoined, onStart, onMessage, onNeighbor) => {
        if (mock.failures.gossipSubscribe !== undefined) {
          throw mock.failures.gossipSubscribe;
        }
        const subId = nextSubId;
        nextSubId += 1;
        const call: GossipSubscribeCall = {
          endpoint,
          topic,
          bootstrapJoined,
          subId,
          onStart,
          onMessage,
          onNeighbor,
        };
        mock.gossipSubscribes.push(call);
        // Native delivers the subscription id asynchronously once the topic
        // has joined; the mock fires it synchronously by default for
        // determinism (opt out with autoStartGossip = false).
        if (mock.autoStartGossip) {
          onStart(subId);
        }
      },
      gossipBroadcast: (subId, payload) => {
        const call: GossipBroadcastCall = { subId, payload, deferred: deferred<void>() };
        mock.gossipBroadcasts.push(call);
        return call.deferred.promise;
      },
      gossipUnsubscribe: (subId) => {
        mock.gossipUnsubscribes.push(subId);
      },
    },
    configs: [],
    endpointIdCalls: [],
    closeCalls: [],
    downloads: [],
    cancelled: [],
    shareCalls: [],
    shareCollectionCalls: [],
    manifestCalls: [],
    parseTicketCalls: [],
    addrCalls: [],
    watches: [],
    stoppedWatches: [],
    onlineCalls: [],
    gossipSubscribes: [],
    gossipBroadcasts: [],
    gossipUnsubscribes: [],
    autoStartGossip: true,
    addrJson: JSON.stringify({
      id: "endpoint-1",
      relayUrls: [],
      directAddrs: ["127.0.0.1:1234"],
    }),
    remoteInfoJson: JSON.stringify({
      id: "remote-1",
      addrs: [
        { addr: "https://relay.example/", kind: "relay", active: false },
        { addr: "192.168.1.9:41234", kind: "ip", active: true },
      ],
    }),
    remoteInfoCalls: [],
    collectionTicket: `blob${"c".repeat(56)}`,
    manifestJson: "[]",
    ticketInfo: { hash: "a".repeat(64), format: "raw", nodeId: "node-mock" },
    failures: {},
  };
  return mock;
}

/** Awaits a promise expected to reject and returns the rejection value. */
export async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject, but it resolved");
}
