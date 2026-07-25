#!/usr/bin/env bash
# Shared harness plumbing for run-e2e.sh and run-bench.sh: logging, tool
# discovery, device listing, app install, and Metro.
#
# Both harnesses drive the same example app on the same devices, so they had
# the same setup code twice and it drifted (they wrote their Metro log to
# different paths). This file is the single copy.
#
# Contract: set LOG_TAG, ARTIFACTS, REPO_DIR and APK before sourcing, then call
# the functions you need. Nothing runs on source: device selection differs
# between the two harnesses, so each one drives it.

log() { printf '[%s] %s\n' "$LOG_TAG" "$*"; }

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

# adb is taken from PATH; override with ADB=/path/to/adb (an adb.exe under
# /mnt/c works from WSL: APK paths are converted for it automatically).
discover_adb() {
  if [ -n "${ADB:-}" ]; then
    return 0
  fi
  if command -v adb >/dev/null 2>&1; then
    ADB=adb
  else
    fail "adb not found; set ADB=/path/to/adb"
  fi
}

discover_maestro() {
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
}

# Maestro needs JDK 17+; borrow the Gradle JDK if the ambient java is older.
ensure_jdk17() {
  local java_major jdk
  java_major="$(java -version 2>&1 | sed -nE 's/.*version "([0-9]+).*/\1/p' | head -1)"
  if [ "${java_major:-0}" -ge 17 ]; then
    return 0
  fi
  for jdk in "$HOME"/.jdks/jdk-17* /usr/lib/jvm/temurin-17* /usr/lib/jvm/zulu-17*; do
    if [ -x "$jdk/bin/java" ]; then
      export JAVA_HOME="$jdk"
      export PATH="$jdk/bin:$PATH"
      return 0
    fi
  done
}

# Fills the DEVICES array with every connected device serial.
list_devices() {
  mapfile -t DEVICES < <("$ADB" devices | tr -d '\r' | awk 'NR>1 && $2=="device" {print $1}')
  [ "${#DEVICES[@]}" -gt 0 ] || fail "no devices connected"
}

install_app() { # install_app <device>...
  local d push_src="$APK"
  [ -f "$APK" ] || fail "APK not found at $APK (build it or set SKIP_INSTALL=1)"
  # A Windows-side adb.exe (WSL interop) cannot read Linux filesystem paths;
  # hand it the \\wsl.localhost\ UNC form instead.
  case "$ADB" in
    *.exe) push_src="$(wslpath -w "$APK")" ;;
  esac
  for d in "$@"; do
    "$ADB" -s "$d" push "$push_src" /data/local/tmp/iroh-e2e.apk >/dev/null || fail "push to $d"
    "$ADB" -s "$d" shell pm install -r /data/local/tmp/iroh-e2e.apk >/dev/null || fail "install on $d"
    log "installed app on $d"
  done
}

metro_listening() { timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/8081' 2>/dev/null; }

# Starts Metro unless something already serves 8081. Sets STARTED_METRO_PID to
# the new process when this script started it, and to the empty string when an
# existing Metro was reused, so a caller can decide whether to stop it on exit.
ensure_metro() {
  local _
  STARTED_METRO_PID=""
  metro_listening && return 0
  log "starting Metro"
  mkdir -p "$ARTIFACTS"
  (cd "$REPO_DIR/example" && exec bun start > "$ARTIFACTS/metro.log" 2>&1) &
  STARTED_METRO_PID=$!
  for _ in $(seq 1 45); do
    metro_listening && return 0
    sleep 2
  done
  fail "Metro did not come up on 8081 (see $ARTIFACTS/metro.log)"
}

reverse_port() { # reverse_port <port> <device>...
  local port="$1" d
  shift
  for d in "$@"; do
    "$ADB" -s "$d" reverse "tcp:$port" "tcp:$port" >/dev/null \
      || fail "adb reverse $port on $d"
  done
}
