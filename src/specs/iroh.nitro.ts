import type { HybridObject } from "react-native-nitro-modules";

// The published react-native-nitro-modules@0.36.1 types don't include "rust"
// in PlatformSpec yet — only the nitrogen fork's Rust codegen understands it.
// Types-only skew; the native runtime is unaffected.
// @ts-expect-error TS2344: "rust" is not in the pinned PlatformSpec union
export interface Iroh extends HybridObject<{ ios: "rust"; android: "rust" }> {
  nodeId(): string;
}
