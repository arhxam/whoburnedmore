#!/usr/bin/env bash
# Regression check: move the real pointer into the notch trigger and verify the
# compact reveal. Click transitions are covered by the reducer and source
# contract because macOS blocks synthetic input without Accessibility access.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="dist/BurnBar.app"
BIN="$APP/Contents/MacOS/BurnBar"
LOG="/tmp/burnbar-hover-check.log"
POINTER_STATE="$(mktemp /tmp/burnbar-pointer.XXXXXX)"
[[ -x "$BIN" ]] || { echo "FAIL: build $APP first" >&2; exit 1; }

env BURNBAR_ISLAND_SCREEN=notched \
  "$BIN" >"$LOG" 2>&1 &
APP_PID=$!
cleanup() {
  kill "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  swift - "$POINTER_STATE" restore >/dev/null 2>&1 <<'SWIFT' || true
import AppKit
import CoreGraphics
import Foundation

let path = CommandLine.arguments[1]
guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { exit(0) }
let parts = text.split(separator: " ").compactMap { Double($0) }
guard parts.count == 2, let mainTop = NSScreen.screens.first?.frame.maxY else { exit(0) }
CGWarpMouseCursorPosition(CGPoint(x: parts[0], y: mainTop - parts[1]))
SWIFT
  rm -f "$POINTER_STATE"
}
trap cleanup EXIT

sleep 2
kill -0 "$APP_PID" 2>/dev/null || {
  echo "FAIL: BurnBar exited during launch" >&2
  tail -40 "$LOG" >&2
  exit 1
}

swift - "$POINTER_STATE" move <<'SWIFT'
import AppKit
import CoreGraphics
import Foundation

let path = CommandLine.arguments[1]
let original = NSEvent.mouseLocation
try "\(original.x) \(original.y)".write(toFile: path, atomically: true, encoding: .utf8)
guard let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }),
      let left = screen.auxiliaryTopLeftArea,
      let right = screen.auxiliaryTopRightArea,
      let mainTop = NSScreen.screens.first?.frame.maxY else {
    fputs("FAIL: no notched display is connected\n", stderr)
    exit(1)
}
let triggerHeight = screen.safeAreaInsets.top + 12
let appKitTarget = CGPoint(
    x: (left.maxX + right.minX) / 2,
    y: screen.frame.maxY - triggerHeight / 2
)
let quartzTarget = CGPoint(x: appKitTarget.x, y: mainTop - appKitTarget.y)
for _ in 0..<10 {
    CGWarpMouseCursorPosition(quartzTarget)
    usleep(50_000)
}
SWIFT

sleep 1

APP_STATE=$(ps -p "$APP_PID" -o stat= 2>/dev/null | tr -d ' ' || true)
[[ -n "$APP_STATE" && "$APP_STATE" != Z* ]] || {
  echo "FAIL: BurnBar crashed during notch hover" >&2
  /usr/bin/log show --style compact --last 2m --predicate 'process == "BurnBar" AND eventMessage CONTAINS[c] "uncaught exception"' | tail -20 >&2
  exit 1
}

swift - "$APP_PID" <<'SWIFT'
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
let heights = windows.compactMap { window -> Int? in
    guard (window[kCGWindowOwnerPID as String] as? Int32) == pid,
          let bounds = window[kCGWindowBounds as String] as? [String: Any] else { return nil }
    return bounds["Height"] as? Int
}
guard heights.contains(54) else {
    fputs("FAIL: hover did not reveal the 54px island; heights=\(heights)\n", stderr)
    exit(1)
}
SWIFT

echo "PASS: real pointer entry at the notch revealed the 54px compact UI"
