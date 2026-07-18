import React, { useCallback, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import type { Endpoint } from "react-native-iroh";
import { e2eReport, e2eTicket } from "./markers";
import { SHARE_CANDIDATES, shareFirstReadable } from "./paths";
import { sectionStyles } from "./theme";

interface ShareState {
  phase: "idle" | "sharing" | "shared" | "error";
  ticket: string;
  source: string;
  error: string;
}

const IDLE: ShareState = { phase: "idle", ticket: "", source: "", error: "" };

/**
 * Share flow: imports a local file into the blob store and displays the
 * resulting ticket as a QR code plus a selectable (long-press to copy)
 * string. The source is the first readable candidate path: the harness-
 * provisioned test file when present, else a system font.
 */
function ShareSection({ endpoint }: { endpoint: Endpoint }): React.JSX.Element {
  const [state, setState] = useState<ShareState>(IDLE);

  const onShare = useCallback(async () => {
    setState({ ...IDLE, phase: "sharing" });
    const attempt = await shareFirstReadable(endpoint, SHARE_CANDIDATES);
    if (attempt.ok) {
      e2eTicket(attempt.ticket);
      e2eReport("share", true, `source=${attempt.source}`);
      setState({ phase: "shared", ticket: attempt.ticket, source: attempt.source, error: "" });
      return;
    }
    e2eReport("share", false, attempt.lastError);
    setState({ phase: "error", ticket: "", source: "", error: attempt.lastError });
  }, [endpoint]);

  return (
    <View style={sectionStyles.section}>
      <Text style={sectionStyles.heading}>Share</Text>
      <TouchableOpacity
        testID="share-button"
        accessibilityRole="button"
        style={sectionStyles.button}
        disabled={state.phase === "sharing"}
        onPress={onShare}
      >
        <Text style={sectionStyles.buttonLabel}>
          {state.phase === "sharing" ? "Sharing..." : "Share Test File"}
        </Text>
      </TouchableOpacity>
      {state.phase === "error" ? (
        <Text style={sectionStyles.errorText} testID="share-error">
          Share failed: {state.error}
        </Text>
      ) : null}
      {state.phase === "shared" ? (
        <View style={styles.result}>
          <Text style={sectionStyles.dimText}>Source: {state.source}</Text>
          <View style={styles.qrWrap} testID="share-qr">
            <QRCode value={state.ticket} size={220} ecl="L" quietZone={8} />
          </View>
          <Text style={sectionStyles.dimText}>Ticket (long-press to copy):</Text>
          <Text style={styles.ticket} selectable testID="share-ticket">
            {state.ticket}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  result: {
    marginTop: 12,
    gap: 8,
  },
  qrWrap: {
    alignSelf: "center",
    backgroundColor: "#ffffff",
    padding: 8,
    borderRadius: 8,
  },
  ticket: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#1a1a2e",
    backgroundColor: "#eef0f4",
    borderRadius: 6,
    padding: 8,
  },
});

export default React.memo(ShareSection);
