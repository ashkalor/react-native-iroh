import { NitroModules } from "react-native-nitro-modules";
import type { Iroh as IrohSpec } from "./specs/iroh.nitro";

export const Iroh = NitroModules.createHybridObject<IrohSpec>("Iroh");
