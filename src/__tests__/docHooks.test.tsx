import { act, renderHook, waitFor } from "@testing-library/react";

import type { DocEntry, DocLiveEvent } from "../docs";
import { Endpoint } from "../endpoint";
import { useDoc, useDocs } from "../hooks";
import { createMockBinding, flush, type MockBinding } from "./helpers";

// Mirrors hooks.test.tsx: any "update not wrapped in act(...)" warning (what a
// setState-after-unmount emits under React 19) fails the test.
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

const EMPTY_HASH = "0".repeat(64);

function entry(author: string, key: string, hash: string, size: number): DocEntry {
  return { author, key, hash, size, timestamp: 1 } as DocEntry;
}

function eventLine(event: DocLiveEvent): string {
  return JSON.stringify(event);
}

async function createEndpoint(): Promise<{ mock: MockBinding; endpoint: Endpoint }> {
  const mock = createMockBinding();
  const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);
  return { mock, endpoint };
}

describe("useDoc", () => {
  it("seeds the initial entries from getMany on mount", async () => {
    const { mock, endpoint } = await createEndpoint();
    mock.docsReturns.docsGetMany = JSON.stringify([entry("aa", "k1", "h1", 5)]);
    const doc = await endpoint.docs.create();

    const { result } = renderHook(() => useDoc(doc));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({ key: "k1", hash: "h1" });

    await act(async () => {
      await endpoint.close();
    });
  });

  it("upserts entries on insert events, keyed by author+key", async () => {
    const { mock, endpoint } = await createEndpoint();
    const doc = await endpoint.docs.create();
    const { result } = renderHook(() => useDoc(doc));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const sub = mock.docsSubscribes[0]!;

    await act(async () => {
      sub.onEvent(eventLine({ type: "insert-local", entry: entry("aa", "k1", "h1", 5) }));
      await flush();
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({ hash: "h1", contentStatus: "complete" });

    // Same author+key updates in place rather than adding a row.
    await act(async () => {
      sub.onEvent(eventLine({ type: "insert-local", entry: entry("aa", "k1", "h2", 7) }));
      sub.onEvent(eventLine({ type: "insert-local", entry: entry("aa", "k2", "h3", 9) }));
      await flush();
    });
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries.find((e) => e.key === "k1")).toMatchObject({ hash: "h2" });

    await act(async () => {
      await endpoint.close();
    });
  });

  it("flips content availability on a content-ready event", async () => {
    const { mock, endpoint } = await createEndpoint();
    const doc = await endpoint.docs.create();
    const { result } = renderHook(() => useDoc(doc));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const sub = mock.docsSubscribes[0]!;

    await act(async () => {
      sub.onEvent(
        eventLine({
          type: "insert-remote",
          from: "peer-1",
          entry: entry("aa", "k1", "h1", 5),
          contentStatus: "missing",
        } as DocLiveEvent),
      );
      await flush();
    });
    expect(result.current.entries[0]).toMatchObject({ contentStatus: "missing" });

    await act(async () => {
      sub.onEvent(eventLine({ type: "content-ready", hash: "h1" }));
      await flush();
    });
    expect(result.current.entries[0]).toMatchObject({ contentStatus: "complete" });

    await act(async () => {
      await endpoint.close();
    });
  });

  it("removes an entry when an empty tombstone entry arrives", async () => {
    const { mock, endpoint } = await createEndpoint();
    mock.docsReturns.docsGetMany = JSON.stringify([entry("aa", "k1", "h1", 5)]);
    const doc = await endpoint.docs.create();
    const { result } = renderHook(() => useDoc(doc));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    const sub = mock.docsSubscribes[0]!;

    await act(async () => {
      sub.onEvent(
        eventLine({
          type: "insert-remote",
          from: "peer-1",
          entry: entry("aa", "k1", EMPTY_HASH, 0),
          contentStatus: "missing",
        } as DocLiveEvent),
      );
      await flush();
    });
    expect(result.current.entries).toHaveLength(0);

    await act(async () => {
      await endpoint.close();
    });
  });

  it("caps retained events at the configured limit", async () => {
    const { mock, endpoint } = await createEndpoint();
    const doc = await endpoint.docs.create();
    const { result } = renderHook(() => useDoc(doc, { retain: 2 }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const sub = mock.docsSubscribes[0]!;

    await act(async () => {
      sub.onEvent(eventLine({ type: "insert-local", entry: entry("aa", "k1", "h1", 1) }));
      sub.onEvent(eventLine({ type: "insert-local", entry: entry("aa", "k2", "h2", 1) }));
      sub.onEvent(eventLine({ type: "insert-local", entry: entry("aa", "k3", "h3", 1) }));
      await flush();
    });

    // Oldest dropped: only the last two events are retained.
    expect(result.current.events).toHaveLength(2);
    expect(
      result.current.events.map((e) => (e.type === "insert-local" ? e.entry.key : "")),
    ).toEqual(["k2", "k3"]);

    await act(async () => {
      await endpoint.close();
    });
  });

  it("unsubscribes on unmount", async () => {
    const { mock, endpoint } = await createEndpoint();
    const doc = await endpoint.docs.create();
    const { result, unmount } = renderHook(() => useDoc(doc));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(mock.docsUnsubscribes).toHaveLength(0);
    unmount();
    expect(mock.docsUnsubscribes).toHaveLength(1);

    await act(async () => {
      await endpoint.close();
    });
  });

  it("surfaces an error when the subscription stream fails", async () => {
    const { mock, endpoint } = await createEndpoint();
    const doc = await endpoint.docs.create();
    const { result } = renderHook(() => useDoc(doc));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const sub = mock.docsSubscribes[0]!;

    await act(async () => {
      sub.onClose("error the docs actor is unavailable");
      await flush();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toContain("the docs actor is unavailable");

    await act(async () => {
      await endpoint.close();
    });
  });

  it("stays empty and loading while the doc is null", async () => {
    const { result } = renderHook(() => useDoc(null));
    expect(result.current.status).toBe("loading");
    expect(result.current.entries).toEqual([]);
    await expect(result.current.setBytes("aa", "k", new ArrayBuffer(0))).rejects.toThrow();
  });
});

describe("useDocs", () => {
  it("lists documents on mount and refreshes after create and drop", async () => {
    const { mock, endpoint } = await createEndpoint();
    const { result } = renderHook(() => useDocs(endpoint));

    await waitFor(() => expect(result.current.docs).toHaveLength(2));
    const listCalls = () => mock.docsCalls.filter((c) => c.method === "docsList").length;
    expect(listCalls()).toBe(1);

    // create() must refresh the list afterwards.
    mock.docsReturns.docsList = "f".repeat(64);
    await act(async () => {
      await result.current.create();
    });
    expect(mock.docsCalls.some((c) => c.method === "docsCreate")).toBe(true);
    expect(listCalls()).toBe(2);
    await waitFor(() => expect(result.current.docs).toHaveLength(1));

    // dropDoc() must refresh too.
    mock.docsReturns.docsList = "";
    await act(async () => {
      await result.current.dropDoc("f".repeat(64));
    });
    expect(mock.docsCalls.some((c) => c.method === "docsDrop")).toBe(true);
    await waitFor(() => expect(result.current.docs).toHaveLength(0));

    await act(async () => {
      await endpoint.close();
    });
  });

  it("stays empty while the endpoint is null and rejects mutations", async () => {
    const { result } = renderHook(() => useDocs(null));
    expect(result.current.docs).toEqual([]);
    await expect(result.current.create()).rejects.toThrow();
  });
});
