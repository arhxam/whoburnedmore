#!/usr/bin/env bash
# Generate dist/appcast.xml for the signed/notarized BurnBar DMG. The private
# EdDSA key comes from Keychain by default or stdin via an environment secret.
set -euo pipefail
cd "$(dirname "$0")/.."

DMG="${1:-dist/BurnBar.dmg}"
NOTES="${2:-}"
[[ -f "$DMG" ]] || { echo "DMG not found: $DMG" >&2; exit 1; }

readarray_value() {
  /usr/bin/awk -v key="$1" '$1 == key ":" { gsub(/"/, "", $2); print $2 }' project.yml
}

VERSION="$(readarray_value MARKETING_VERSION)"
BUILD="$(readarray_value CURRENT_PROJECT_VERSION)"
[[ -n "$VERSION" && -n "$BUILD" ]] || { echo "version metadata missing from project.yml" >&2; exit 1; }

BIN="$(bash scripts/find-sparkle-tools.sh)"
ACCOUNT="${BURNBAR_SPARKLE_KEY_ACCOUNT:-com.whoburnedmore.burnbar}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$DMG" "$STAGE/BurnBar.dmg"
if [[ -n "$NOTES" ]]; then
  [[ -f "$NOTES" ]] || { echo "release notes not found: $NOTES" >&2; exit 1; }
  cp "$NOTES" "$STAGE/BurnBar.md"
fi

PREFIX="https://github.com/arhxam/whoburnedmore/releases/download/v${VERSION}/"
ARGS=(
  --account "$ACCOUNT"
  --download-url-prefix "$PREFIX"
  --link "https://whoburnedmore.com"
  --maximum-versions 1
  --maximum-deltas 0
  -o "$STAGE/appcast.xml"
)

if [[ -n "${BURNBAR_SPARKLE_PRIVATE_KEY:-}" ]]; then
  printf '%s' "$BURNBAR_SPARKLE_PRIVATE_KEY" \
    | "$BIN/generate_appcast" "${ARGS[@]}" --ed-key-file - "$STAGE"
else
  "$BIN/generate_appcast" "${ARGS[@]}" "$STAGE"
fi

[[ -f "$STAGE/appcast.xml" ]] || { echo "Sparkle did not generate appcast.xml" >&2; exit 1; }
cp "$STAGE/appcast.xml" dist/appcast.xml
if [[ -n "$NOTES" ]]; then
  cp "$NOTES" dist/BurnBar.md
else
  rm -f dist/BurnBar.md
fi
echo "==> appcast ready: dist/appcast.xml for BurnBar ${VERSION} (${BUILD})"
