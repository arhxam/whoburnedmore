#!/usr/bin/env bash
# Build + sign dist/BurnBar.app (rubric item 7).
#  1. bun-compile the sidecar
#  2. xcodegen + xcodebuild Release (unsigned)
#  3. copy sidecar + standalone ccusage into Contents/Resources
#  4. codesign inside-out with Developer ID + hardened runtime
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="${BURNBAR_SIGN_IDENTITY:-Developer ID Application: Arham Amin (84MFPMUB97)}"

echo "==> app icon"
[[ -f Resources/AppIcon.icns ]] || bash scripts/gen-app-icon.sh

echo "==> sidecar"
(cd sidecar && \
  bun build --compile --target=bun-darwin-arm64 --outfile dist/burnbar-sidecar-arm64 ./src/main.ts >/dev/null && \
  bun build --compile --target=bun-darwin-x64 --outfile dist/burnbar-sidecar-x64 ./src/main.ts >/dev/null && \
  lipo -create dist/burnbar-sidecar-arm64 dist/burnbar-sidecar-x64 -output dist/burnbar-sidecar)

echo "==> xcodebuild"
xcodegen generate >/dev/null
xcodebuild -project BurnBar.xcodeproj -scheme BurnBar -configuration Release \
  -derivedDataPath build build 2>&1 | grep -E "BUILD (SUCCEEDED|FAILED)"

echo "==> assemble"
rm -rf dist/BurnBar.app
mkdir -p dist
cp -R build/Build/Products/Release/BurnBar.app dist/
RES="dist/BurnBar.app/Contents/Resources"
mkdir -p "$RES"
cp Resources/AppIcon.icns "$RES/AppIcon.icns"
cp sidecar/dist/burnbar-sidecar "$RES/burnbar-sidecar"
CCU_VERSION=$(node -p "require('./node_modules/ccusage/package.json').version")
CCU_ARM="../../node_modules/.pnpm/@ccusage+ccusage-darwin-arm64@${CCU_VERSION}/node_modules/@ccusage/ccusage-darwin-arm64/bin/ccusage"
CCU_X64="../../node_modules/.pnpm/@ccusage+ccusage-darwin-x64@${CCU_VERSION}/node_modules/@ccusage/ccusage-darwin-x64/bin/ccusage"
[[ -f "$CCU_ARM" ]] || { echo "ERROR: missing arm64 ccusage ${CCU_VERSION}" >&2; exit 1; }
[[ -f "$CCU_X64" ]] || { echo "ERROR: missing x64 ccusage ${CCU_VERSION}" >&2; exit 1; }
lipo -create "$CCU_ARM" "$CCU_X64" -output "$RES/ccusage"
chmod +x "$RES/ccusage"

echo "==> architecture gate"
for BIN in dist/BurnBar.app/Contents/MacOS/BurnBar "$RES/burnbar-sidecar" "$RES/ccusage"; do
  lipo "$BIN" -verify_arch arm64 x86_64
done

echo "==> codesign"
# Inside-out: nested executables/frameworks first, then the bundle.
# The bun sidecar + ccusage JIT, so they carry the JIT entitlements; the app
# itself is hardened-runtime clean. All with a secure timestamp for notarization.
SIDECAR_ENT="sidecar.entitlements"
APP_ENT="BurnBar.entitlements"
codesign --force --options runtime --timestamp --entitlements "$SIDECAR_ENT" --sign "$IDENTITY" "$RES/burnbar-sidecar"
codesign --force --options runtime --timestamp --entitlements "$SIDECAR_ENT" --sign "$IDENTITY" "$RES/ccusage"
codesign --force --options runtime --timestamp --sign "$IDENTITY" \
  dist/BurnBar.app/Contents/Frameworks/BurnBarCore.framework
codesign --force --options runtime --timestamp --entitlements "$APP_ENT" --sign "$IDENTITY" dist/BurnBar.app

codesign --verify --strict --deep dist/BurnBar.app
echo "==> signed OK"
