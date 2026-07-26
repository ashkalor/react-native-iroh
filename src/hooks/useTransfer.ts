import { useEffect, useState } from "react";

import type { Blobs, DownloadOptions } from "../endpoint";
import type { BlobTicket } from "../ticket";
import type { CollectionTransfer, FileProgress, Transfer } from "../transfer";
import { toError } from "./internal";

/** Lifecycle phase of a {@link useTransfer} download. */
export type TransferStatus = "idle" | "transferring" | "done" | "error";

/** The reactive state of a {@link useTransfer} download. */
export interface UseTransferState {
  /**
   * `"idle"` when no transfer is attached, `"transferring"` while in flight,
   * then `"done"` on success or `"error"` on failure/cancellation.
   */
  readonly status: TransferStatus;
  /** Cumulative payload bytes received so far. Non-decreasing; `0` when idle. */
  readonly bytesReceived: number;
  /** The transfer's total size in bytes, when the native layer reports one. */
  readonly totalBytes?: number;
  /**
   * Per-file progress, present only for a {@link CollectionTransfer}. A fresh
   * snapshot array on each update, so it is safe to render directly.
   */
  readonly files?: FileProgress[];
  /** The failure, present only when `status` is `"error"`. */
  readonly error?: Error;
}

const IDLE: UseTransferState = { status: "idle", bytesReceived: 0 };

/** Reads a collection transfer's live per-file snapshot; `undefined` for a
 * single-blob transfer. */
function readFiles(transfer: Transfer): FileProgress[] | undefined {
  return "files" in transfer ? (transfer as CollectionTransfer).files : undefined;
}

/** The state a transfer starts in: nothing received yet, per-file snapshot for
 * a collection. */
function startingState(transfer: Transfer | CollectionTransfer | null): UseTransferState {
  return transfer === null
    ? IDLE
    : { status: "transferring", bytesReceived: 0, files: readFiles(transfer) };
}

/**
 * Reflects a {@link Transfer} (or {@link CollectionTransfer}) as reactive
 * component state: progress events update {@link UseTransferState.bytesReceived}
 * (and {@link UseTransferState.files} for a collection), completion moves
 * `status` to `"done"`, and a failure or cancellation moves it to `"error"`.
 *
 * The hook subscribes on mount and whenever `transfer` changes, and
 * unsubscribes on unmount / transfer change; it never starts or cancels the
 * transfer itself (pass `null` to detach and report `"idle"`). To start a
 * download and observe it in one call, see {@link useDownload}.
 */
export function useTransfer(transfer: Transfer | CollectionTransfer | null): UseTransferState {
  const [state, setState] = useState<UseTransferState>(() => startingState(transfer));

  useEffect(() => {
    if (transfer === null) {
      setState(IDLE);
      return;
    }
    let active = true;
    setState(startingState(transfer));

    const unsubscribe = transfer.onProgress((event) => {
      if (!active) {
        return;
      }
      setState((prev) => ({
        status: prev.status === "done" || prev.status === "error" ? prev.status : "transferring",
        bytesReceived: event.bytesReceived,
        totalBytes: event.totalBytes,
        files: readFiles(transfer),
      }));
    });

    transfer.done.then(
      () => {
        if (active) {
          setState((prev) => ({ ...prev, status: "done", files: readFiles(transfer) }));
        }
      },
      (error: unknown) => {
        if (active) {
          setState((prev) => ({ ...prev, status: "error", error: toError(error) }));
        }
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [transfer]);

  return state;
}

/**
 * Convenience over {@link useTransfer}: starts a single-blob download on mount
 * (via {@link Blobs.download}) and returns its live {@link UseTransferState}.
 * The download is cancelled on unmount, or when any argument changes (a new one
 * then starts). Pass `null` for any argument to hold off starting.
 *
 * @param blobs The endpoint's {@link Blobs} API (e.g. `endpoint.blobs`).
 * @param ticket The blob ticket to fetch.
 * @param destPath Absolute destination file path.
 * @param options Optional {@link DownloadOptions} (e.g. an `AbortSignal`).
 */
export function useDownload(
  blobs: Blobs | null,
  ticket: BlobTicket | string | null,
  destPath: string | null,
  options?: DownloadOptions,
): UseTransferState {
  const [transfer, setTransfer] = useState<Transfer | null>(null);

  useEffect(() => {
    if (blobs === null || ticket === null || destPath === null) {
      setTransfer(null);
      return;
    }
    const started = blobs.download(ticket, destPath, options);
    setTransfer(started);
    return () => {
      started.cancel();
      setTransfer(null);
    };
    // `options` is intentionally not a dependency: re-running on a new inline
    // options object each render would restart the download. It is captured
    // once when the download starts (matching Blobs.download's own semantics).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blobs, ticket, destPath]);

  return useTransfer(transfer);
}
