import { readFileSync } from "node:fs";
import { DEFAULT_MAX_CONCURRENT_DOWNLOADS } from "../endpoint";
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

describe("documented defaults", () => {
  // The README claimed a download cap of 4 for an entire release cycle after
  // the code moved to 32, because nothing tied the prose to the constant.
  it("README quotes the real DEFAULT_MAX_CONCURRENT_DOWNLOADS everywhere", () => {
    const readme = readFileSync(`${import.meta.dir}/../../README.md`, "utf8").replace(/\s+/g, " ");
    const claims = [...readme.matchAll(/cap(?:ped)?[^.]{0,120}?\(default:? `?(\d+)`?/g)].map(
      (match) => match[1]!,
    );

    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(claims)]).toEqual([String(DEFAULT_MAX_CONCURRENT_DOWNLOADS)]);
  });
});
