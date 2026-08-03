#!/usr/bin/env bash
# Rubric item 8: BurnBarCore logic tests (formatters, meter states, decoders).
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -d BurnBar.xcodeproj ]] || xcodegen generate >/dev/null

LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
if xcodebuild -project BurnBar.xcodeproj -scheme BurnBarCoreTests -configuration Debug \
    -derivedDataPath build -destination 'platform=macOS' test > "$LOG" 2>&1; then
  grep -E "Test Case .* passed" "$LOG" | sed "s/.*Test Case/Test Case/" | sort -u | head -40
  grep -E "Executed .* tests" "$LOG" | tail -2
  echo "TESTS PASSED"
else
  grep -E "error|failed" "$LOG" | head -20
  echo "TESTS FAILED"
  exit 1
fi
