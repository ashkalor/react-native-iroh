import React, { useEffect, useState } from "react";
import { ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { Endpoint } from "react-native-iroh";
import DownloadSection from "./src/DownloadSection";
import { APP_STORE_DIR } from "./src/paths";
import ShareSection from "./src/ShareSection";
import SmokeSection from "./src/SmokeSection";
import { sectionStyles } from "./src/theme";

type EndpointState =
  | { phase: "starting" }
  | { phase: "ready"; endpoint: Endpoint }
  | { phase: "error"; message: string };

/**
 * react-native-iroh example: peer-to-peer file transfer between two devices.
 * Device A shares a file and shows the ticket (QR + copyable string); device
 * B pastes the ticket, downloads to app storage with live progress, and
 * verifies integrity by re-sharing the downloaded file and comparing the
 * content hash embedded in the tickets.
 */
function App(): React.JSX.Element {
  const [state, setState] = useState<EndpointState>({ phase: "starting" });

  useEffect(() => {
    let alive = true;
    let created: Endpoint | null = null;
    Endpoint.create({ blobStoreDir: APP_STORE_DIR })
      .then((endpoint) => {
        created = endpoint;
        if (!alive) {
          return endpoint.close();
        }
        console.log(`E2E: READY ${endpoint.nodeId}`);
        setState({ phase: "ready", endpoint });
        return undefined;
      })
      .catch((error: unknown) => {
        if (alive) {
          console.log(`E2E: FAIL endpoint ${String(error)}`);
          setState({ phase: "error", message: String(error) });
        }
      });
    return () => {
      alive = false;
      created?.close().catch(() => undefined);
    };
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#f2f3f7" />
      {/* keyboardShouldPersistTaps: with the keyboard up, a tap must reach
          its target (e.g. the Download button) on the first try instead of
          only dismissing the keyboard. */}
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>react-native-iroh</Text>
        <View style={sectionStyles.section}>
          <Text style={sectionStyles.heading}>Endpoint</Text>
          <Text style={styles.statusLine} testID="endpoint-status">
            Status:{" "}
            {state.phase === "ready"
              ? "Online"
              : state.phase === "starting"
                ? "Starting..."
                : "Error"}
          </Text>
          {state.phase === "ready" ? (
            <>
              <Text style={sectionStyles.dimText}>Node id:</Text>
              <Text style={styles.nodeId} selectable testID="node-id">
                {state.endpoint.nodeId}
              </Text>
            </>
          ) : null}
          {state.phase === "error" ? (
            <Text style={sectionStyles.errorText}>{state.message}</Text>
          ) : null}
        </View>
        {state.phase === "ready" ? (
          <>
            <ShareSection endpoint={state.endpoint} />
            <DownloadSection endpoint={state.endpoint} />
          </>
        ) : null}
        <SmokeSection />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#f2f3f7",
  },
  content: {
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 48,
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: "#1a1a2e",
    marginBottom: 14,
  },
  statusLine: {
    fontSize: 13,
    fontWeight: "600",
    color: "#1a1a2e",
    marginBottom: 8,
  },
  nodeId: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#1a1a2e",
  },
});

export default App;
