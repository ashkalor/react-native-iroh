import { MessageQueue } from "../message-queue";
import { captureRejection } from "./helpers";

describe("MessageQueue delivery", () => {
  it("delivers buffered values in FIFO order", async () => {
    const queue = new MessageQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(await queue.next()).toEqual({ value: 1, done: false });
    expect(await queue.next()).toEqual({ value: 2, done: false });
    expect(await queue.next()).toEqual({ value: 3, done: false });
  });

  it("hands a value directly to a parked consumer", async () => {
    const queue = new MessageQueue<string>();
    const pending = queue.next();
    queue.push("hi");
    expect(await pending).toEqual({ value: "hi", done: false });
  });

  it("resolves parked consumers in FIFO order", async () => {
    const queue = new MessageQueue<number>();
    const first = queue.next();
    const second = queue.next();
    queue.push(10);
    queue.push(20);
    expect(await first).toEqual({ value: 10, done: false });
    expect(await second).toEqual({ value: 20, done: false });
  });

  it("works as an async iterable", async () => {
    const queue = new MessageQueue<number>();
    queue.push(1);
    queue.push(2);
    const seen: number[] = [];
    for await (const value of queue) {
      seen.push(value);
      if (seen.length === 2) {
        break;
      }
    }
    expect(seen).toEqual([1, 2]);
  });
});

describe("MessageQueue overflow and lag", () => {
  it("drops the oldest on overflow and surfaces the lag", () => {
    const dropped: number[] = [];
    const queue = new MessageQueue<number>({ capacity: 2, onLagged: (n) => dropped.push(n) });
    queue.push(1);
    queue.push(2);
    queue.push(3); // drops 1
    queue.push(4); // drops 2
    expect(queue.dropped).toBe(2);
    expect(dropped).toEqual([1, 2]);
  });

  it("keeps the live tail after overflow", async () => {
    const queue = new MessageQueue<number>({ capacity: 2 });
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(await queue.next()).toEqual({ value: 2, done: false });
    expect(await queue.next()).toEqual({ value: 3, done: false });
  });

  it("clamps a sub-1 capacity to 1", () => {
    const queue = new MessageQueue<number>({ capacity: 0 });
    queue.push(1);
    queue.push(2);
    expect(queue.dropped).toBe(1);
  });

  it("markLagged advances the signal without discarding a buffered value", async () => {
    const dropped: number[] = [];
    const queue = new MessageQueue<number>({ capacity: 4, onLagged: (n) => dropped.push(n) });
    queue.push(1);
    queue.markLagged();
    expect(queue.dropped).toBe(1);
    expect(dropped).toEqual([1]);
    // The buffered value is still there.
    expect(await queue.next()).toEqual({ value: 1, done: false });
  });

  it("a throwing onLagged does not break the producer", () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      const queue = new MessageQueue<number>({
        capacity: 1,
        onLagged: () => {
          throw new Error("lag handler bug");
        },
      });
      queue.push(1);
      expect(() => queue.push(2)).not.toThrow();
      expect(queue.dropped).toBe(1);
    } finally {
      console.error = original;
    }
  });
});

describe("MessageQueue termination", () => {
  it("a graceful close ends a parked consumer", async () => {
    const queue = new MessageQueue<number>();
    const pending = queue.next();
    queue.close();
    expect((await pending).done).toBe(true);
    expect(queue.isClosed).toBe(true);
  });

  it("an error close rejects once, then ends", async () => {
    const queue = new MessageQueue<number>();
    const boom = new Error("terminal");
    const pending = queue.next();
    queue.close(boom);
    expect(await captureRejection(pending)).toBe(boom);
    expect((await queue.next()).done).toBe(true);
  });

  it("push is a no-op after close", async () => {
    const queue = new MessageQueue<number>();
    queue.close();
    queue.push(1);
    expect((await queue.next()).done).toBe(true);
  });

  it("return() closes the queue", async () => {
    const queue = new MessageQueue<number>();
    const result = await queue.return();
    expect(result.done).toBe(true);
    expect(queue.isClosed).toBe(true);
  });

  it("hands overflow-evicted values to the drop hook", () => {
    const dropped: number[] = [];
    const queue = new MessageQueue<number>({ capacity: 2, onDropped: (v) => dropped.push(v) });
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(dropped).toEqual([1]);
  });

  it("hands values still buffered at close to the drop hook", () => {
    const dropped: number[] = [];
    const queue = new MessageQueue<number>({ onDropped: (v) => dropped.push(v) });
    queue.push(1);
    queue.push(2);
    queue.close();
    expect(dropped).toEqual([1, 2]);
  });

  it("does not drop values that were delivered", async () => {
    const dropped: number[] = [];
    const queue = new MessageQueue<number>({ onDropped: (v) => dropped.push(v) });
    queue.push(1);
    expect((await queue.next()).value).toBe(1);
    queue.close();
    expect(dropped).toEqual([]);
  });

  it("keeps producing when the drop hook throws", () => {
    const original = console.error;
    console.error = () => {};
    try {
      const queue = new MessageQueue<number>({
        capacity: 1,
        onDropped: () => {
          throw new Error("hook exploded");
        },
      });
      queue.push(1);
      expect(() => queue.push(2)).not.toThrow();
    } finally {
      console.error = original;
    }
  });
});
