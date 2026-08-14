#!/usr/bin/env bash
# Full production release: build + sign → notarize + staple the app → build the
# DMG from the stapled app → notarize + staple the DMG. The result opens cleanly
# on any Mac (no "Apple could not verify" Gatekeeper block).
#
# Needs notarization credentials — see scripts/notarize.sh for the env vars.
# Usage: bash scripts/release.sh [release-notes.md]
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/build-app.sh
bash scripts/notarize.sh dist/BurnBar.app     # staples the .app itself
bash scripts/make-dmg.sh                       # DMG now wraps the stapled app
bash scripts/notarize.sh dist/BurnBar.dmg      # staples the .dmg too
bash scripts/generate-appcast.sh dist/BurnBar.dmg "${1:-}"
BURNBAR_REQUIRE_NOTARIZATION=1 bash scripts/verify-update-artifacts.sh

echo
echo "==> release ready: dist/BurnBar.dmg + dist/appcast.xml"
spctl --assess -vv --type execute dist/BurnBar.app || true
