import { Endpoint } from "../endpoint";
import { IrohError } from "../errors";
import { captureRejection, createMockBinding } from "./helpers";
import type { BlobInfo, BlobStatus, TagInfo } from "../endpoint";

function expectIrohError(value: unknown): IrohError {
  expect(value).toBeInstanceOf(IrohError);
  return value as IrohError;
}

const HASH = "a".repeat(64);

describe("blobs.status / has", () => {
  it("parses the notFound / partial / complete union", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);

    mock.blobStatusJson = JSON.stringify({ state: "notFound" });
    expect(await endpoint.blobs.status(HASH)).toEqual({ state: "notFound" } satisfies BlobStatus);

    mock.blobStatusJson = JSON.stringify({ state: "partial", size: 512 });
    expect(await endpoint.blobs.status(HASH)).toEqual({
      state: "partial",
      size: 512,
    } satisfies BlobStatus);

    mock.blobStatusJson = JSON.stringify({ state: "complete", size: 4096 });
    expect(await endpoint.blobs.status(HASH)).toEqual({
      state: "complete",
      size: 4096,
    } satisfies BlobStatus);

    expect(mock.blobStatusCalls).toEqual([
      { endpoint: 1, hash: HASH },
      { endpoint: 1, hash: HASH },
      { endpoint: 1, hash: HASH },
    ]);
  });

  it("forwards has() and wraps a malformed-hash rejection", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);

    mock.blobHasResult = false;
    expect(await endpoint.blobs.has(HASH)).toBe(false);
    expect(mock.blobHasCalls).toEqual([{ endpoint: 1, hash: HASH }]);

    mock.failures.blobStatus = new Error("[iroh:3004] invalid blob hash");
    const error = expectIrohError(await captureRejection(endpoint.blobs.status("nope")));
    expect(error.code).toBe(3004);
    expect(error.kind).toBe("blob-store");
  });
});

describe("blobs.list", () => {
  it("parses the store's blobs", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);

    mock.blobListJson = JSON.stringify([
      { hash: HASH, size: 10 },
      { hash: "b".repeat(64), size: 20 },
    ]);
    const blobs = await endpoint.blobs.list();
    expect(blobs).toEqual([
      { hash: HASH, size: 10 },
      { hash: "b".repeat(64), size: 20 },
    ] satisfies BlobInfo[]);
    expect(mock.blobListCalls).toEqual([1]);
  });
});

describe("blobs.addBytes", () => {
  it("imports an ArrayBuffer and returns a ticket", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);

    mock.addBytesTicket = `blob${"c".repeat(56)}`;
    const data = new Uint8Array([1, 2, 3]).buffer;
    const ticket = await endpoint.blobs.addBytes(data);
    expect(ticket).toBe(mock.addBytesTicket);
    expect(mock.addBytesCalls).toHaveLength(1);
    expect(mock.addBytesCalls[0]!.endpoint).toBe(1);
    expect(mock.addBytesCalls[0]!.data).toBe(data);
  });

  it("wraps an import failure", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);
    mock.failures.addBytes = new Error("[iroh:3000] import failed");
    const error = expectIrohError(
      await captureRejection(endpoint.blobs.addBytes(new ArrayBuffer(0))),
    );
    expect(error.code).toBe(3000);
    expect(error.kind).toBe("blob-import");
  });
});

describe("blobs.tags lifecycle", () => {
  it("lists, creates (defaulting raw), renames and deletes tags", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);

    mock.tagsListJson = JSON.stringify([{ name: "keep", hash: HASH, format: "raw" }]);
    expect(await endpoint.blobs.tags.list()).toEqual([
      { name: "keep", hash: HASH, format: "raw" },
    ] satisfies TagInfo[]);
    expect(mock.tagsListCalls).toEqual([1]);

    await endpoint.blobs.tags.create("keep", HASH);
    await endpoint.blobs.tags.create("seq", HASH, "hashSeq");
    expect(mock.tagsCreateCalls).toEqual([
      { endpoint: 1, name: "keep", hash: HASH, format: "raw" },
      { endpoint: 1, name: "seq", hash: HASH, format: "hashSeq" },
    ]);

    await endpoint.blobs.tags.rename("keep", "renamed");
    expect(mock.tagsRenameCalls).toEqual([{ endpoint: 1, from: "keep", to: "renamed" }]);

    await endpoint.blobs.tags.delete("renamed");
    expect(mock.tagsDeleteCalls).toEqual([{ endpoint: 1, name: "renamed" }]);
  });

  it("wraps a rename-of-missing-tag rejection", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ preset: "minimal" }, mock.binding);
    mock.failures.tagsRename = new Error("[iroh:3004] tag not found");
    const error = expectIrohError(await captureRejection(endpoint.blobs.tags.rename("nope", "x")));
    expect(error.code).toBe(3004);
    expect(error.kind).toBe("blob-store");
  });
});

describe("gc option", () => {
  it("forwards a positive interval as gcIntervalSecs", async () => {
    const mock = createMockBinding();
    await Endpoint.create({ preset: "minimal", gc: { intervalSecs: 60 } }, mock.binding);
    expect(mock.configs).toEqual([{ preset: "minimal", gcIntervalSecs: 60 }]);
  });

  it("omits GC by default (off, unchanged retention)", async () => {
    const mock = createMockBinding();
    await Endpoint.create({ preset: "minimal" }, mock.binding);
    expect(mock.configs[0]!.gcIntervalSecs).toBeUndefined();
  });

  it("treats a non-positive interval as off", async () => {
    const mock = createMockBinding();
    await Endpoint.create({ preset: "minimal", gc: { intervalSecs: 0 } }, mock.binding);
    expect(mock.configs[0]!.gcIntervalSecs).toBeUndefined();
  });
});
