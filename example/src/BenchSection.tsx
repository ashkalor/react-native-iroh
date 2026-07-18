import React, { useCallback, useEffect, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { fetchBenchPlan, runBenchPlan } from "./bench";
import { sectionStyles } from "./theme";

type BenchStatus = "idle" | "running" | "pass" | "fail";

const STATUS_LABEL: Record<BenchStatus, string> = {
  idle: "Idle (no harness plan served)",
  running: "RUNNING...",
  pass: "PASS",
  fail: "FAIL",
};

const VISIBLE_LINES = 12;

/**
 * Benchmark harness hook: on mount (and via the button, for manual reruns)
 * the section asks the harness control server for a plan and executes it.
 * Outside harness runs the plan fetch fails immediately and nothing happens,
 * so this section is inert in normal interactive use.
 */
function BenchSection(): React.JSX.Element {
  const [status, setStatus] = useState<BenchStatus>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const runningRef = useRef(false);

  const run = useCallback(async () => {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    setLines([]);
    try {
      const plan = await fetchBenchPlan();
      if (plan === null) {
        setStatus("idle");
        return;
      }
      setStatus("running");
      const ok = await runBenchPlan(plan, (line) => {
        setLines((previous) => [...previous.slice(1 - VISIBLE_LINES), line]);
      });
      setStatus(ok ? "pass" : "fail");
    } catch (error) {
      setLines((previous) => [...previous, String(error)]);
      setStatus("fail");
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <View style={sectionStyles.section}>
      <Text style={sectionStyles.heading}>Benchmark</Text>
      <TouchableOpacity
        testID="bench-run"
        accessibilityRole="button"
        style={sectionStyles.button}
        disabled={status === "running"}
        onPress={run}
      >
        <Text style={sectionStyles.buttonLabel}>
          {status === "running" ? "Running..." : "Run Benchmark"}
        </Text>
      </TouchableOpacity>
      <Text
        style={[
          sectionStyles.monoLine,
          styles.status,
          status === "pass" && sectionStyles.passText,
          status === "fail" && sectionStyles.failText,
        ]}
        testID="bench-status"
      >
        {STATUS_LABEL[status]}
      </Text>
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`} style={sectionStyles.monoLine}>
          {line}
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

export default React.memo(BenchSection);
