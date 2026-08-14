#!/usr/bin/env bash
# Sign BurnBar's embedded frameworks and Sparkle services from the inside out.
# The sidecar binaries are signed separately because only they need JIT
# entitlements. Nothing signed here receives those entitlements.
set -euo pipefail

APP="${1:?usage: sign-embedded-code.sh <BurnBar.app> [identity]}"
IDENTITY="${2:-${BURNBAR_SIGN_IDENTITY:-Developer ID Application: Arham Amin (84MFPMUB97)}}"

[[ -d "$APP" ]] || { echo "app not found: $APP" >&2; exit 1; }
FRAMEWORKS="$APP/Contents/Frameworks"
SPARKLE="$FRAMEWORKS/Sparkle.framework"
CORE="$FRAMEWORKS/BurnBarCore.framework"

sign_bundle() {
  local target="$1"
  [[ -e "$target" ]] || { echo "embedded code not found: $target" >&2; exit 1; }
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$target"
}

if [[ -d "$SPARKLE" ]]; then
  VERSION_DIR="$SPARKLE/Versions/Current"
  [[ -d "$VERSION_DIR" ]] || { echo "Sparkle current version not found: $VERSION_DIR" >&2; exit 1; }

  # Standalone helper first, then nested service/app bundles, then framework.
  sign_bundle "$VERSION_DIR/Autoupdate"
  sign_bundle "$VERSION_DIR/XPCServices/Downloader.xpc"
  sign_bundle "$VERSION_DIR/XPCServices/Installer.xpc"
  sign_bundle "$VERSION_DIR/Updater.app"
  sign_bundle "$SPARKLE"
fi

sign_bundle "$CORE"
