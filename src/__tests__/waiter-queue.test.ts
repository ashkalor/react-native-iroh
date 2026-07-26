import { WaiterQueue } from "../waiter-queue";

describe("WaiterQueue", () => {
  it("hands values to the longest-parked consumer first", async () => {
    const queue = new WaiterQueue<string>();
    const first = queue.park();
    const second = queue.park();

    expect(queue.handOff("a")).toBe(true);
    expect(queue.handOff("b")).toBe(true);
    expect(await first).toEqual({ value: "a", done: false });
    expect(await second).toEqual({ value: "b", done: false });
  });

  it("reports when nobody is parked so the owner can buffer", () => {
    const queue = new WaiterQueue<string>();
    expect(queue.handOff("a")).toBe(false);
  });

  // The rule that previously had two independent implementations: whichever
  // consumer observes the terminal error first is the only one that sees it.
  it("delivers a terminal error to exactly one parked consumer", async () => {
    const queue = new WaiterQueue<string>();
    const parked = [queue.park(), queue.park(), queue.park()];
    const boom = new Error("boom");

    queue.settle(boom);

    const settled = await Promise.allSettled(parked);
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
    for (const result of settled.filter((r) => r.status === "fulfilled")) {
      expect(result.value).toEqual({ value: undefined, done: true });
    }
  });

  it("delivers a terminal error exactly once when consumers arrive after settling", async () => {
    const queue = new WaiterQueue<string>();
    queue.settle(new Error("boom"));

    await expect(queue.settledResult()).rejects.toThrow("boom");
    expect(await queue.settledResult()).toEqual({ value: undefined, done: true });
  });

  it("does not re-deliver the error to a late consumer once a parked one took it", async () => {
    const queue = new WaiterQueue<string>();
    const parked = queue.park();
    queue.settle(new Error("boom"));

    await expect(parked).rejects.toThrow("boom");
    expect(await queue.settledResult()).toEqual({ value: undefined, done: true });
  });

  it("ends parked consumers gracefully on a null settle, and is idempotent", async () => {
    const queue = new WaiterQueue<string>();
    const parked = queue.park();

    queue.settle(null);
    queue.settle(new Error("ignored: already settled"));

    expect(await parked).toEqual({ value: undefined, done: true });
    expect(queue.isSettled).toBe(true);
    expect(await queue.settledResult()).toEqual({ value: undefined, done: true });
  });

  it("reports no settled result while live", () => {
    const queue = new WaiterQueue<string>();
    expect(queue.isSettled).toBe(false);
    expect(queue.settledResult()).toBeNull();
  });
});
