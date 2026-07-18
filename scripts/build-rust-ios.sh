#!/usr/bin/env bash
# Builds libIroh_rust.a (release) for iOS and packages an XCFramework:
#   - device slice:    aarch64-apple-ios
#   - simulator slice: aarch64-apple-ios-sim + x86_64-apple-ios (lipo fat lib)
#
# Usage: bun run build:rust:ios  (or: bash scripts/build-rust-ios.sh)
#
# Requirements (macOS only):
#   - Xcode command line tools (xcrun, lipo, xcodebuild)
#   - rustup targets: aarch64-apple-ios, aarch64-apple-ios-sim, x86_64-apple-ios
#
# Output: build/apple/Iroh_rust.xcframework
#
# Note: this XCFramework is the distributable CI artifact. Local development
# builds do not need it; the podspec builds the required slice on demand via
# the nitrogen-generated cargo script phase.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: build:rust:ios requires macOS (Xcode toolchain needed to link Apple targets)." >&2
  echo "  iOS artifacts are produced by the ios-build GitHub workflow on macos runners." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/build/apple"
XCFRAMEWORK="$OUT_DIR/Iroh_rust.xcframework"

TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios)

MISSING=""
for triple in "${TARGETS[@]}"; do
  rustup target list --installed | grep -qx "$triple" || MISSING="$MISSING $triple"
done
if [ -n "$MISSING" ]; then
  echo "error: missing rustup targets:$MISSING" >&2
  echo "  fix: rustup target add$MISSING" >&2
  exit 1
fi

cd "$ROOT"

# Xcode-driven environments (pod script phases, CI wrappers) may export
# iOS-SDK CC/SDKROOT which breaks host build scripts; clear them and let
# cargo/cc pick the right SDK per target.
unset CC CXX LD AR CFLAGS CXXFLAGS LDFLAGS LIBRARY_PATH SDKROOT

IPHONEOS_CLANG="$(xcrun --sdk iphoneos --find clang)"
SIMULATOR_CLANG="$(xcrun --sdk iphonesimulator --find clang)"
export CARGO_TARGET_AARCH64_APPLE_IOS_LINKER="$IPHONEOS_CLANG"
export CARGO_TARGET_AARCH64_APPLE_IOS_SIM_LINKER="$SIMULATOR_CLANG"
export CARGO_TARGET_X86_64_APPLE_IOS_LINKER="$SIMULATOR_CLANG"

for triple in "${TARGETS[@]}"; do
  echo "==> Building $triple"
  cargo build --release --target "$triple"
done

rm -rf "$XCFRAMEWORK"
mkdir -p "$OUT_DIR/simulator"

# The two simulator slices must be lipo'd into one fat library: an
# XCFramework distinguishes libraries by platform+environment, not by arch.
lipo -create \
  "target/aarch64-apple-ios-sim/release/libIroh_rust.a" \
  "target/x86_64-apple-ios/release/libIroh_rust.a" \
  -output "$OUT_DIR/simulator/libIroh_rust.a"

xcodebuild -create-xcframework \
  -library "target/aarch64-apple-ios/release/libIroh_rust.a" \
  -library "$OUT_DIR/simulator/libIroh_rust.a" \
  -output "$XCFRAMEWORK"

echo ""
echo "XCFramework slice sizes:"
printf '%-40s %10s\n' "SLICE" "SIZE"
find "$XCFRAMEWORK" -name '*.a' | sort | while read -r lib; do
  printf '%-40s %10s\n' "${lib#"$XCFRAMEWORK"/}" "$(du -h "$lib" | cut -f1)"
done
echo ""
echo "Wrote $XCFRAMEWORK"
