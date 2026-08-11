#!/usr/bin/env bash
# Notarize + staple a signed .app or .dmg with Apple's notary service.
#
# Credentials (first that resolves wins):
#   1. Keychain profile:   BURNBAR_NOTARY_PROFILE=<name>   (set up once via
#        xcrun notarytool store-credentials <name> --key <p8> --key-id <id> --issuer <uuid>)
#   2. App Store Connect API key:
#        BURNBAR_NOTARY_KEY=~/.appstoreconnect/private_keys/AuthKey_XXXX.p8
#        BURNBAR_NOTARY_KEY_ID=XXXX   BURNBAR_NOTARY_ISSUER=<issuer-uuid>
#
# Apple-ID password flags are deliberately unsupported: they expose the secret
# in the process argument list. Store credentials in Keychain instead.
#
# Usage: bash scripts/notarize.sh dist/BurnBar.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:?usage: notarize.sh <path-to-.app-or-.dmg>}"
[[ -e "$TARGET" ]] || { echo "not found: $TARGET" >&2; exit 1; }

CREDS=()
if [[ -n "${BURNBAR_NOTARY_PROFILE:-}" ]]; then
  CREDS=(--keychain-profile "$BURNBAR_NOTARY_PROFILE")
elif [[ -n "${BURNBAR_NOTARY_KEY:-}" && -n "${BURNBAR_NOTARY_KEY_ID:-}" && -n "${BURNBAR_NOTARY_ISSUER:-}" ]]; then
  CREDS=(--key "$BURNBAR_NOTARY_KEY" --key-id "$BURNBAR_NOTARY_KEY_ID" --issuer "$BURNBAR_NOTARY_ISSUER")
else
  cat >&2 <<'EOF'
ERROR: no notarization credentials found.

Set ONE of:
  • BURNBAR_NOTARY_PROFILE (a keychain profile from `notarytool store-credentials`)
  • BURNBAR_NOTARY_KEY + BURNBAR_NOTARY_KEY_ID + BURNBAR_NOTARY_ISSUER (API key)

Apple-ID app-specific passwords are intentionally rejected because passing a
password to notarytool exposes it in the process argument list. Store those
credentials in a Keychain profile first.

The App Store Connect API keys already on this Mac live in
  ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8
so you likely just need the ISSUER UUID from App Store Connect → Users and Access → Integrations → Keys.
EOF
  exit 2
fi

# notarytool wants a zip for a .app; a .dmg can be submitted directly.
SUBMIT="$TARGET"
CLEANUP=""
if [[ "$TARGET" == *.app ]]; then
  SUBMIT="${TARGET%.app}.notarize.zip"
  rm -f "$SUBMIT"
  /usr/bin/ditto -c -k --keepParent "$TARGET" "$SUBMIT"
  CLEANUP="$SUBMIT"
fi

echo "==> submitting $SUBMIT to notary (this can take a few minutes)…"
xcrun notarytool submit "$SUBMIT" "${CREDS[@]}" --wait

echo "==> stapling $TARGET"
xcrun stapler staple "$TARGET"
xcrun stapler validate "$TARGET"
[[ -n "$CLEANUP" ]] && rm -f "$CLEANUP"
echo "==> notarized + stapled OK: $TARGET"
