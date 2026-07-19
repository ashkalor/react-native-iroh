/**
 * download-progress: drive a progress UI from a transfer.
 *
 * One concept: Transfer.progress is an async iterable. Each `for await` loop
 * gets its own iterator, conflated to the latest value - a slow consumer
 * (like a UI on a busy JS thread) sees fewer, fresher events, never a
 * growing backlog. The loop ends when the download completes and throws the
 * terminal IrohError if it fails.
 */
import React, { useCallback, useState } from "react";
import { Button, Text, View } from "react-native";
import { parseTicket } from "react-native-iroh";
import type { Endpoint } from "react-native-iroh";

// Any absolute directory inside your app's sandbox, e.g.
// RNFS.DocumentDirectoryPath (react-native-fs) or an expo-file-system path.
declare const DocumentDir: string;

type Phase = "idle" | "downloading" | "done" | "failed";

export function DownloadProgress({
  endpoint,
  ticket,
}: {
  endpoint: Endpoint;
  ticket: string;
}): React.JSX.Element {
  const [received, setReceived] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");

  const onDownload = useCallback(async () => {
    setPhase("downloading");
    try {
      // parseTicket validates the pasted string's shape up front (and
      // download would run the same check on a plain string itself).
      const transfer = endpoint.blobs.download(
        parseTicket(ticket.trim()),
        `${DocumentDir}/download.bin`,
      );
      for await (const { bytesReceived } of transfer.progress) {
        setReceived(bytesReceived);
      }
      await transfer.done;
      setPhase("done");
    } catch {
      setPhase("failed");
    }
  }, [endpoint, ticket]);

  return (
    <View>
      <Button title="Download" onPress={onDownload} disabled={phase === "downloading"} />
      <Text>{phase === "downloading" ? `received ${received} bytes` : phase}</Text>
    </View>
  );
}
