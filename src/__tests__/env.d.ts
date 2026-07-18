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
