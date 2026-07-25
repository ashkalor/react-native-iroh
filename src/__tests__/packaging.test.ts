import pkg from "../../package.json";

type Target = { types: string; default: string };
type Conditions = { require: Target; import: Target };

const SUBPATHS = [".", "./hooks"] as const;

const conditionsFor = (subpath: (typeof SUBPATHS)[number]): Conditions =>
  pkg.exports[subpath] as unknown as Conditions;

describe("package exports", () => {
  it("gives each entry point a build and types per module system", () => {
    for (const subpath of SUBPATHS) {
      const conditions = conditionsFor(subpath);
      expect(Object.keys(conditions)).toEqual(["require", "import"]);
      expect(conditions.require.default).toMatch(/^\.\/lib\/commonjs\//);
      expect(conditions.require.types).toMatch(/^\.\/lib\/typescript\/commonjs\//);
      expect(conditions.import.default).toMatch(/^\.\/lib\/module\//);
      expect(conditions.import.types).toMatch(/^\.\/lib\/typescript\/module\//);
    }
  });

  // Node treats "require" and "import" as mutually exclusive, so their order is
  // irrelevant there. Metro enables BOTH at once and takes the first key that
  // matches, so listing "import" first would silently move React Native onto
  // the ESM build. Keep "require" ahead of it.
  it("keeps require ahead of import so Metro resolves the CommonJS build", () => {
    for (const subpath of SUBPATHS) {
      const keys = Object.keys(conditionsFor(subpath));
      expect(keys.indexOf("require")).toBeLessThan(keys.indexOf("import"));
    }
  });

  // The ESM build is only loadable if bob's `esm` option stays on for the
  // module target: it is what writes lib/module/package.json ({"type":"module"})
  // and the explicit ".js" specifiers Node requires. Without it the emitted
  // files parse as CommonJS and every ESM consumer breaks.
  it("keeps the module target building real ESM", () => {
    const targets = pkg["react-native-builder-bob"].targets as unknown[];
    const module = targets.find(
      (target): target is [string, { esm?: boolean }] =>
        Array.isArray(target) && target[0] === "module",
    );
    expect(module?.[1]?.esm).toBe(true);
  });

  // That these paths exist is enforced by `bob build`, which fails the build
  // when a field points at a missing file. Here we only pin that they stay
  // inside the published `lib` directory.
  it("points the legacy fields into the shipped lib directory", () => {
    expect(pkg.files).toContain("lib");
    for (const field of [pkg.main, pkg.module, pkg.types]) {
      expect(field.startsWith("./lib/")).toBe(true);
    }
  });
});
