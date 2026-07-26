import { useEffect, useRef, useState } from "react";

import { Endpoint, type EndpointOptions } from "../endpoint";
import type { IrohBinding } from "../native";
import { toError } from "./internal";

/** Lifecycle phase of a {@link useEndpoint} endpoint. */
export type EndpointStatus = "creating" | "ready" | "error";

/** The reactive result of {@link useEndpoint}. */
export interface UseEndpointResult {
  /** The live endpoint once created, or `null` while creating or on error. */
  readonly endpoint: Endpoint | null;
  /** `"creating"` on mount, then `"ready"`, or `"error"` if creation failed. */
  readonly status: EndpointStatus;
  /** The creation error, present only when `status` is `"error"`. */
  readonly error?: Error;
}

/**
 * Creates an {@link Endpoint} for the lifetime of the calling component:
 * {@link Endpoint.create} runs on mount and {@link Endpoint.close} runs on
 * unmount. The endpoint is re-created only when the (deep-compared) `options`
 * change, so passing an inline options object does not thrash it.
 *
 * The hook is safe under React StrictMode's deliberate double-invoke: an
 * endpoint whose effect is torn down before creation resolves is closed
 * immediately rather than leaked, and no state is set after unmount.
 *
 * @param options Endpoint configuration; see {@link EndpointOptions}. Defaults
 *   to the `"n0"` preset with an in-memory blob store.
 * @param binding Advanced: an alternative native binding, primarily for tests.
 *   App code should omit it to use the real native module.
 */
export function useEndpoint(options?: EndpointOptions, binding?: IrohBinding): UseEndpointResult {
  const [result, setResult] = useState<UseEndpointResult>({
    endpoint: null,
    status: "creating",
  });

  // Deep-compare options so an inline object does not re-create the endpoint
  // every render; the effect reads the latest object through a ref.
  const optionsKey = JSON.stringify(options ?? {});
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    let created: Endpoint | null = null;
    setResult({ endpoint: null, status: "creating" });

    Endpoint.create(optionsRef.current ?? {}, binding).then(
      (endpoint) => {
        if (cancelled) {
          // Unmounted (or options changed) before creation resolved: close the
          // now-orphaned endpoint instead of leaking it, and set no state.
          void endpoint.close();
          return;
        }
        created = endpoint;
        setResult({ endpoint, status: "ready" });
      },
      (error: unknown) => {
        if (cancelled) {
          return;
        }
        setResult({ endpoint: null, status: "error", error: toError(error) });
      },
    );

    return () => {
      cancelled = true;
      // If creation already resolved, close the live endpoint; if it has not,
      // the `cancelled` guard above closes it when it does.
      if (created !== null) {
        void created.close();
      }
    };
    // optionsKey stands in for a deep compare of `options`; `binding` is a
    // stable escape hatch. optionsRef is intentionally read, not depended on.
  }, [optionsKey, binding]);

  return result;
}
