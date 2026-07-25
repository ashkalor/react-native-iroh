import { act, renderHook, waitFor } from "@testing-library/react";

import { Endpoint } from "../endpoint";
import { useEndpoint, useGossip, useTransfer } from "../hooks";
import { createMockBinding, flush, testTicket, type MockBinding } from "./helpers";

// Every hook test asserts React never logged an "update not wrapped in act(...)"
// warning, which is exactly what a setState-after-unmount (or otherwise
// unguarded async update) would emit under React 19. A shared spy collects
// them; each test's teardown fails if any leaked.
let consoleErrors: string[] = [];
let originalConsoleError: typeof console.error;

beforeEach(() => {
  consoleErrors = [];
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.error = originalConsoleError;
  const actWarnings = consoleErrors.filter((line) => line.includes("not wrapped in act"));
  expect(actWarnings).toEqual([]);
});

describe("useEndpoint", () => {
  it("creates an endpoint on mount and closes it on unmount", async () => {
    const mock = createMockBinding();
    const { result, unmount } = renderHook(() => useEndpoint({ preset: "minimal" }, mock.binding));

    expect(result.current.status).toBe("creating");
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(mock.configs).toHaveLength(1);
    expect(mock.configs[0]).toMatchObject({ preset: "minimal" });
    const endpoint = result.current.endpoint;
    expect(endpoint).toBeInstanceOf(Endpoint);

    unmount();
    // close() is async; let its microtask settle.
    await act(async () => {
      await flush();
    });
    expect(mock.closeCalls).toHaveLength(1);
  });

  it("reports an error status when creation fails", async () => {
    const mock = createMockBinding();
    mock.failures.createEndpoint = new Error("[iroh:2000] failed to bind endpoint");
    const { result } = renderHook(() => useEndpoint({}, mock.binding));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.endpoint).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("survives StrictMode's double mount, closing the orphaned endpoint", async () => {
    const mock = createMockBinding();
    const { result, unmount } = renderHook(() => useEndpoint({}, mock.binding), {
      reactStrictMode: true,
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    // StrictMode created two endpoints; the first (orphaned by the immediate
    // cleanup) is closed rather than leaked.
    await waitFor(() => expect(mock.closeCalls.length).toBeGreaterThanOrEqual(1));
    expect(mock.configs.length).toBeGreaterThanOrEqual(2);

    const liveHandleClosedBefore = mock.closeCalls.length;
    unmount();
    await act(async () => {
      await flush();
    });
    // The live endpoint is closed too on final unmount.
    expect(mock.closeCalls.length).toBeGreaterThan(liveHandleClosedBefore);
  });

  it("does not set state after an unmount that races creation", async () => {
    const mock = createMockBinding();
    const { unmount } = renderHook(() => useEndpoint({}, mock.binding));
    // Unmount while Endpoint.create is still pending.
    unmount();
    await act(async () => {
      await flush();
    });
    // The orphaned endpoint is closed, and no act warning was emitted (asserted
    // by the shared afterEach).
    expect(mock.closeCalls).toHaveLength(1);
  });
});

describe("useTransfer", () => {
  async function createEndpoint(): Promise<{ mock: MockBinding; endpoint: Endpoint }> {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);
    return { mock, endpoint };
  }

  it("flows progress events into state and settles to done", async () => {
    const { mock, endpoint } = await createEndpoint();
    const transfer = endpoint.blobs.download(testTicket("a"), "/tmp/out.bin");
    const { result } = renderHook(() => useTransfer(transfer));

    expect(result.current.status).toBe("transferring");
    expect(result.current.bytesReceived).toBe(0);

    const download = mock.downloads[0]!;
    act(() => {
      download.onProgress(2048);
    });
    expect(result.current.bytesReceived).toBe(2048);
    expect(result.current.status).toBe("transferring");

    await act(async () => {
      download.deferred.resolve();
      await flush();
    });
    expect(result.current.status).toBe("done");

    await endpoint.close();
  });

  it("reports idle when passed null", async () => {
    const { result } = renderHook(() => useTransfer(null));
    expect(result.current.status).toBe("idle");
    expect(result.current.bytesReceived).toBe(0);
  });

  it("unsubscribes on unmount so later progress does not update state", async () => {
    const { mock, endpoint } = await createEndpoint();
    const transfer = endpoint.blobs.download(testTicket("b"), "/tmp/out.bin");
    const { unmount } = renderHook(() => useTransfer(transfer));

    const download = mock.downloads[0]!;
    unmount();
    // A progress event after unmount must not trigger a state update (which,
    // being outside act, would emit an act warning caught by afterEach).
    act(() => {
      download.onProgress(4096);
    });
    await act(async () => {
      await flush();
    });

    await endpoint.close();
  });
});

describe("useGossip", () => {
  it("accumulates messages, marks joined, and unsubscribes on unmount", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);
    const { result, unmount } = renderHook(() => useGossip(endpoint, "chat"));

    expect(result.current.status).toBe("joining");
    const subscribe = mock.gossipSubscribes[0]!;

    await act(async () => {
      subscribe.onMessage("peer-1 hello");
      subscribe.onMessage("peer-2 world");
      await flush();
    });

    expect(result.current.messages).toEqual([
      { from: "peer-1", text: "hello" },
      { from: "peer-2", text: "world" },
    ]);
    // Receiving traffic means the swarm is live.
    expect(result.current.status).toBe("joined");

    await act(async () => {
      subscribe.onNeighbor("up endpoint-9");
      await flush();
    });
    expect(result.current.neighbors).toEqual([{ type: "up", endpointId: "endpoint-9" }]);

    unmount();
    expect(mock.gossipUnsubscribes).toHaveLength(1);

    await endpoint.close();
  });

  it("caps retained messages at the configured limit", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);
    const { result } = renderHook(() => useGossip(endpoint, "chat", { retain: 2 }));
    const subscribe = mock.gossipSubscribes[0]!;

    await act(async () => {
      subscribe.onMessage("a 1");
      subscribe.onMessage("b 2");
      subscribe.onMessage("c 3");
      await flush();
    });

    // Oldest dropped: only the last two are retained.
    expect(result.current.messages.map((m) => m.text)).toEqual(["2", "3"]);

    await act(async () => {
      await endpoint.close();
    });
  });

  it("reports closed and stops broadcasting when the endpoint closes underneath it", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);
    const { result } = renderHook(() => useGossip(endpoint, "chat"));
    const subscribe = mock.gossipSubscribes[0]!;

    await act(async () => {
      subscribe.onMessage("peer hello");
      await flush();
    });
    expect(result.current.status).toBe("joined");

    // The component stays mounted; only the endpoint goes away.
    await act(async () => {
      await endpoint.close();
    });

    expect(result.current.status).toBe("closed");
    await expect(result.current.broadcast("hi")).rejects.toThrow(/not active/);
  });

  it("stays empty and joining while the endpoint is null", async () => {
    const { result } = renderHook(() => useGossip(null, "chat"));
    expect(result.current.status).toBe("joining");
    expect(result.current.messages).toEqual([]);
    await expect(result.current.broadcast("hi")).rejects.toThrow();
  });
});
