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
 * Returns the process-wide `Iroh` hybrid object, creating it on first use.
 */
export function getRawIroh(): IrohSpec {
  singleton ??= NitroModules.createHybridObject<IrohSpec>("Iroh");
  return singleton;
}
