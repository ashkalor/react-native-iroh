import {
  DocsController,
  DocSubscriptionController,
  parseDocTicket,
  validateDocTicketShape,
  type DocSubscriptionBinding,
  type DocsBinding,
} from "../docs";
import { Endpoint } from "../endpoint";
import { IrohError } from "../errors";
import { createMockBinding } from "./helpers";

/** A recording, hand-drivable {@link DocsBinding} for the docs controllers. */
interface FakeDocs {
  binding: DocsBinding;
  calls: { method: string; args: unknown[] }[];
  /** An in-memory key set so deletePrefix can model real prefix semantics. */
  keys: Set<string>;
  returns: {
    authorsDefault: string;
    authorsList: string;
    docsCreate: string;
    docsOpen: boolean;
    docsImport: string;
    docsList: string;
    docsGetExact: string;
    docsGetMany: string;
    docsDeletePrefix: number;
    docsShare: string;
    docsGetContent: ArrayBuffer;
  };
  failures: Partial<Record<string, Error>>;
}

function fakeDocs(): FakeDocs {
  const fake: FakeDocs = {
    calls: [],
    failures: {},
    keys: new Set<string>(),
    returns: {
      authorsDefault: "a".repeat(64),
      authorsList: `${"a".repeat(64)}\n${"b".repeat(64)}`,
      docsCreate: "d".repeat(64),
      docsOpen: true,
      docsImport: "e".repeat(64),
      docsList: `${"d".repeat(64)}\n${"e".repeat(64)}`,
      docsGetExact: "null",
      docsGetMany: "[]",
      docsDeletePrefix: 0,
      docsShare: `doc${"a".repeat(60)}`,
      docsGetContent: new ArrayBuffer(0),
    },
    binding: undefined as unknown as DocsBinding,
  };
  const record = <T>(method: string, args: unknown[], value: T): Promise<T> => {
    fake.calls.push({ method, args });
    const failure = fake.failures[method];
    return failure !== undefined ? Promise.reject(failure) : Promise.resolve(value);
  };
  fake.binding = {
    authorsDefault: () => record("authorsDefault", [], fake.returns.authorsDefault),
    authorsCreate: () => record("authorsCreate", [], "created"),
    authorsList: () => record("authorsList", [], fake.returns.authorsList),
    authorsImport: (secretKey) => record("authorsImport", [secretKey], "imported"),
    docsCreate: () => record("docsCreate", [], fake.returns.docsCreate),
    docsOpen: (ns) => record("docsOpen", [ns], fake.returns.docsOpen),
    docsImport: (ticket) => record("docsImport", [ticket], fake.returns.docsImport),
    docsList: () => record("docsList", [], fake.returns.docsList),
    docsDrop: (ns) => record("docsDrop", [ns], undefined as unknown as void),
    docsSetBytes: (ns, author, key, value) =>
      record("docsSetBytes", [ns, author, key, value], "hash-of-value"),
    docsGetExact: (ns, author, key) =>
      record("docsGetExact", [ns, author, key], fake.returns.docsGetExact),
    docsGetMany: (ns, query) => record("docsGetMany", [ns, query], fake.returns.docsGetMany),
    docsDeletePrefix: (ns, author, prefix) => {
      // Model iroh-docs prefix semantics: remove the key and every key that has
      // it as a prefix. The count is what the native side would return.
      fake.calls.push({ method: "docsDeletePrefix", args: [ns, author, prefix] });
      const failure = fake.failures.docsDeletePrefix;
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      const matched = [...fake.keys].filter((key) => key.startsWith(prefix));
      for (const key of matched) {
        fake.keys.delete(key);
      }
      return Promise.resolve(matched.length);
    },
    docsShare: (ns, mode) => record("docsShare", [ns, mode], fake.returns.docsShare),
    docsGetContent: (hash) => record("docsGetContent", [hash], fake.returns.docsGetContent),
    docsSubscribe: (ns) => {
      fake.calls.push({ method: "docsSubscribe", args: [ns] });
    },
    docsUnsubscribe: (subId) => {
      fake.calls.push({ method: "docsUnsubscribe", args: [subId] });
    },
    docsStartSync: (ns, peers) =>
      record("docsStartSync", [ns, peers], undefined as unknown as void),
    docsLeave: (ns) => record("docsLeave", [ns], undefined as unknown as void),
  };
  return fake;
}

/** A hand-drivable {@link DocSubscriptionBinding} for exercising the controller. */
interface FakeDocSub {
  binding: DocSubscriptionBinding;
  onStart?: (subId: number) => void;
  onEvent?: (event: string) => void;
  onClose?: (event: string) => void;
  unsubscribed: number[];
  disposed: number;
  startThrows?: Error;
}

function fakeDocSub(capacity?: number): FakeDocSub {
  const fake: FakeDocSub = {
    unsubscribed: [],
    disposed: 0,
    binding: {
      capacity,
      startSubscribe: (onStart, onEvent, onClose) => {
        if (fake.startThrows !== undefined) {
          throw fake.startThrows;
        }
        fake.onStart = onStart;
        fake.onEvent = onEvent;
        fake.onClose = onClose;
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

const ENTRY_JSON = JSON.stringify({
  author: "a".repeat(64),
  key: "chapter/1",
  hash: "f".repeat(64),
  size: 12,
  timestamp: 1_700_000_000,
});

describe("Authors", () => {
  it("returns the default author id", async () => {
    const fake = fakeDocs();
    const docs = new DocsController(fake.binding);
    await expect(docs.authors.default()).resolves.toBe("a".repeat(64));
    expect(fake.calls[0]!.method).toBe("authorsDefault");
  });

  it("splits the newline-joined author list, dropping blanks", async () => {
    const fake = fakeDocs();
    fake.returns.authorsList = `${"a".repeat(64)}\n${"b".repeat(64)}\n`;
    const docs = new DocsController(fake.binding);
    expect(await docs.authors.list()).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("returns an empty list for an empty native payload", async () => {
    const fake = fakeDocs();
    fake.returns.authorsList = "";
    const docs = new DocsController(fake.binding);
    expect(await docs.authors.list()).toEqual([]);
  });

  it("imports an author from its secret key", async () => {
    const fake = fakeDocs();
    const docs = new DocsController(fake.binding);
    await expect(docs.authors.import("secret-hex")).resolves.toBe("imported");
    expect(fake.calls.at(-1)).toEqual({ method: "authorsImport", args: ["secret-hex"] });
  });

  it("maps a native failure to an IrohError", async () => {
    const fake = fakeDocs();
    fake.failures.authorsDefault = new Error("[iroh:6000] docs are not enabled on this endpoint");
    const docs = new DocsController(fake.binding);
    await expect(docs.authors.default()).rejects.toBeInstanceOf(IrohError);
    await expect(docs.authors.default()).rejects.toHaveProperty("kind", "docs-disabled");
  });
});

describe("DocsApi", () => {
  it("create returns a Doc carrying the new namespace id", async () => {
    const fake = fakeDocs();
    const docs = new DocsController(fake.binding);
    const doc = await docs.create();
    expect(doc.id).toBe("d".repeat(64));
    expect(fake.calls[0]!.method).toBe("docsCreate");
  });

  it("open returns a Doc when the namespace exists and null otherwise", async () => {
    const fake = fakeDocs();
    const docs = new DocsController(fake.binding);
    fake.returns.docsOpen = true;
    const opened = await docs.open("d".repeat(64));
    expect(opened?.id).toBe("d".repeat(64));
    fake.returns.docsOpen = false;
    expect(await docs.open("z".repeat(64))).toBeNull();
  });

  it("import joins a ticket and returns a Doc", async () => {
    const fake = fakeDocs();
    const docs = new DocsController(fake.binding);
    const doc = await docs.import(`doc${"a".repeat(60)}`);
    expect(doc.id).toBe("e".repeat(64));
    expect(fake.calls.at(-1)!.method).toBe("docsImport");
  });

  it("list splits the namespace ids", async () => {
    const fake = fakeDocs();
    const docs = new DocsController(fake.binding);
    expect(await docs.list()).toEqual(["d".repeat(64), "e".repeat(64)]);
  });

  it("dropDoc forwards the namespace id", async () => {
    const fake = fakeDocs();
    const docs = new DocsController(fake.binding);
    await docs.dropDoc("d".repeat(64));
    expect(fake.calls.at(-1)).toEqual({ method: "docsDrop", args: ["d".repeat(64)] });
  });
});

describe("Doc CRUD", () => {
  it("setBytes forwards namespace, author, key, and value and returns the hash", async () => {
    const fake = fakeDocs();
    const doc = await new DocsController(fake.binding).create();
    const value = new Uint8Array([1, 2, 3]).buffer;
    await expect(doc.setBytes("author-1", "k", value)).resolves.toBe("hash-of-value");
    expect(fake.calls.at(-1)).toEqual({
      method: "docsSetBytes",
      args: ["d".repeat(64), "author-1", "k", value],
    });
  });

  it("getExact parses an entry object", async () => {
    const fake = fakeDocs();
    fake.returns.docsGetExact = ENTRY_JSON;
    const doc = await new DocsController(fake.binding).create();
    const entry = await doc.getExact("a".repeat(64), "chapter/1");
    expect(entry).toEqual({
      author: "a".repeat(64),
      key: "chapter/1",
      hash: "f".repeat(64),
      size: 12,
      timestamp: 1_700_000_000,
    });
  });

  it("getExact returns null when the native payload is null", async () => {
    const fake = fakeDocs();
    fake.returns.docsGetExact = "null";
    const doc = await new DocsController(fake.binding).create();
    expect(await doc.getExact("a".repeat(64), "missing")).toBeNull();
  });

  it("getMany parses the entry array", async () => {
    const fake = fakeDocs();
    fake.returns.docsGetMany = `[${ENTRY_JSON}]`;
    const doc = await new DocsController(fake.binding).create();
    const entries = await doc.getMany();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("chapter/1");
    // No query serializes to the empty selector (match all).
    expect(fake.calls.at(-1)).toEqual({ method: "docsGetMany", args: ["d".repeat(64), ""] });
  });

  it("getMany serializes a query into the native selector JSON", async () => {
    const fake = fakeDocs();
    const doc = await new DocsController(fake.binding).create();
    await doc.getMany({ author: "a".repeat(64), keyPrefix: "chapter/" });
    const [, queryJson] = fake.calls.at(-1)!.args as [string, string];
    expect(JSON.parse(queryJson)).toEqual({ author: "a".repeat(64), keyPrefix: "chapter/" });
  });

  it("getMany prefers keyExact over keyPrefix when both are set", async () => {
    const fake = fakeDocs();
    const doc = await new DocsController(fake.binding).create();
    await doc.getMany({ keyExact: "exact", keyPrefix: "pre" });
    const [, queryJson] = fake.calls.at(-1)!.args as [string, string];
    expect(JSON.parse(queryJson)).toEqual({ keyExact: "exact" });
  });

  it("getOne returns the first matching entry or null", async () => {
    const fake = fakeDocs();
    const doc = await new DocsController(fake.binding).create();
    fake.returns.docsGetMany = `[${ENTRY_JSON}]`;
    expect((await doc.getOne())?.key).toBe("chapter/1");
    fake.returns.docsGetMany = "[]";
    expect(await doc.getOne()).toBeNull();
  });

  it("deletePrefix forwards the prefix verbatim and removes the key plus its prefix-siblings", async () => {
    const fake = fakeDocs();
    const doc = await new DocsController(fake.binding).create();

    // "note" and "note-draft" share the "note" prefix: deleting "note" removes
    // BOTH (returns 2). A verbatim exact-key delete would leave "note-draft"
    // behind and return 1, so this locks the prefix contract at the boundary.
    fake.keys = new Set(["note", "note-draft"]);
    await expect(doc.deletePrefix("a".repeat(64), "note")).resolves.toBe(2);
    expect(fake.keys.has("note")).toBe(false);
    expect(fake.keys.has("note-draft")).toBe(false);
    // The prefix crossed the bridge unchanged.
    expect(fake.calls.at(-1)).toEqual({
      method: "docsDeletePrefix",
      args: ["d".repeat(64), "a".repeat(64), "note"],
    });

    // "a" and "b" do not share a prefix: deleting "a" removes ONLY "a".
    fake.keys = new Set(["a", "b"]);
    await expect(doc.deletePrefix("a".repeat(64), "a")).resolves.toBe(1);
    expect(fake.keys.has("a")).toBe(false);
    expect(fake.keys.has("b")).toBe(true);
  });

  it("share defaults to write mode and returns a ticket", async () => {
    const fake = fakeDocs();
    const doc = await new DocsController(fake.binding).create();
    await doc.share();
    expect(fake.calls.at(-1)).toEqual({ method: "docsShare", args: ["d".repeat(64), "write"] });
  });

  it("share honors an explicit read mode", async () => {
    const fake = fakeDocs();
    const doc = await new DocsController(fake.binding).create();
    await doc.share("read");
    expect(fake.calls.at(-1)!.args[1]).toBe("read");
  });

  it("getContent resolves an entry's bytes through the blobs bridge by its hash", async () => {
    const fake = fakeDocs();
    const payload = new Uint8Array([9, 8, 7]).buffer;
    fake.returns.docsGetContent = payload;
    const doc = await new DocsController(fake.binding).create();
    const entry = {
      author: "a".repeat(64) as never,
      key: "k",
      hash: "f".repeat(64),
      size: 3,
      timestamp: 1,
    };
    const bytes = await doc.getContent(entry);
    expect(bytes).toBe(payload);
    // Content is fetched by hash only (the out-of-band blob-store read), never
    // implicitly on a get.
    expect(fake.calls.at(-1)).toEqual({ method: "docsGetContent", args: ["f".repeat(64)] });
  });

  it("maps a native CRUD failure to an IrohError", async () => {
    const fake = fakeDocs();
    fake.failures.docsSetBytes = new Error("[iroh:6001] docs operation failed: set entry");
    const doc = await new DocsController(fake.binding).create();
    const error = await doc.setBytes("a", "k", new ArrayBuffer(0)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IrohError);
    expect((error as IrohError).kind).toBe("docs");
  });
});

describe("parseDocTicket", () => {
  it("decodes a ticket into namespace, capability, and node ids", () => {
    const mock = createMockBinding();
    mock.docsReturns.parseDocTicket = JSON.stringify({
      namespace: "d".repeat(64),
      capability: "read",
      nodeIds: ["peer-1", "peer-2"],
    });
    const info = parseDocTicket(`doc${"a".repeat(60)}`, mock.binding);
    expect(info).toEqual({
      namespace: "d".repeat(64),
      capability: "read",
      nodeIds: ["peer-1", "peer-2"],
    });
  });

  it("rejects a malformed ticket shape before hitting native", () => {
    const mock = createMockBinding();
    expect(() => parseDocTicket("not-a-doc-ticket", mock.binding)).toThrow(IrohError);
    // The native parse is never reached for a bad shape.
    expect(mock.docsCalls.some((c) => c.method === "parseDocTicket")).toBe(false);
  });

  it("validateDocTicketShape throws docs-invalid-ticket on garbage", () => {
    try {
      validateDocTicketShape("blobnotdoc");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(IrohError);
      expect((error as IrohError).kind).toBe("docs-invalid-ticket");
    }
  });
});

const INSERT_REMOTE_EVENT = JSON.stringify({
  type: "insert-remote",
  from: "peer-alice",
  entry: {
    author: "a".repeat(64),
    key: "chapter/1",
    hash: "f".repeat(64),
    size: 12,
    timestamp: 1_700_000_000,
  },
  contentStatus: "missing",
});

describe("Doc live sync", () => {
  it("subscribe streams parsed live events, holds started, and forwards the namespace", async () => {
    const fake = fakeDocs();
    const doc = await new DocsController(fake.binding).create();
    const sub = doc.subscribe();
    expect(fake.calls.at(-1)).toEqual({
      method: "docsSubscribe",
      args: ["d".repeat(64)],
    });
    // Not started until the native subscription id arrives; the fakeDocs binding
    // does not fire onStart, so this stays a bare controller with no id yet.
    expect(sub).toBeInstanceOf(DocSubscriptionController);
  });

  it("startSync forwards the peer list and leave forwards the namespace", async () => {
    const fake = fakeDocs();
    const doc = await new DocsController(fake.binding).create();
    await doc.startSync([{ id: "peer-1" as never, relayUrls: [], directAddrs: ["127.0.0.1:1"] }]);
    expect(fake.calls.at(-1)!.method).toBe("docsStartSync");
    const [ns, peers] = fake.calls.at(-1)!.args as [string, unknown];
    expect(ns).toBe("d".repeat(64));
    // The binding receives the EndpointAddr list; the endpoint serializes it.
    expect(peers).toEqual([{ id: "peer-1", relayUrls: [], directAddrs: ["127.0.0.1:1"] }]);

    await doc.startSync();
    expect((fake.calls.at(-1)!.args as [string, unknown[]])[1]).toEqual([]);

    await doc.leave();
    expect(fake.calls.at(-1)).toEqual({ method: "docsLeave", args: ["d".repeat(64)] });
  });

  it("maps a native startSync failure to an IrohError", async () => {
    const fake = fakeDocs();
    fake.failures.docsStartSync = new Error("[iroh:6001] docs operation failed: start sync");
    const doc = await new DocsController(fake.binding).create();
    await expect(doc.startSync()).rejects.toBeInstanceOf(IrohError);
    await expect(doc.startSync()).rejects.toHaveProperty("kind", "docs");
  });
});

describe("DocSubscriptionController events", () => {
  it("parses a JSON live event into a DocLiveEvent on the events stream", async () => {
    const fake = fakeDocSub();
    const sub = new DocSubscriptionController(fake.binding);
    fake.onStart?.(3);
    fake.onEvent?.(INSERT_REMOTE_EVENT);
    const iterator = sub.events[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      value: {
        type: "insert-remote",
        from: "peer-alice",
        entry: {
          author: "a".repeat(64),
          key: "chapter/1",
          hash: "f".repeat(64),
          size: 12,
          timestamp: 1_700_000_000,
        },
        contentStatus: "missing",
      },
      done: false,
    });
  });

  it("resolves started once onStart fires", async () => {
    const fake = fakeDocSub();
    const sub = new DocSubscriptionController(fake.binding);
    fake.onStart?.(9);
    await expect(sub.started).resolves.toBeUndefined();
  });

  it("honors a custom event-buffer capacity, dropping the oldest", async () => {
    const original = console.warn;
    console.warn = () => undefined;
    try {
      const fake = fakeDocSub(2);
      const sub = new DocSubscriptionController(fake.binding);
      fake.onStart?.(1);
      const event = (hash: string): string => JSON.stringify({ type: "content-ready", hash });
      fake.onEvent?.(event("a"));
      fake.onEvent?.(event("b"));
      fake.onEvent?.(event("c"));
      const events = sub.events[Symbol.asyncIterator]();
      expect((await events.next()).value).toEqual({ type: "content-ready", hash: "b" });
      expect((await events.next()).value).toEqual({ type: "content-ready", hash: "c" });
    } finally {
      console.warn = original;
    }
  });
});

describe("DocSubscriptionController teardown", () => {
  it("unsubscribe ends the stream, calls native unsubscribe, and disposes", async () => {
    const fake = fakeDocSub();
    const sub = new DocSubscriptionController(fake.binding);
    fake.onStart?.(9);
    const events = sub.events[Symbol.asyncIterator]();
    const pending = events.next();
    sub.unsubscribe();
    expect(fake.unsubscribed).toEqual([9]);
    expect(fake.disposed).toBe(1);
    expect((await pending).done).toBe(true);
    // Idempotent.
    sub.unsubscribe();
    expect(fake.unsubscribed).toEqual([9]);
  });

  it("unsubscribe before onStart tears down once the id arrives and rejects started", async () => {
    const fake = fakeDocSub();
    const sub = new DocSubscriptionController(fake.binding);
    const started = sub.started.catch((e: unknown) => e);
    sub.unsubscribe();
    expect(await started).toBeInstanceOf(IrohError);
    expect(fake.unsubscribed).toEqual([]);
    fake.onStart?.(5);
    expect(fake.unsubscribed).toEqual([5]);
  });

  it("a close error before start rejects started and ends the stream with it", async () => {
    const fake = fakeDocSub();
    const sub = new DocSubscriptionController(fake.binding);
    const started = sub.started.catch((e: unknown) => e);
    const parked = sub.events[Symbol.asyncIterator]().next();
    fake.onClose?.("error [iroh:6001] docs operation failed: open document");

    const error = await started;
    expect(error).toBeInstanceOf(IrohError);
    expect((error as IrohError).kind).toBe("docs");
    await expect(parked).rejects.toBeInstanceOf(IrohError);
    expect(fake.disposed).toBe(1);
  });

  it("a graceful close ends the events stream", async () => {
    const fake = fakeDocSub();
    const sub = new DocSubscriptionController(fake.binding);
    fake.onStart?.(1);
    const events = sub.events[Symbol.asyncIterator]();
    const pending = events.next();
    fake.onClose?.("end");
    expect((await pending).done).toBe(true);
  });

  it("propagates a synchronous startSubscribe failure", () => {
    const fake = fakeDocSub();
    fake.startThrows = new Error("[iroh:6000] docs are not enabled on this endpoint");
    expect(() => new DocSubscriptionController(fake.binding)).toThrow();
  });
});

describe("Endpoint.docs.subscribe wiring", () => {
  it("streams events and tears down live subscriptions when the endpoint closes", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ docs: true }, mock.binding);
    const doc = await endpoint.docs.create();
    const sub = doc.subscribe();
    expect(mock.docsSubscribes).toHaveLength(1);
    await sub.started;

    mock.docsSubscribes[0]!.onEvent(INSERT_REMOTE_EVENT);
    const events = sub.events[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({
      type: "insert-remote",
      from: "peer-alice",
    });

    const parked = events.next();
    await endpoint.close();
    expect((await parked).done).toBe(true);
    expect(mock.docsUnsubscribes).toHaveLength(1);
  });

  it("throws a typed error when the native subscribe fails synchronously", async () => {
    const mock = createMockBinding();
    mock.failures.docsSubscribe = new Error("[iroh:6000] docs are not enabled on this endpoint");
    const endpoint = await Endpoint.create({ docs: true }, mock.binding);
    const doc = await endpoint.docs.create();
    expect(() => doc.subscribe()).toThrow(IrohError);
    await endpoint.close();
  });
});

describe("Endpoint.docs wiring", () => {
  it("exposes a docs API bound to the endpoint handle", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ docs: true }, mock.binding);
    await endpoint.docs.create();
    const create = mock.docsCalls.find((c) => c.method === "docsCreate");
    // The mock hands out endpoint handles from 1; the docs call must carry it.
    expect(create?.endpoint).toBe(1);
    await endpoint.close();
  });

  it("forwards the docs option into the native endpoint config", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ docs: true, docsStoreDir: "/abs/docs" }, mock.binding);
    expect(mock.configs[0]).toMatchObject({ docs: true, docsStoreDir: "/abs/docs" });
    await endpoint.close();
  });

  it("leaves docs config unset when the option is omitted", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({}, mock.binding);
    expect(mock.configs[0]!.docs).toBeUndefined();
    expect(mock.configs[0]!.docsStoreDir).toBeUndefined();
    await endpoint.close();
  });
});
