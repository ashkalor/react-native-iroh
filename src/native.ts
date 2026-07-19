import { NitroModules } from "react-native-nitro-modules";
import type { Iroh as IrohSpec } from "./specs/iroh.nitro";

/**
 * The minimal native surface the TypeScript layer depends on: a structural
 * subset of the `Iroh` hybrid object. {@link Endpoint} accepts any
 * implementation of this interface, which lets tests substitute a mock while
 * app code transparently gets the real native singleton.
 */
export type IrohBinding = Pick<
  IrohSpec,
  | "createEndpoint"
  | "endpointId"
  | "isEndpointOpen"
  | "closeEndpoint"
  | "shareBlob"
  | "downloadBlob"
  | "cancelDownload"
>;

let singleton: IrohSpec | undefined;

/**
 * Unstable escape hatch: returns the process-wide raw `Iroh` hybrid object,
 * the full native bridge surface, without the queueing, error typing, or
 * lifecycle handling of the {@link Endpoint} class API.
 *
 * The native binding is instantiated lazily on the first call, never at
 * module import, so importing this package is side-effect-free and safe in
 * environments where the native module is absent (Node, SSR, unit tests).
 * Rejected Promises / thrown errors carry messages of the form
 * `[iroh:<code>] <detail>`; use {@link getIrohErrorCode} to recover the
 * stable numeric code. Prefer {@link Endpoint} for application code.
 */
export function getIroh(): IrohSpec {
  singleton ??= NitroModules.createHybridObject<IrohSpec>("Iroh");
  return singleton;
}
