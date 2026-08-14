#!/usr/bin/env bash
# Capture the local notch-island SwiftUI surface without Screen Recording access.
# Usage: scripts/island-shot.sh [--compact|--expanded] [output.png]
set -euo pipefail
cd "$(dirname "$0")/.."

STATE="expanded"
OUT="/tmp/burnbar-island-expanded.png"
for arg in "$@"; do
  case "$arg" in
    --compact) STATE="compact"; OUT="/tmp/burnbar-island-compact.png" ;;
    --expanded) STATE="expanded" ;;
    *) OUT="$arg" ;;
  esac
done

[[ -x dist/BurnBar.app/Contents/MacOS/BurnBar ]] || {
  echo "FAIL: build dist/BurnBar.app first" >&2
  exit 1
}

pkill -x BurnBar 2>/dev/null || true
rm -f "$OUT"

nohup env \
  BURNBAR_ISLAND_AUTOPEN=0 \
  BURNBAR_ISLAND_EXPANDED="$([[ "$STATE" == "expanded" ]] && echo 1 || echo 0)" \
  BURNBAR_ISLAND_SCREENSHOT_STATE="$STATE" \
  BURNBAR_ISLAND_SCREENSHOT="$OUT" \
  BURNBAR_SHOT_DELAY="${BURNBAR_SHOT_DELAY:-8}" \
  dist/BurnBar.app/Contents/MacOS/BurnBar >/tmp/burnbar-island-shot.log 2>&1 &

for _ in $(seq 1 24); do
  [[ -s "$OUT" ]] && break
  sleep 1
done

pkill -x BurnBar 2>/dev/null || true
[[ -s "$OUT" ]] || {
  echo "FAIL: no island shot written" >&2
  tail -20 /tmp/burnbar-island-shot.log >&2
  exit 1
}

echo "captured $STATE island at $OUT"
