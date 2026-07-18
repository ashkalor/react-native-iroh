#!/usr/bin/env bash
# Two-device E2E for react-native-iroh's example app.
#
# Flow: device A gets a FILE_MB-sized random test file provisioned into app
# storage (run-as + dd), shares it via the app UI (Maestro), the ticket is
# extracted from A's logcat ("E2E: TICKET ..." marker), then device B's UI is
# driven to paste the ticket and download. Asserts (from logcat markers the
# app emits, plus a Maestro on-screen check):
#   - E2E: PASS share
#   - E2E: PASS download-complete
#   - E2E: PASS progress-observed  (>= 1 progress event)
#   - E2E: PASS integrity          (content hash of re-shared download matches)
#
# Requirements: two connected Android devices/emulators with the example app
# installed (or an APK at the default build output path, which this script
# installs), Metro running or startable, and Maestro + JDK 17 available.
# With a single device it falls back to a loopback transfer and says so.
#
# Env overrides: ADB, MAESTRO, APK, FILE_MB (default 5), E2E_ARTIFACTS,
# SKIP_INSTALL=1.
set -uo pipefail

APP_ID=com.irohexample
FILE_MB="${FILE_MB:-5}"
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$E2E_DIR")"
APK="${APK:-$REPO_DIR/example/android/app/build/outputs/apk/debug/app-debug.apk}"
ARTIFACTS="${E2E_ARTIFACTS:-/tmp/iroh-e2e-logs}"

log() { printf '[e2e] %s\n' "$*"; }

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

# adb is taken from PATH; override with ADB=/path/to/adb (an adb.exe under
# /mnt/c works from WSL: APK paths are converted for it automatically).
if [ -z "${ADB:-}" ]; then
  if command -v adb >/dev/null 2>&1; then
    ADB=adb
  else
    fail "adb not found; set ADB=/path/to/adb"
  fi
fi

if [ -z "${MAESTRO:-}" ]; then
  if command -v maestro >/dev/null 2>&1; then
    MAESTRO=maestro
  elif [ -x "$HOME/.maestro/bin/maestro" ]; then
    MAESTRO="$HOME/.maestro/bin/maestro"
  else
    fail "maestro not found; install with: curl -Ls https://get.maestro.mobile.dev | bash"
  fi
fi
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export MAESTRO_CLI_NO_ANALYTICS=1

# Self-healing relaunch: force-stop the app (and Maestro's on-device driver,
# which occasionally loses its gRPC forward), clear the log buffer so stale
# markers from the failed attempt cannot pollute assertions, start the app
# fresh, and wait for its "E2E: READY" marker before driving any UI.
relaunch_app() { # relaunch_app <device>
  local device="$1"
  "$ADB" -s "$device" shell am force-stop "$APP_ID" >/dev/null 2>&1
  "$ADB" -s "$device" shell am force-stop dev.mobile.maestro >/dev/null 2>&1
  "$ADB" -s "$device" logcat -c
  "$ADB" -s "$device" shell am start -n "$APP_ID/.MainActivity" >/dev/null 2>&1
  # Let logcat do the matching: stream (buffer contents first, then follow)
  # and exit at the first READY marker instead of re-dumping every 2s.
  if timeout 120 "$ADB" -s "$device" logcat -e "E2E: READY" -m 1 >/dev/null 2>&1; then
    return 0
  fi
  log "WARNING: app on $device did not emit E2E: READY within 120s of relaunch"
  return 1
}

# Retries recover from transient Maestro driver failures. Each retry starts
# from a known state: relaunched app, empty log buffer, READY confirmed.
# (Flows are retry-safe; in single-device loopback a relaunch also discards
# the sharing endpoint, so a download retry there cannot succeed - loopback
# is a best-effort fallback.)
run_flow() { # run_flow <device> <description> <maestro test args...>
  local device="$1" desc="$2" attempt
  shift 2
  for attempt in 1 2 3; do
    if [ "$attempt" -gt 1 ]; then
      log "self-healing: relaunching app on $device and waiting for E2E: READY"
      relaunch_app "$device" || true
    fi
    "$MAESTRO" --device "$device" test "$@" && return 0
    log "maestro $desc attempt $attempt failed on $device"
  done
  return 1
}

# Maestro needs JDK 17+; borrow the Gradle JDK if the ambient java is older.
java_major="$(java -version 2>&1 | sed -nE 's/.*version "([0-9]+).*/\1/p' | head -1)"
if [ "${java_major:-0}" -lt 17 ]; then
  for jdk in "$HOME"/.jdks/jdk-17* /usr/lib/jvm/temurin-17* /usr/lib/jvm/zulu-17*; do
    if [ -x "$jdk/bin/java" ]; then
      export JAVA_HOME="$jdk"
      export PATH="$jdk/bin:$PATH"
      break
    fi
  done
fi

# --- Device selection -----------------------------------------------------

mapfile -t DEVICES < <("$ADB" devices | tr -d '\r' | awk 'NR>1 && $2=="device" {print $1}')
case "${#DEVICES[@]}" in
  0)
    fail "no devices connected"
    ;;
  1)
    DEVICE_A="${DEVICES[0]}"
    DEVICE_B="${DEVICES[0]}"
    log "NOTE: single device (${DEVICE_A}) - falling back to loopback transfer"
    ;;
  *)
    DEVICE_A="${DEVICES[0]}"
    DEVICE_B="${DEVICES[1]}"
    log "two-device run: A=$DEVICE_A (share) B=$DEVICE_B (download)"
    ;;
esac

# --- App install + Metro --------------------------------------------------

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  [ -f "$APK" ] || fail "APK not found at $APK (build it or set SKIP_INSTALL=1)"
  # A Windows-side adb.exe (WSL interop) cannot read Linux filesystem paths;
  # hand it the \\wsl.localhost\ UNC form instead.
  PUSH_SRC="$APK"
  case "$ADB" in
    *.exe) PUSH_SRC="$(wslpath -w "$APK")" ;;
  esac
  for d in "$DEVICE_A" "$DEVICE_B"; do
    "$ADB" -s "$d" push "$PUSH_SRC" /data/local/tmp/iroh-e2e.apk >/dev/null || fail "push to $d"
    "$ADB" -s "$d" shell pm install -r /data/local/tmp/iroh-e2e.apk >/dev/null || fail "install on $d"
    log "installed app on $d"
  done
fi

# Debug builds load JS from Metro; start it if nothing listens on 8081.
if ! timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/8081' 2>/dev/null; then
  log "starting Metro"
  (cd "$REPO_DIR/example" && nohup bun start > "$ARTIFACTS-metro.log" 2>&1 &)
  for _ in $(seq 1 45); do
    timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/8081' 2>/dev/null && break
    sleep 2
  done
  timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/8081' 2>/dev/null || fail "Metro did not come up on 8081"
fi

for d in "$DEVICE_A" "$DEVICE_B"; do
  "$ADB" -s "$d" reverse tcp:8081 tcp:8081 >/dev/null || fail "adb reverse on $d"
done

# --- Fresh state + provisioning ------------------------------------------

# Every run starts from first-launch state: kill any running instance and
# wipe app data (endpoint store, downloads, UI state) on both devices.
for d in "$DEVICE_A" "$DEVICE_B"; do
  "$ADB" -s "$d" shell am force-stop "$APP_ID" >/dev/null 2>&1
  "$ADB" -s "$d" shell pm clear "$APP_ID" >/dev/null || fail "pm clear on $d"
done

log "provisioning ${FILE_MB}MB test file on $DEVICE_A"
# pm clear wipes the app data dir including files/; recreate it first.
"$ADB" -s "$DEVICE_A" shell run-as "$APP_ID" mkdir -p files
"$ADB" -s "$DEVICE_A" shell run-as "$APP_ID" dd if=/dev/urandom of=files/e2e-share.bin bs=1048576 "count=$FILE_MB" 2>/dev/null
size="$("$ADB" -s "$DEVICE_A" shell run-as "$APP_ID" stat -c %s files/e2e-share.bin | tr -d '\r')"
[ "$size" = "$((FILE_MB * 1048576))" ] || fail "test file provisioning: size=$size expected=$((FILE_MB * 1048576))"
log "test file ready ($size bytes)"

# --- Share on device A ----------------------------------------------------

"$ADB" -s "$DEVICE_A" logcat -c
log "driving share flow on $DEVICE_A"
run_flow "$DEVICE_A" share "$E2E_DIR/flows/share.yaml" || fail "share flow failed on $DEVICE_A"

# One logcat dump serves both the ticket and the share marker extraction.
SHARE_LOG="$("$ADB" -s "$DEVICE_A" logcat -d | tr -d '\r')"
TICKET="$(printf '%s\n' "$SHARE_LOG" | grep "E2E: TICKET " | tail -1 | sed 's/.*E2E: TICKET //')"
case "$TICKET" in
  blob*) log "ticket extracted (${#TICKET} chars)" ;;
  *) fail "could not extract ticket from $DEVICE_A logcat" ;;
esac
SHARE_MARKER="$(printf '%s\n' "$SHARE_LOG" | grep -oE "E2E: (PASS|FAIL) share.*" | tail -1)"
case "$SHARE_MARKER" in
  "E2E: PASS share"*) ;;
  *) fail "share marker missing or failed: $SHARE_MARKER" ;;
esac

# --- Download on device B -------------------------------------------------

# Only clear B's log when it is a distinct device; in loopback the share
# markers above live in the same buffer and the download markers are new.
if [ "$DEVICE_B" != "$DEVICE_A" ]; then
  "$ADB" -s "$DEVICE_B" logcat -c
fi
log "driving download flow on $DEVICE_B"
run_flow "$DEVICE_B" download -e "TICKET=$TICKET" "$E2E_DIR/flows/download.yaml" \
  || fail "download flow failed on $DEVICE_B (UI-level Integrity: PASS assert included)"

# --- Assertions from app-emitted markers ----------------------------------

MARKERS="$("$ADB" -s "$DEVICE_B" logcat -d | tr -d '\r' | grep -oE "E2E: (PASS|FAIL) .*")"
log "----- assert markers -----"
printf '%s\n' "$SHARE_MARKER"
printf '%s\n' "$MARKERS" | grep -E "download-complete|progress-observed|integrity"
log "--------------------------"

STATUS=0
printf '%s\n' "$MARKERS" | grep -q "^E2E: PASS download-complete" || { log "ASSERT FAILED: download-complete"; STATUS=1; }
printf '%s\n' "$MARKERS" | grep -q "^E2E: PASS progress-observed" || { log "ASSERT FAILED: progress-observed"; STATUS=1; }
printf '%s\n' "$MARKERS" | grep -q "^E2E: PASS integrity" || { log "ASSERT FAILED: integrity"; STATUS=1; }
if printf '%s\n' "$MARKERS" | grep -q "^E2E: FAIL"; then
  log "ASSERT FAILED: at least one E2E: FAIL marker present"
  STATUS=1
fi

if [ "$STATUS" -ne 0 ]; then
  fail "E2E assertions failed"
fi

# --- Smoke suite on device A ----------------------------------------------
# The adapted Phase 2 raw-surface suite, now expressed through the class API.
# Runs on device A (idle since sharing); asserts the app-emitted markers.

"$ADB" -s "$DEVICE_A" logcat -c
log "driving smoke suite on $DEVICE_A"
run_flow "$DEVICE_A" smoke "$E2E_DIR/flows/smoke.yaml" || fail "smoke flow failed on $DEVICE_A"

SMOKE="$("$ADB" -s "$DEVICE_A" logcat -d | tr -d '\r' | grep -oE "SMOKE: .*")"
log "----- smoke markers ------"
printf '%s\n' "$SMOKE" | grep -E "^SMOKE: (PASS|FAIL|RESULT)"
log "--------------------------"
printf '%s\n' "$SMOKE" | grep -q "^SMOKE: RESULT ALL PASS" || fail "smoke suite did not report ALL PASS"
if printf '%s\n' "$SMOKE" | grep -qE "^SMOKE: (FAIL|SUITE ABORTED)"; then
  fail "smoke suite emitted a FAIL marker"
fi

log "E2E: RESULT ALL PASS"
