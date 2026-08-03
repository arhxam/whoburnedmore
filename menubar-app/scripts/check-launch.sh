#!/usr/bin/env bash
# Rubric item 9: the signed app launches and stays up.
set -euo pipefail
cd "$(dirname "$0")/.."

pkill -x BurnBar 2>/dev/null || true
sleep 1
nohup dist/BurnBar.app/Contents/MacOS/BurnBar >/tmp/burnbar-launch.log 2>&1 &
sleep 6
PID=$(pgrep -x BurnBar | head -1)
if [[ -n "$PID" ]]; then
  echo "PID $PID"
else
  echo "FAIL: BurnBar not running"
  tail -5 /tmp/burnbar-launch.log
  exit 1
fi
