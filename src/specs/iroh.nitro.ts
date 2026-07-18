import type { HybridObject } from "react-native-nitro-modules";

/**
 * Which network infrastructure an endpoint uses.
 *
 * - `standard`: n0 relay servers and address lookup services (production).
 * - `isolated`: no relays, no address lookup; peers are only reachable via
 *   direct addresses embedded in tickets (tests / LAN-only setups).
 */
export type NetworkProfile = "standard" | "isolated";

/**
 * Configuration for {@link Iroh.createEndpoint}.
 */
export interface EndpointConfig {
  /** Network infrastructure profile. */
  profile: NetworkProfile;
  /**
   * Absolute directory path for the persistent blob store. Omit to keep
   * blobs in memory (they are lost when the endpoint closes).
   */
  blobStoreDir?: string;
}

/**
 * The react-native-iroh native bridge (v0.1.0 surface).
 *
 * Errors: every rejected Promise (and every thrown sync error) carries a
 * message of the form `[iroh:<code>] <detail>`, where `<code>` is a stable
 * numeric error code (1000-1003 generic, 2000 endpoint, 3000-3003 blobs).
 * Parse it with `/\[iroh:(\d+)\]/`.
 */
// The published react-native-nitro-modules@0.36.1 types don't include "rust"
// in PlatformSpec yet — only the nitrogen fork's Rust codegen understands it.
// Types-only skew; the native runtime is unaffected.
// @ts-expect-error TS2344: "rust" is not in the pinned PlatformSpec union
export interface Iroh extends HybridObject<{ ios: "rust"; android: "rust" }> {
  /**
   * Creates an endpoint (binds sockets, loads the blob store) and resolves
   * with its opaque handle. Handles are never `0` and never reused.
   */
  createEndpoint(config: EndpointConfig): Promise<number>;
  /** Returns the endpoint's node id (its public key) as a string. Cheap and synchronous. */
  nodeId(endpoint: number): string;
  /** Whether `endpoint` refers to a live (not yet closed) endpoint. */
  isEndpointOpen(endpoint: number): boolean;
  /**
   * Closes an endpoint: shuts down its router, sockets and blob store. The
   * handle is invalid from this point on.
   */
  closeEndpoint(endpoint: number): Promise<void>;
  /**
   * Imports the file at absolute `path` into the endpoint's blob store and
   * resolves with a shareable ticket string. On the `standard` profile this
   * waits (bounded) for the endpoint to come online first, so the ticket
   * contains dialable addresses.
   */
  shareBlob(endpoint: number, path: string): Promise<string>;
  /**
   * Downloads the blob described by `ticket` into absolute `destPath`.
   *
   * `onStart` fires once with the transfer's handle (usable with
   * {@link cancelDownload}) before any progress is reported. `onProgress`
   * reports cumulative payload bytes received; events are coalesced natively
   * to at most ~30 per second, the latest value is always flushed before the
   * Promise settles, and the total size is unknown in v0.1.0. The returned
   * Promise settles exactly once: resolved on success, rejected on failure
   * or cancellation (code 3003).
   */
  downloadBlob(
    endpoint: number,
    ticket: string,
    destPath: string,
    onStart: (transferId: number) => void,
    onProgress: (bytesReceived: number) => void,
  ): Promise<void>;
  /**
   * Requests cancellation of an in-flight download. Idempotent: calling it
   * on an already-finished (or unknown) transfer is a no-op. A cancelled
   * transfer's Promise rejects with code 3003.
   */
  cancelDownload(transferId: number): void;
}
