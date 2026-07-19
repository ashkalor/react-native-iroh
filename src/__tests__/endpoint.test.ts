import { DEFAULT_MAX_CONCURRENT_DOWNLOADS, Endpoint } from "../endpoint";
import { IrohError } from "../errors";
import { captureRejection, createMockBinding, flush, testTicket } from "./helpers";
import type { AbortSignalLike } from "../endpoint";

// The project's TS lib is "esnext" (no DOM), so the runtime-provided
// AbortController global is typed locally against the structural signal
// interface the download option accepts.
declare const AbortController: new () => {
  readonly signal: AbortSignalLike;
  abort(): void;
};

function expectIrohError(value: unknown): IrohError {
  expect(value).toBeInstanceOf(IrohError);
  return value as IrohError;
}

describe("Endpoint.create", () => {
  it("defaults to the n0 preset with no blob store dir", async () => {
    const mock = createMockBinding();
    await Endpoint.create({}, mock.binding);
    expect(mock.configs).toEqual([{ preset: "n0" }]);
  });

  it("passes preset and blobStoreDir through", async () => {
    const mock = createMockBinding();
    await Endpoint.create({ preset: "minimal", blobStoreDir: "/data/store" }, mock.binding);
    expect(mock.configs).toEqual([{ preset: "minimal", blobStoreDir: "/data/store" }]);
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
  it("caches id at creation (single native call)", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    expect(endpoint.id).toBe("endpoint-1");
    expect(endpoint.id).toBe("endpoint-1");
    expect(mock.endpointIdCalls).toEqual([1]);
  });

  it("reports isOpen until closed, and id stays readable after close", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    expect(endpoint.isOpen).toBe(true);
    await endpoint.close();
    expect(endpoint.isOpen).toBe(false);
    expect(endpoint.id).toBe("endpoint-1");
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

  it("Symbol.asyncDispose closes the endpoint (await using)", async () => {
    const mock = createMockBinding();
    {
      await using endpoint = await Endpoint.create({}, mock.binding);
      expect(endpoint.isOpen).toBe(true);
    }
    expect(mock.closeCalls).toEqual([1]);
  });

  it("Symbol.asyncDispose is an alias of close (same shared promise)", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const disposed = endpoint[Symbol.asyncDispose]();
    expect(endpoint.close()).toBe(disposed);
    await disposed;
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

describe("Endpoint.create relayMode", () => {
  it("passes bare relay-mode keywords through as strings", async () => {
    for (const relayMode of ["default", "disabled", "staging"] as const) {
      const mock = createMockBinding();
      await Endpoint.create({ relayMode }, mock.binding);
      expect(mock.configs).toEqual([{ preset: "n0", relayMode }]);
    }
  });

  it("serializes a custom relay list as a newline-delimited string", async () => {
    const mock = createMockBinding();
    await Endpoint.create(
      { relayMode: { custom: ["https://a.example/", "https://b.example/"] } },
      mock.binding,
    );
    expect(mock.configs).toEqual([
      { preset: "n0", relayMode: "custom\nhttps://a.example/\nhttps://b.example/" },
    ]);
  });

  it("omits relayMode from the config when not provided", async () => {
    const mock = createMockBinding();
    await Endpoint.create({ preset: "minimal" }, mock.binding);
    expect(mock.configs).toEqual([{ preset: "minimal" }]);
  });

  it("rejects an empty custom relay list synchronously with a typed IrohError", async () => {
    const mock = createMockBinding();
    const error = expectIrohError(
      await captureRejection(Endpoint.create({ relayMode: { custom: [] } }, mock.binding)),
    );
    expect(error.code).toBe(2000);
    // Never reached native.
    expect(mock.configs).toHaveLength(0);
  });
});

describe("Endpoint.addr", () => {
  it("parses the native JSON snapshot into a typed EndpointAddr", async () => {
    const mock = createMockBinding();
    mock.addrJson = JSON.stringify({
      id: "endpoint-1",
      relayUrls: ["https://relay.example/"],
      directAddrs: ["127.0.0.1:5000", "[::1]:5000"],
    });
    const endpoint = await Endpoint.create({}, mock.binding);
    expect(endpoint.addr).toEqual({
      id: "endpoint-1",
      relayUrls: ["https://relay.example/"],
      directAddrs: ["127.0.0.1:5000", "[::1]:5000"],
    });
    expect(mock.addrCalls).toEqual([1]);
  });

  it("wraps native failures in a typed IrohError", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    mock.failures.endpointAddr = new Error("[iroh:1001] stale handle");
    let caught: unknown;
    try {
      void endpoint.addr;
    } catch (error) {
      caught = error;
    }
    expect(expectIrohError(caught).kind).toBe("invalid-handle");
  });
});

describe("Endpoint.watchAddr", () => {
  const addrJson = (host: string): string =>
    JSON.stringify({ id: "endpoint-1", relayUrls: [], directAddrs: [host] });

  it("starts the native watch lazily and delivers parsed changes", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    expect(mock.watches).toHaveLength(0);

    const seen: string[] = [];
    endpoint.watchAddr((addr) => {
      seen.push(addr.directAddrs[0] ?? "");
    });
    // First subscriber starts exactly one native watch.
    expect(mock.watches).toHaveLength(1);
    expect(mock.watches[0]!.endpoint).toBe(1);

    mock.watches[0]!.onChange(addrJson("10.0.0.1:1"));
    mock.watches[0]!.onChange(addrJson("10.0.0.2:2"));
    expect(seen).toEqual(["10.0.0.1:1", "10.0.0.2:2"]);
  });

  it("shares one native watch across subscribers and stops it when the last detaches", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const first = endpoint.watchAddr(() => undefined);
    const second = endpoint.watchAddr(() => undefined);
    // Both share a single native subscription.
    expect(mock.watches).toHaveLength(1);

    first();
    expect(mock.stoppedWatches).toEqual([]);
    second();
    // The last unsubscribe stops the native watch.
    expect(mock.stoppedWatches).toEqual([1]);

    // A later subscriber restarts a fresh native watch.
    endpoint.watchAddr(() => undefined);
    expect(mock.watches).toHaveLength(2);
    expect(mock.watches[1]!.watchId).toBe(2);
  });

  it("ignores a malformed change payload without tearing the stream down", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const seen: string[] = [];
    endpoint.watchAddr((addr) => seen.push(addr.directAddrs[0] ?? ""));
    mock.watches[0]!.onChange("not json{");
    mock.watches[0]!.onChange(addrJson("10.0.0.9:9"));
    expect(seen).toEqual(["10.0.0.9:9"]);
  });

  it("unsubscribe is idempotent and does not double-stop the native watch", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const unsubscribe = endpoint.watchAddr(() => undefined);
    unsubscribe();
    unsubscribe();
    expect(mock.stoppedWatches).toEqual([1]);
  });

  it("closing the endpoint stops the native watch", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    endpoint.watchAddr(() => undefined);
    await endpoint.close();
    expect(mock.stoppedWatches).toEqual([1]);
  });

  it("surfaces a watch-start failure by closing the stream with the error", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    mock.failures.watchAddr = new Error("[iroh:1001] stale handle");
    // Listening triggers the (failing) native start; rather than hanging, the
    // stream is closed with the typed error so consumers observe the failure.
    endpoint.watchAddr(() => undefined);
    const iterator = endpoint.addrChanges[Symbol.asyncIterator]();
    const error = expectIrohError(await captureRejection(iterator.next()));
    expect(error.kind).toBe("invalid-handle");
    // Once the terminal error has been observed once, the stream is done.
    expect((await iterator.next()).done).toBe(true);
  });
});

describe("Endpoint.addrChanges", () => {
  const addrJson = (host: string): string =>
    JSON.stringify({ id: "endpoint-1", relayUrls: [], directAddrs: [host] });

  it("conflates changes for a slow consumer and ends on close", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const iterator = endpoint.addrChanges[Symbol.asyncIterator]();
    // Iterating is a subscriber: it starts the native watch.
    expect(mock.watches).toHaveLength(1);

    mock.watches[0]!.onChange(addrJson("1.1.1.1:1"));
    mock.watches[0]!.onChange(addrJson("2.2.2.2:2"));
    const first = await iterator.next();
    expect(first.value?.directAddrs).toEqual(["2.2.2.2:2"]);

    await endpoint.close();
    expect((await iterator.next()).done).toBe(true);
  });
});

describe("Endpoint.online", () => {
  it("resolves when the native online wait resolves and passes the default timeout", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const pending = endpoint.online();
    await flush();
    expect(mock.onlineCalls).toHaveLength(1);
    expect(mock.onlineCalls[0]!.timeoutMs).toBe(10_000);
    mock.onlineCalls[0]!.deferred.resolve();
    await expect(pending).resolves.toBeUndefined();
  });

  it("forwards a custom timeout", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const pending = endpoint.online({ timeoutMs: 250 });
    await flush();
    expect(mock.onlineCalls[0]!.timeoutMs).toBe(250);
    mock.onlineCalls[0]!.deferred.resolve();
    await pending;
  });

  it("wraps a native timeout rejection in a typed IrohError", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const pending = endpoint.online({ timeoutMs: 5 });
    await flush();
    mock.onlineCalls[0]!.deferred.reject(new Error("[iroh:2000] did not come online"));
    const error = expectIrohError(await captureRejection(pending));
    expect(error.code).toBe(2000);
    expect(error.kind).toBe("endpoint-bind");
  });
});

describe("Endpoint.blobs.share", () => {
  it("resolves with the native ticket", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    await expect(endpoint.blobs.share("/tmp/file.bin")).resolves.toBe("ticket-/tmp/file.bin");
    expect(mock.shareCalls).toEqual([{ endpoint: 1, path: "/tmp/file.bin" }]);
  });

  it("rejects with a typed IrohError on native failure", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    mock.failures.shareBlob = new Error("[iroh:3000] import failed");
    const error = expectIrohError(await captureRejection(endpoint.blobs.share("/missing")));
    expect(error.code).toBe(3000);
    expect(error.kind).toBe("blob-import");
  });
});

describe("Endpoint.blobs.download", () => {
  it("starts the native download with the right arguments and resolves", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.blobs.download(testTicket("a"), "/dest/a");
    await flush();
    expect(mock.downloads).toHaveLength(1);
    const call = mock.downloads[0]!;
    expect(call.endpoint).toBe(1);
    expect(call.ticket).toBe(testTicket("a"));
    expect(call.destPath).toBe("/dest/a");
    expect(transfer.isSettled).toBe(false);
    call.deferred.resolve();
    await transfer.done;
    expect(transfer.isSettled).toBe(true);
  });

  it("throws a typed IrohError synchronously on malformed ticket strings", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    let caught: unknown;
    try {
      endpoint.blobs.download("definitely-not-a-ticket", "/dest/a");
    } catch (error) {
      caught = error;
    }
    const error = expectIrohError(caught);
    expect(error.code).toBe(1002);
    expect(error.kind).toBe("invalid-ticket");
    expect(mock.downloads).toHaveLength(0);
  });

  it("rejects with a typed IrohError when the native side refuses the ticket", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.blobs.download(testTicket("wellformedbutbogus"), "/dest/a");
    await flush();
    mock.downloads[0]!.deferred.reject(new Error("[iroh:1002] not a ticket"));
    const error = expectIrohError(await captureRejection(transfer.done));
    expect(error.code).toBe(1002);
    expect(error.kind).toBe("invalid-ticket");
  });

  it("delivers progress to listeners and honors unsubscribe", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.blobs.download(testTicket("a"), "/dest/a");
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
    await transfer.done;
  });

  it("ignores progress after settlement and no-ops late subscriptions", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.blobs.download(testTicket("a"), "/dest/a");
    await flush();
    const seen: number[] = [];
    transfer.onProgress((event) => {
      seen.push(event.bytesReceived);
    });
    const call = mock.downloads[0]!;
    call.onProgress(10);
    call.deferred.resolve();
    await transfer.done;
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
    const transfer = endpoint.blobs.download(testTicket("a"), "/dest/a");
    await flush();
    const call = mock.downloads[0]!;
    call.onStart(77);
    transfer.cancel();
    expect(mock.cancelled).toEqual([77]);
    call.deferred.reject(new Error("[iroh:3003] cancelled"));
    const error = expectIrohError(await captureRejection(transfer.done));
    expect(error.kind).toBe("cancelled");
  });

  it("cancel before onStart defers the native cancel until the id arrives", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.blobs.download(testTicket("a"), "/dest/a");
    await flush();
    transfer.cancel();
    expect(mock.cancelled).toEqual([]);
    mock.downloads[0]!.onStart(5);
    expect(mock.cancelled).toEqual([5]);
  });

  it("cancel is idempotent and a no-op after settlement", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.blobs.download(testTicket("a"), "/dest/a");
    await flush();
    const call = mock.downloads[0]!;
    call.onStart(7);
    transfer.cancel();
    transfer.cancel();
    call.deferred.reject(new Error("[iroh:3003] cancelled"));
    await captureRejection(transfer.done);
    transfer.cancel();
    expect(mock.cancelled).toEqual([7, 7]);
  });
});

describe("Endpoint.blobs.download with an AbortSignal", () => {
  it("aborting the signal cancels the active transfer", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const controller = new AbortController();
    const transfer = endpoint.blobs.download(testTicket("a"), "/dest/a", {
      signal: controller.signal,
    });
    await flush();
    mock.downloads[0]!.onStart(11);
    controller.abort();
    expect(mock.cancelled).toEqual([11]);
    mock.downloads[0]!.deferred.reject(new Error("[iroh:3003] cancelled"));
    const error = expectIrohError(await captureRejection(transfer.done));
    expect(error.kind).toBe("cancelled");
  });

  it("an already-aborted signal cancels before the download reaches native", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const controller = new AbortController();
    controller.abort();
    const transfer = endpoint.blobs.download(testTicket("a"), "/dest/a", {
      signal: controller.signal,
    });
    const error = expectIrohError(await captureRejection(transfer.done));
    expect(error.code).toBe(3003);
    expect(error.kind).toBe("cancelled");
    await flush();
    expect(mock.downloads).toHaveLength(0);
  });

  it("aborting after settle is a no-op", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const controller = new AbortController();
    const transfer = endpoint.blobs.download(testTicket("a"), "/dest/a", {
      signal: controller.signal,
    });
    await flush();
    mock.downloads[0]!.onStart(3);
    mock.downloads[0]!.deferred.resolve();
    await transfer.done;
    await flush();
    controller.abort();
    expect(mock.cancelled).toEqual([]);
    expect(transfer.isSettled).toBe(true);
  });
});

describe("Endpoint download queue", () => {
  it("caps concurrent native downloads at the default and drains FIFO", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    // One more than the default so the queue is exercised regardless of the
    // default's exact value.
    const names = Array.from({ length: DEFAULT_MAX_CONCURRENT_DOWNLOADS + 1 }, (_, i) => `t${i}`);
    const transfers = names.map((name) =>
      endpoint.blobs.download(testTicket(name), `/dest/${name}`),
    );
    await flush();
    // Only the default number run natively; the extra one waits in the queue.
    expect(mock.downloads).toHaveLength(DEFAULT_MAX_CONCURRENT_DOWNLOADS);
    expect(mock.downloads.map((call) => call.ticket)).toEqual(
      names.slice(0, DEFAULT_MAX_CONCURRENT_DOWNLOADS).map((name) => testTicket(name)),
    );
    // Completing one frees exactly one slot, pulled from the FIFO queue.
    mock.downloads[0]!.deferred.resolve();
    await flush();
    expect(mock.downloads).toHaveLength(DEFAULT_MAX_CONCURRENT_DOWNLOADS + 1);
    expect(mock.downloads[DEFAULT_MAX_CONCURRENT_DOWNLOADS]!.ticket).toBe(
      testTicket(names[DEFAULT_MAX_CONCURRENT_DOWNLOADS]!),
    );
    // Drain the rest in order.
    for (let i = 1; i < names.length; i += 1) {
      mock.downloads[i]!.deferred.resolve();
      await flush();
    }
    await Promise.all(transfers.map((transfer) => transfer.done));
  });

  it("respects a custom maxConcurrentDownloads", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: 2 }, mock.binding);
    endpoint.blobs.download(testTicket("a"), "/dest/a");
    endpoint.blobs.download(testTicket("b"), "/dest/b");
    endpoint.blobs.download(testTicket("c"), "/dest/c");
    await flush();
    expect(mock.downloads).toHaveLength(2);
  });

  it("clamps maxConcurrentDownloads to at least 1", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: 0 }, mock.binding);
    endpoint.blobs.download(testTicket("a"), "/dest/a");
    endpoint.blobs.download(testTicket("b"), "/dest/b");
    await flush();
    expect(mock.downloads).toHaveLength(1);
  });

  it("falls back to the default cap for a NaN maxConcurrentDownloads", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: Number.NaN }, mock.binding);
    const names = Array.from({ length: DEFAULT_MAX_CONCURRENT_DOWNLOADS + 2 }, (_, i) => `t${i}`);
    const transfers = names.map((name) =>
      endpoint.blobs.download(testTicket(name), `/dest/${name}`),
    );
    await flush();
    // A NaN cap must neither deadlock the queue nor lift it: downloads run,
    // capped at the finite default rather than left permanently pending.
    expect(mock.downloads).toHaveLength(DEFAULT_MAX_CONCURRENT_DOWNLOADS);
    for (let i = 0; i < names.length; i += 1) {
      mock.downloads[i]!.deferred.resolve();
      await flush();
    }
    await Promise.all(transfers.map((transfer) => transfer.done));
  });

  it("treats an Infinity maxConcurrentDownloads as unlimited (no gate)", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create(
      { maxConcurrentDownloads: Number.POSITIVE_INFINITY },
      mock.binding,
    );
    // More than the default: with the native blocking cap gone, Infinity opts
    // out of the throttle entirely, so every download runs at once.
    const names = Array.from({ length: DEFAULT_MAX_CONCURRENT_DOWNLOADS + 5 }, (_, i) => `t${i}`);
    const transfers = names.map((name) =>
      endpoint.blobs.download(testTicket(name), `/dest/${name}`),
    );
    await flush();
    expect(mock.downloads).toHaveLength(names.length);
    for (const call of mock.downloads) {
      call.deferred.resolve();
    }
    await Promise.all(transfers.map((transfer) => transfer.done));
  });

  it("a transfer cancelled while queued never reaches native and frees no slot", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: 1 }, mock.binding);
    endpoint.blobs.download(testTicket("a"), "/dest/a");
    const queued = endpoint.blobs.download(testTicket("b"), "/dest/b");
    const third = endpoint.blobs.download(testTicket("c"), "/dest/c");
    await flush();
    queued.cancel();
    const error = expectIrohError(await captureRejection(queued.done));
    expect(error.code).toBe(3003);
    expect(error.kind).toBe("cancelled");
    expect(mock.cancelled).toEqual([]);
    mock.downloads[0]!.deferred.resolve();
    await flush();
    expect(mock.downloads).toHaveLength(2);
    expect(mock.downloads[1]!.ticket).toBe(testTicket("c"));
    mock.downloads[1]!.deferred.resolve();
    await third.done;
  });

  it("a failed close still cancels queued transfers (the endpoint is unusable)", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: 1 }, mock.binding);
    endpoint.blobs.download(testTicket("a"), "/dest/a");
    const queued = endpoint.blobs.download(testTicket("b"), "/dest/b");
    await flush();
    mock.failures.closeEndpoint = new Error("[iroh:1000] close failed");
    const first = endpoint.close();
    const error = expectIrohError(await captureRejection(first));
    expect(error.kind).toBe("internal");
    // The native handle is invalidated at the first close call, so a failed
    // close still cancels everything waiting in the queue.
    const cancelled = expectIrohError(await captureRejection(queued.done));
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
    const active = endpoint.blobs.download(testTicket("a"), "/dest/a");
    const queued = endpoint.blobs.download(testTicket("b"), "/dest/b");
    await flush();
    const closing = endpoint.close();
    const error = expectIrohError(await captureRejection(queued.done));
    expect(error.kind).toBe("cancelled");
    mock.downloads[0]!.deferred.reject(new Error("[iroh:1001] endpoint closed"));
    const activeError = expectIrohError(await captureRejection(active.done));
    expect(activeError.kind).toBe("invalid-handle");
    await closing;
    expect(mock.downloads).toHaveLength(1);
  });
});

describe("Endpoint.blobs.shareCollection", () => {
  it("joins paths with newlines and resolves with the native ticket", async () => {
    const mock = createMockBinding();
    mock.collectionTicket = testTicket("coll");
    const endpoint = await Endpoint.create({}, mock.binding);
    await expect(endpoint.blobs.shareCollection(["/a.bin", "/b.bin"])).resolves.toBe(
      testTicket("coll"),
    );
    expect(mock.shareCollectionCalls).toEqual([{ endpoint: 1, pathsJoined: "/a.bin\n/b.bin" }]);
  });

  it("rejects with a typed IrohError on native failure", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    mock.failures.shareCollection = new Error("[iroh:3000] import failed");
    const error = expectIrohError(await captureRejection(endpoint.blobs.shareCollection(["/a"])));
    expect(error.code).toBe(3000);
    expect(error.kind).toBe("blob-import");
  });
});

describe("Endpoint.blobs.downloadCollection", () => {
  function setManifest(mock: ReturnType<typeof createMockBinding>): void {
    mock.manifestJson = JSON.stringify([
      { name: "a.bin", ticket: testTicket("childa") },
      { name: "b.bin", ticket: testTicket("childb") },
    ]);
  }

  it("downloads each child to destDir/name and aggregates progress and files", async () => {
    const mock = createMockBinding();
    setManifest(mock);
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.blobs.downloadCollection(testTicket("coll"), "/dest/");
    await flush();
    expect(mock.manifestCalls).toEqual([{ endpoint: 1, ticket: testTicket("coll") }]);
    // A trailing slash on destDir is normalized away before joining names.
    expect(mock.downloads.map((call) => call.destPath)).toEqual(["/dest/a.bin", "/dest/b.bin"]);

    const aggregate: number[] = [];
    transfer.onProgress((event) => aggregate.push(event.bytesReceived));
    mock.downloads[0]!.onProgress(10);
    mock.downloads[1]!.onProgress(5);
    expect(transfer.files).toEqual([
      { name: "a.bin", bytesReceived: 10, done: false },
      { name: "b.bin", bytesReceived: 5, done: false },
    ]);
    expect(aggregate[aggregate.length - 1]).toBe(15);

    mock.downloads[0]!.deferred.resolve();
    mock.downloads[1]!.deferred.resolve();
    await transfer.done;
    expect(transfer.isSettled).toBe(true);
    expect(transfer.files.every((file) => file.done)).toBe(true);
  });

  it("completes immediately for an empty collection", async () => {
    const mock = createMockBinding();
    mock.manifestJson = "[]";
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.blobs.downloadCollection(testTicket("coll"), "/dest");
    await transfer.done;
    expect(transfer.isSettled).toBe(true);
    expect(transfer.files).toEqual([]);
    expect(mock.downloads).toHaveLength(0);
  });

  it("fans children out through the shared download queue (honors the cap)", async () => {
    const mock = createMockBinding();
    mock.manifestJson = JSON.stringify([
      { name: "a", ticket: testTicket("ca") },
      { name: "b", ticket: testTicket("cb") },
      { name: "c", ticket: testTicket("cc") },
    ]);
    const endpoint = await Endpoint.create({ maxConcurrentDownloads: 2 }, mock.binding);
    endpoint.blobs.downloadCollection(testTicket("coll"), "/dest");
    await flush();
    expect(mock.downloads).toHaveLength(2);
  });

  it("fails the whole collection and cancels remaining children on a child error", async () => {
    const mock = createMockBinding();
    setManifest(mock);
    const endpoint = await Endpoint.create(
      { maxConcurrentDownloads: Number.POSITIVE_INFINITY },
      mock.binding,
    );
    const transfer = endpoint.blobs.downloadCollection(testTicket("coll"), "/dest");
    await flush();
    mock.downloads[0]!.onStart(1);
    mock.downloads[1]!.onStart(2);
    mock.downloads[0]!.deferred.reject(new Error("[iroh:3001] boom"));
    const error = expectIrohError(await captureRejection(transfer.done));
    expect(error.code).toBe(3001);
    // The still-running sibling is cancelled natively.
    expect(mock.cancelled).toContain(2);
  });

  it("cancel before the manifest resolves settles as cancelled and starts no children", async () => {
    const mock = createMockBinding();
    setManifest(mock);
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.blobs.downloadCollection(testTicket("coll"), "/dest");
    // Cancel synchronously, before the (async) manifest fetch resolves.
    transfer.cancel();
    const error = expectIrohError(await captureRejection(transfer.done));
    expect(error.code).toBe(3003);
    expect(error.kind).toBe("cancelled");
    await flush();
    expect(mock.downloads).toHaveLength(0);
  });

  it("throws synchronously on a malformed collection ticket", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    let caught: unknown;
    try {
      endpoint.blobs.downloadCollection("definitely-not-a-ticket", "/dest");
    } catch (error) {
      caught = error;
    }
    const error = expectIrohError(caught);
    expect(error.code).toBe(1002);
    expect(mock.manifestCalls).toHaveLength(0);
  });

  it("rejects with a typed IrohError when the manifest fetch fails", async () => {
    const mock = createMockBinding();
    mock.failures.collectionManifest = new Error("[iroh:3001] connect failed");
    const endpoint = await Endpoint.create({}, mock.binding);
    const transfer = endpoint.blobs.downloadCollection(testTicket("coll"), "/dest");
    const error = expectIrohError(await captureRejection(transfer.done));
    expect(error.code).toBe(3001);
    expect(mock.downloads).toHaveLength(0);
  });

  it("an already-aborted signal cancels the collection before any child starts", async () => {
    const mock = createMockBinding();
    setManifest(mock);
    const endpoint = await Endpoint.create({}, mock.binding);
    const controller = new AbortController();
    controller.abort();
    const transfer = endpoint.blobs.downloadCollection(testTicket("coll"), "/dest", {
      signal: controller.signal,
    });
    const error = expectIrohError(await captureRejection(transfer.done));
    expect(error.code).toBe(3003);
    await flush();
    expect(mock.downloads).toHaveLength(0);
  });
});
