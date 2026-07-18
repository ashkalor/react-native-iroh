import { NitroModules } from "react-native-nitro-modules";
import type { Iroh as IrohSpec } from "./specs/iroh.nitro";

export type { EndpointConfig, Iroh as IrohSpec, NetworkProfile } from "./specs/iroh.nitro";

/**
 * The `Iroh` hybrid object — the full native bridge surface.
 *
 * Rejected Promises / thrown errors carry messages of the form
 * `[iroh:<code>] <detail>`; use {@link getIrohErrorCode} to recover the
 * stable numeric code.
 */
export const Iroh = NitroModules.createHybridObject<IrohSpec>("Iroh");

const ERROR_CODE_PATTERN = /\[iroh:(\d+)\]/;

/**
 * Extracts the stable numeric iroh error code from an error thrown (or a
 * Promise rejection produced) by any {@link Iroh} method, or `undefined` if
 * the error did not originate from the iroh bridge.
 */
export function getIrohErrorCode(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = ERROR_CODE_PATTERN.exec(message);
  return match === null ? undefined : Number(match[1]);
}
