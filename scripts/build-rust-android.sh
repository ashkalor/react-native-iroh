#!/usr/bin/env bash
# Builds libIroh_rust.a (release) for all four Android ABIs with one command.
#
# Usage: bun run build:rust:android  (or: bash scripts/build-rust-android.sh)
#
# Requirements:
#   - rustup targets: aarch64-linux-android, armv7-linux-androideabi,
#     x86_64-linux-android, i686-linux-android
#   - Android NDK (ANDROID_NDK_HOME, or auto-detected under the SDK)
#
# Outputs: target/<triple>/release/libIroh_rust.a per target, plus a size table.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# WSL: strip Windows PATH entries. Paths like "Program Files (x86)" contain
# parentheses that break ninja/cmake command lines, and Windows toolchains
# must never be picked up by cargo or its build scripts.
if grep -qi microsoft /proc/version 2>/dev/null; then
  PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/c' | paste -sd:)"
  export PATH
fi

case "$(uname -s)" in
  Darwin) HOST_TAG="darwin-x86_64" ;;
  *) HOST_TAG="linux-x86_64" ;;
esac

# Locate the NDK: ANDROID_NDK_HOME/ANDROID_NDK_ROOT first, then any NDKs
# installed under the Android SDK (newest first). On WSL, Windows-side
# installs under /mnt are skipped: their prebuilt toolchains are Windows
# binaries and cannot run here.
CANDIDATES=()
[ -n "${ANDROID_NDK_HOME:-}" ] && CANDIDATES+=("$ANDROID_NDK_HOME")
[ -n "${ANDROID_NDK_ROOT:-}" ] && CANDIDATES+=("$ANDROID_NDK_ROOT")
for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk"; do
  [ -d "$sdk/ndk" ] || continue
  while IFS= read -r d; do CANDIDATES+=("$d"); done \
    < <(find "$sdk/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -rV)
done

TOOLCHAIN=""
for ndk in "${CANDIDATES[@]}"; do
  case "$ndk" in /mnt/*) continue ;; esac
  if [ -d "$ndk/toolchains/llvm/prebuilt/$HOST_TAG/bin" ]; then
    TOOLCHAIN="$ndk/toolchains/llvm/prebuilt/$HOST_TAG/bin"
    echo "Using NDK: $ndk"
    break
  fi
done
if [ -z "$TOOLCHAIN" ]; then
  echo "error: no usable Android NDK found. Set ANDROID_NDK_HOME or install an NDK under \$ANDROID_HOME/ndk." >&2
  exit 1
fi

# ABI -> rust target triple. The Android API level (24, = minSdkVersion) is
# selected by the per-target link-args in .cargo/config.toml.
TARGETS=(
  "arm64-v8a aarch64-linux-android"
  "armeabi-v7a armv7-linux-androideabi"
  "x86_64 x86_64-linux-android"
  "x86 i686-linux-android"
)

MISSING=""
for entry in "${TARGETS[@]}"; do
  read -r _abi triple <<<"$entry"
  rustup target list --installed | grep -qx "$triple" || MISSING="$MISSING $triple"
done
if [ -n "$MISSING" ]; then
  echo "error: missing rustup targets:$MISSING" >&2
  echo "  fix: rustup target add$MISSING" >&2
  exit 1
fi

# Mirror the env of the nitrogen-generated CMake exactly (bare clang as
# CC/linker, --target selected via .cargo/config.toml link-args) so cargo
# artifacts are shared between this script and gradle builds with no
# fingerprint churn.
cd "$ROOT"
for entry in "${TARGETS[@]}"; do
  read -r abi triple <<<"$entry"
  triple_upper="$(printf '%s' "$triple" | tr 'a-z-' 'A-Z_')"

  echo "==> Building $abi ($triple)"
  env \
    "CC=$TOOLCHAIN/clang" \
    "AR=$TOOLCHAIN/llvm-ar" \
    "CARGO_TARGET_${triple_upper}_LINKER=$TOOLCHAIN/clang" \
    cargo build --release --target "$triple"
done

echo ""
echo "Artifact sizes (release, unstripped static libs):"
printf '%-14s %-28s %10s\n' "ABI" "TARGET" "SIZE"
for entry in "${TARGETS[@]}"; do
  read -r abi triple <<<"$entry"
  lib="$ROOT/target/$triple/release/libIroh_rust.a"
  size="$(du -h "$lib" | cut -f1)"
  printf '%-14s %-28s %10s\n' "$abi" "$triple" "$size"
done
