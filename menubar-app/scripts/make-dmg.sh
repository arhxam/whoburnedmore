#!/usr/bin/env bash
# Rubric item 12: dist/BurnBar.dmg from the signed app.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -d dist/BurnBar.app ]] || { echo "run build-app.sh first"; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R dist/BurnBar.app "$STAGE/"
ln -s /Applications "$STAGE/Applications"

rm -f dist/BurnBar.dmg
hdiutil create -volname "BurnBar" -srcfolder "$STAGE" -ov -format UDZO dist/BurnBar.dmg >/dev/null
IDENTITY="${BURNBAR_SIGN_IDENTITY:-Developer ID Application: Arham Amin (84MFPMUB97)}"
codesign --force --sign "$IDENTITY" dist/BurnBar.dmg
echo "created dist/BurnBar.dmg ($(du -h dist/BurnBar.dmg | cut -f1))"
