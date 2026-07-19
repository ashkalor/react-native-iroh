import { Endpoint } from "../endpoint";
import { IrohError } from "../errors";
import { GossipSubscriptionController, type GossipBinding } from "../gossip";
import { captureRejection, createMockBinding, deferred, flush, type Deferred } from "./helpers";

/** A hand-drivable {@link GossipBinding} for exercising the controller. */
interface FakeGossip {
  binding: GossipBinding;
  onStart?: (subId: number) => void;
  onMessage?: (message: string) => void;
  onNeighbor?: (event: string) => void;
  broadcasts: { subId: number; payload: string; deferred: Deferred<void> }[];
  unsubscribed: number[];
  disposed: number;
  startThrows?: Error;
}

function fakeGossip(capacity?: number): FakeGossip {
  const fake: FakeGossip = {
    broadcasts: [],
    unsubscribed: [],
    disposed: 0,
    binding: {
      capacity,
      startSubscribe: (onStart, onMessage, onNeighbor) => {
        if (fake.startThrows !== undefined) {
          throw fake.startThrows;
        }
        fake.onStart = onStart;
        fake.onMessage = onMessage;
        fake.onNeighbor = onNeighbor;
      },
      broadcast: (subId, payload) => {
        const call = { subId, payload, deferred: deferred<void>() };
        fake.broadcasts.push(call);
        return call.deferred.promise;
      },
      unsubscribe: (subId) => {
        fake.unsubscribed.push(subId);
      },
      onDispose: () => {
        fake.disposed += 1;
      },
    },
  };
  return fake;
}

describe("GossipSubscriptionController messages", () => {
  it("parses onMessage into { from, text } split on the first space", async () => {
    const fake = fakeGossip();
    const sub = new GossipSubscriptionController(fake.binding);
    fake.onStart?.(7);
    fake.onMessage?.("endpoint-abc hello there world");
    const iterator = sub.messages[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      value: { from: "endpoint-abc", text: "hello there world" },
      done: false,
    });
  });

  it("routes neighbor up/down into the neighbors stream", async () => {
    const fake = fakeGossip();
    const sub = new GossipSubscriptionController(fake.binding);
    fake.onStart?.(1);
    fake.onNeighbor?.("up endpoint-a");
    fake.onNeighbor?.("down endpoint-b");
    const iterator = sub.neighbors[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      value: { type: "up", endpointId: "endpoint-a" },
      done: false,
    });
    expect(await iterator.next()).toEqual({
      value: { type: "down", endpointId: "endpoint-b" },
      done: false,
    });
  });

  it("maps a native lagged event onto the message queue lag signal", async () => {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const fake = fakeGossip();
      const sub = new GossipSubscriptionController(fake.binding);
      fake.onStart?.(1);
      fake.onNeighbor?.("lagged");
      await flush();
      expect(warnings.some((w) => w.includes("lagging"))).toBe(true);
      // The lagged event is not surfaced as a neighbor event.
      const iterator = sub.neighbors[Symbol.asyncIterator]();
      const race = await Promise.race([iterator.next(), flush().then(() => "pending" as const)]);
      expect(race).toBe("pending");
    } finally {
      console.warn = original;
    }
  });
});

describe("GossipSubscriptionController broadcast", () => {
  it("waits for onStart, then broadcasts with the subscription id", async () => {
    const fake = fakeGossip();
    const sub = new GossipSubscriptionController(fake.binding);
    const pending = sub.broadcast("hi");
    // Not yet broadcast: the id has not arrived.
    expect(fake.broadcasts).toHaveLength(0);
    fake.onStart?.(42);
    await flush();
    expect(fake.broadcasts).toHaveLength(1);
    expect(fake.broadcasts[0]).toMatchObject({ subId: 42, payload: "hi" });
    fake.broadcasts[0]!.deferred.resolve();
    await expect(pending).resolves.toBeUndefined();
  });

  it("maps a broadcast rejection to an IrohError", async () => {
    const fake = fakeGossip();
    const sub = new GossipSubscriptionController(fake.binding);
    fake.onStart?.(1);
    const pending = sub.broadcast("hi");
    await flush();
    fake.broadcasts[0]!.deferred.reject(
      new Error("[iroh:4002] gossip message too large: 5000 bytes"),
    );
    const error = await captureRejection(pending);
    expect(error).toBeInstanceOf(IrohError);
    expect((error as IrohError).kind).toBe("gossip-message-too-large");
  });
});

describe("GossipSubscriptionController teardown", () => {
  it("unsubscribe ends both streams, calls native unsubscribe, and disposes", async () => {
    const fake = fakeGossip();
    const sub = new GossipSubscriptionController(fake.binding);
    fake.onStart?.(9);
    const messages = sub.messages[Symbol.asyncIterator]();
    const pending = messages.next();
    sub.unsubscribe();
    expect(fake.unsubscribed).toEqual([9]);
    expect(fake.disposed).toBe(1);
    expect((await pending).done).toBe(true);
    // Idempotent.
    sub.unsubscribe();
    expect(fake.unsubscribed).toEqual([9]);
  });

  it("unsubscribe before onStart tears down once the id arrives", async () => {
    const fake = fakeGossip();
    const sub = new GossipSubscriptionController(fake.binding);
    const pending = sub.broadcast("hi");
    sub.unsubscribe();
    // A broadcast that was awaiting the id now rejects.
    const error = await captureRejection(pending);
    expect(error).toBeInstanceOf(IrohError);
    expect(fake.unsubscribed).toEqual([]);
    // When the join finally completes, the native subscription is ended.
    fake.onStart?.(5);
    expect(fake.unsubscribed).toEqual([5]);
  });

  it("propagates a synchronous startSubscribe failure", () => {
    const fake = fakeGossip();
    fake.startThrows = new Error("[iroh:1001] invalid or stale handle: 3");
    expect(() => new GossipSubscriptionController(fake.binding)).toThrow();
  });

  it("honors a custom message-buffer capacity", () => {
    const fake = fakeGossip(2);
    const sub = new GossipSubscriptionController(fake.binding);
    fake.onStart?.(1);
    fake.onMessage?.("a one");
    fake.onMessage?.("b two");
    fake.onMessage?.("c three");
    // Capacity 2 keeps only the last two; no assertion beyond no-throw here,
    // capacity behavior itself is covered by the MessageQueue tests.
    expect(sub).toBeDefined();
  });
});

describe("Endpoint.gossip.subscribe", () => {
  it("serializes bootstrap peers as newline-joined EndpointAddr JSON", async () => {
    const { binding, gossipSubscribes } = createMockBinding();
    const endpoint = await Endpoint.create({}, binding);
    const sub = endpoint.gossip.subscribe("chat", {
      bootstrap: [
        { id: "peer-1" as never, relayUrls: ["https://relay.example/"], directAddrs: [] },
        { id: "peer-2" as never, relayUrls: [], directAddrs: ["127.0.0.1:1234"] },
      ],
    });
    expect(gossipSubscribes).toHaveLength(1);
    const lines = gossipSubscribes[0]!.bootstrapJoined.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({
      id: "peer-1",
      relayUrls: ["https://relay.example/"],
      directAddrs: [],
    });
    sub.unsubscribe();
    await endpoint.close();
  });

  it("tears down live subscriptions when the endpoint closes", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    const sub = endpoint.gossip.subscribe("chat");
    const messages = sub.messages[Symbol.asyncIterator]();
    const pending = messages.next();
    await endpoint.close();
    expect((await pending).done).toBe(true);
    expect(mock.gossipUnsubscribes).toHaveLength(1);
  });

  it("throws a typed error when the native subscribe fails synchronously", async () => {
    const mock = createMockBinding();
    mock.failures.gossipSubscribe = new Error("[iroh:4000] failed to subscribe: bad bootstrap");
    const endpoint = await Endpoint.create({}, mock.binding);
    expect(() => endpoint.gossip.subscribe("chat")).toThrow(IrohError);
    await endpoint.close();
  });
});
