import type { EndpointConfig } from "../specs/iroh.nitro";
import type { IrohBinding } from "../native";

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
  nodeIdCalls: number[];
  closeCalls: number[];
  downloads: DownloadCall[];
  cancelled: number[];
  shareCalls: { endpoint: number; path: string }[];
  /** Overridable per test to make calls fail. */
  failures: {
    createEndpoint?: Error;
    isEndpointOpen?: Error;
    closeEndpoint?: Error;
    shareBlob?: Error;
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
      nodeId: (endpoint) => {
        mock.nodeIdCalls.push(endpoint);
        return `node-${endpoint}`;
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
    },
    configs: [],
    nodeIdCalls: [],
    closeCalls: [],
    downloads: [],
    cancelled: [],
    shareCalls: [],
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
