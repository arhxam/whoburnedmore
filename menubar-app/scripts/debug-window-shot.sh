#!/usr/bin/env bash
# Rubric items 10/11/11b: launch with the debug window and screenshot it.
#   usage: debug-window-shot.sh [--offline] [output.png]
set -euo pipefail
cd "$(dirname "$0")/.."

OFFLINE=0
NO_TOOLS_SESSIONS=0
OUT="/tmp/burnbar-popover.png"
for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    --no-tools-sessions) NO_TOOLS_SESSIONS=1 ;;
    *) OUT="$arg" ;;
  esac
done

pkill -x BurnBar 2>/dev/null || true
sleep 1

BUNDLE=com.whoburnedmore.burnbar
if [[ "$NO_TOOLS_SESSIONS" == "1" ]]; then
  defaults write "$BUNDLE" popover.showTools -bool false
  defaults write "$BUNDLE" popover.showSessions -bool false
  OUT="${OUT%.png}-no-tools-sessions.png"
  trap 'defaults delete "$BUNDLE" popover.showTools 2>/dev/null; defaults delete "$BUNDLE" popover.showSessions 2>/dev/null' EXIT
fi

env_vars=(BURNBAR_DEBUG_WINDOW=1)
if [[ "$OFFLINE" == "1" ]]; then
  env_vars+=(BURNBAR_API_BASE=http://127.0.0.1:9)
  OUT="${OUT%.png}-offline.png"
fi
rm -f "$OUT"
env_vars+=(BURNBAR_SHOT_PATH="$OUT" BURNBAR_SHOT_DELAY="${BURNBAR_SHOT_DELAY:-15}")

nohup env "${env_vars[@]}" dist/BurnBar.app/Contents/MacOS/BurnBar >/tmp/burnbar-debug.log 2>&1 &
# Wait for the sidecar's first snapshot (warm cache: seconds; cold: longer).
sleep "${BURNBAR_SHOT_DELAY:-25}"

for _ in $(seq 1 12); do [[ -s "$OUT" ]] && break; sleep 2; done
pkill -x BurnBar 2>/dev/null || true
[[ -s "$OUT" ]] || { echo "FAIL: no shot written"; tail -3 /tmp/burnbar-debug.log; exit 1; }
echo "captured $OUT"
