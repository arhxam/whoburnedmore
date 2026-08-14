#!/usr/bin/env bash
# Regression check: explicit local test launch must produce the fixed dashboard
# panel after AppKit's initial layout settles.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN="dist/BurnBar.app/Contents/MacOS/BurnBar"
LOG="/tmp/burnbar-expanded-check.log"
SCREEN_KIND="${1:-notched}"
[[ "$SCREEN_KIND" == "notched" || "$SCREEN_KIND" == "external" ]] || {
  echo "usage: check-island-expanded.sh [notched|external]" >&2
  exit 2
}
[[ -x "$BIN" ]] || { echo "FAIL: build dist/BurnBar.app first" >&2; exit 1; }

env BURNBAR_ISLAND_EXPANDED=1 \
  BURNBAR_ISLAND_SCREEN="$SCREEN_KIND" \
  BURNBAR_ISLAND_DISABLE_AUTO_COLLAPSE=1 \
  "$BIN" >"$LOG" 2>&1 &
APP_PID=$!
cleanup() {
  kill "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT

sleep 3
APP_STATE=$(ps -p "$APP_PID" -o stat= 2>/dev/null | tr -d ' ' || true)
[[ -n "$APP_STATE" && "$APP_STATE" != Z* ]] || {
  echo "FAIL: BurnBar exited during expanded launch" >&2
  tail -40 "$LOG" >&2
  exit 1
}

# Screen capture refreshes macOS display metadata. The island must stay on the
# selected laptop display when NSScreen instances are recreated.
SHOT=$(mktemp /tmp/burnbar-expanded-check.XXXXXX.png)
screencapture -x "$SHOT"
rm -f "$SHOT"
sleep 1

swift - "$APP_PID" "$SCREEN_KIND" <<'SWIFT'
import AppKit
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let screenKind = CommandLine.arguments[2]
let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
let candidates = windows.compactMap { window -> (String, CGRect)? in
    guard (window[kCGWindowOwnerPID as String] as? Int32) == pid,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let width = bounds["Width"] as? Int,
          let height = bounds["Height"] as? Int,
          let x = bounds["X"] as? Int,
          let y = bounds["Y"] as? Int else { return nil }
    return ("\(width)x\(height)", CGRect(x: x, y: y, width: width, height: height))
}
let sizes = candidates.map(\.0)
guard let dashboard = candidates.first(where: { $0.0 == "404x590" }) else {
    fputs("FAIL: expanded dashboard missing; sizes=\(sizes)\n", stderr)
    exit(1)
}
let mainTop = NSScreen.screens.first?.frame.maxY ?? 0
let appKitCenter = CGPoint(
    x: dashboard.1.midX,
    y: mainTop - dashboard.1.midY
)
guard NSScreen.screens.contains(where: {
    let expectedNotch = screenKind == "notched"
    return ($0.safeAreaInsets.top > 0) == expectedNotch && $0.frame.contains(appKitCenter)
}) else {
    fputs("FAIL: dashboard moved away from the \(screenKind) display; bounds=\(dashboard.1)\n", stderr)
    exit(1)
}
SWIFT

echo "PASS: BurnBar opened the 404x590 dashboard on the $SCREEN_KIND display"
