import { useCallback, useEffect, useRef, useState } from "react";

import type { Doc, DocTicket, NamespaceId } from "../docs";
import type { Endpoint } from "../endpoint";
import { IrohError } from "../errors";
import { toError } from "./internal";

/** The reactive result of {@link useDocs}. */
export interface UseDocsResult {
  /**
   * The {@link NamespaceId} of every document on the endpoint, as of the last
   * {@link refresh}. Refreshed on mount and after {@link create}, {@link import},
   * and {@link dropDoc}; there is no push stream for the document list, so call
   * {@link refresh} to pick up changes made elsewhere.
   */
  readonly docs: NamespaceId[];
  /** The failure of the last list/mutation, present only after one fails. */
  readonly error?: Error;
  /** Creates a new document, refreshes {@link docs}, and resolves with a handle. */
  create(): Promise<Doc>;
  /** Imports the document named by `ticket`, refreshes {@link docs}, and resolves
   * with a handle. */
  import(ticket: DocTicket | string): Promise<Doc>;
  /** Opens `namespaceId`, resolving with a handle or `null` if this node does not
   * have it. Does not change {@link docs}. */
  open(namespaceId: NamespaceId | string): Promise<Doc | null>;
  /** Removes `namespaceId` and its entries from this node, then refreshes
   * {@link docs}. */
  dropDoc(namespaceId: NamespaceId | string): Promise<void>;
  /** Re-reads the document list into {@link docs}. */
  refresh(): Promise<void>;
}

/**
 * Reflects the documents on `endpoint` as reactive component state. It lists the
 * documents on mount and exposes stable {@link UseDocsResult.create},
 * {@link UseDocsResult.import}, {@link UseDocsResult.open},
 * {@link UseDocsResult.dropDoc}, and {@link UseDocsResult.refresh} callbacks that
 * proxy the endpoint's {@link import("../docs").DocsApi}, refreshing the list
 * after each mutation.
 *
 * The document list is not push-based, so changes made outside this hook (or on
 * another node) are not reflected until {@link UseDocsResult.refresh} runs.
 *
 * Pass `null` for `endpoint` (e.g. while it is still being created) to hold off;
 * the list stays empty until an endpoint is provided.
 */
export function useDocs(endpoint: Endpoint | null): UseDocsResult {
  const [docs, setDocs] = useState<NamespaceId[]>([]);
  const [error, setError] = useState<Error | undefined>(undefined);

  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  const activeRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    const current = endpointRef.current;
    if (current === null) {
      if (activeRef.current) {
        setDocs([]);
      }
      return;
    }
    try {
      const list = await current.docs.list();
      if (activeRef.current) {
        setDocs(list);
      }
    } catch (listError) {
      if (activeRef.current) {
        setError(toError(listError));
      }
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    setError(undefined);
    void refresh();
    return () => {
      activeRef.current = false;
    };
  }, [endpoint, refresh]);

  const create = useCallback(async (): Promise<Doc> => {
    const doc = await requireEndpoint(endpointRef.current).docs.create();
    await refresh();
    return doc;
  }, [refresh]);

  const importDoc = useCallback(
    async (ticket: DocTicket | string): Promise<Doc> => {
      const doc = await requireEndpoint(endpointRef.current).docs.import(ticket);
      await refresh();
      return doc;
    },
    [refresh],
  );

  const open = useCallback(
    async (namespaceId: NamespaceId | string): Promise<Doc | null> =>
      requireEndpoint(endpointRef.current).docs.open(namespaceId),
    [],
  );

  const dropDoc = useCallback(
    async (namespaceId: NamespaceId | string): Promise<void> => {
      await requireEndpoint(endpointRef.current).docs.dropDoc(namespaceId);
      await refresh();
    },
    [refresh],
  );

  return { docs, error, create, import: importDoc, open, dropDoc, refresh };
}

/** Rejects a callback with a typed error when no endpoint is attached. */
function requireEndpoint(endpoint: Endpoint | null): Endpoint {
  if (endpoint === null) {
    throw new IrohError(1001, "no endpoint is attached to this hook");
  }
  return endpoint;
}
