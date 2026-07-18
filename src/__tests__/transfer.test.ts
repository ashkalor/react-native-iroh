import { IrohError } from "../errors";
import { TransferController } from "../transfer";
import type { ProgressEvent } from "../transfer";
import { captureRejection, deferred, flush } from "./helpers";

interface Harness {
  transfer: TransferController;
  emit: (bytesReceived: number) => void;
  start: (transferId: number) => void;
  resolve: () => void;
  reject: (reason: unknown) => void;
  cancelled: number[];
}

/** Builds a TransferController wired to a controllable fake native download. */
function createTransfer(): Harness {
  const native = deferred<void>();
  let onStart: ((transferId: number) => void) | undefined;
  let onProgress: ((bytesReceived: number) => void) | undefined;
  const cancelled: number[] = [];
  const transfer = new TransferController(
    (start, progress) => {
      onStart = start;
      onProgress = progress;
      return native.promise;
    },
    (transferId) => {
      cancelled.push(transferId);
    },
  );
  void transfer.begin();
  return {
    transfer,
    emit: (bytesReceived) => onProgress?.(bytesReceived),
    start: (transferId) => onStart?.(transferId),
    resolve: native.resolve,
    reject: native.reject,
    cancelled,
  };
}

describe("Transfer.progress async iteration", () => {
  it("delivers each event when the consumer keeps up, then ends on completion", async () => {
    const harness = createTransfer();
    const events: number[] = [];
    const consumer = (async () => {
      for await (const event of harness.transfer.progress) {
        events.push(event.bytesReceived);
      }
    })();
    await flush();
    harness.emit(1);
    await flush();
    harness.emit(2);
    await flush();
    harness.resolve();
    await consumer;
    expect(events).toEqual([1, 2]);
  });

  it("conflates to the latest value when the consumer is slow", async () => {
    const harness = createTransfer();
    const iterator = harness.transfer.progress[Symbol.asyncIterator]();
    harness.emit(1);
    harness.emit(2);
    harness.emit(3);
    const first = await iterator.next();
    expect(first).toEqual({ value: { bytesReceived: 3 }, done: false });
    harness.resolve();
    await flush();
    const second = await iterator.next();
    expect(second.done).toBe(true);
  });

  it("flushes a pending latest value before reporting completion", async () => {
    const harness = createTransfer();
    const iterator = harness.transfer.progress[Symbol.asyncIterator]();
    harness.emit(41);
    harness.emit(42);
    harness.resolve();
    await flush();
    expect(await iterator.next()).toEqual({ value: { bytesReceived: 42 }, done: false });
    expect((await iterator.next()).done).toBe(true);
  });

  it("resolves a waiting next() as soon as an event arrives", async () => {
    const harness = createTransfer();
    const iterator = harness.transfer.progress[Symbol.asyncIterator]();
    const pending = iterator.next();
    harness.emit(7);
    expect(await pending).toEqual({ value: { bytesReceived: 7 }, done: false });
  });

  it("throws the terminal IrohError when the transfer fails", async () => {
    const harness = createTransfer();
    const consumer = (async () => {
      let total = 0;
      for await (const event of harness.transfer.progress) {
        total = event.bytesReceived;
      }
      return total;
    })();
    await flush();
    harness.emit(10);
    await flush();
    harness.reject(new Error("[iroh:3001] connection lost"));
    const error = await captureRejection(consumer);
    expect(error).toBeInstanceOf(IrohError);
    expect((error as IrohError).kind).toBe("blob-download");
  });

  it("breaking out of the loop detaches the iterator", async () => {
    const harness = createTransfer();
    const events: number[] = [];
    const consumer = (async () => {
      for await (const event of harness.transfer.progress) {
        events.push(event.bytesReceived);
        break;
      }
    })();
    await flush();
    harness.emit(1);
    await consumer;
    harness.emit(2);
    harness.emit(3);
    expect(events).toEqual([1]);
    harness.resolve();
    await harness.transfer.promise;
  });

  it("after an explicit return(), next() reports done and events are ignored", async () => {
    const harness = createTransfer();
    const iterator = harness.transfer.progress[Symbol.asyncIterator]();
    harness.emit(1);
    await iterator.next();
    await iterator.return?.(undefined);
    harness.emit(2);
    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it("supports independent concurrent iterators", async () => {
    const harness = createTransfer();
    const first = harness.transfer.progress[Symbol.asyncIterator]();
    const second = harness.transfer.progress[Symbol.asyncIterator]();
    harness.emit(5);
    expect(await first.next()).toEqual({ value: { bytesReceived: 5 }, done: false });
    expect(await second.next()).toEqual({ value: { bytesReceived: 5 }, done: false });
    await first.return?.(undefined);
    harness.emit(6);
    expect(await second.next()).toEqual({ value: { bytesReceived: 6 }, done: false });
  });

  it("an iterator created after success is immediately done", async () => {
    const harness = createTransfer();
    harness.resolve();
    await harness.transfer.promise;
    const iterator = harness.transfer.progress[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(true);
  });

  it("an iterator created after failure rejects once, then is done", async () => {
    const harness = createTransfer();
    harness.reject(new Error("[iroh:3001] connection lost"));
    await captureRejection(harness.transfer.promise);
    const iterator = harness.transfer.progress[Symbol.asyncIterator]();
    const error = await captureRejection(iterator.next());
    expect(error).toBeInstanceOf(IrohError);
    expect((error as IrohError).code).toBe(3001);
    expect((await iterator.next()).done).toBe(true);
  });

  it("resolves waiting next() calls when the transfer completes", async () => {
    const harness = createTransfer();
    const iterator = harness.transfer.progress[Symbol.asyncIterator]();
    const waiting = iterator.next();
    harness.resolve();
    expect((await waiting).done).toBe(true);
  });
});

describe("Transfer listeners alongside iterators", () => {
  it("a throwing listener does not break iterators or other listeners", async () => {
    const harness = createTransfer();
    const seen: number[] = [];
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      harness.transfer.onProgress(() => {
        throw new Error("listener bug");
      });
      harness.transfer.onProgress((event: ProgressEvent) => {
        seen.push(event.bytesReceived);
      });
      const iterator = harness.transfer.progress[Symbol.asyncIterator]();
      harness.emit(11);
      expect(seen).toEqual([11]);
      expect(await iterator.next()).toEqual({ value: { bytesReceived: 11 }, done: false });
    } finally {
      console.error = originalConsoleError;
    }
    harness.resolve();
    await harness.transfer.promise;
  });
});
