/**
 * Compile-time-only tests for the public API surface. This file is included
 * in `bun run typecheck` but never executed (its name intentionally does not
 * match the test runner's `*.test.ts` pattern) and is excluded from builds.
 */
import { Endpoint } from "../endpoint";
import type { EndpointOptions } from "../endpoint";
import { getIrohErrorCode, IrohError } from "../errors";
import type { IrohErrorCase, IrohErrorCode, IrohErrorKind } from "../errors";
import type { IrohBinding } from "../native";
import type { ProgressEvent, Transfer } from "../transfer";

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
  Expect<Equal<typeof endpoint.nodeId, string>>,
  Expect<Equal<typeof endpoint.isOpen, boolean>>,
  Expect<Equal<ReturnType<typeof endpoint.close>, Promise<void>>>,
  Expect<Equal<ReturnType<typeof endpoint.shareBlob>, Promise<string>>>,
  Expect<Equal<ReturnType<typeof endpoint.downloadBlob>, Transfer>>,
  // Transfer surface.
  Expect<Equal<typeof transfer.promise, Promise<void>>>,
  Expect<Equal<typeof transfer.progress, AsyncIterable<ProgressEvent>>>,
  Expect<Equal<typeof transfer.isSettled, boolean>>,
  Expect<Equal<ReturnType<typeof transfer.cancel>, void>>,
  Expect<Equal<ReturnType<typeof transfer.onProgress>, () => void>>,
  Expect<Equal<ProgressEvent, { readonly bytesReceived: number }>>,
  // Config optionality.
  Expect<
    Equal<
      Required<EndpointOptions>,
      { profile: "standard" | "isolated"; blobStoreDir: string; maxConcurrentDownloads: number }
    >
  >,
  Expect<Equal<typeof options.profile, "standard" | "isolated">>,
  // Nothing on the public surface degrades to `any`.
  Expect<NotAny<typeof endpoint.nodeId>>,
  Expect<NotAny<Awaited<typeof transfer.promise>>>,
  Expect<NotAny<Parameters<typeof endpoint.downloadBlob>[0]>>,
  Expect<NotAny<Parameters<IrohBinding["downloadBlob"]>[0]>>,
  Expect<NotAny<InstanceType<typeof IrohError>["code"]>>,
];

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

/** Every argument of Endpoint.create is optional; bad profiles are rejected. */
export async function createSignatures(binding: IrohBinding): Promise<void> {
  const bare = await Endpoint.create();
  const empty = await Endpoint.create({});
  const full = await Endpoint.create(
    { profile: "isolated", blobStoreDir: "/data/store", maxConcurrentDownloads: 2 },
    binding,
  );
  // @ts-expect-error unknown profile names are rejected at compile time
  await Endpoint.create({ profile: "custom" });
  // @ts-expect-error unknown option keys are rejected at compile time
  await Endpoint.create({ maxDownloads: 4 });
  void bare;
  void empty;
  void full;
}

/** The progress stream is directly usable in `for await`. */
export async function progressIsAsyncIterable(input: Transfer): Promise<number> {
  let latest = 0;
  for await (const event of input.progress) {
    latest = event.bytesReceived;
  }
  return latest;
}
