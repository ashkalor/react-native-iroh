import { readFileSync } from "node:fs";
import { IROH_VERSION } from "../version";

describe("IROH_VERSION", () => {
  it("matches the iroh version pinned in the crate manifest", () => {
    const manifestPath = `${import.meta.dir}/../../rust/iroh-rn-core/Cargo.toml`;
    const manifest = readFileSync(manifestPath, "utf8");
    const pinned = /^iroh = "=(\d+\.\d+\.\d+)"$/m.exec(manifest);
    expect(pinned).not.toBeNull();
    expect(IROH_VERSION).toBe(pinned![1]!);
  });

  it("is a plain semver string", () => {
    expect(IROH_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
