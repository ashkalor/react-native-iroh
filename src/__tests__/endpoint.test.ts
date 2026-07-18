import { DEFAULT_MAX_CONCURRENT_DOWNLOADS, Endpoint } from "../endpoint";
import { IrohError } from "../errors";
import { captureRejection, createMockBinding, flush } from "./helpers";

function expectIrohError(value: unknown): IrohError {
  expect(value).toBeInstanceOf(IrohError);
  return value as IrohError;
}

describe("Endpoint.create", () => {
  it("defaults to the standard profile with no blob store dir", async () => {
    const mock = createMockBinding();
    await Endpoint.create({}, mock.binding);
    expect(mock.configs).toEqual([{ profile: "standard" }]);
  });

  it("passes profile and blobStoreDir through", async () => {
    const mock = createMockBinding();
    await Endpoint.create({ profile: "isolated", blobStoreDir: "/data/store" }, mock.binding);
    expect(mock.configs).toEqual([{ profile: "isolated", blobStoreDir: "/data/store" }]);
  });

  it("wraps native bind failures in IrohError", async () => {
    const mock = createMockBinding();
    mock.failures.createEndpoint = new Error("[iroh:2000] bind failed");
    const error = expectIrohError(await captureRejection(Endpoint.create({}, mock.binding)));
    expect(error.code).toBe(2000);
    expect(error.kind).toBe("endpoint-bind");
  });
});

describe("Endpoint identity and lifecycle", () => {
  it("caches nodeId at creation (single native call)", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    expect(endpoint.nodeId).toBe("node-1");
    expect(endpoint.nodeId).toBe("node-1");
    expect(mock.nodeIdCalls).toEqual([1]);
  });

  it("reports isOpen until closed, and nodeId stays readable after close", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    expect(endpoint.isOpen).toBe(true);
    await endpoint.close();
    expect(endpoint.isOpen).toBe(false);
    expect(endpoint.nodeId).toBe("node-1");
  });

  it("close is idempotent: repeated calls share one native close", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const first = endpoint.close();
    const second = endpoint.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await endpoint.close();
    expect(mock.closeCalls).toEqual([1]);
  });

  it("wraps sync isEndpointOpen failures in IrohError", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    mock.failures.isEndpointOpen = new Error("[iroh:1001] stale handle");
    let caught: unknown;
    try {
      void endpoint.isOpen;
    } catch (error) {
      caught = error;
    }
    const wrapped = expectIrohError(caught);
    expect(wrapped.code).toBe(1001);
    expect(wrapped.kind).toBe("invalid-handle");
  });

  it("wraps close failures in IrohError and memoizes them: no second native call", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    mock.failures.closeEndpoint = new Error("[iroh:1001] stale handle");
    const first = endpoint.close();
    const error = expectIrohError(await captureRejection(first));
    expect(error.kind).toBe("invalid-handle");
    // close is one-shot: even after a failure, repeated calls return the
    // same settled promise and never retry natively.
    mock.failures.closeEndpoint = undefined;
    const second = endpoint.close();
    expect(second).toBe(first);
    expectIrohError(await captureRejection(second));
    expect(mock.closeCalls).toEqual([1]);
  });
});

describe("Endpoint.shareBlob", () => {
  it("resolves with the native ticket", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    await expect(endpoint.shareBlob("/tmp/file.bin")).resolves.toBe("ticket-/tmp/file.bin");
    expect(mock.shareCalls).toEqual([{ endpoint: 1, path: "/tmp/file.bin" }]);
  });

  it("rejects with a typed IrohError on native failure", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    mock.failures.shareBlob = new Error("[iroh:3000] import failed");
    const error = expectIrohError(await captureRejection(endpoint.shareBlob("/missing")));
    expect(error.code).toBe(3000);
    expect(error.kind).toBe("blob-import");
  });
});

describe("Endpoint.downloadBlob", () => {
  it("starts the native download with the right arguments and resolves", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.downloadBlob("ticket-a", "/dest/a");
    await flush();
    expect(mock.downloads).toHaveLength(1);
    const call = mock.downloads[0]!;
    expect(call.endpoint).toBe(1);
    expect(call.ticket).toBe("ticket-a");
    expect(call.destPath).toBe("/dest/a");
    expect(transfer.isSettled).toBe(false);
    call.deferred.resolve();
    await transfer.promise;
    expect(transfer.isSettled).toBe(true);
  });

  it("rejects with a typed IrohError on invalid tickets", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.downloadBlob("garbage", "/dest/a");
    await flush();
    mock.downloads[0]!.deferred.reject(new Error("[iroh:1002] not a ticket"));
    const error = expectIrohError(await captureRejection(transfer.promise));
    expect(error.code).toBe(1002);
    expect(error.kind).toBe("invalid-ticket");
  });

  it("delivers progress to listeners and honors unsubscribe", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.downloadBlob("ticket-a", "/dest/a");
    await flush();
    const seen: number[] = [];
    const unsubscribe = transfer.onProgress((event) => {
      seen.push(event.bytesReceived);
    });
    const call = mock.downloads[0]!;
    call.onProgress(10);
    call.onProgress(20);
    unsubscribe();
    call.onProgress(30);
    expect(seen).toEqual([10, 20]);
    call.deferred.resolve();
    await transfer.promise;
  });

  it("ignores progress after settlement and no-ops late subscriptions", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.downloadBlob("ticket-a", "/dest/a");
    await flush();
    const seen: number[] = [];
    transfer.onProgress((event) => {
      seen.push(event.bytesReceived);
    });
    const call = mock.downloads[0]!;
    call.onProgress(10);
    call.deferred.resolve();
    await transfer.promise;
    call.onProgress(99);
    const lateUnsubscribe = transfer.onProgress(() => {
      throw new Error("must never fire");
    });
    lateUnsubscribe();
    expect(seen).toEqual([10]);
  });

  it("cancel on an active transfer forwards the native transfer id", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.downloadBlob("ticket-a", "/dest/a");
    await flush();
    const call = mock.downloads[0]!;
    call.onStart(77);
    transfer.cancel();
    expect(mock.cancelled).toEqual([77]);
    call.deferred.reject(new Error("[iroh:3003] cancelled"));
    const error = expectIrohError(await captureRejection(transfer.promise));
    expect(error.kind).toBe("cancelled");
  });

  it("cancel before onStart defers the native cancel until the id arrives", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.downloadBlob("ticket-a", "/dest/a");
    await flush();
    transfer.cancel();
    expect(mock.cancelled).toEqual([]);
    mock.downloads[0]!.onStart(5);
    expect(mock.cancelled).toEqual([5]);
  });

  it("cancel is idempotent and a no-op after settlement", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.downloadBlob("ticket-a", "/dest/a");
    await flush();
    const call = mock.downloads[0]!;
    call.onStart(7);
    transfer.cancel();
    transfer.cancel();
    call.deferred.reject(new Error("[iroh:3003] cancelled"));
    await captureRejection(transfer.promise);
    transfer.cancel();
    expect(mock.cancelled).toEqual([7, 7]);
  });
});

describe("Endpoint download queue", () => {
  it("caps concurrent native downloads at the default and drains FIFO", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfers = ["a", "b", "c", "d", "e", "f"].map((name) =>
      endpoint.downloadBlob(`ticket-${name}`, `/dest/${name}`),
    );
    await flush();
    expect(mock.downloads).toHaveLength(DEFAULT_MAX_CONCURRENT_DOWNLOADS);
    expect(mock.downloads.map((call) => call.ticket)).toEqual([
      "ticket-a",
      "ticket-b",
      "ticket-c",
      "ticket-d",
    ]);
    mock.downloads[1]!.deferred.resolve();
    await flush();
    expect(mock.downloads).toHaveLength(5);
    expect(mock.downloads[4]!.ticket).toBe("ticket-e");
    mock.downloads[0]!.deferred.resolve();
    await flush();
    expect(mock.downloads).toHaveLength(6);
    expect(mock.downloads[5]!.ticket).toBe("ticket-f");
    for (const call of mock.downloads.slice(2)) {
      call.deferred.resolve();
    }
    await Promise.all(transfers.map((transfer) => transfer.promise));
  });

  it("respects a custom maxConcurrentDownloads", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: 2 }, mock.binding);
    endpoint.downloadBlob("ticket-a", "/dest/a");
    endpoint.downloadBlob("ticket-b", "/dest/b");
    endpoint.downloadBlob("ticket-c", "/dest/c");
    await flush();
    expect(mock.downloads).toHaveLength(2);
  });

  it("clamps maxConcurrentDownloads to at least 1", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: 0 }, mock.binding);
    endpoint.downloadBlob("ticket-a", "/dest/a");
    endpoint.downloadBlob("ticket-b", "/dest/b");
    await flush();
    expect(mock.downloads).toHaveLength(1);
  });

  it("a transfer cancelled while queued never reaches native and frees no slot", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: 1 }, mock.binding);
    endpoint.downloadBlob("ticket-a", "/dest/a");
    const queued = endpoint.downloadBlob("ticket-b", "/dest/b");
    const third = endpoint.downloadBlob("ticket-c", "/dest/c");
    await flush();
    queued.cancel();
    const error = expectIrohError(await captureRejection(queued.promise));
    expect(error.code).toBe(3003);
    expect(error.kind).toBe("cancelled");
    expect(mock.cancelled).toEqual([]);
    mock.downloads[0]!.deferred.resolve();
    await flush();
    expect(mock.downloads).toHaveLength(2);
    expect(mock.downloads[1]!.ticket).toBe("ticket-c");
    mock.downloads[1]!.deferred.resolve();
    await third.promise;
  });

  it("a failed close still cancels queued transfers (the endpoint is unusable)", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: 1 }, mock.binding);
    endpoint.downloadBlob("ticket-a", "/dest/a");
    const queued = endpoint.downloadBlob("ticket-b", "/dest/b");
    await flush();
    mock.failures.closeEndpoint = new Error("[iroh:1000] close failed");
    const first = endpoint.close();
    const error = expectIrohError(await captureRejection(first));
    expect(error.kind).toBe("internal");
    // The native handle is invalidated at the first close call, so a failed
    // close still cancels everything waiting in the queue.
    const cancelled = expectIrohError(await captureRejection(queued.promise));
    expect(cancelled.code).toBe(3003);
    expect(cancelled.kind).toBe("cancelled");
    // Second close() returns the same settled promise; no second native call.
    const second = endpoint.close();
    expect(second).toBe(first);
    await captureRejection(second);
    expect(mock.closeCalls).toEqual([1]);
    expect(mock.downloads).toHaveLength(1);
  });

  it("close cancels queued transfers", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: 1 }, mock.binding);
    const active = endpoint.downloadBlob("ticket-a", "/dest/a");
    const queued = endpoint.downloadBlob("ticket-b", "/dest/b");
    await flush();
    const closing = endpoint.close();
    const error = expectIrohError(await captureRejection(queued.promise));
    expect(error.kind).toBe("cancelled");
    mock.downloads[0]!.deferred.reject(new Error("[iroh:1001] endpoint closed"));
    const activeError = expectIrohError(await captureRejection(active.promise));
    expect(activeError.kind).toBe("invalid-handle");
    await closing;
    expect(mock.downloads).toHaveLength(1);
  });
});
