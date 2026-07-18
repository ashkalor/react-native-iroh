import { describe, expect, it, mock } from "bun:test";

// Count native-hybrid instantiations at the nitro boundary. Importing the
// package must never cross it; only an explicit getIroh() call may.
let createHybridObjectCalls = 0;
mock.module("react-native-nitro-modules", () => ({
  NitroModules: {
    createHybridObject: () => {
      createHybridObjectCalls += 1;
      return {};
    },
  },
}));

describe("package import", () => {
  it("does not instantiate the native hybrid object until first getIroh() use", async () => {
    // Importing the package entry point after the counting stub is installed
    // must not cross the nitro boundary.
    const iroh = await import("../index");
    expect(createHybridObjectCalls).toBe(0);

    // The binding is created lazily on the first getIroh() call...
    const first = iroh.getIroh();
    expect(createHybridObjectCalls).toBe(1);

    // ...and is a process-wide singleton reused by later calls.
    const second = iroh.getIroh();
    expect(createHybridObjectCalls).toBe(1);
    expect(second).toBe(first);
  });
});
