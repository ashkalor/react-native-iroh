import { Endpoint } from "../endpoint";
import { IrohError } from "../errors";
import type { StreamFraming } from "../specs/iroh.nitro";
import {
  ConnectionController,
  StreamController,
  StreamListenerController,
  type Connection,
  type Stream,
  type StreamsBinding,
} from "../streams";
import { captureRejection, createMockBinding, deferred, flush, type Deferred } from "./helpers";

/** A hand-drivable {@link StreamsBinding} for exercising the controllers. */
interface FakeStreams {
  binding: StreamsBinding;
  listen?: { alpn: string; onConnection: (line: string) => void; onClose: (e: string) => void };
  connections: Map<
    number,
    { framing: StreamFraming; onStream: (streamId: number) => void; onClose: (e: string) => void }
  >;
  streams: Map<number, { onData: (chunk: ArrayBuffer) => void; onClose: (e: string) => void }>;
  opens: Deferred<number>[];
  sends: { streamId: number; data: ArrayBuffer; deferred: Deferred<void> }[];
  stoppedListeners: number[];
  closedConnections: number[];
  closedStreams: number[];
  listenThrows?: Error;
}

function fakeStreams(): FakeStreams {
  const fake: FakeStreams = {
    connections: new Map(),
    streams: new Map(),
    opens: [],
    sends: [],
    stoppedListeners: [],
    closedConnections: [],
    closedStreams: [],
    binding: {
      listen: (alpn, onConnection, onClose) => {
        if (fake.listenThrows !== undefined) {
          throw fake.listenThrows;
        }
        fake.listen = { alpn, onConnection, onClose };
        return 42;
      },
      stopListen: (listenerId) => {
        fake.stoppedListeners.push(listenerId);
      },
      connect: () => Promise.resolve(1),
      subscribeConnection: (connectionId, framing, onStream, onClose) => {
        fake.connections.set(connectionId, { framing, onStream, onClose });
      },
      openStream: () => {
        const pending = deferred<number>();
        fake.opens.push(pending);
        return pending.promise;
      },
      closeConnection: (connectionId) => {
        fake.closedConnections.push(connectionId);
      },
      subscribeStream: (streamId, onData, onClose) => {
        fake.streams.set(streamId, { onData, onClose });
      },
      send: (streamId, data) => {
        const pending = deferred<void>();
        fake.sends.push({ streamId, data, deferred: pending });
        return pending.promise;
      },
      closeStream: (streamId) => {
        fake.closedStreams.push(streamId);
      },
    },
  };
  return fake;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("StreamController data", () => {
  it("delivers native chunks as Uint8Arrays in arrival order", async () => {
    const fake = fakeStreams();
    const stream = new StreamController(fake.binding, 7);
    fake.streams.get(7)?.onData(bytes(1, 2, 3).buffer as ArrayBuffer);
    fake.streams.get(7)?.onData(bytes(4).buffer as ArrayBuffer);

    const iterator = stream.data[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(bytes(1, 2, 3));
    expect((await iterator.next()).value).toEqual(bytes(4));
  });

  it("ends the data stream and resolves closed on an orderly finish", async () => {
    const fake = fakeStreams();
    const stream = new StreamController(fake.binding, 7);
    fake.streams.get(7)?.onClose("end");

    await stream.closed;
    expect(stream.isClosed).toBe(true);
    const iterator = stream.data[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("surfaces a native failure as a typed error on both closed and data", async () => {
    const fake = fakeStreams();
    const stream = new StreamController(fake.binding, 7);
    fake.streams.get(7)?.onClose("error [iroh:5004] stream closed: reset by peer");

    const error = (await captureRejection(stream.closed)) as IrohError;
    expect(error).toBeInstanceOf(IrohError);
    expect(error.kind).toBe("stream-closed");
    const iterator = stream.data[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/reset by peer/);
  });

  it("fails the stream when the consumer falls behind, rather than dropping bytes", async () => {
    const fake = fakeStreams();
    const stream = new StreamController(fake.binding, 7, { capacity: 1 });
    fake.streams.get(7)?.onData(bytes(1).buffer as ArrayBuffer);
    fake.streams.get(7)?.onData(bytes(2).buffer as ArrayBuffer);

    const error = (await captureRejection(stream.closed)) as IrohError;
    expect(error.kind).toBe("stream-overflow");
    expect(fake.closedStreams).toEqual([7]);
  });
});

describe("StreamController send and close", () => {
  it("passes a whole-buffer view through without copying it", async () => {
    const fake = fakeStreams();
    const stream = new StreamController(fake.binding, 7);
    const payload = bytes(9, 8, 7);
    void stream.send(payload);
    expect(fake.sends[0]?.data).toBe(payload.buffer as ArrayBuffer);
  });

  it("copies a partial view so only its own bytes are sent", async () => {
    const fake = fakeStreams();
    const stream = new StreamController(fake.binding, 7);
    const view = bytes(1, 2, 3, 4).subarray(1, 3);
    void stream.send(view);
    expect(new Uint8Array(fake.sends[0]?.data as ArrayBuffer)).toEqual(bytes(2, 3));
  });

  it("rejects a send once the stream has closed", async () => {
    const fake = fakeStreams();
    const stream = new StreamController(fake.binding, 7);
    stream.close();
    const error = (await captureRejection(stream.send(bytes(1)))) as IrohError;
    expect(error.kind).toBe("stream-closed");
  });

  it("maps a native send failure onto a typed error", async () => {
    const fake = fakeStreams();
    const stream = new StreamController(fake.binding, 7);
    const sending = stream.send(bytes(1));
    fake.sends[0]?.deferred.reject(new Error("[iroh:5003] failed to send on stream: broken"));
    const error = (await captureRejection(sending)) as IrohError;
    expect(error.kind).toBe("stream-send");
  });

  it("releases the native stream exactly once however often close is called", () => {
    const fake = fakeStreams();
    const stream = new StreamController(fake.binding, 7);
    stream.close();
    stream.close();
    expect(fake.closedStreams).toEqual([7]);
  });
});

describe("ConnectionController", () => {
  function connection(fake: FakeStreams, framing: StreamFraming = "framed"): ConnectionController {
    return new ConnectionController(fake.binding, 3, {
      remoteId: "peer-1" as never,
      alpn: "app/1",
      framing,
    });
  }

  it("fixes the framing natively and exposes it", () => {
    const fake = fakeStreams();
    const conn = connection(fake, "raw");
    expect(conn.framing).toBe("raw");
    expect(fake.connections.get(3)?.framing).toBe("raw");
  });

  it("delivers a peer-opened stream on incoming, already reading", async () => {
    const fake = fakeStreams();
    const conn = connection(fake);
    fake.connections.get(3)?.onStream(11);

    const iterator = conn.incoming[Symbol.asyncIterator]();
    const stream = (await iterator.next()).value as Stream;
    // Subscribed at creation, so bytes that arrive before the host consumes the
    // stream are buffered rather than lost.
    expect(fake.streams.has(11)).toBe(true);
    fake.streams.get(11)?.onData(bytes(5).buffer as ArrayBuffer);
    const data = stream.data[Symbol.asyncIterator]();
    expect((await data.next()).value).toEqual(bytes(5));
  });

  it("keeps a locally opened stream off the incoming queue", async () => {
    const fake = fakeStreams();
    const conn = connection(fake);
    const opening = conn.openStream();
    fake.opens[0]?.resolve(12);
    const stream = await opening;

    expect(fake.streams.has(12)).toBe(true);
    conn.close();
    // Only the connection's own close ends the incoming iteration; the opened
    // stream was never offered on it.
    const iterator = conn.incoming[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(stream.isClosed).toBe(true);
  });

  it("closes its streams and the native connection on close", async () => {
    const fake = fakeStreams();
    const conn = connection(fake);
    fake.connections.get(3)?.onStream(11);
    conn.close();
    conn.close();

    await conn.closed;
    expect(fake.closedStreams).toEqual([11]);
    expect(fake.closedConnections).toEqual([3]);
  });

  it("propagates a native connection failure to closed and incoming", async () => {
    const fake = fakeStreams();
    const conn = connection(fake);
    fake.connections.get(3)?.onClose("error [iroh:5004] stream closed: timed out");

    const error = (await captureRejection(conn.closed)) as IrohError;
    expect(error.kind).toBe("stream-closed");
    const iterator = conn.incoming[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/timed out/);
  });
});

describe("StreamListenerController", () => {
  function listener(fake: FakeStreams, created: Connection[]): StreamListenerController {
    return new StreamListenerController(fake.binding, {
      alpn: "app/1",
      createConnection: (connectionId, remoteId) => {
        const conn = new ConnectionController(fake.binding, connectionId, {
          remoteId,
          alpn: "app/1",
          framing: "framed",
        });
        created.push(conn);
        return conn;
      },
    });
  }

  it("parses an accepted connection line into its id and peer", async () => {
    const fake = fakeStreams();
    const created: Connection[] = [];
    const live = listener(fake, created);
    fake.listen?.onConnection("5 peer-abc");

    const iterator = live.connections[Symbol.asyncIterator]();
    const accepted = (await iterator.next()).value as Connection;
    expect(accepted.remoteId).toBe("peer-abc" as never);
    expect(created).toHaveLength(1);
    expect(fake.connections.has(5)).toBe(true);
  });

  it("closes connections nobody picked up, but not ones already handed over", async () => {
    const fake = fakeStreams();
    const created: Connection[] = [];
    const live = listener(fake, created);
    fake.listen?.onConnection("5 peer-a");
    fake.listen?.onConnection("6 peer-b");

    const iterator = live.connections[Symbol.asyncIterator]();
    const taken = (await iterator.next()).value as Connection;
    live.close();

    expect(taken.isClosed).toBe(false);
    expect(created[1]?.isClosed).toBe(true);
    expect(fake.stoppedListeners).toEqual([42]);
  });

  it("surfaces a listener failure through the connections iteration", async () => {
    const fake = fakeStreams();
    const live = listener(fake, []);
    fake.listen?.onClose("error [iroh:5000] failed to listen on alpn: endpoint gone");

    const iterator = live.connections[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/endpoint gone/);
  });
});

describe("native callbacks never throw back across the bridge", () => {
  it("drops a peer-opened stream the endpoint already tore down", () => {
    const fake = fakeStreams();
    const binding: StreamsBinding = {
      ...fake.binding,
      subscribeStream: () => {
        throw new Error("[iroh:1001] invalid or stale handle: 11");
      },
    };
    const conn = new ConnectionController(binding, 3, {
      remoteId: "peer-1" as never,
      alpn: "app/1",
      framing: "framed",
    });
    expect(() => fake.connections.get(3)?.onStream(11)).not.toThrow();
    expect(fake.closedStreams).toEqual([11]);
    conn.close();
  });

  it("drops an accepted connection the endpoint already tore down", () => {
    const fake = fakeStreams();
    const live = new StreamListenerController(fake.binding, {
      alpn: "app/1",
      createConnection: () => {
        throw new Error("[iroh:1001] invalid or stale handle: 5");
      },
    });
    expect(() => fake.listen?.onConnection("5 peer-a")).not.toThrow();
    expect(fake.closedConnections).toEqual([5]);
    live.close();
  });
});

describe("Endpoint streams namespace", () => {
  it("declares custom ALPNs newline-joined, and omits the field when there are none", async () => {
    const mock = createMockBinding();
    await Endpoint.create({ preset: "minimal", alpns: ["app/1", "app/2"] }, mock.binding);
    await Endpoint.create({ preset: "minimal", alpns: [] }, mock.binding);
    await Endpoint.create({ preset: "minimal" }, mock.binding);

    expect(mock.configs[0]?.alpns).toBe("app/1\napp/2");
    expect(mock.configs[1]?.alpns).toBeUndefined();
    expect(mock.configs[2]?.alpns).toBeUndefined();
  });

  it("dials a bare endpoint id as an address with no transports", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "n0" }, mock.binding);
    const connecting = endpoint.streams.connect("peer-1" as never, "app/1");
    mock.streamConnects[0]?.deferred.resolve(9);
    const connection = await connecting;

    expect(JSON.parse(mock.streamConnects[0]?.remoteAddr as string)).toEqual({
      id: "peer-1",
      relayUrls: [],
      directAddrs: [],
    });
    expect(connection.remoteId).toBe("peer-1" as never);
    expect(mock.streamConnections[0]?.framing).toBe("framed");
  });

  it("dials a full address so a peer without discovery is still reachable", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);
    const connecting = endpoint.streams.connect(
      { id: "peer-2" as never, relayUrls: [], directAddrs: ["127.0.0.1:4242"] },
      "app/1",
      { framing: "raw" },
    );
    mock.streamConnects[0]?.deferred.resolve(9);
    await connecting;

    expect(JSON.parse(mock.streamConnects[0]?.remoteAddr as string).directAddrs).toEqual([
      "127.0.0.1:4242",
    ]);
    expect(mock.streamConnections[0]?.framing).toBe("raw");
  });

  it("throws a typed error when a dial fails", async () => {
    const mock = createMockBinding();
    mock.failures.streamConnect = new Error("[iroh:5001] failed to connect: no route");
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);
    const error = (await captureRejection(
      endpoint.streams.connect("peer-1" as never, "app/1"),
    )) as IrohError;
    expect(error.kind).toBe("stream-connect");
  });

  it("throws a typed error when listening on an ALPN the endpoint never declared", async () => {
    const mock = createMockBinding();
    mock.failures.streamListen = new Error(
      "[iroh:5000] failed to listen on alpn: not declared on this endpoint",
    );
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);
    expect(() => endpoint.streams.listen("app/1")).toThrow(IrohError);
    try {
      endpoint.streams.listen("app/1");
    } catch (error) {
      expect((error as IrohError).kind).toBe("stream-listen");
    }
  });

  it("tears down listeners and connections when the endpoint closes", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal", alpns: ["app/1"] }, mock.binding);
    const listener = endpoint.streams.listen("app/1");
    const connecting = endpoint.streams.connect("peer-1" as never, "app/1");
    mock.streamConnects[0]?.deferred.resolve(9);
    const connection = await connecting;

    await endpoint.close();
    await flush();

    expect(mock.stoppedListeners).toEqual([mock.streamListens[0]?.listenerId as number]);
    expect(mock.closedConnections).toEqual([9]);
    expect(connection.isClosed).toBe(true);
    const iterator = listener.connections[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});
