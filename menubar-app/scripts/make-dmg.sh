#!/usr/bin/env bash
# Build the public whoburnedmore DMG and the legacy filename kept for existing
# download links. Both names must refer to the exact same signed bytes.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -d dist/BurnBar.app ]] || { echo "run build-app.sh first"; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R dist/BurnBar.app "$STAGE/"
ln -s /Applications "$STAGE/Applications"

rm -f dist/whoburnedmore.dmg dist/BurnBar.dmg
hdiutil create -volname "whoburnedmore" -srcfolder "$STAGE" -ov -format UDZO dist/whoburnedmore.dmg >/dev/null
IDENTITY="${BURNBAR_SIGN_IDENTITY:-Developer ID Application: Arham Amin (84MFPMUB97)}"
codesign --force --sign "$IDENTITY" dist/whoburnedmore.dmg
cp -p dist/whoburnedmore.dmg dist/BurnBar.dmg
cmp -s dist/whoburnedmore.dmg dist/BurnBar.dmg || {
  echo "compatibility DMG differs from primary artifact" >&2
  exit 1
}
echo "created dist/whoburnedmore.dmg + dist/BurnBar.dmg ($(du -h dist/whoburnedmore.dmg | cut -f1))"
