import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AuthorId,
  Doc,
  DocContentStatus,
  DocEntry,
  DocLiveEvent,
  DocSubscribeOptions,
  DocSubscription,
} from "../docs";
import type { EndpointAddr } from "../endpoint";
import { IrohError } from "../errors";
import { appendCapped, DEFAULT_RETAINED, toError } from "./internal";

/** Lifecycle phase of a {@link useDoc} subscription. */
export type DocStatus = "loading" | "ready" | "closed" | "error";

/**
 * One entry in a {@link useDoc} view: the underlying {@link DocEntry} plus the
 * local availability of its content as learned from live events.
 */
export interface DocEntryView extends DocEntry {
  /**
   * Whether this entry's content is available locally, when a live event has
   * reported it (`"complete"` for a local write, the peer-reported status for a
   * remote insert, then `"complete"` once a matching content-ready lands).
   * `undefined` for entries seeded from the initial read, which do not carry a
   * status.
   */
  readonly contentStatus?: DocContentStatus;
}

/** Options for {@link useDoc}: the underlying subscribe options plus how many
 * events to retain. */
export interface UseDocOptions extends DocSubscribeOptions {
  /**
   * Maximum retained events in {@link UseDocResult.events}. Older entries are
   * dropped past this cap. Defaults to {@link DEFAULT_RETAINED} (500). The live
   * `entries` view is always complete and is not capped by this.
   */
  retain?: number;
}

/** The reactive result of {@link useDoc}. */
export interface UseDocResult {
  /**
   * The document's current entries, one per author+key, seeded from an initial
   * {@link Doc.getMany} read and kept current as live events arrive. An insert
   * upserts; an empty entry (a delete tombstone) removes; a content-ready
   * updates {@link DocEntryView.contentStatus}. A fresh array on each change.
   */
  readonly entries: DocEntryView[];
  /**
   * Raw live events in arrival order, oldest first, capped at the most recent
   * {@link UseDocOptions.retain} (default 500) so a busy document stays bounded
   * in memory.
   */
  readonly events: DocLiveEvent[];
  /**
   * `"loading"` until the initial read seeds {@link entries}, then `"ready"`.
   * Becomes `"closed"` if the subscription ends underneath the component (the
   * usual cause is the endpoint being closed while this component stays
   * mounted). `"error"` if subscribing, the initial read, or the stream fails.
   */
  readonly status: DocStatus;
  /** The failure, present only when `status` is `"error"`. */
  readonly error?: Error;
  /**
   * Writes `value` under `key` as `author`, resolving with the content hash.
   * Rejects with an {@link IrohError} of kind `"invalid-handle"` when no
   * document is attached.
   */
  readonly setBytes: (
    author: AuthorId | string,
    key: string,
    value: ArrayBuffer,
  ) => Promise<string>;
  /**
   * Deletes every entry for `author` whose key equals or starts with `prefix`,
   * resolving with the number removed. Rejects like {@link setBytes} when no
   * document is attached.
   */
  readonly deletePrefix: (author: AuthorId | string, prefix: string) => Promise<number>;
  /** Reads `entry`'s content out of the blob store (the opt-in fetch). */
  readonly getContent: (entry: DocEntry) => Promise<ArrayBuffer>;
  /** Starts (or refreshes) live sync of the document with `peers`. */
  readonly startSync: (peers?: readonly EndpointAddr[]) => Promise<void>;
  /** Stops live sync of the document and leaves its gossip swarm. */
  readonly leave: () => Promise<void>;
}

/** The stable author+key identity of an entry within a document. */
function entryKey(entry: DocEntry): string {
  return `${entry.author}\n${entry.key}`;
}

/**
 * Upserts `entry` into `byKey`, or removes it when it is an empty tombstone
 * (iroh-docs represents a delete as an entry with zero-length content).
 */
function upsertEntry(
  byKey: Map<string, DocEntryView>,
  entry: DocEntry,
  contentStatus: DocContentStatus | undefined,
): void {
  const key = entryKey(entry);
  if (entry.size === 0) {
    byKey.delete(key);
    return;
  }
  byKey.set(key, contentStatus === undefined ? entry : { ...entry, contentStatus });
}

/** Folds one live event into the entry map: inserts upsert, empty entries
 * remove, and content-ready flips matching entries to available. */
function applyEvent(byKey: Map<string, DocEntryView>, event: DocLiveEvent): void {
  switch (event.type) {
    case "insert-local":
      upsertEntry(byKey, event.entry, "complete");
      break;
    case "insert-remote":
      upsertEntry(byKey, event.entry, event.contentStatus);
      break;
    case "content-ready":
      for (const [key, entry] of byKey) {
        if (entry.hash === event.hash && entry.contentStatus !== "complete") {
          byKey.set(key, { ...entry, contentStatus: "complete" });
        }
      }
      break;
    default:
      break;
  }
}

/**
 * Reflects a {@link Doc} as reactive component state: it seeds the document's
 * current entries from a {@link Doc.getMany} read, subscribes to the live event
 * stream for the lifetime of the calling component, and keeps the `entries`
 * view current as events arrive (insert upserts, an empty entry removes,
 * content-ready updates availability). It also drains raw events into a capped
 * `events` array and exposes stable write/read callbacks.
 *
 * The document is subscribed on mount (and whenever `doc` or the options
 * change) and unsubscribed on unmount / change; no state is set after unmount.
 * Subscribing does not start sync: call {@link UseDocResult.startSync}.
 *
 * Pass `null` for `doc` (e.g. while it is still being opened) to hold off; the
 * result stays empty and `"loading"` until a document is provided.
 */
export function useDoc(doc: Doc | null, options?: UseDocOptions): UseDocResult {
  const [entries, setEntries] = useState<DocEntryView[]>([]);
  const [events, setEvents] = useState<DocLiveEvent[]>([]);
  const [status, setStatus] = useState<DocStatus>("loading");
  const [error, setError] = useState<Error | undefined>(undefined);

  // The document, held in a ref so the write/read callbacks stay referentially
  // stable across renders while still reaching the current document.
  const docRef = useRef(doc);
  docRef.current = doc;

  // Deep-compare options so an inline object does not re-subscribe every
  // render; the effect reads the latest object through a ref.
  const optionsKey = JSON.stringify(options ?? {});
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    setEntries([]);
    setEvents([]);
    setStatus("loading");
    setError(undefined);
    if (doc === null) {
      return;
    }

    let active = true;
    const retain = optionsRef.current?.retain ?? DEFAULT_RETAINED;
    const byKey = new Map<string, DocEntryView>();
    const flushEntries = (): void => {
      if (active) {
        setEntries(Array.from(byKey.values()));
      }
    };
    const fail = (value: unknown): void => {
      if (!active) {
        return;
      }
      setStatus("error");
      setError(toError(value));
    };
    // The event stream ends when the subscription is torn down. If that happens
    // while this component is still mounted (endpoint.close(), say), the hook
    // must stop claiming to be live.
    const markClosed = (): void => {
      if (!active) {
        return;
      }
      setStatus((prev) => (prev === "error" ? prev : "closed"));
    };

    let subscription: DocSubscription;
    try {
      subscription = doc.subscribe(optionsRef.current);
    } catch (subscribeError) {
      fail(subscribeError);
      return;
    }

    // A start that never completes is a failure, not a teardown: surface it. A
    // real teardown clears `active` first, so it stays silent.
    void subscription.started.then(undefined, (startError: unknown) => fail(startError));

    // Seed from the current replica state, then let live events accumulate on
    // top. Events that land between subscribe and this read are buffered in the
    // subscription and drained below; upsert/remove are keyed and idempotent, so
    // re-applying one already reflected in the seed is harmless.
    void (async () => {
      try {
        const initial = await doc.getMany();
        if (!active) {
          return;
        }
        for (const entry of initial) {
          upsertEntry(byKey, entry, undefined);
        }
        flushEntries();
        setStatus((prev) => (prev === "loading" ? "ready" : prev));
      } catch (readError) {
        fail(readError);
      }
    })();

    void (async () => {
      try {
        for await (const event of subscription.events) {
          if (!active) {
            break;
          }
          applyEvent(byKey, event);
          flushEntries();
          setEvents((prev) => appendCapped(prev, event, retain));
        }
        markClosed();
      } catch (streamError) {
        fail(streamError);
      }
    })();

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [doc, optionsKey]);

  const setBytes = useCallback(
    async (author: AuthorId | string, key: string, value: ArrayBuffer): Promise<string> =>
      requireDoc(docRef.current).setBytes(author, key, value),
    [],
  );
  const deletePrefix = useCallback(
    async (author: AuthorId | string, prefix: string): Promise<number> =>
      requireDoc(docRef.current).deletePrefix(author, prefix),
    [],
  );
  const getContent = useCallback(
    async (entry: DocEntry): Promise<ArrayBuffer> => requireDoc(docRef.current).getContent(entry),
    [],
  );
  const startSync = useCallback(
    async (peers?: readonly EndpointAddr[]): Promise<void> =>
      requireDoc(docRef.current).startSync(peers),
    [],
  );
  const leave = useCallback(async (): Promise<void> => requireDoc(docRef.current).leave(), []);

  return { entries, events, status, error, setBytes, deletePrefix, getContent, startSync, leave };
}

/** Rejects a callback with a typed error when no document is attached, instead
 * of a raw null-dereference. */
function requireDoc(doc: Doc | null): Doc {
  if (doc === null) {
    throw new IrohError(1001, "no document is attached to this hook");
  }
  return doc;
}
