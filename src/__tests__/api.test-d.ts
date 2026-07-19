/**
 * Compile-time-only tests for the public API surface. This file is included
 * in `bun run typecheck` but never executed (its name intentionally does not
 * match the test runner's `*.test.ts` pattern) and is excluded from builds.
 */
import { Endpoint } from "../endpoint";
import type { EndpointAddr, EndpointId, EndpointOptions, RelayMode } from "../endpoint";
import { getIrohErrorCode, IrohError } from "../errors";
import type { IrohErrorCase, IrohErrorCode, IrohErrorKind } from "../errors";
import type { IrohBinding } from "../native";
import { parseTicket, validateTicketShape } from "../ticket";
import type { BlobFormat, BlobTicket, TicketInfo } from "../ticket";
import type { CollectionTransfer, FileProgress, ProgressEvent, Transfer } from "../transfer";
import { IROH_VERSION } from "../version";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type NotAny<T> = 0 extends 1 & T ? false : true;

declare const transfer: Transfer;
declare const endpoint: Endpoint;
declare const options: Required<EndpointOptions>;

export type Cases = [
  // Error unions are exactly the stable table.
  Expect<Equal<IrohErrorCode, 1000 | 1001 | 1002 | 1003 | 2000 | 3000 | 3001 | 3002 | 3003>>,
  Expect<
    Equal<
      IrohErrorKind,
      | "internal"
      | "invalid-handle"
      | "invalid-ticket"
      | "invalid-path"
      | "endpoint-bind"
      | "blob-import"
      | "blob-download"
      | "blob-export"
      | "cancelled"
    >
  >,
  Expect<Equal<IrohErrorCase["code"], IrohErrorCode>>,
  Expect<Equal<IrohErrorCase["kind"], IrohErrorKind>>,
  // Compat helper keeps its loose signature.
  Expect<Equal<ReturnType<typeof getIrohErrorCode>, number | undefined>>,
  // Endpoint surface.
  Expect<Equal<Awaited<ReturnType<typeof Endpoint.create>>, Endpoint>>,
  Expect<Equal<typeof endpoint.id, EndpointId>>,
  Expect<Equal<typeof endpoint.isOpen, boolean>>,
  Expect<Equal<ReturnType<typeof endpoint.close>, Promise<void>>>,
  // Observability surface.
  Expect<Equal<typeof endpoint.addr, EndpointAddr>>,
  Expect<Equal<ReturnType<typeof endpoint.watchAddr>, () => void>>,
  Expect<Equal<typeof endpoint.addrChanges, AsyncIterable<EndpointAddr>>>,
  Expect<Equal<ReturnType<typeof endpoint.online>, Promise<void>>>,
  Expect<Equal<EndpointAddr["id"], EndpointId>>,
  Expect<Equal<EndpointAddr["relayUrls"], readonly string[]>>,
  Expect<Equal<EndpointAddr["directAddrs"], readonly string[]>>,
  // Blobs namespace.
  Expect<Equal<ReturnType<(typeof endpoint)["blobs"]["share"]>, Promise<BlobTicket>>>,
  Expect<Equal<ReturnType<(typeof endpoint)["blobs"]["download"]>, Transfer>>,
  Expect<Equal<ReturnType<(typeof endpoint)["blobs"]["shareCollection"]>, Promise<BlobTicket>>>,
  Expect<Equal<ReturnType<(typeof endpoint)["blobs"]["downloadCollection"]>, CollectionTransfer>>,
  // Branded strings: usable as strings, but plain strings do not brand.
  Expect<EndpointId extends string ? true : false>,
  Expect<BlobTicket extends string ? true : false>,
  Expect<Equal<string extends EndpointId ? true : false, false>>,
  Expect<Equal<string extends BlobTicket ? true : false, false>>,
  // Ticket introspection.
  Expect<Equal<ReturnType<typeof parseTicket>, TicketInfo>>,
  Expect<Equal<ReturnType<typeof validateTicketShape>, BlobTicket>>,
  Expect<Equal<TicketInfo["hash"], string>>,
  Expect<Equal<TicketInfo["format"], BlobFormat>>,
  Expect<Equal<TicketInfo["nodeId"], string>>,
  Expect<Equal<TicketInfo["size"], number | undefined>>,
  Expect<Equal<BlobFormat, "raw" | "hashSeq">>,
  // Collection transfer: aggregate Transfer plus a per-file breakdown.
  Expect<CollectionTransfer extends Transfer ? true : false>,
  Expect<Equal<CollectionTransfer["files"], FileProgress[]>>,
  Expect<Equal<FileProgress["name"], string>>,
  Expect<Equal<FileProgress["bytesReceived"], number>>,
  Expect<Equal<FileProgress["totalBytes"], number | undefined>>,
  Expect<Equal<FileProgress["done"], boolean>>,
  // Version constant.
  Expect<typeof IROH_VERSION extends string ? true : false>,
  Expect<NotAny<typeof IROH_VERSION>>,
  // Transfer surface.
  Expect<Equal<typeof transfer.promise, Promise<void>>>,
  Expect<Equal<typeof transfer.done, Promise<void>>>,
  Expect<Equal<typeof transfer.progress, AsyncIterable<ProgressEvent>>>,
  Expect<Equal<typeof transfer.isSettled, boolean>>,
  Expect<Equal<ReturnType<typeof transfer.cancel>, void>>,
  Expect<Equal<ReturnType<typeof transfer.onProgress>, () => void>>,
  Expect<Equal<ProgressEvent, { readonly bytesReceived: number; readonly totalBytes?: number }>>,
  // Config optionality.
  Expect<Equal<typeof options.preset, "n0" | "minimal">>,
  Expect<Equal<typeof options.blobStoreDir, string>>,
  Expect<Equal<typeof options.maxConcurrentDownloads, number>>,
  Expect<Equal<typeof options.relayMode, RelayMode>>,
  // Nothing on the public surface degrades to `any`.
  Expect<NotAny<typeof endpoint.id>>,
  Expect<NotAny<Awaited<typeof transfer.done>>>,
  Expect<NotAny<Parameters<(typeof endpoint)["blobs"]["download"]>[0]>>,
  Expect<NotAny<Parameters<IrohBinding["downloadBlob"]>[0]>>,
  Expect<NotAny<InstanceType<typeof IrohError>["code"]>>,
];

/** `await using` support: Endpoint is AsyncDisposable via Symbol.asyncDispose. */
export function endpointIsAsyncDisposable(input: Endpoint): AsyncDisposable {
  const dispose: Promise<void> = input[Symbol.asyncDispose]();
  void dispose;
  return input;
}

/** Plain strings need validateTicketShape before they brand as BlobTicket. */
export function brandsRequireValidation(raw: string): BlobTicket {
  // @ts-expect-error a plain string is not a BlobTicket without validation
  const unchecked: BlobTicket = raw;
  void unchecked;
  return validateTicketShape(raw);
}

/** parseTicket decodes a string into structured, native-backed TicketInfo. */
export function decodesTicket(raw: string): TicketInfo {
  return parseTicket(raw);
}

/** `kind` narrows `code` (discriminated union in both directions). */
export function narrowsByKind(error: IrohError): void {
  if (error.kind === "invalid-ticket") {
    const code: 1002 = error.code;
    void code;
  } else if (error.kind === "cancelled") {
    const code: 3003 = error.code;
    void code;
  }
}

/** `code` narrows `kind`. */
export function narrowsByCode(error: IrohError): void {
  if (error.code === 1001) {
    const kind: "invalid-handle" = error.kind;
    void kind;
  }
  if (error.code === 2000) {
    const kind: "endpoint-bind" = error.kind;
    void kind;
  }
}

/** `instanceof` narrows `unknown` to IrohError. */
export function narrowsUnknown(error: unknown): void {
  if (error instanceof IrohError) {
    const code: IrohErrorCode = error.code;
    const kind: IrohErrorKind = error.kind;
    void code;
    void kind;
  }
}

/** Every argument of Endpoint.create is optional; bad presets are rejected. */
export async function createSignatures(binding: IrohBinding): Promise<void> {
  const bare = await Endpoint.create();
  const empty = await Endpoint.create({});
  const full = await Endpoint.create(
    { preset: "minimal", blobStoreDir: "/data/store", maxConcurrentDownloads: 2 },
    binding,
  );
  // @ts-expect-error unknown preset names are rejected at compile time
  await Endpoint.create({ preset: "standard" });
  // @ts-expect-error unknown option keys are rejected at compile time
  await Endpoint.create({ maxDownloads: 4 });
  void bare;
  void empty;
  void full;
}

/** download accepts branded tickets, plain strings, and an optional signal. */
export function downloadSignatures(input: Endpoint, ticket: BlobTicket, raw: string): void {
  input.blobs.download(ticket, "/dest/a");
  input.blobs.download(raw, "/dest/b");
  input.blobs.download(ticket, "/dest/c", {});
  // @ts-expect-error unknown download options are rejected at compile time
  input.blobs.download(ticket, "/dest/d", { retries: 3 });
}

/** The progress stream is directly usable in `for await`. */
export async function progressIsAsyncIterable(input: Transfer): Promise<number> {
  let latest = 0;
  for await (const event of input.progress) {
    latest = event.bytesReceived;
  }
  return latest;
}

/** relayMode accepts the bare keywords and a custom URL list; garbage is rejected. */
export async function relayModeSignatures(): Promise<void> {
  await Endpoint.create({ relayMode: "default" });
  await Endpoint.create({ relayMode: "disabled" });
  await Endpoint.create({ relayMode: "staging" });
  await Endpoint.create({ relayMode: { custom: ["https://relay.example/"] } });
  // @ts-expect-error unknown relay mode keywords are rejected at compile time
  await Endpoint.create({ relayMode: "custom" });
  // @ts-expect-error a custom map must use the { custom } shape
  await Endpoint.create({ relayMode: ["https://relay.example/"] });
}

/** The address surface: sync snapshot, live listener, async iterable, online wait. */
export async function observabilitySignatures(input: Endpoint): Promise<void> {
  const snapshot: EndpointAddr = input.addr;
  void snapshot.id;
  void snapshot.relayUrls;
  void snapshot.directAddrs;
  const unsubscribe: () => void = input.watchAddr((addr) => {
    void addr.directAddrs;
  });
  unsubscribe();
  for await (const addr of input.addrChanges) {
    void addr;
    break;
  }
  await input.online();
  await input.online({ timeoutMs: 5000 });
}
