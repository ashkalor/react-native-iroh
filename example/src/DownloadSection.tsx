import React, { useCallback, useRef, useState } from "react";
import { Keyboard, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { Endpoint, Transfer } from "react-native-iroh";
import { e2eEvent, e2eReport } from "./markers";
import ProgressBar from "./ProgressBar";
import { DOWNLOAD_DEST } from "./paths";
import { extractTicketHash } from "./ticketHash";
import { sectionStyles } from "./theme";

type Phase = "idle" | "downloading" | "verifying" | "complete" | "failed";

interface DownloadState {
  phase: Phase;
  transfer: Transfer | null;
  error: string;
  integrity: "pass" | "fail" | null;
  integrityDetail: string;
}

const IDLE: DownloadState = {
  phase: "idle",
  transfer: null,
  error: "",
  integrity: null,
  integrityDetail: "",
};

const STATUS_LABEL: Record<Phase, string> = {
  idle: "Idle",
  downloading: "Downloading",
  verifying: "Verifying integrity",
  complete: "Complete",
  failed: "Failed",
};

/**
 * Download flow: paste a ticket, download to app storage with live progress,
 * then verify integrity by re-sharing the downloaded file locally and
 * comparing the content hash embedded in both tickets (no bytes cross to JS).
 *
 * The ticket input is uncontrolled (value kept in a ref) so typing or
 * injecting a long ticket never re-renders the section.
 */
function DownloadSection({ endpoint }: { endpoint: Endpoint }): React.JSX.Element {
  const ticketRef = useRef("");
  const [state, setState] = useState<DownloadState>(IDLE);

  const onTicketChange = useCallback((text: string) => {
    ticketRef.current = text;
  }, []);

  const onDownload = useCallback(async () => {
    // Dismiss the keyboard in-app: automation must never rely on Android's
    // flaky hideKeyboard (a back-style key event that can exit the activity
    // when the keyboard is already down).
    Keyboard.dismiss();
    const ticket = ticketRef.current.trim();
    if (ticket.length === 0) {
      setState({ ...IDLE, phase: "failed", error: "Paste a ticket first" });
      return;
    }
    const expectedHash = extractTicketHash(ticket);
    e2eEvent("DOWNLOAD_START");
    let transfer: Transfer;
    try {
      // Throws synchronously on malformed tickets (parseTicket validation).
      transfer = endpoint.blobs.download(ticket, DOWNLOAD_DEST);
    } catch (error) {
      e2eReport("download-complete", false, String(error));
      setState({ ...IDLE, phase: "failed", error: String(error) });
      return;
    }

    // E2E accounting: refs, not state, so progress never re-renders here.
    let progressEvents = 0;
    let lastBytes = 0;
    const unsubscribe = transfer.onProgress((event) => {
      progressEvents += 1;
      lastBytes = event.bytesReceived;
    });

    setState({ ...IDLE, phase: "downloading", transfer });
    try {
      await transfer.done;
    } catch (error) {
      unsubscribe();
      e2eReport("download-complete", false, String(error));
      setState({ ...IDLE, phase: "failed", transfer, error: String(error) });
      return;
    }
    unsubscribe();
    e2eReport("download-complete", true, `bytes=${lastBytes}`);
    e2eReport("progress-observed", progressEvents >= 1, `events=${progressEvents}`);

    setState({ ...IDLE, phase: "verifying", transfer });
    try {
      const reShareTicket = await endpoint.blobs.share(DOWNLOAD_DEST);
      const actualHash = extractTicketHash(reShareTicket);
      const pass = expectedHash !== null && actualHash !== null && expectedHash === actualHash;
      const detail = `expected=${expectedHash ?? "unparseable"} actual=${actualHash ?? "unparseable"}`;
      e2eReport("integrity", pass, detail);
      setState({
        ...IDLE,
        phase: "complete",
        transfer,
        integrity: pass ? "pass" : "fail",
        integrityDetail: detail,
      });
    } catch (error) {
      e2eReport("integrity", false, `re-share failed: ${String(error)}`);
      setState({
        ...IDLE,
        phase: "complete",
        transfer,
        integrity: "fail",
        integrityDetail: `re-share failed: ${String(error)}`,
      });
    }
  }, [endpoint]);

  const onCancel = useCallback(() => {
    state.transfer?.cancel();
  }, [state.transfer]);

  const busy = state.phase === "downloading" || state.phase === "verifying";

  return (
    <View style={sectionStyles.section}>
      <Text style={sectionStyles.heading}>Download</Text>
      {/* Input and button share a row: while the input is focused the OS
          keeps this row visible above the keyboard, so the button is always
          tappable right after typing (no scrolling past the keyboard). */}
      <View style={styles.inputRow}>
        <TextInput
          testID="ticket-input"
          style={styles.input}
          placeholder="Paste ticket here"
          placeholderTextColor="#9aa0ad"
          autoCapitalize="none"
          autoCorrect={false}
          defaultValue=""
          onChangeText={onTicketChange}
        />
        <TouchableOpacity
          testID="download-button"
          accessibilityRole="button"
          style={[sectionStyles.button, styles.downloadButton]}
          disabled={busy}
          onPress={onDownload}
        >
          <Text style={sectionStyles.buttonLabel}>{busy ? "Working..." : "Download"}</Text>
        </TouchableOpacity>
      </View>
      {state.phase === "downloading" ? (
        <TouchableOpacity
          testID="cancel-button"
          accessibilityRole="button"
          style={styles.cancelButton}
          onPress={onCancel}
        >
          <Text style={styles.cancelLabel}>Cancel</Text>
        </TouchableOpacity>
      ) : null}
      <Text style={styles.status} testID="download-status">
        Status: {STATUS_LABEL[state.phase]}
      </Text>
      {state.transfer !== null && state.phase !== "failed" ? (
        <ProgressBar transfer={state.transfer} />
      ) : null}
      {state.phase === "failed" ? (
        <Text style={sectionStyles.errorText} testID="download-error">
          {state.error}
        </Text>
      ) : null}
      {state.integrity !== null ? (
        <Text
          style={[
            styles.integrity,
            state.integrity === "pass" ? sectionStyles.passText : sectionStyles.failText,
          ]}
          testID="integrity-result"
        >
          Integrity: {state.integrity === "pass" ? "PASS" : "FAIL"} (content hash of re-shared file)
        </Text>
      ) : null}
      {state.integrity === "fail" ? (
        <Text style={sectionStyles.dimText}>{state.integrityDetail}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#d5d9e0",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: "monospace",
    fontSize: 12,
    color: "#1a1a2e",
  },
  downloadButton: {
    paddingHorizontal: 14,
  },
  cancelButton: {
    marginTop: 6,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#c0392b",
  },
  cancelLabel: {
    color: "#c0392b",
    fontWeight: "600",
    fontSize: 13,
  },
  status: {
    marginTop: 10,
    fontSize: 13,
    fontWeight: "600",
    color: "#1a1a2e",
  },
  integrity: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: "700",
  },
});

export default React.memo(DownloadSection);
