import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import {
  IrohError,
  type Endpoint,
  type EndpointAddr,
  type GossipMessage,
  type GossipSubscription,
} from "react-native-iroh";
import { e2eEvent, e2eGossipAddr, e2eReport } from "./markers";
import { sectionStyles } from "./theme";

/** The fixed topic both devices join in the e2e chat roundtrip. */
const TOPIC = "react-native-iroh-e2e-chat";

/** Chat lines kept on screen, so a long-running topic cannot grow state without
 * bound (the `useGossip` hook caps its own retention the same way). */
const MAX_LOG_LINES = 200;

type ChatState =
  | { phase: "idle" }
  | { phase: "joining" }
  | { phase: "joined"; sub: GossipSubscription }
  | { phase: "error"; message: string };

/**
 * Gossip chat demo: join a fixed topic, stream the message log with
 * `for await (const m of sub.messages)`, and broadcast from a send box. On the
 * `"n0"` preset the relay traverses NAT so two emulators can chat; device B
 * bootstraps to device A by pasting A's `E2E: GOSSIP_ADDR` JSON into the
 * bootstrap box before joining.
 */
function GossipChatSection({ endpoint }: { endpoint: Endpoint }): React.JSX.Element {
  const [state, setState] = useState<ChatState>({ phase: "idle" });
  const [bootstrap, setBootstrap] = useState("");
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<GossipMessage[]>([]);
  const reportedRoundtrip = useRef(false);

  const onJoin = useCallback(async () => {
    setState({ phase: "joining" });
    setLog([]);
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

      let peers: EndpointAddr[] | undefined;
      const pasted = bootstrap.trim();
      if (pasted.length > 0) {
        peers = [JSON.parse(pasted) as EndpointAddr];
      }
      const sub = endpoint.gossip.subscribe(TOPIC, peers ? { bootstrap: peers } : undefined);
      setState({ phase: "joined", sub });
    } catch (error) {
      const message = error instanceof IrohError ? error.message : String(error);
      e2eReport("gossip-join", false, message);
      setState({ phase: "error", message });
    }
  }, [endpoint, bootstrap]);

  // Drain the message stream into the on-screen log for as long as the
  // subscription is live; the loop ends when the subscription is torn down.
  useEffect(() => {
    if (state.phase !== "joined") {
      return;
    }
    const sub = state.sub;
    let alive = true;
    void (async () => {
      for await (const message of sub.messages) {
        if (!alive) {
          break;
        }
        setLog((previous) => [...previous, message].slice(-MAX_LOG_LINES));
        // The first message received from a peer proves the roundtrip.
        if (!reportedRoundtrip.current) {
          reportedRoundtrip.current = true;
          e2eReport("gossip-roundtrip", true, `from=${message.from} text=${message.text}`);
        }
      }
    })();
    return () => {
      alive = false;
      sub.unsubscribe();
    };
  }, [state]);

  const onSend = useCallback(async () => {
    if (state.phase !== "joined") {
      return;
    }
    const text = draft.trim().length > 0 ? draft.trim() : `ping from ${endpoint.id.slice(0, 8)}`;
    setDraft("");
    try {
      await state.sub.broadcast(text);
      e2eReport("gossip-send", true, `text=${text}`);
    } catch (error) {
      const message = error instanceof IrohError ? error.message : String(error);
      e2eReport("gossip-send", false, message);
    }
  }, [state, draft, endpoint]);

  const joined = state.phase === "joined";
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
            value={bootstrap}
            onChangeText={setBootstrap}
          />
          <TouchableOpacity
            testID="gossip-join"
            accessibilityRole="button"
            style={[sectionStyles.button, styles.button]}
            disabled={state.phase === "joining"}
            onPress={onJoin}
          >
            <Text style={sectionStyles.buttonLabel}>
              {state.phase === "joining" ? "Joining..." : "Join Topic"}
            </Text>
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
            Joined - {log.length} received
          </Text>
          <View style={styles.chatLog} testID="gossip-log">
            {log.map((message, index) => (
              <Text key={index} style={styles.chatLine} numberOfLines={2}>
                {message.from.slice(0, 8)}: {message.text}
              </Text>
            ))}
          </View>
        </>
      )}

      {state.phase === "error" ? (
        <Text style={sectionStyles.errorText} testID="gossip-error">
          {state.message}
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
