// Ambient declarations for the bun test runtime. The root project compiles
// without @types/node (it is a react-native library), so the two runtime
// facilities the tests rely on are declared minimally here. This directory
// is excluded from builds and from the published package.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

interface ImportMeta {
  /** Bun runtime: absolute directory of the current file. */
  readonly dir: string;
}

declare module "bun:test" {
  // Importing anything from "bun:test" opts a file out of the runtime's global
  // test-function injection, so the describe/it/expect a file uses must be
  // imported too. Their shapes are reused from the @types/jest globals.
  export const mock: {
    module(specifier: string, factory: () => unknown): void;
  };
  export const describe: typeof globalThis.describe;
  export const it: typeof globalThis.it;
  export const expect: typeof globalThis.expect;
}
