import { getIrohErrorCode, IrohError } from "../errors";
import type { IrohErrorCode, IrohErrorKind } from "../errors";

const KNOWN_CASES: [IrohErrorCode, IrohErrorKind][] = [
  [1000, "internal"],
  [1001, "invalid-handle"],
  [1002, "invalid-ticket"],
  [1003, "invalid-path"],
  [2000, "endpoint-bind"],
  [3000, "blob-import"],
  [3001, "blob-download"],
  [3002, "blob-export"],
  [3003, "cancelled"],
];

describe("IrohError.from", () => {
  it("parses every stable code into its kind, preserving the message", () => {
    for (const [code, kind] of KNOWN_CASES) {
      const native = new Error(`[iroh:${code}] something happened`);
      const error = IrohError.from(native);
      expect(error.code).toBe(code);
      expect(error.kind).toBe(kind);
      expect(error.message).toBe(`[iroh:${code}] something happened`);
    }
  });

  it("maps unknown codes to internal, preserving the message", () => {
    const error = IrohError.from(new Error("[iroh:9999] mystery failure"));
    expect(error.code).toBe(1000);
    expect(error.kind).toBe("internal");
    expect(error.message).toBe("[iroh:9999] mystery failure");
  });

  it("maps untagged errors to internal", () => {
    const error = IrohError.from(new Error("plain failure"));
    expect(error.code).toBe(1000);
    expect(error.kind).toBe("internal");
    expect(error.message).toBe("plain failure");
  });

  it("stringifies non-Error values and maps them to internal", () => {
    const error = IrohError.from("string failure");
    expect(error.code).toBe(1000);
    expect(error.kind).toBe("internal");
    expect(error.message).toBe("string failure");
  });

  it("still parses codes from non-Error values", () => {
    const error = IrohError.from("[iroh:1002] bad ticket");
    expect(error.code).toBe(1002);
    expect(error.kind).toBe("invalid-ticket");
  });

  it("returns existing IrohError instances unchanged", () => {
    const original = new IrohError(3003, "[iroh:3003] cancelled");
    expect(IrohError.from(original)).toBe(original);
  });
});

describe("IrohError instances", () => {
  it("supports instanceof against IrohError and Error", () => {
    const error: unknown = IrohError.from(new Error("[iroh:2000] bind failed"));
    expect(error instanceof IrohError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  it("has name IrohError and a correlated code/kind from the constructor", () => {
    const error = new IrohError(1003, "[iroh:1003] not a path");
    expect(error.name).toBe("IrohError");
    expect(error.code).toBe(1003);
    expect(error.kind).toBe("invalid-path");
  });
});

describe("getIrohErrorCode (raw escape hatch compat)", () => {
  it("extracts the numeric code from tagged errors", () => {
    expect(getIrohErrorCode(new Error("[iroh:1002] bad ticket"))).toBe(1002);
  });

  it("returns undefined for untagged errors and non-errors", () => {
    expect(getIrohErrorCode(new Error("nope"))).toBeUndefined();
    expect(getIrohErrorCode(42)).toBeUndefined();
  });
});
