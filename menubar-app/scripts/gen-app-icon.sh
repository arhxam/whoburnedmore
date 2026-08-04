#!/usr/bin/env bash
# Generate Resources/AppIcon.icns from the canonical brand tile
# (assets/brand-icon-tile.svg — flame-burning-cash on a dark rounded tile, the
# same mark as the website favicon). WebKit (qlmanage) renders the SVG because
# ImageMagick drops the gradient fills; sips/magick then resize the raster.
# Run: bash scripts/gen-app-icon.sh   (needs qlmanage + `magick`)
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=../../assets/brand-icon-tile.svg
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

qlmanage -t -s 1024 -o "$TMP" "$SRC" >/dev/null 2>&1
MASTER="$TMP/$(basename "$SRC").png"
[[ -f "$MASTER" ]] || { echo "render failed: $SRC" >&2; exit 1; }

ICO="$TMP/AppIcon.iconset"; mkdir -p "$ICO"
for s in 16 32 128 256 512; do
  magick "$MASTER" -resize ${s}x${s} "$ICO/icon_${s}x${s}.png"
  magick "$MASTER" -resize $((s*2))x$((s*2)) "$ICO/icon_${s}x${s}@2x.png"
done
magick "$MASTER" -resize 1024x1024 "$ICO/icon_512x512@2x.png"

mkdir -p Resources
iconutil -c icns "$ICO" -o Resources/AppIcon.icns
echo "==> Resources/AppIcon.icns generated"
