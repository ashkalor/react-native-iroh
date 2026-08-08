import React, { useCallback, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { Endpoint, IrohError, parseTicket } from "react-native-iroh";
import type { EndpointAddr, Stream } from "react-native-iroh";
import { smokeAborted, smokeReport, smokeResult } from "./markers";
import { SYSTEM_FILE_CANDIDATES, resetSmokeDir, shareFirstReadable } from "./paths";
import { sectionStyles } from "./theme";

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const STREAMS_ALPN = "iroh-rn-smoke/streams/1";

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function rampBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = i % 256;
  }
  return out;
}

async function firstWithin<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
  });
  try {
    const result = await Promise.race([iterator.next(), timeout]);
    if (result.done) {
      throw new Error(`${label} ended before yielding`);
    }
    return result.value;
  } finally {
    clearTimeout(timer);
  }
}

async function readChunksWithin(
  stream: Stream,
  count: number,
  timeoutMs: number,
  label: string,
): Promise<Uint8Array[]> {
  const iterator = stream.data[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  while (chunks.length < count) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout reading ${label}`)), timeoutMs);
    });
    try {
      const result = await Promise.race([iterator.next(), timeout]);
      if (result.done) {
        break;
      }
      chunks.push(result.value);
    } finally {
      clearTimeout(timer);
    }
  }
  return chunks;
}

/**
 * Regression net: the Phase 2 raw-surface smoke suite, re-expressed through
 * the public class API (Endpoint / Transfer / IrohError). Runs against its
 * own minimal-preset endpoints so it never disturbs the app's main endpoint.
 */
async function runSmokeSuite(report: (result: CheckResult) => void): Promise<void> {
  const check = (name: string, pass: boolean, detail: string) => {
    report({ name, pass, detail });
    smokeReport(name, pass, detail);
    if (!pass) {
      throw new Error(`check failed: ${name}: ${detail}`);
    }
  };

  // Stores from a previous run break this one, and app data outlives a
  // reinstall, so start from an empty workspace every time.
  const smokeDir = resetSmokeDir();

  // relayMode "disabled" runs a relay-less LAN endpoint: peers are reachable
  // only through the direct addresses embedded in tickets.
  const provider = await Endpoint.create({
    preset: "minimal",
    relayMode: "disabled",
    blobStoreDir: `${smokeDir}/provider-store`,
    alpns: [STREAMS_ALPN],
  });
  check("Endpoint.create provider", provider.isOpen, "provider endpoint (relay disabled) open");
  const receiver = await Endpoint.create({
    preset: "minimal",
    relayMode: "disabled",
    blobStoreDir: `${smokeDir}/receiver-store`,
  });
  check("Endpoint.create receiver", receiver.isOpen, "receiver endpoint (relay disabled) open");

  check(
    "endpoint id",
    provider.id.length > 0 && receiver.id.length > 0 && provider.id !== receiver.id,
    `provider=${provider.id.slice(0, 12)}... receiver=${receiver.id.slice(0, 12)}...`,
  );

  // Observability: the address snapshot is consistent with the id, and a
  // relay-disabled endpoint reports no home relays.
  const addr = provider.addr;
  check(
    "endpoint addr",
    addr.id === provider.id && addr.relayUrls.length === 0,
    `id matches, relays=${addr.relayUrls.length}, direct=${addr.directAddrs.length}`,
  );

  // watchAddr delivers the current address soon after subscribing.
  const firstAddr = await new Promise<EndpointAddr | null>((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, 3000);
    const unsubscribe = provider.watchAddr((next) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(next);
    });
  });
  check(
    "endpoint watchAddr",
    firstAddr !== null && firstAddr.id === provider.id,
    firstAddr === null ? "no address delivered" : `observed id ${firstAddr.id.slice(0, 12)}...`,
  );

  // online() on a relay-disabled endpoint can never connect a home relay, so
  // it rejects on timeout (endpoint-bind). That rejection is the status line.
  let onlineOutcome = "resolved";
  try {
    await provider.online({ timeoutMs: 500 });
  } catch (error) {
    onlineOutcome =
      error instanceof IrohError ? `rejected (${error.kind})` : `rejected (${String(error)})`;
  }
  check(
    "endpoint online (no relay)",
    onlineOutcome === "rejected (endpoint-bind)",
    `relay disabled -> ${onlineOutcome}`,
  );

  const attempt = await shareFirstReadable(provider, SYSTEM_FILE_CANDIDATES);
  const ticket = attempt.ok ? attempt.ticket : "";
  const sourceFile = attempt.ok ? attempt.source : "";
  check("blobs.share", ticket.length > 0, `${sourceFile} -> ticket[${ticket.length} chars]`);

  const contentHash = ticket.length > 0 ? parseTicket(ticket).hash : null;
  check(
    "ticket hash extraction",
    contentHash !== null && contentHash.length === 64,
    `hash=${contentHash?.slice(0, 16) ?? "null"}...`,
  );

  const destPath = `${smokeDir}/downloaded.bin`;
  const transfer = receiver.blobs.download(ticket, destPath);
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
  await transfer.done;
  await iteration;
  unsubscribe();
  check("Transfer.done resolves", true, `terminal resolve, ${lastBytes} bytes received`);
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
  const ticketAgain = await provider.blobs.share(sourceFile);
  check("re-share ticket equality", ticketAgain === ticket, "same endpoint, identical ticket");

  // Cross-endpoint re-share: different ticket string (different endpoint
  // addresses), identical content hash. This validates the native
  // parseTicket decode used by the download integrity check.
  const receiverTicket = await receiver.blobs.share(destPath);
  check(
    "cross-endpoint hash equality",
    receiverTicket !== ticket && parseTicket(receiverTicket).hash === contentHash,
    "tickets differ, content hashes match",
  );

  transfer.cancel();
  check("cancel idempotent", true, "no-op on settled transfer did not throw");

  let invalidTicketError: unknown;
  try {
    // Throws synchronously: parseTicket validation runs before native.
    await receiver.blobs.download("definitely-not-a-ticket", destPath).done;
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

  // Raw QUIC streams over a custom ALPN. This is the first typed-array
  // (ArrayBuffer) parameter to cross the Nitro bridge in the package, so it is
  // the on-device proof that bytes survive the bridge in both directions and
  // that framed sends keep their message boundaries. The receiver dials the
  // provider's direct address (relay is disabled), opens one bidirectional
  // stream, sends two framed payloads, and the provider echoes each back.
  const listener = provider.streams.listen(STREAMS_ALPN);
  const smallPayload = new Uint8Array([1, 2, 3, 4, 5]);
  const largePayload = rampBytes(5000);
  const serverEcho = (async () => {
    const connection = await firstWithin(listener.connections, 5000, "server connection");
    const stream = await firstWithin(connection.incoming, 5000, "server stream");
    const inbound = await readChunksWithin(stream, 2, 5000, "server chunks");
    for (const chunk of inbound) {
      await stream.send(chunk);
    }
    return inbound;
  })();

  const clientConnection = await receiver.streams.connect(provider.addr, STREAMS_ALPN);
  const clientStream = await clientConnection.openStream();
  await clientStream.send(smallPayload);
  await clientStream.send(largePayload);
  const echoes = await readChunksWithin(clientStream, 2, 5000, "client echoes");
  const serverReceived = await serverEcho;

  check(
    "streams framed receive",
    serverReceived.length === 2 &&
      bytesEqual(serverReceived[0], smallPayload) &&
      bytesEqual(serverReceived[1], largePayload),
    `${serverReceived.length} framed chunks, boundaries preserved`,
  );
  check(
    "streams echo roundtrip",
    echoes.length === 2 &&
      bytesEqual(echoes[0], smallPayload) &&
      bytesEqual(echoes[1], largePayload),
    `${echoes.reduce((total, chunk) => total + chunk.length, 0)} bytes returned across the bridge`,
  );

  clientStream.close();
  clientConnection.close();
  listener.close();

  await provider.close();
  await receiver.close();
  check("close", !provider.isOpen && !receiver.isOpen, "both endpoints report closed");
  check("id cached after close", provider.id.length > 0, "id readable after close");

  let staleError: unknown;
  try {
    await provider.blobs.share(sourceFile);
  } catch (error) {
    staleError = error;
  }
  check(
    "error path stale endpoint",
    staleError instanceof IrohError && staleError.code === 1001,
    `blobs.share after close rejected with code ${staleError instanceof IrohError ? staleError.code : "?"}`,
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
