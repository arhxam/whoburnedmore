#!/usr/bin/env bash
# Proves a fresh web download opens clean: download the LIVE release DMG, mark it
# quarantined (as a browser does), mount it, and assess the app inside. A stapled
# + notarized app is "accepted" here even offline/quarantined; an un-notarized one
# is "rejected". Prints "DOWNLOAD OK" only when Gatekeeper accepts it.
set -euo pipefail
URL="${1:-https://github.com/arhxam/whoburnedmore/releases/latest/download/BurnBar.dmg}"
TMP="$(mktemp -d)"
MP=""
cleanup() { [[ -n "$MP" ]] && hdiutil detach "$MP" -quiet 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

DMG="$TMP/BurnBar.dmg"
# Retry + bound each attempt so transient GitHub-CDN slowness can't hang the check.
curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors --max-time 180 -o "$DMG" "$URL"
# what a browser download sets:
xattr -w com.apple.quarantine "0083;00000000;Safari;$(uuidgen)" "$DMG" 2>/dev/null || true

MP="$(hdiutil attach "$DMG" -nobrowse -quiet && ls -d /Volumes/BurnBar* 2>/dev/null | head -1)"
APP="$MP/BurnBar.app"
[[ -d "$APP" ]] || { echo "DOWNLOAD FAIL: no app in DMG"; exit 1; }

ASSESS="$(spctl -a -vvv -t exec "$APP" 2>&1 || true)"
if echo "$ASSESS" | grep -qi "accepted"; then
  echo "DOWNLOAD OK: $(echo "$ASSESS" | grep -i source | head -1)"
  # also confirm the app carries a stapled ticket
  xcrun stapler validate "$APP" 2>&1 | grep -i worked && echo "stapled ticket present" || true
else
  echo "DOWNLOAD FAIL:"; echo "$ASSESS" | head -4
  exit 1
fi
