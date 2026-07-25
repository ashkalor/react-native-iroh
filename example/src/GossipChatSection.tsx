import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { IrohError, type Endpoint, type EndpointAddr } from "react-native-iroh";
import { useGossip } from "react-native-iroh/hooks";
import { e2eEvent, e2eGossipAddr, e2eReport } from "./markers";
import { sectionStyles } from "./theme";

/** The fixed topic both devices join in the e2e chat roundtrip. */
const TOPIC = "react-native-iroh-e2e-chat";

/** Chat lines kept on screen, so a long-running topic cannot grow state without
 * bound. */
const MAX_LOG_LINES = 200;

/** What the user asked to join with, or `null` before they pressed Join. This
 * gates {@link useGossip}, which subscribes as soon as it has an endpoint. */
type JoinRequest = { bootstrap?: readonly EndpointAddr[] };

/**
 * Gossip chat demo, written on the `react-native-iroh/hooks` layer: `useGossip`
 * owns the subscription, drains both streams into capped state, and tears the
 * topic down when this component unmounts. On the `"n0"` preset the relay
 * traverses NAT so two emulators can chat; device B bootstraps to device A by
 * pasting A's `E2E: GOSSIP_ADDR` JSON into the bootstrap box before joining.
 */
function GossipChatSection({ endpoint }: { endpoint: Endpoint }): React.JSX.Element {
  const [request, setRequest] = useState<JoinRequest | null>(null);
  const [joining, setJoining] = useState(false);
  const [bootstrapText, setBootstrapText] = useState("");
  const [draft, setDraft] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const reportedRoundtrip = useRef(false);

  const { messages, broadcast, status, error } = useGossip(
    request === null ? null : endpoint,
    TOPIC,
    { bootstrap: request?.bootstrap, retain: MAX_LOG_LINES },
  );

  const onJoin = useCallback(async () => {
    setJoining(true);
    setJoinError(null);
    reportedRoundtrip.current = false;
    e2eEvent("GOSSIP_JOIN");
    try {
      // Publish the address immediately: `endpoint.addr` is a synchronous
      // snapshot, so the marker never hangs on a slow relay. Then wait (bounded)
      // for a dialable relay address and publish the fuller one a bootstrapping
      // peer can reach us through; the harness picks the relay-carrying line.
      e2eGossipAddr(JSON.stringify(endpoint.addr));
      await endpoint.online({ timeoutMs: 20_000 }).catch(() => undefined);
      e2eGossipAddr(JSON.stringify(endpoint.addr));

      const pasted = bootstrapText.trim();
      setRequest({
        bootstrap: pasted.length > 0 ? [JSON.parse(pasted) as EndpointAddr] : undefined,
      });
    } catch (caught) {
      const message = caught instanceof IrohError ? caught.message : String(caught);
      e2eReport("gossip-join", false, message);
      setJoinError(message);
    } finally {
      setJoining(false);
    }
  }, [endpoint, bootstrapText]);

  // The first message received from a peer proves the roundtrip.
  useEffect(() => {
    const first = messages[0];
    if (first === undefined || reportedRoundtrip.current) {
      return;
    }
    reportedRoundtrip.current = true;
    e2eReport("gossip-roundtrip", true, `from=${first.from} text=${first.text}`);
  }, [messages]);

  // A subscription that fails after Join was pressed reports on the same marker
  // the synchronous failure path uses.
  useEffect(() => {
    if (status === "error" && error !== undefined) {
      e2eReport("gossip-join", false, error.message);
    }
  }, [status, error]);

  const onSend = useCallback(async () => {
    const text = draft.trim().length > 0 ? draft.trim() : `ping from ${endpoint.id.slice(0, 8)}`;
    setDraft("");
    try {
      await broadcast(text);
      e2eReport("gossip-send", true, `text=${text}`);
    } catch (caught) {
      const message = caught instanceof IrohError ? caught.message : String(caught);
      e2eReport("gossip-send", false, message);
    }
  }, [broadcast, draft, endpoint]);

  const joined = request !== null && status !== "error";
  const shownError = joinError ?? (status === "error" ? error?.message : undefined);
  return (
    <View style={sectionStyles.section}>
      <Text style={sectionStyles.heading}>Gossip Chat</Text>
      <Text style={sectionStyles.dimText}>
        Join a shared topic and broadcast messages. On device B, paste device A&apos;s bootstrap
        address first.
      </Text>

      {!joined ? (
        <>
          <Text style={[sectionStyles.dimText, styles.label]}>Bootstrap peer (device B only):</Text>
          <TextInput
            testID="gossip-bootstrap"
            style={styles.input}
            placeholder="paste E2E: GOSSIP_ADDR json"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            value={bootstrapText}
            onChangeText={setBootstrapText}
          />
          <TouchableOpacity
            testID="gossip-join"
            accessibilityRole="button"
            style={[sectionStyles.button, styles.button]}
            disabled={joining}
            onPress={onJoin}
          >
            <Text style={sectionStyles.buttonLabel}>{joining ? "Joining..." : "Join Topic"}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <View style={styles.sendRow}>
            <TextInput
              testID="gossip-message"
              style={[styles.input, styles.messageInput]}
              placeholder="message"
              autoCapitalize="none"
              autoCorrect={false}
              value={draft}
              onChangeText={setDraft}
            />
            <TouchableOpacity
              testID="gossip-send"
              accessibilityRole="button"
              style={[sectionStyles.button, styles.sendButton]}
              onPress={onSend}
            >
              <Text style={sectionStyles.buttonLabel}>Send</Text>
            </TouchableOpacity>
          </View>
          <Text style={sectionStyles.dimText} testID="gossip-status">
            Joined - {messages.length} received
          </Text>
          <View style={styles.chatLog} testID="gossip-log">
            {messages.map((message, index) => (
              <Text key={index} style={styles.chatLine} numberOfLines={2}>
                {message.from.slice(0, 8)}: {message.text}
              </Text>
            ))}
          </View>
        </>
      )}

      {shownError !== undefined && shownError !== null ? (
        <Text style={sectionStyles.errorText} testID="gossip-error">
          {shownError}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    marginTop: 8,
    marginBottom: 4,
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
  sendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  messageInput: {
    flex: 1,
  },
  sendButton: {
    paddingHorizontal: 18,
  },
  chatLog: {
    marginTop: 10,
    gap: 4,
  },
  chatLine: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#1a1a2e",
  },
});

export default React.memo(GossipChatSection);
