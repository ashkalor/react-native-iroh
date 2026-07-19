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
    closeEndpoint?: Error;
    shareBlob?: Error;
    shareCollection?: Error;
    collectionManifest?: Error;
    parseTicket?: Error;
  };
}

/** Builds a fully controllable in-memory implementation of the native bridge. */
export function createMockBinding(): MockBinding {
  let nextHandle = 1;
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
