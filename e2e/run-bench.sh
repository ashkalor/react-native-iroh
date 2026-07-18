#!/usr/bin/env bash
# Loopback performance benchmark for react-native-iroh's example app.
#
# Measures the hard path of the v0.1 API: many image-sized files shared and
# downloaded through the class API (endpoint.blobs.share / .download), one
# ticket per file. Provider and consumer endpoints run in the same app
# process on one emulator with the minimal preset, so the transfer is
# loopback QUIC: deterministic, and it measures the library stack (import,
# BLAKE3 hashing, QUIC, blob store, export, native thread pool, TS download
# queue) rather than relay infrastructure. Two minimal-preset endpoints on
# *different* emulators cannot dial each other (each emulator NATs its own
# 10.0.2.x network and tickets carry undialable addresses), and the n0
# preset would benchmark n0's public relays instead of this library.
#
# Run matrix (per invocation):
#   device A: mix-mcd4   100 files (60x300KiB, 30x1MiB, 10x3MiB), cap 4
#             mix-mcd8   same corpus, cap 8
#             mix-mcd1   same corpus, cap 1 (serialized downloads)
#             single-100m one 100MiB file (peak single-transfer throughput)
#   device B: mix-mcd4-b same as mix-mcd4 (cross-device consistency sample)
#
# Mechanics: the harness provisions random source files on-device (run-as +
# dd), serves a per-run plan.json over an adb-reversed port (the app's
# BenchSection auto-fetches it on launch and runs the plan), waits for the
# app's "BENCH: RESULT" logcat marker, verifies every downloaded file's size
# on-device, and prints a summary table parsed from the BENCH: markers.
# App JS changes need no rebuild: debug builds load the bundle from Metro.
#
# Requirements: at least one connected Android device/emulator with the
# example app installed (or an APK at the default build output path), Metro
# running or startable, and bun (for the tiny plan server).
#
# Env overrides: ADB, APK, SKIP_INSTALL=1, BENCH_PORT (default 8899),
# BENCH_RUN_TIMEOUT (seconds per run, default 900), BENCH_ARTIFACTS,
# BENCH_ONLY="mix-mcd4 single-100m" (restrict the matrix to named runs).
set -uo pipefail

APP_ID=com.irohexample
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$E2E_DIR")"
APK="${APK:-$REPO_DIR/example/android/app/build/outputs/apk/debug/app-debug.apk}"
ARTIFACTS="${BENCH_ARTIFACTS:-/tmp/iroh-bench-logs}"
SERVE_DIR="$ARTIFACTS/serve"
CONTROL_PORT="${BENCH_PORT:-8899}"
RUN_TIMEOUT="${BENCH_RUN_TIMEOUT:-900}"
FILES_BASE="/data/user/0/$APP_ID/files"
RESULTS="$ARTIFACTS/results.psv"

log() { printf '[bench] %s\n' "$*"; }

dump_logs() {
  mkdir -p "$ARTIFACTS"
  for d in "${DEVICES[@]:-}"; do
    [ -n "$d" ] && "$ADB" -s "$d" logcat -d > "$ARTIFACTS/logcat-$d.txt" 2>/dev/null
  done
  log "logcat dumps written to $ARTIFACTS"
}

fail() {
  log "FAIL: $*"
  dump_logs
  exit 1
}

# --- Tool discovery -------------------------------------------------------

if [ -z "${ADB:-}" ]; then
  if command -v adb >/dev/null 2>&1; then
    ADB=adb
  else
    fail "adb not found; set ADB=/path/to/adb"
  fi
fi
command -v bun >/dev/null 2>&1 || fail "bun not found (needed for the plan server)"

# --- Device selection -----------------------------------------------------

mapfile -t DEVICES < <("$ADB" devices | tr -d '\r' | awk 'NR>1 && $2=="device" {print $1}')
case "${#DEVICES[@]}" in
  0)
    fail "no devices connected"
    ;;
  1)
    DEVICE_A="${DEVICES[0]}"
    DEVICE_B=""
    log "single-device run: A=$DEVICE_A (no cross-device consistency sample)"
    ;;
  *)
    DEVICE_A="${DEVICES[0]}"
    DEVICE_B="${DEVICES[1]}"
    log "devices: A=$DEVICE_A (full matrix) B=$DEVICE_B (consistency sample)"
    ;;
esac
BENCH_DEVICES=("$DEVICE_A")
[ -n "$DEVICE_B" ] && BENCH_DEVICES+=("$DEVICE_B")

# --- App install + Metro --------------------------------------------------

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  [ -f "$APK" ] || fail "APK not found at $APK (build it or set SKIP_INSTALL=1)"
  PUSH_SRC="$APK"
  case "$ADB" in
    *.exe) PUSH_SRC="$(wslpath -w "$APK")" ;;
  esac
  for d in "${BENCH_DEVICES[@]}"; do
    "$ADB" -s "$d" push "$PUSH_SRC" /data/local/tmp/iroh-e2e.apk >/dev/null || fail "push to $d"
    "$ADB" -s "$d" shell pm install -r /data/local/tmp/iroh-e2e.apk >/dev/null || fail "install on $d"
    log "installed app on $d"
  done
fi

# A Metro this script starts is killed on exit (a lingering child would keep
# the script's process group alive in some sandboxed environments); a Metro
# that was already running is left untouched.
STARTED_METRO_PID=""
if ! timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/8081' 2>/dev/null; then
  log "starting Metro"
  mkdir -p "$ARTIFACTS"
  (cd "$REPO_DIR/example" && exec bun start > "$ARTIFACTS/metro.log" 2>&1) &
  STARTED_METRO_PID=$!
  for _ in $(seq 1 45); do
    timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/8081' 2>/dev/null && break
    sleep 2
  done
  timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/8081' 2>/dev/null || fail "Metro did not come up on 8081"
fi

for d in "${BENCH_DEVICES[@]}"; do
  "$ADB" -s "$d" reverse tcp:8081 tcp:8081 >/dev/null || fail "adb reverse 8081 on $d"
  "$ADB" -s "$d" reverse "tcp:$CONTROL_PORT" "tcp:$CONTROL_PORT" >/dev/null \
    || fail "adb reverse $CONTROL_PORT on $d"
done

# --- Plan server ----------------------------------------------------------

mkdir -p "$SERVE_DIR"
bun "$E2E_DIR/bench-server.mjs" "$SERVE_DIR" "$CONTROL_PORT" > "$ARTIFACTS/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" $STARTED_METRO_PID 2>/dev/null' EXIT
sleep 1
kill -0 "$SERVER_PID" 2>/dev/null || fail "plan server did not start (see $ARTIFACTS/server.log; port $CONTROL_PORT busy?)"

# --- Corpus manifests + on-device provisioning ----------------------------

# Manifest format: "<name> <bytes>" per line. All sizes are KiB multiples so
# the on-device dd runs with bs=1024 and no tail handling.
MIX_MANIFEST="$SERVE_DIR/manifest-mix.txt"
SINGLE_MANIFEST="$SERVE_DIR/manifest-single.txt"
{
  for i in $(seq 0 59); do printf 'mix-300k-%02d.bin 307200\n' "$i"; done
  for i in $(seq 0 29); do printf 'mix-1m-%02d.bin 1048576\n' "$i"; done
  for i in $(seq 0 9); do printf 'mix-3m-%02d.bin 3145728\n' "$i"; done
} > "$MIX_MANIFEST"
printf 'single-100m.bin 104857600\n' > "$SINGLE_MANIFEST"
cat "$MIX_MANIFEST" "$SINGLE_MANIFEST" > "$SERVE_DIR/manifest-all.txt"

# Provisioning script: runs under `run-as` (cwd = app data dir), creates any
# missing/wrong-sized source file from /dev/urandom.
cat > "$SERVE_DIR/provision.sh" <<'EOS'
set -e
mkdir -p files/bench-src
while read -r name bytes; do
  f="files/bench-src/$name"
  actual="$(stat -c %s "$f" 2>/dev/null || echo missing)"
  if [ "$actual" != "$bytes" ]; then
    dd if=/dev/urandom of="$f" bs=1024 count=$((bytes / 1024)) 2>/dev/null
  fi
done < /data/local/tmp/iroh-bench-manifest-all.txt
echo PROVISION-OK
EOS

# Download-size verifier: argument 1 is the on-device manifest to check
# against files/bench-work/dl/.
cat > "$SERVE_DIR/verify.sh" <<'EOS'
mismatches=0
count=0
while read -r name bytes; do
  count=$((count + 1))
  actual="$(stat -c %s "files/bench-work/dl/$name" 2>/dev/null || echo missing)"
  if [ "$actual" != "$bytes" ]; then
    echo "VERIFY-MISMATCH $name expected=$bytes actual=$actual"
    mismatches=$((mismatches + 1))
  fi
done < "$1"
echo "VERIFY files=$count mismatches=$mismatches"
EOS

to_push_path() { # to_push_path <linux-path> -> path usable by $ADB
  case "$ADB" in
    *.exe) wslpath -w "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

for d in "${BENCH_DEVICES[@]}"; do
  for f in manifest-all.txt manifest-mix.txt manifest-single.txt provision.sh verify.sh; do
    "$ADB" -s "$d" push "$(to_push_path "$SERVE_DIR/$f")" "/data/local/tmp/iroh-bench-$f" >/dev/null \
      || fail "push $f to $d"
  done
  log "provisioning source corpus on $d (about 178MiB of random data; reused if present)"
  out="$("$ADB" -s "$d" shell run-as "$APP_ID" sh /data/local/tmp/iroh-bench-provision.sh | tr -d '\r')"
  printf '%s\n' "$out" | grep -q "PROVISION-OK" || fail "provisioning on $d: $out"
done

# --- Per-run plumbing -----------------------------------------------------

write_plan() { # write_plan <run-id> <mcd> <manifest> <integrity-sample>
  local run_id="$1" mcd="$2" manifest="$3" sample="$4" sep=""
  {
    printf '{"runId":"%s","srcDir":"%s/bench-src","workDir":"%s/bench-work",' \
      "$run_id" "$FILES_BASE" "$FILES_BASE"
    printf '"maxConcurrentDownloads":%s,"integritySample":%s,"files":[' "$mcd" "$sample"
    while read -r name bytes; do
      printf '%s{"name":"%s","bytes":%s}' "$sep" "$name" "$bytes"
      sep=","
    done < "$manifest"
    printf ']}'
  } > "$SERVE_DIR/plan.json"
}

field() { # field <line> <key> -> numeric value or "?"
  local value
  value="$(printf '%s' "$1" | sed -nE "s/.* $2=([0-9.]+).*/\1/p")"
  printf '%s' "${value:-?}"
}

OVERALL=0

run_bench() { # run_bench <device> <run-id> <mcd> <manifest-basename> <integrity-sample>
  local device="$1" run_id="$2" mcd="$3" manifest="$4" sample="$5"
  local bench_log="$ARTIFACTS/bench-$device-$run_id.txt"

  # BENCH_ONLY="id1 id2" restricts the matrix to the named runs.
  if [ -n "${BENCH_ONLY:-}" ]; then
    case " ${BENCH_ONLY} " in
      *" $run_id "*) ;;
      *) return ;;
    esac
  fi

  log "run $run_id on $device (mcd=$mcd)"
  write_plan "$run_id" "$mcd" "$SERVE_DIR/$manifest" "$sample"
  "$ADB" -s "$device" shell run-as "$APP_ID" rm -rf files/bench-work
  "$ADB" -s "$device" shell run-as "$APP_ID" mkdir -p files/bench-work/dl \
    || { log "ASSERT FAILED: $run_id workdir setup"; OVERALL=1; return; }
  "$ADB" -s "$device" shell am force-stop "$APP_ID" >/dev/null 2>&1
  "$ADB" -s "$device" logcat -c
  "$ADB" -s "$device" shell am start -n "$APP_ID/.MainActivity" >/dev/null 2>&1

  local result_line
  result_line="$(timeout "$RUN_TIMEOUT" "$ADB" -s "$device" logcat -e "BENCH: RESULT" -m 1 2>/dev/null \
    | tr -d '\r' | grep -oE "BENCH: RESULT.*" | head -1)"
  "$ADB" -s "$device" logcat -d | tr -d '\r' | grep -oE "BENCH: .*" > "$bench_log"
  if [ -z "$result_line" ]; then
    log "ASSERT FAILED: $run_id produced no BENCH: RESULT within ${RUN_TIMEOUT}s"
    sed 's/^/[bench]   /' "$bench_log"
    OVERALL=1
    return
  fi

  local verify share_line download_line integrity_line verdict
  verify="$("$ADB" -s "$device" shell run-as "$APP_ID" sh /data/local/tmp/iroh-bench-verify.sh \
    "/data/local/tmp/iroh-bench-$manifest" | tr -d '\r')"
  printf '%s\n' "$verify" | grep -E "VERIFY-MISMATCH" | head -5 | sed 's/^/[bench]   /'
  local mismatches
  mismatches="$(printf '%s\n' "$verify" | sed -nE 's/.*mismatches=([0-9]+).*/\1/p')"

  share_line="$(grep "BENCH: SHARE " "$bench_log" | tail -1)"
  download_line="$(grep "BENCH: DOWNLOAD " "$bench_log" | tail -1)"
  integrity_line="$(grep "BENCH: INTEGRITY " "$bench_log" | tail -1)"
  verdict="${result_line##* }"
  if [ "$verdict" != "PASS" ] || [ "${mismatches:-1}" != "0" ]; then
    log "ASSERT FAILED: $run_id verdict=$verdict size-mismatches=${mismatches:-?}"
    grep "BENCH: ERROR" "$bench_log" | sed 's/^/[bench]   /'
    OVERALL=1
  fi

  local files bytes mib
  files="$(field "$download_line" files)"
  bytes="$(field "$download_line" bytes)"
  case "$bytes" in
    '?') mib="?" ;;
    *) mib="$(awk "BEGIN {printf \"%.1f\", $bytes / 1048576}")" ;;
  esac
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s/%s|%s|%s\n' \
    "$run_id" "$device" "$mcd" "$files" \
    "$mib" \
    "$(field "$share_line" ms)" \
    "$(field "$download_line" ms)" \
    "$(field "$download_line" mibps)" \
    "$(field "$download_line" p50)" \
    "$(field "$download_line" p95)" \
    "$(field "$download_line" p50act)" \
    "$(field "$download_line" p95act)" \
    "$(field "$integrity_line" pass)" "$(field "$integrity_line" sample)" \
    "${mismatches:-?}" "$verdict" >> "$RESULTS"

  # Free the transient stores/downloads before the next run.
  "$ADB" -s "$device" shell run-as "$APP_ID" rm -rf files/bench-work
  "$ADB" -s "$device" shell am force-stop "$APP_ID" >/dev/null 2>&1
}

# --- Run matrix -----------------------------------------------------------

mkdir -p "$ARTIFACTS"
: > "$RESULTS"

# No stray app instance may fetch a mid-matrix plan meant for another device.
for d in "${BENCH_DEVICES[@]}"; do
  "$ADB" -s "$d" shell am force-stop "$APP_ID" >/dev/null 2>&1
done

run_bench "$DEVICE_A" mix-mcd4 4 manifest-mix.txt 10
run_bench "$DEVICE_A" mix-mcd8 8 manifest-mix.txt 10
run_bench "$DEVICE_A" mix-mcd1 1 manifest-mix.txt 10
run_bench "$DEVICE_A" single-100m 4 manifest-single.txt 1
if [ -n "$DEVICE_B" ]; then
  run_bench "$DEVICE_B" mix-mcd4-b 4 manifest-mix.txt 10
fi

# --- Summary --------------------------------------------------------------

log "----- benchmark summary -----"
{
  printf 'RUN|DEVICE|MCD|FILES|MiB|SHARE_MS|DL_MS|MiB/S|P50|P95|P50ACT|P95ACT|INTEG|SIZES_BAD|VERDICT\n'
  cat "$RESULTS"
} | column -t -s '|'
log "-----------------------------"
log "columns: SHARE_MS/DL_MS wall time; P50/P95 per-file enqueue-to-settle ms;"
log "P50ACT/P95ACT first-progress-to-settle ms; INTEG integrity sample passed;"
log "raw markers and logs in $ARTIFACTS"

if [ "$OVERALL" -ne 0 ]; then
  fail "benchmark assertions failed"
fi
log "BENCH: RESULT ALL PASS"
