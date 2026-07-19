import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Endpoint, IrohError, type CollectionTransfer, type FileProgress } from "react-native-iroh";
import { e2eEvent, e2eReport } from "./markers";
import { FILES_DIR, SYSTEM_FILE_CANDIDATES } from "./paths";
import { sectionStyles } from "./theme";

/** Where the collection demo's endpoints keep their blob stores. */
const STORE_ROOT = `${FILES_DIR}/iroh-collections`;
/** Where downloaded children land (must be an existing directory). */
const DEST_DIR = FILES_DIR;

type DemoState =
  | { phase: "idle" }
  | { phase: "running"; step: string }
  | { phase: "downloading"; ticket: string; transfer: CollectionTransfer }
  | { phase: "done"; ticket: string; files: number; ok: boolean }
  | { phase: "error"; message: string };

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Live per-file breakdown of a {@link CollectionTransfer}. Isolated in its own
 * leaf so the ~30/s aggregate progress events re-render only this subtree.
 * Reads {@link CollectionTransfer.files} (a fresh snapshot) on every event.
 */
function CollectionProgress({ transfer }: { transfer: CollectionTransfer }): React.JSX.Element {
  const [files, setFiles] = useState<FileProgress[]>(transfer.files);

  useEffect(() => {
    let alive = true;
    const sync = (): void => {
      if (alive) {
        setFiles(transfer.files);
      }
    };
    const unsubscribe = transfer.onProgress(sync);
    // Settlement flips the last files to done without a further progress event.
    transfer.promise.then(sync, sync);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [transfer]);

  const total = files.reduce((sum, file) => sum + file.bytesReceived, 0);
  return (
    <View style={styles.fileList} testID="collection-files">
      {files.map((file) => (
        <View key={file.name} style={styles.fileRow}>
          <Text style={styles.fileName} numberOfLines={1}>
            {file.done ? "[done] " : "[....] "}
            {file.name}
          </Text>
          <Text style={styles.fileBytes}>{formatBytes(file.bytesReceived)}</Text>
        </View>
      ))}
      <Text style={sectionStyles.dimText}>Aggregate received: {formatBytes(total)}</Text>
    </View>
  );
}

/**
 * Collections demo: bundles several local files into one ticket with
 * {@link Endpoint.blobs}`.shareCollection`, then fetches them all through a
 * single {@link Endpoint.blobs}`.downloadCollection` and renders each child's
 * progress. Runs against its own minimal-preset endpoints (loopback), so it
 * never disturbs the app's main endpoint.
 */
function CollectionsSection(): React.JSX.Element {
  const [state, setState] = useState<DemoState>({ phase: "idle" });

  const onRun = useCallback(async () => {
    e2eEvent("COLLECTION_START");
    setState({ phase: "running", step: "creating endpoints" });
    let provider: Endpoint | null = null;
    let receiver: Endpoint | null = null;
    try {
      provider = await Endpoint.create({
        preset: "minimal",
        blobStoreDir: `${STORE_ROOT}/provider-store`,
      });
      receiver = await Endpoint.create({
        preset: "minimal",
        blobStoreDir: `${STORE_ROOT}/receiver-store`,
      });

      // Probe which candidate files are readable on this device by attempting
      // to share each individually; a collection needs every path to import.
      setState({ phase: "running", step: "collecting readable files" });
      const readable: string[] = [];
      for (const candidate of SYSTEM_FILE_CANDIDATES) {
        try {
          await provider.blobs.share(candidate);
          readable.push(candidate);
        } catch {
          // Not present/readable on this device; skip it.
        }
        if (readable.length >= 4) {
          break;
        }
      }
      if (readable.length === 0) {
        throw new IrohError(3000, "no readable files to bundle into a collection");
      }

      setState({ phase: "running", step: `bundling ${readable.length} files` });
      const ticket = await provider.blobs.shareCollection(readable);
      e2eReport("collection-share", true, `files=${readable.length} ticket=${ticket.length}chars`);

      const transfer = receiver.blobs.downloadCollection(ticket, DEST_DIR);
      setState({ phase: "downloading", ticket, transfer });
      await transfer.done;

      const files = transfer.files.length;
      const ok = transfer.files.every((file) => file.done);
      e2eReport("collection-download", ok, `files=${files}`);
      setState({ phase: "done", ticket, files, ok });
    } catch (error) {
      e2eReport("collection-download", false, String(error));
      setState({ phase: "error", message: String(error) });
    } finally {
      await provider?.close().catch(() => undefined);
      await receiver?.close().catch(() => undefined);
    }
  }, []);

  const running = state.phase === "running" || state.phase === "downloading";
  return (
    <View style={sectionStyles.section}>
      <Text style={sectionStyles.heading}>Collections</Text>
      <Text style={sectionStyles.dimText}>
        Share several files as one ticket, then download them all with per-file progress.
      </Text>
      <TouchableOpacity
        testID="collection-run"
        accessibilityRole="button"
        style={[sectionStyles.button, styles.button]}
        disabled={running}
        onPress={onRun}
      >
        <Text style={sectionStyles.buttonLabel}>
          {running ? "Running..." : "Run Collection Demo"}
        </Text>
      </TouchableOpacity>

      {state.phase === "running" ? (
        <Text style={sectionStyles.dimText}>{state.step}...</Text>
      ) : null}
      {state.phase === "downloading" ? <CollectionProgress transfer={state.transfer} /> : null}
      {state.phase === "done" ? (
        <Text
          style={[
            sectionStyles.monoLine,
            state.ok ? sectionStyles.passText : sectionStyles.failText,
          ]}
          testID="collection-result"
        >
          {state.ok ? "PASS" : "FAIL"}: downloaded {state.files} files from one ticket
        </Text>
      ) : null}
      {state.phase === "error" ? (
        <Text style={sectionStyles.errorText} testID="collection-error">
          {state.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    marginTop: 10,
  },
  fileList: {
    marginTop: 10,
    gap: 4,
  },
  fileRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  fileName: {
    flex: 1,
    fontFamily: "monospace",
    fontSize: 12,
    color: "#1a1a2e",
  },
  fileBytes: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#5a5f6e",
    fontVariant: ["tabular-nums"],
  },
});

export default CollectionsSection;
