/**
 * Benchmark runner: measures share and download performance of the public
 * class API under a plan served by the harness (e2e/run-bench.sh) on an
 * adb-reversed local port.
 *
 * Both endpoints live in this app process and use the isolated profile, so
 * the transfer runs over loopback QUIC. That is deliberate: two emulators
 * each sit behind their own virtual NAT, so isolated (relay-less) endpoints
 * on different emulators cannot dial each other, and the standard profile
 * would benchmark public relay infrastructure instead of this library.
 * Loopback exercises the full shipped stack — file import, BLAKE3 hashing,
 * QUIC transfer, blob store, export to disk, the native thread pool, and the
 * TS download queue — without network variance.
 *
 * All measurements are emitted as `BENCH:` logcat markers (see markers.ts);
 * the harness greps them and prints a summary table.
 */
import { Endpoint } from "react-native-iroh";
import { benchReport, benchResult } from "./markers";
import { extractTicketHash } from "./ticketHash";

/**
 * Where the app looks for a benchmark plan. Reachable only when the harness
 * has set up `adb reverse` and its control server; in normal interactive use
 * the fetch fails immediately (connection refused) and the bench stays idle.
 */
export const BENCH_PLAN_URL = "http://localhost:8899/plan.json";

/** One source file of the benchmark corpus (relative to the plan's srcDir). */
export interface BenchFile {
  readonly name: string;
  readonly bytes: number;
}

/** A single benchmark run, produced by e2e/run-bench.sh. */
export interface BenchPlan {
  /** Identifier echoed in every marker, e.g. "mix-mcd4". */
  readonly runId: string;
  /** Absolute directory holding the harness-provisioned source files. */
  readonly srcDir: string;
  /**
   * Absolute scratch directory for this run (blob stores and downloads live
   * under it). The harness creates `<workDir>/dl` and wipes the whole
   * directory between runs.
   */
  readonly workDir: string;
  readonly files: readonly BenchFile[];
  /** Consumer endpoint's download-concurrency cap for this run. */
  readonly maxConcurrentDownloads: number;
  /**
   * How many downloaded files to integrity-check by re-sharing them and
   * comparing ticket content hashes. A sample keeps verification honest
   * without dominating the measured run.
   */
  readonly integritySample: number;
}

const timeSource = (globalThis as { performance?: { now(): number } }).performance;

/** Monotonic-ish milliseconds; falls back to Date.now if performance is absent. */
function now(): number {
  return timeSource ? timeSource.now() : Date.now();
}

function isBenchFile(value: unknown): value is BenchFile {
  const file = value as { name?: unknown; bytes?: unknown };
  return (
    typeof file === "object" &&
    value !== null &&
    typeof file.name === "string" &&
    typeof file.bytes === "number"
  );
}

/** Validates a fetched payload as a {@link BenchPlan}; throws when malformed. */
export function parseBenchPlan(payload: unknown): BenchPlan {
  const plan = payload as {
    runId?: unknown;
    srcDir?: unknown;
    workDir?: unknown;
    files?: unknown;
    maxConcurrentDownloads?: unknown;
    integritySample?: unknown;
  };
  if (
    typeof plan !== "object" ||
    payload === null ||
    typeof plan.runId !== "string" ||
    typeof plan.srcDir !== "string" ||
    typeof plan.workDir !== "string" ||
    !Array.isArray(plan.files) ||
    plan.files.length === 0 ||
    !plan.files.every(isBenchFile) ||
    typeof plan.maxConcurrentDownloads !== "number" ||
    typeof plan.integritySample !== "number"
  ) {
    throw new Error("malformed bench plan");
  }
  return {
    runId: plan.runId,
    srcDir: plan.srcDir,
    workDir: plan.workDir,
    files: plan.files,
    maxConcurrentDownloads: plan.maxConcurrentDownloads,
    integritySample: plan.integritySample,
  };
}

/**
 * Fetches the harness-served plan. Resolves null when no server is reachable
 * (the normal case outside harness runs); throws when the server responds
 * with something that is not a valid plan.
 */
export async function fetchBenchPlan(url: string = BENCH_PLAN_URL): Promise<BenchPlan | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  let payload: unknown;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "cache-control": "no-store" },
    });
    if (!response.ok) {
      return null;
    }
    payload = await response.json();
  } catch {
    // Connection refused / timeout: no harness present.
    return null;
  } finally {
    clearTimeout(timer);
  }
  return parseBenchPlan(payload);
}

/**
 * Nearest-rank percentile, rounded to whole milliseconds. `fraction` is in
 * (0, 1], e.g. 0.5 for p50.
 */
function percentileMs(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[index] ?? 0);
}

interface DownloadOutcome {
  readonly ok: boolean;
  /** Enqueue (downloadBlob call) to settle: queue wait included. */
  readonly totalMs: number;
  /** First progress event to settle: approximates active transfer time. */
  readonly activeMs: number;
  readonly error: string;
}

/**
 * Executes one benchmark run and emits `BENCH:` markers. Returns whether the
 * run passed (all downloads completed and the integrity sample matched).
 * Never rejects: failures are reported through markers and the return value.
 */
export async function runBenchPlan(plan: BenchPlan, log: (line: string) => void): Promise<boolean> {
  const emit = (tag: string, detail: string): void => {
    benchReport(tag, detail);
    log(`${tag} ${detail}`);
  };
  const run = plan.runId;
  const totalBytes = plan.files.reduce((sum, file) => sum + file.bytes, 0);
  emit(
    "START",
    `run=${run} files=${plan.files.length} bytes=${totalBytes} mcd=${plan.maxConcurrentDownloads}`,
  );

  let provider: Endpoint | null = null;
  let consumer: Endpoint | null = null;
  let ok = false;
  try {
    provider = await Endpoint.create({
      profile: "isolated",
      blobStoreDir: `${plan.workDir}/provider-store`,
    });
    consumer = await Endpoint.create({
      profile: "isolated",
      blobStoreDir: `${plan.workDir}/consumer-store`,
      maxConcurrentDownloads: plan.maxConcurrentDownloads,
    });
    const providerEndpoint = provider;
    const consumerEndpoint = consumer;

    // Share phase: fire all imports concurrently, as an app sharing a batch
    // would. Per-share latency therefore includes native pool queueing.
    const shareStart = now();
    const shareLatencies: number[] = [];
    const tickets = await Promise.all(
      plan.files.map(async (file) => {
        const start = now();
        const ticket = await providerEndpoint.shareBlob(`${plan.srcDir}/${file.name}`);
        shareLatencies.push(now() - start);
        return ticket;
      }),
    );
    const shareMs = Math.round(now() - shareStart);
    emit(
      "SHARE",
      `run=${run} files=${plan.files.length} ms=${shareMs} p50=${percentileMs(shareLatencies, 0.5)} p95=${percentileMs(
        shareLatencies,
        0.95,
      )}`,
    );

    const jobs = plan.files.map((file, index) => ({
      file,
      ticket: tickets[index] ?? "",
      destPath: `${plan.workDir}/dl/${file.name}`,
    }));

    // Download phase: enqueue everything at once; the endpoint's FIFO queue
    // admits maxConcurrentDownloads at a time.
    const downloadStart = now();
    const outcomes: DownloadOutcome[] = await Promise.all(
      jobs.map((job) => {
        const enqueuedAt = now();
        const transfer = consumerEndpoint.downloadBlob(job.ticket, job.destPath);
        let firstProgressAt: number | null = null;
        const unsubscribe = transfer.onProgress(() => {
          if (firstProgressAt === null) {
            firstProgressAt = now();
          }
        });
        return transfer.promise.then(
          (): DownloadOutcome => {
            unsubscribe();
            const settledAt = now();
            return {
              ok: true,
              totalMs: settledAt - enqueuedAt,
              activeMs: settledAt - (firstProgressAt ?? enqueuedAt),
              error: "",
            };
          },
          (error: unknown): DownloadOutcome => {
            unsubscribe();
            return { ok: false, totalMs: 0, activeMs: 0, error: String(error) };
          },
        );
      }),
    );
    const downloadMs = Math.round(now() - downloadStart);

    const failures = outcomes.filter((outcome) => !outcome.ok);
    if (failures.length > 0) {
      throw new Error(`${failures.length} downloads failed; first: ${failures[0]?.error ?? "?"}`);
    }
    const totals = outcomes.map((outcome) => outcome.totalMs);
    const actives = outcomes.map((outcome) => outcome.activeMs);
    const mibps = totalBytes / 1048576 / Math.max(0.001, downloadMs / 1000);
    emit(
      "DOWNLOAD",
      `run=${run} files=${jobs.length} bytes=${totalBytes} ms=${downloadMs} mibps=${mibps.toFixed(2)} p50=${percentileMs(
        totals,
        0.5,
      )} p95=${percentileMs(totals, 0.95)} p50act=${percentileMs(actives, 0.5)} p95act=${percentileMs(
        actives,
        0.95,
      )}`,
    );

    // Integrity sample: re-share downloaded files and compare the BLAKE3
    // content hash embedded in the tickets. Validates exported bytes on disk
    // without hashing the whole corpus twice in the measured path.
    const sampleSize = Math.max(1, Math.min(plan.integritySample, jobs.length));
    let passed = 0;
    for (let index = 0; index < sampleSize; index += 1) {
      const job = jobs[Math.floor((index * jobs.length) / sampleSize)];
      if (job === undefined) {
        continue;
      }
      const reShareTicket = await consumerEndpoint.shareBlob(job.destPath);
      const expected = extractTicketHash(job.ticket);
      if (expected !== null && extractTicketHash(reShareTicket) === expected) {
        passed += 1;
      }
    }
    emit("INTEGRITY", `run=${run} pass=${passed} sample=${sampleSize}`);
    ok = passed === sampleSize;
  } catch (error) {
    emit("ERROR", `run=${run} ${String(error)}`);
    ok = false;
  } finally {
    // Close before the RESULT marker so the harness never wipes a store that
    // is still open.
    await provider?.close().catch(() => undefined);
    await consumer?.close().catch(() => undefined);
  }
  benchResult(run, ok);
  log(`RESULT ${run} ${ok ? "PASS" : "FAIL"}`);
  return ok;
}
