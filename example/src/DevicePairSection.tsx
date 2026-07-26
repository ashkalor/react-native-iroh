import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import type { Endpoint } from "react-native-iroh";
import {
  INITIAL_PAIR_STATE,
  runPairTest,
  type Check,
  type PairTestRun,
  type PairTestState,
} from "./devicePairTest";
import { sectionStyles } from "./theme";

const STATUS_MARK: Record<Check["status"], string> = {
  pending: "·",
  running: "…",
  pass: "PASS",
  fail: "FAIL",
};

const PHASE_LABEL: Record<PairTestState["phase"], string> = {
  idle: "Not started",
  running: "Running",
  passed: "ALL PASS",
  failed: "FAILED",
};

function CheckRow({ check }: { check: Check }): React.JSX.Element {
  const tone =
    check.status === "pass"
      ? sectionStyles.passText
      : check.status === "fail"
        ? sectionStyles.failText
        : undefined;
  return (
    <View style={styles.row} testID={`pair-check-${check.id}`}>
      <Text style={[styles.mark, tone]}>{STATUS_MARK[check.status]}</Text>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{check.label}</Text>
        {check.detail !== "" ? <Text style={styles.rowDetail}>{check.detail}</Text> : null}
      </View>
    </View>
  );
}

/**
 * The two-device suite, driven by hand from both screens.
 *
 * Everything here needs a second real device, which is exactly why it cannot
 * live in the single-process smoke suite: a genuine transfer between two
 * endpoints on two machines, its content hash verified, the network path it
 * took recorded, and the peer's own verdict echoed back. Both devices run the
 * identical script, so either screen shows the whole picture.
 *
 * Pairing carries only an endpoint id (that is all the QR encodes, and all the
 * paste box expects), so a successful handshake also demonstrates that discovery
 * resolved the peer's addresses rather than them being handed over.
 */
function DevicePairSection({ endpoint }: { endpoint: Endpoint }): React.JSX.Element {
  const [state, setState] = useState<PairTestState>(INITIAL_PAIR_STATE);
  const [peerText, setPeerText] = useState("");
  const runRef = useRef<PairTestRun | null>(null);

  useEffect(
    () => () => {
      runRef.current?.cancel();
      runRef.current = null;
    },
    [],
  );

  const onStart = useCallback(
    (peer: string) => {
      runRef.current?.cancel();
      setState({ ...INITIAL_PAIR_STATE, phase: "running" });
      runRef.current = runPairTest({ endpoint, peer, onState: setState });
    },
    [endpoint],
  );

  const onStop = useCallback(() => {
    runRef.current?.cancel();
    runRef.current = null;
  }, []);

  const running = state.phase === "running";
  const verdictTone =
    state.phase === "passed"
      ? sectionStyles.passText
      : state.phase === "failed"
        ? sectionStyles.failText
        : undefined;

  return (
    <View style={sectionStyles.section}>
      <Text style={sectionStyles.heading}>Two-Device Test</Text>
      <Text style={sectionStyles.dimText}>
        Install the app on both devices and open this section on each. Order matters: a gossip topic
        only exists where it has been joined, so device 1 presses Wait first, then device 2 is given
        device 1&apos;s id. From there both run the same script and both screens show the same
        results.
      </Text>

      <Text style={styles.step}>
        Device 1: press this first, then hand the other device the id below.
      </Text>
      <TouchableOpacity
        testID="pair-wait"
        accessibilityRole="button"
        style={[sectionStyles.button, styles.button]}
        disabled={running}
        onPress={() => onStart("")}
      >
        <Text style={sectionStyles.buttonLabel}>
          {running ? "Running..." : "1. Wait For Other Device"}
        </Text>
      </TouchableOpacity>

      <Text style={styles.step}>
        This device&apos;s id. Scan this code with the other device&apos;s camera app, or long-press
        the text to copy it.
      </Text>
      <View style={styles.qrWrap} testID="pair-qr">
        <QRCode value={endpoint.id} size={200} ecl="M" quietZone={8} />
      </View>
      <Text style={styles.id} selectable testID="pair-id">
        {endpoint.id}
      </Text>

      <Text style={styles.step}>Device 2: paste the other device&apos;s id here and run.</Text>
      <TextInput
        testID="pair-peer-input"
        style={styles.input}
        placeholder="other device's endpoint id"
        placeholderTextColor="#9aa0ad"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        value={peerText}
        onChangeText={setPeerText}
      />
      <TouchableOpacity
        testID="pair-run"
        accessibilityRole="button"
        style={[sectionStyles.button, styles.button]}
        disabled={running || peerText.trim().length === 0}
        onPress={() => onStart(peerText.trim())}
      >
        <Text style={sectionStyles.buttonLabel}>2. Connect To Pasted Id</Text>
      </TouchableOpacity>

      <Text style={[styles.verdict, verdictTone]} testID="pair-verdict">
        {PHASE_LABEL[state.phase]}
        {state.peerId !== null ? ` - peer ${state.peerId.slice(0, 12)}...` : ""}
      </Text>

      <View style={styles.checks}>
        {state.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </View>

      {state.error !== null ? (
        <Text style={sectionStyles.errorText} testID="pair-error">
          {state.error}
        </Text>
      ) : null}

      {running ? (
        <TouchableOpacity
          testID="pair-stop"
          accessibilityRole="button"
          style={styles.stopButton}
          onPress={onStop}
        >
          <Text style={styles.stopLabel}>Stop</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  step: {
    marginTop: 12,
    marginBottom: 6,
    fontSize: 12,
    color: "#41485a",
  },
  qrWrap: {
    alignSelf: "center",
    backgroundColor: "#ffffff",
    padding: 8,
    borderRadius: 8,
    marginBottom: 8,
  },
  id: {
    fontFamily: "monospace",
    fontSize: 10,
    color: "#1a1a2e",
    backgroundColor: "#f7f8fb",
    borderRadius: 6,
    padding: 8,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#c5cad3",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: "monospace",
    fontSize: 11,
    color: "#1a1a2e",
    backgroundColor: "#f7f8fb",
  },
  button: {
    marginTop: 10,
  },
  verdict: {
    marginTop: 14,
    fontSize: 14,
    fontWeight: "700",
    color: "#1a1a2e",
  },
  checks: {
    marginTop: 8,
    gap: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  mark: {
    fontFamily: "monospace",
    fontSize: 11,
    fontWeight: "700",
    width: 38,
    color: "#5a5f6e",
  },
  rowBody: {
    flex: 1,
  },
  rowLabel: {
    fontSize: 12,
    color: "#1a1a2e",
  },
  rowDetail: {
    fontSize: 10,
    color: "#5a5f6e",
    fontFamily: "monospace",
  },
  stopButton: {
    marginTop: 10,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#c0392b",
  },
  stopLabel: {
    color: "#c0392b",
    fontWeight: "600",
    fontSize: 13,
  },
});

export default React.memo(DevicePairSection);
