import React, { useCallback, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { Endpoint, IrohError } from "react-native-iroh";
import { smokeAborted, smokeReport, smokeResult } from "./markers";
import { FILES_DIR, SYSTEM_FILE_CANDIDATES, shareFirstReadable } from "./paths";
import { extractTicketHash } from "./ticketHash";
import { sectionStyles } from "./theme";

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * Regression net: the Phase 2 raw-surface smoke suite, re-expressed through
 * the public class API (Endpoint / Transfer / IrohError). Runs against its
 * own isolated endpoints so it never disturbs the app's main endpoint.
 */
async function runSmokeSuite(report: (result: CheckResult) => void): Promise<void> {
  const check = (name: string, pass: boolean, detail: string) => {
    report({ name, pass, detail });
    smokeReport(name, pass, detail);
    if (!pass) {
      throw new Error(`check failed: ${name}: ${detail}`);
    }
  };

  const provider = await Endpoint.create({
    profile: "isolated",
    blobStoreDir: `${FILES_DIR}/iroh-smoke/provider-store`,
  });
  check("Endpoint.create provider", provider.isOpen, "provider endpoint open");
  const receiver = await Endpoint.create({
    profile: "isolated",
    blobStoreDir: `${FILES_DIR}/iroh-smoke/receiver-store`,
  });
  check("Endpoint.create receiver", receiver.isOpen, "receiver endpoint open");

  check(
    "nodeId",
    provider.nodeId.length > 0 && receiver.nodeId.length > 0 && provider.nodeId !== receiver.nodeId,
    `provider=${provider.nodeId.slice(0, 12)}... receiver=${receiver.nodeId.slice(0, 12)}...`,
  );

  const attempt = await shareFirstReadable(provider, SYSTEM_FILE_CANDIDATES);
  const ticket = attempt.ok ? attempt.ticket : "";
  const sourceFile = attempt.ok ? attempt.source : "";
  check("shareBlob", ticket.length > 0, `${sourceFile} -> ticket[${ticket.length} chars]`);

  const contentHash = extractTicketHash(ticket);
  check(
    "ticket hash extraction",
    contentHash !== null && contentHash.length === 64,
    `hash=${contentHash?.slice(0, 16) ?? "null"}...`,
  );

  const destPath = `${FILES_DIR}/iroh-smoke/downloaded.bin`;
  const transfer = receiver.downloadBlob(ticket, destPath);
  let progressEvents = 0;
  let lastBytes = 0;
  let monotone = true;
  const unsubscribe = transfer.onProgress((event) => {
    progressEvents += 1;
    if (event.bytesReceived < lastBytes) {
      monotone = false;
    }
    lastBytes = event.bytesReceived;
  });
  let iteratorEvents = 0;
  const iteration = (async () => {
    for await (const event of transfer.progress) {
      if (event.bytesReceived >= 0) {
        iteratorEvents += 1;
      }
    }
  })();
  await transfer.promise;
  await iteration;
  unsubscribe();
  check("Transfer.promise resolves", true, `terminal resolve, ${lastBytes} bytes received`);
  check(
    "Transfer.onProgress",
    progressEvents >= 1 && monotone,
    `${progressEvents} events, cumulative bytes non-decreasing`,
  );
  check(
    "Transfer.progress iterator",
    iteratorEvents >= 1,
    `${iteratorEvents} conflated events, loop ended at terminal`,
  );
  check("Transfer.isSettled", transfer.isSettled, "settled after promise resolved");

  // Same-endpoint re-share must reproduce the identical ticket.
  const ticketAgain = await provider.shareBlob(sourceFile);
  check("re-share ticket equality", ticketAgain === ticket, "same endpoint, identical ticket");

  // Cross-endpoint re-share: different ticket string (different node
  // addresses), identical trailing content hash. This validates the
  // extractTicketHash parser used by the download integrity check.
  const receiverTicket = await receiver.shareBlob(destPath);
  check(
    "cross-endpoint hash equality",
    receiverTicket !== ticket && extractTicketHash(receiverTicket) === contentHash,
    "tickets differ, content hashes match",
  );

  transfer.cancel();
  check("cancel idempotent", true, "no-op on settled transfer did not throw");

  let invalidTicketError: unknown;
  try {
    await receiver.downloadBlob("definitely-not-a-ticket", destPath).promise;
  } catch (error) {
    invalidTicketError = error;
  }
  check(
    "error path invalid ticket",
    invalidTicketError instanceof IrohError &&
      invalidTicketError.code === 1002 &&
      invalidTicketError.kind === "invalid-ticket",
    `rejected with IrohError code=1002 kind=invalid-ticket`,
  );

  await provider.close();
  await receiver.close();
  check("close", !provider.isOpen && !receiver.isOpen, "both endpoints report closed");
  check("nodeId cached after close", provider.nodeId.length > 0, "nodeId readable after close");

  let staleError: unknown;
  try {
    await provider.shareBlob(sourceFile);
  } catch (error) {
    staleError = error;
  }
  check(
    "error path stale endpoint",
    staleError instanceof IrohError && staleError.code === 1001,
    `shareBlob after close rejected with code ${staleError instanceof IrohError ? staleError.code : "?"}`,
  );
}

type SuiteStatus = "idle" | "running" | "all-pass" | "failed";

const STATUS_LABEL: Record<SuiteStatus, string> = {
  idle: "Not run yet",
  running: "RUNNING...",
  "all-pass": "ALL PASS",
  failed: "FAILED",
};

function SmokeSection(): React.JSX.Element {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [status, setStatus] = useState<SuiteStatus>("idle");

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
      smokeAborted(String(error));
    }
    setStatus(failed ? "failed" : "all-pass");
    smokeResult(!failed);
  }, []);

  return (
    <View style={sectionStyles.section}>
      <Text style={sectionStyles.heading}>Smoke Checks</Text>
      <TouchableOpacity
        testID="smoke-run"
        accessibilityRole="button"
        style={sectionStyles.button}
        disabled={status === "running"}
        onPress={run}
      >
        <Text style={sectionStyles.buttonLabel}>
          {status === "running" ? "Running..." : "Run Smoke Checks"}
        </Text>
      </TouchableOpacity>
      <Text
        style={[
          sectionStyles.monoLine,
          styles.status,
          status === "all-pass" && sectionStyles.passText,
          status === "failed" && sectionStyles.failText,
        ]}
        testID="smoke-status"
      >
        {STATUS_LABEL[status]}
      </Text>
      {results.map((result) => (
        <Text
          key={result.name}
          style={[
            sectionStyles.monoLine,
            result.pass ? sectionStyles.passText : sectionStyles.failText,
          ]}
        >
          {result.pass ? "PASS" : "FAIL"} {result.name} - {result.detail}
        </Text>
      ))}
    </View>
  );
}

const styles = {
  status: {
    marginTop: 10,
    fontWeight: "700" as const,
  },
};

export default React.memo(SmokeSection);
