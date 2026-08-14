#!/usr/bin/env bash
# Validate the exact DMG/appcast pair that will be uploaded to GitHub Releases.
set -euo pipefail
cd "$(dirname "$0")/.."

DMG="${1:-dist/BurnBar.dmg}"
APPCAST="${2:-dist/appcast.xml}"
[[ -f "$DMG" ]] || { echo "DMG not found: $DMG" >&2; exit 1; }
[[ -f "$APPCAST" ]] || { echo "appcast not found: $APPCAST" >&2; exit 1; }

MOUNT="$(mktemp -d)"
PUBLISHED="$(mktemp)"
ATTACHED=0
cleanup() {
  if [[ "$ATTACHED" == "1" ]]; then hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; fi
  rm -rf "$MOUNT"
  rm -f "$PUBLISHED"
}
trap cleanup EXIT

hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" -quiet
ATTACHED=1
APP="$MOUNT/BurnBar.app"
[[ -d "$APP" ]] || { echo "BurnBar.app missing from DMG" >&2; exit 1; }

PROJECT_VERSION="$(/usr/bin/awk '$1 == "MARKETING_VERSION:" { gsub(/"/, "", $2); print $2 }' project.yml)"
PROJECT_BUILD="$(/usr/bin/awk '$1 == "CURRENT_PROJECT_VERSION:" { gsub(/"/, "", $2); print $2 }' project.yml)"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
APP_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
[[ "$APP_VERSION" == "$PROJECT_VERSION" ]] || { echo "embedded app version $APP_VERSION != project $PROJECT_VERSION" >&2; exit 1; }
[[ "$APP_BUILD" == "$PROJECT_BUILD" ]] || { echo "embedded app build $APP_BUILD != project $PROJECT_BUILD" >&2; exit 1; }

codesign --verify --strict --deep --verbose=4 "$APP"
if [[ "${BURNBAR_REQUIRE_NOTARIZATION:-0}" == "1" ]]; then
  xcrun stapler validate "$APP"
  xcrun stapler validate "$DMG"
  spctl --assess --type execute -vv "$APP"
fi

BYTE_LENGTH="$(stat -f '%z' "$DMG")"
METADATA_ARGS=(
  --project project.yml
  --appcast "$APPCAST"
  --byte-length "$BYTE_LENGTH"
  --minimum-system-version "14.0"
)

if [[ "${BURNBAR_CHECK_PUBLISHED_BUILD:-1}" == "1" ]]; then
  FEED_URL="https://github.com/arhxam/whoburnedmore/releases/latest/download/appcast.xml"
  CURL_STATUS=0
  HTTP_CODE="$(curl -sSL --retry 2 --retry-all-errors --max-time 30 \
    -o "$PUBLISHED" -w '%{http_code}' "$FEED_URL")" || CURL_STATUS=$?
  if [[ "$CURL_STATUS" == "0" && "$HTTP_CODE" == "200" ]]; then
    METADATA_ARGS+=(--published-appcast "$PUBLISHED")
  elif [[ "$CURL_STATUS" == "0" && "$HTTP_CODE" == "404" && "${BURNBAR_ALLOW_BOOTSTRAP_FEED_MISSING:-0}" == "1" ]]; then
    echo "==> published appcast is absent; explicit bootstrap allowance accepted"
  else
    echo "published appcast check failed (curl=$CURL_STATUS http=$HTTP_CODE); refusing to bypass build-order validation" >&2
    exit 1
  fi
fi

node scripts/verify-update-metadata.mjs "${METADATA_ARGS[@]}"
SIGNATURE="$(node scripts/verify-update-metadata.mjs "${METADATA_ARGS[@]}" --signature-only true)"
BIN="$(bash scripts/find-sparkle-tools.sh)"
ACCOUNT="${BURNBAR_SPARKLE_KEY_ACCOUNT:-com.whoburnedmore.burnbar}"
BUNDLED_PUBLIC_KEY="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$APP/Contents/Info.plist")"
if [[ -n "${BURNBAR_SPARKLE_PRIVATE_KEY:-}" && -n "${BURNBAR_SPARKLE_PUBLIC_KEY:-}" ]]; then
  SIGNING_PUBLIC_KEY="$BURNBAR_SPARKLE_PUBLIC_KEY"
else
  SIGNING_PUBLIC_KEY="$("$BIN/generate_keys" --account "$ACCOUNT" -p)"
fi
[[ "$BUNDLED_PUBLIC_KEY" == "$SIGNING_PUBLIC_KEY" ]] || {
  echo "bundled SUPublicEDKey does not match the configured Sparkle signing key" >&2
  exit 1
}
if [[ -n "${BURNBAR_SPARKLE_PRIVATE_KEY:-}" ]]; then
  printf '%s' "$BURNBAR_SPARKLE_PRIVATE_KEY" \
    | "$BIN/sign_update" --ed-key-file - --verify "$DMG" "$SIGNATURE"
else
  "$BIN/sign_update" --account "$ACCOUNT" --verify "$DMG" "$SIGNATURE"
fi

echo "UPDATE ARTIFACTS OK: BurnBar ${PROJECT_VERSION} (${PROJECT_BUILD})"
