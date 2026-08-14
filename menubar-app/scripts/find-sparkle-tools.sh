#!/usr/bin/env bash
# Print the directory containing Sparkle's release tools for the pinned SPM
# artifact. Resolve the package on demand if Xcode has not done so yet.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${SPARKLE_BIN_DIR:-}" ]]; then
  BIN="$SPARKLE_BIN_DIR"
else
  BIN="build/SourcePackages/artifacts/sparkle/Sparkle/bin"
fi

if [[ ! -x "$BIN/generate_appcast" || ! -x "$BIN/generate_keys" || ! -x "$BIN/sign_update" ]]; then
  command -v xcodegen >/dev/null || { echo "xcodegen is required to resolve Sparkle" >&2; exit 1; }
  xcodegen generate >/dev/null
  xcodebuild -resolvePackageDependencies -project BurnBar.xcodeproj -scheme BurnBar \
    -derivedDataPath build >/dev/null
fi

for tool in generate_appcast generate_keys sign_update; do
  [[ -x "$BIN/$tool" ]] || { echo "Sparkle tool not found: $BIN/$tool" >&2; exit 1; }
done

cd "$BIN"
pwd -P
