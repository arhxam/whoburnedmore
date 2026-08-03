#!/usr/bin/env bash
# Rubric item 1 (v2): the Settings window is real, big, and centered on the
# active screen. Captures it by window id and asserts the frame the app logs.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-/tmp/burnbar-settings.png}"
pkill -x BurnBar 2>/dev/null || true
sleep 1
rm -f "$OUT"
nohup env BURNBAR_OPEN_SETTINGS=1 BURNBAR_SHOT_PATH="$OUT" BURNBAR_SHOT_DELAY=6 \
  dist/BurnBar.app/Contents/MacOS/BurnBar >/tmp/burnbar-settings.log 2>&1 &
for _ in $(seq 1 15); do [[ -s "$OUT" ]] && break; sleep 2; done
[[ -s "$OUT" ]] || { echo "FAIL: settings shot not written"; tail -5 /tmp/burnbar-settings.log; exit 1; }

FRAME=$(grep -m1 "settings-frame" /tmp/burnbar-settings.log || true)
pkill -x BurnBar 2>/dev/null || true
[[ -n "$FRAME" ]] || { echo "FAIL: no settings-frame log line"; exit 1; }
echo "$FRAME"

/usr/bin/python3 - "$FRAME" <<'EOF'
import re, sys
m = dict(re.findall(r"(\w+)=(-?\d+)", sys.argv[1]))
# window: x y w h ; screen visible frame: second x y w h — parse positionally.
nums = re.findall(r"=(-?\d+)", sys.argv[1])
wx, wy, ww, wh, sx, sy, sw, sh = map(int, nums[:8])
assert ww >= 700 and wh >= 480, f"window {ww}x{wh} too small"
assert sx <= wx and wy >= sy and wx + ww <= sx + sw and wy + wh <= sy + sh, "window not inside active screen"
# centered within ~80px tolerance
cx, cy = wx + ww / 2, wy + wh / 2
assert abs(cx - (sx + sw / 2)) < 80 and abs(cy - (sy + sh / 2)) < 80, "window not centered"
print(f"PASS settings window {ww}x{wh} centered on active screen")
EOF
echo "captured $OUT"
