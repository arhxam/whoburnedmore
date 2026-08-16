#!/usr/bin/env bash
# Upload a previously validated BurnBar DMG/appcast pair to the public release
# repository. This never pushes source or a monorepo branch.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=""
BUILD=""
NOTES=""
MODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --build) BUILD="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --dry-run) MODE="dry-run"; shift ;;
    --confirm-publish) MODE="publish"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$VERSION" || -z "$BUILD" || -z "$NOTES" || -z "$MODE" ]]; then
  echo "usage: publish-release.sh --version <semver> --build <integer> --notes <file> (--dry-run|--confirm-publish)" >&2
  exit 2
fi
[[ -f "$NOTES" ]] || { echo "release notes not found: $NOTES" >&2; exit 2; }
[[ -f dist/BurnBar.dmg && -f dist/appcast.xml && -f dist/BurnBar.md ]] || {
  echo "dist/BurnBar.dmg, dist/appcast.xml, and dist/BurnBar.md must exist" >&2
  exit 2
}

PROJECT_VERSION="$(/usr/bin/awk '$1 == "MARKETING_VERSION:" { gsub(/"/, "", $2); print $2 }' project.yml)"
PROJECT_BUILD="$(/usr/bin/awk '$1 == "CURRENT_PROJECT_VERSION:" { gsub(/"/, "", $2); print $2 }' project.yml)"
[[ "$VERSION" == "$PROJECT_VERSION" ]] || { echo "requested version $VERSION != project $PROJECT_VERSION" >&2; exit 2; }
[[ "$BUILD" == "$PROJECT_BUILD" ]] || { echo "requested build $BUILD != project $PROJECT_BUILD" >&2; exit 2; }

REPOSITORY="arhxam/whoburnedmore"
TAG="v${VERSION}"
BURNBAR_REQUIRE_NOTARIZATION="${BURNBAR_REQUIRE_NOTARIZATION:-1}" \
  bash scripts/verify-update-artifacts.sh

command -v gh >/dev/null || { echo "GitHub CLI is required" >&2; exit 1; }
ACCOUNT="$(gh api user --jq .login)"
REPO_ACCESS="$(gh repo view "$REPOSITORY" --json nameWithOwner,viewerPermission)"
RESOLVED_REPOSITORY="$(printf '%s' "$REPO_ACCESS" | jq -r .nameWithOwner)"
[[ "$RESOLVED_REPOSITORY" == "$REPOSITORY" ]] || {
  echo "resolved repository $RESOLVED_REPOSITORY != $REPOSITORY" >&2
  exit 1
}
PERMISSION="$(printf '%s' "$REPO_ACCESS" | jq -r .viewerPermission)"
case "$PERMISSION" in
  ADMIN|MAINTAIN|WRITE) ;;
  *) echo "GitHub account $ACCOUNT has $PERMISSION access to $REPOSITORY; write access is required" >&2; exit 1 ;;
esac

if [[ "$MODE" == "dry-run" ]]; then
  echo "PUBLISH DRY RUN OK"
  echo "repository=$REPOSITORY"
  echo "tag=$TAG"
  echo "assets=dist/BurnBar.dmg,dist/appcast.xml,dist/BurnBar.md"
  echo "notes=$NOTES"
  exit 0
fi

if gh release view "$TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
  echo "release $REPOSITORY $TAG already exists; update archives are immutable — use a new version/build" >&2
  exit 1
fi
gh release create "$TAG" dist/BurnBar.dmg dist/appcast.xml dist/BurnBar.md \
  --repo "$REPOSITORY" --title "BurnBar ${TAG}" --notes-file "$NOTES" --latest
# GitHub can retain the previous `/releases/latest/download/*` redirect even
# when `release create --latest` was requested. Re-assert the promotion before
# polling the public feed so the updater cannot remain pinned to the old tag.
gh release edit "$TAG" --repo "$REPOSITORY" --latest

FEED_URL="https://github.com/${REPOSITORY}/releases/latest/download/appcast.xml"
DMG_URL="https://github.com/${REPOSITORY}/releases/latest/download/BurnBar.dmg"
NOTES_URL="https://github.com/${REPOSITORY}/releases/latest/download/BurnBar.md"
PUBLISHED_STAGE="$(mktemp -d)"
trap 'rm -rf "$PUBLISHED_STAGE"' EXIT
PUBLISHED_APPCAST="$PUBLISHED_STAGE/appcast.xml"
PUBLISHED_DMG="$PUBLISHED_STAGE/BurnBar.dmg"
LOCAL_DMG_LENGTH="$(stat -f %z dist/BurnBar.dmg)"

wait_for_asset() {
  local url="$1"
  local attempts=12
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl -fsSIL --retry 2 --retry-all-errors --max-time 30 \
      "${url}?verify=${attempt}-$(date +%s)" >/dev/null; then
      return 0
    fi
    [[ "$attempt" -lt "$attempts" ]] && sleep 5
  done
  echo "published asset did not become reachable: $url" >&2
  return 1
}

wait_for_latest_appcast() {
  local attempts=24
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl -fsSL --retry 2 --retry-all-errors --max-time 30 \
      "${FEED_URL}?verify=${attempt}-$(date +%s)" -o "$PUBLISHED_APPCAST" && \
      node scripts/verify-update-metadata.mjs \
        --project project.yml \
        --appcast "$PUBLISHED_APPCAST" \
        --byte-length "$LOCAL_DMG_LENGTH" >/dev/null 2>&1; then
      return 0
    fi
    [[ "$attempt" -lt "$attempts" ]] && sleep 5
  done
  echo "latest appcast did not converge to BurnBar $VERSION ($BUILD)" >&2
  return 1
}

wait_for_latest_dmg() {
  local attempts=24
  local headers
  local remote_length
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    headers="$(curl -fsSIL --retry 2 --retry-all-errors --max-time 30 \
      "${DMG_URL}?verify=${attempt}-$(date +%s)" || true)"
    remote_length="$(printf '%s\n' "$headers" | tr -d '\r' | \
      awk 'tolower($1) == "content-length:" { value=$2 } END { print value }')"
    if [[ "$remote_length" == "$LOCAL_DMG_LENGTH" ]]; then
      return 0
    fi
    [[ "$attempt" -lt "$attempts" ]] && sleep 5
  done
  echo "latest DMG did not converge to $LOCAL_DMG_LENGTH bytes" >&2
  return 1
}

wait_for_latest_appcast
wait_for_latest_dmg
wait_for_asset "$NOTES_URL"

VERIFY_STAMP="$(date +%s)"
curl -fsSL --retry 3 --retry-all-errors --max-time 120 \
  "${FEED_URL}?verify=$VERIFY_STAMP" -o "$PUBLISHED_APPCAST"
curl -fsSL --retry 3 --retry-all-errors --max-time 300 \
  "${DMG_URL}?verify=$VERIFY_STAMP" -o "$PUBLISHED_DMG"
BURNBAR_REQUIRE_NOTARIZATION=1 BURNBAR_CHECK_PUBLISHED_BUILD=0 \
  bash scripts/verify-update-artifacts.sh "$PUBLISHED_DMG" "$PUBLISHED_APPCAST"
echo "PUBLISHED: ${REPOSITORY} ${TAG}"
