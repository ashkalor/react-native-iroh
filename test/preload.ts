// bun test preload (wired via bunfig.toml): stubs the nitro module boundary
// so importing library source never pulls in react-native (whose Flow-typed
// entry point bun cannot parse). Tests inject a mock IrohBinding instead of
// ever touching this stub.
import { mock } from "bun:test";

mock.module("react-native-nitro-modules", () => ({
  NitroModules: {
    createHybridObject: () => {
      throw new Error(
        "react-native-nitro-modules is not available under bun test; inject a mock IrohBinding",
      );
    },
  },
}));
