import { Watchable } from "../watchable";
import { captureRejection } from "./helpers";

describe("Watchable subscriber lifecycle", () => {
  it("fires onActive once on the first subscriber and onIdle once on the last", () => {
    const events: string[] = [];
    const watchable = new Watchable<number>({
      onActive: () => events.push("active"),
      onIdle: () => events.push("idle"),
    });
    const first = watchable.listen(() => undefined);
    const second = watchable.listen(() => undefined);
    // Only the 0 -> 1 transition is active.
    expect(events).toEqual(["active"]);
    first();
    expect(events).toEqual(["active"]);
    second();
    // Only the 1 -> 0 transition is idle.
    expect(events).toEqual(["active", "idle"]);
    // A later subscriber re-activates.
    watchable.listen(() => undefined);
    expect(events).toEqual(["active", "idle", "active"]);
  });

  it("counts iterators as subscribers and releases them on detach", async () => {
    const events: string[] = [];
    const watchable = new Watchable<number>({
      onActive: () => events.push("active"),
      onIdle: () => events.push("idle"),
    });
    const iterator = watchable.stream[Symbol.asyncIterator]();
    expect(events).toEqual(["active"]);
    await iterator.return?.(undefined);
    expect(events).toEqual(["active", "idle"]);
  });

  it("idempotent unsubscribe releases the subscriber exactly once", () => {
    let idle = 0;
    const watchable = new Watchable<number>({ onIdle: () => (idle += 1) });
    const a = watchable.listen(() => undefined);
    const b = watchable.listen(() => undefined);
    a();
    a();
    expect(idle).toBe(0);
    b();
    expect(idle).toBe(1);
  });
});

describe("Watchable delivery and termination", () => {
  it("delivers values to listeners and conflates for slow iterators", async () => {
    const watchable = new Watchable<number>();
    const seen: number[] = [];
    watchable.listen((value) => seen.push(value));
    const iterator = watchable.stream[Symbol.asyncIterator]();
    watchable.push(1);
    watchable.push(2);
    watchable.push(3);
    expect(seen).toEqual([1, 2, 3]);
    // The slow iterator only sees the latest conflated value.
    expect(await iterator.next()).toEqual({ value: 3, done: false });
  });

  it("a graceful close ends iterators", async () => {
    const watchable = new Watchable<number>();
    const iterator = watchable.stream[Symbol.asyncIterator]();
    const waiting = iterator.next();
    watchable.close();
    expect((await waiting).done).toBe(true);
    expect(watchable.isClosed).toBe(true);
  });

  it("an error close rethrows once, then ends", async () => {
    const watchable = new Watchable<number>();
    const iterator = watchable.stream[Symbol.asyncIterator]();
    const boom = new Error("terminal");
    watchable.close(boom);
    expect(await captureRejection(iterator.next())).toBe(boom);
    expect((await iterator.next()).done).toBe(true);
  });

  it("push and listen are no-ops after close", async () => {
    const watchable = new Watchable<number>();
    const seen: number[] = [];
    watchable.close();
    const unsubscribe = watchable.listen((value) => seen.push(value));
    watchable.push(1);
    unsubscribe();
    expect(seen).toEqual([]);
    // Iterators created after close are immediately done.
    const iterator = watchable.stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(true);
  });

  it("a throwing listener does not break other consumers", async () => {
    const watchable = new Watchable<number>();
    const seen: number[] = [];
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      watchable.listen(() => {
        throw new Error("listener bug");
      });
      watchable.listen((value) => seen.push(value));
      const iterator = watchable.stream[Symbol.asyncIterator]();
      watchable.push(7);
      expect(seen).toEqual([7]);
      expect(await iterator.next()).toEqual({ value: 7, done: false });
    } finally {
      console.error = originalConsoleError;
    }
  });
});
