#!/usr/bin/env bash
# Rubric item 13 (v2): the published DMG is publicly downloadable.
set -euo pipefail
URL="https://github.com/arhxam/whoburnedmore/releases/latest/download/BurnBar.dmg"
CODE=$(curl -sIL "$URL" -o /dev/null -w '%{http_code}')
echo "HTTP $CODE $URL"
[[ "$CODE" == "200" ]]
