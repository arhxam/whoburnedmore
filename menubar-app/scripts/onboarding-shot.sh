#!/usr/bin/env bash
# Rubric item 10 (v2): first-run onboarding window on fresh defaults.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-/tmp/burnbar-onboarding.png}"
pkill -x BurnBar 2>/dev/null || true
sleep 1
rm -f "$OUT"
nohup env BURNBAR_RESET_DEFAULTS=1 BURNBAR_SHOT_PATH="$OUT" BURNBAR_SHOT_DELAY=6 \
  dist/BurnBar.app/Contents/MacOS/BurnBar >/tmp/burnbar-onboarding.log 2>&1 &
for _ in $(seq 1 15); do [[ -s "$OUT" ]] && break; sleep 2; done
[[ -s "$OUT" ]] || { echo "FAIL: onboarding shot not written"; exit 1; }
pkill -x BurnBar 2>/dev/null || true
# The reset wiped defaults — mark onboarding done so later launches skip it.
defaults write com.whoburnedmore.burnbar onboarding.done -bool true
echo "captured $OUT"
