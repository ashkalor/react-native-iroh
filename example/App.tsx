import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { getIrohErrorCode, Iroh } from "react-native-iroh";

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

// The example app's private files directory. Hardcoded because the bare
// example app has no filesystem module; matches applicationId "com.irohexample".
const FILES_DIR = "/data/user/0/com.irohexample/files";

// A small pre-existing, world-readable file to share. Fonts are ideal: large
// enough (~1MB) to produce progress events. Candidates are tried in order.
const SOURCE_FILE_CANDIDATES = [
  "/system/fonts/Roboto-Regular.ttf",
  "/system/fonts/NotoSans-Regular.ttf",
  "/system/fonts/NotoSerif-Regular.ttf",
  "/system/etc/fonts.xml",
  "/system/etc/hosts",
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runSmokeSuite(report: (result: CheckResult) => void): Promise<void> {
  const check = (name: string, pass: boolean, detail: string) => {
    report({ name, pass, detail });
    console.log(`SMOKE: ${pass ? "PASS" : "FAIL"} ${name} - ${detail}`);
    if (!pass) {
      throw new Error(`check failed: ${name}: ${detail}`);
    }
  };

  // createEndpoint (twice: provider + receiver, both with real data dirs)
  const provider = await Iroh.createEndpoint({
    profile: "isolated",
    blobStoreDir: `${FILES_DIR}/iroh-smoke/provider-store`,
  });
  check("createEndpoint provider", provider >= 1, `handle=${provider}`);
  const receiver = await Iroh.createEndpoint({
    profile: "isolated",
    blobStoreDir: `${FILES_DIR}/iroh-smoke/receiver-store`,
  });
  check("createEndpoint receiver", receiver >= 1 && receiver !== provider, `handle=${receiver}`);

  // nodeId
  const providerId = Iroh.nodeId(provider);
  const receiverId = Iroh.nodeId(receiver);
  check(
    "nodeId",
    providerId.length > 0 && receiverId.length > 0 && providerId !== receiverId,
    `provider=${providerId.slice(0, 12)}... receiver=${receiverId.slice(0, 12)}...`,
  );

  // isEndpointOpen (live)
  check(
    "isEndpointOpen live",
    Iroh.isEndpointOpen(provider) && Iroh.isEndpointOpen(receiver),
    "both endpoints report open",
  );

  // shareBlob: first readable candidate file -> ticket
  let sourceFile = "";
  let ticket = "";
  for (const candidate of SOURCE_FILE_CANDIDATES) {
    try {
      ticket = await Iroh.shareBlob(provider, candidate);
      sourceFile = candidate;
      break;
    } catch {
      // Candidate missing/unreadable on this device; try the next one.
    }
  }
  check("shareBlob", ticket.length > 0, `${sourceFile} -> ticket[${ticket.length} chars]`);

  // downloadBlob: loopback receiver <- provider, with onStart + progress
  const destPath = `${FILES_DIR}/iroh-smoke/downloaded.bin`;
  let transferId = 0;
  let progressEvents = 0;
  let lastBytes = 0;
  let monotone = true;
  await Iroh.downloadBlob(
    receiver,
    ticket,
    destPath,
    (id) => {
      transferId = id;
    },
    (bytesReceived) => {
      progressEvents += 1;
      if (bytesReceived < lastBytes) {
        monotone = false;
      }
      lastBytes = bytesReceived;
    },
  );
  const progressAtTerminal = progressEvents;
  check("downloadBlob completes", true, `terminal resolve, ${lastBytes} bytes received`);
  check("downloadBlob onStart", transferId >= 1, `transferId=${transferId}`);
  check(
    "downloadBlob progress",
    progressEvents >= 1 && monotone,
    `${progressEvents} events, cumulative bytes non-decreasing`,
  );
  await sleep(300);
  check(
    "single terminal event",
    progressEvents === progressAtTerminal,
    "no progress events after the Promise settled",
  );

  // Content integrity, string-side: re-sharing the downloaded file on the
  // same provider endpoint must reproduce the identical ticket (same
  // addresses + same content hash). No bytes ever cross into JS.
  const ticket2 = await Iroh.shareBlob(provider, destPath);
  check("re-share ticket equality", ticket2 === ticket, "downloaded content hashes identically");

  // cancelDownload: idempotent no-op after the transfer already finished.
  // (Real mid-flight cancellation is covered by the Rust test suite.)
  Iroh.cancelDownload(transferId);
  check("cancelDownload idempotent", true, "no-op on finished transfer did not throw");

  // Error path: garbage ticket must reject with the stable numeric code 1002.
  let errorCode: number | undefined;
  try {
    await Iroh.downloadBlob(
      receiver,
      "definitely-not-a-ticket",
      destPath,
      () => {},
      () => {},
    );
  } catch (error) {
    errorCode = getIrohErrorCode(error);
  }
  check("error path invalid ticket", errorCode === 1002, `rejected with code ${errorCode}`);

  // closeEndpoint + isEndpointOpen (closed) + stale-handle error code 1001
  await Iroh.closeEndpoint(provider);
  await Iroh.closeEndpoint(receiver);
  check(
    "closeEndpoint",
    !Iroh.isEndpointOpen(provider) && !Iroh.isEndpointOpen(receiver),
    "both endpoints report closed",
  );
  let staleCode: number | undefined;
  try {
    Iroh.nodeId(provider);
  } catch (error) {
    staleCode = getIrohErrorCode(error);
  }
  check("error path stale handle", staleCode === 1001, `nodeId threw code ${staleCode}`);
}

function App(): React.JSX.Element {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [status, setStatus] = useState<"running" | "all-pass" | "failed">("running");

  const run = useCallback(async () => {
    setResults([]);
    setStatus("running");
    let failed = false;
    try {
      await runSmokeSuite((result) => {
        setResults((previous) => [...previous, result]);
        failed = failed || !result.pass;
      });
    } catch (error) {
      failed = true;
      console.log(`SMOKE: SUITE ABORTED - ${String(error)}`);
    }
    if (failed) {
      setStatus("failed");
      console.log("SMOKE: RESULT FAILED");
    } else {
      setStatus("all-pass");
      console.log("SMOKE: RESULT ALL PASS");
    }
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>react-native-iroh smoke suite</Text>
      <Text
        style={[
          styles.status,
          status === "all-pass" && styles.pass,
          status === "failed" && styles.fail,
        ]}
      >
        {status === "running" ? "RUNNING..." : status === "all-pass" ? "ALL PASS" : "FAILED"}
      </Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {results.map((result) => (
          <Text key={result.name} style={[styles.line, result.pass ? styles.pass : styles.fail]}>
            {result.pass ? "PASS" : "FAIL"} {result.name} - {result.detail}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 60,
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: "bold",
  },
  status: {
    fontSize: 24,
    fontWeight: "bold",
    marginVertical: 12,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 40,
  },
  line: {
    fontSize: 13,
    marginBottom: 6,
    fontFamily: "monospace",
  },
  pass: {
    color: "green",
  },
  fail: {
    color: "red",
  },
});

export default App;
