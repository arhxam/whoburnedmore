#!/usr/bin/env bash
# Rubric item 9: the signed app launches, stays up, and owns its sidecar.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="$(pwd)/dist/BurnBar.app/Contents/MacOS/BurnBar"
APP_PID=""
SIDECAR_PID=""
COLLECTOR_PIDS=""
TEST_SIDECAR_PID=""
TEST_COLLECTOR_PIDS=""
TEST_ROOT=""
TEST_STDIN_OPEN=0
cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  if [[ -n "$SIDECAR_PID" ]] && kill -0 "$SIDECAR_PID" 2>/dev/null; then
    kill -TERM "$SIDECAR_PID" 2>/dev/null || true
  fi
  for pid in $COLLECTOR_PIDS; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  if [[ -n "$TEST_SIDECAR_PID" ]] && kill -0 "$TEST_SIDECAR_PID" 2>/dev/null; then
    kill -TERM "$TEST_SIDECAR_PID" 2>/dev/null || true
    wait "$TEST_SIDECAR_PID" 2>/dev/null || true
  fi
  for pid in $TEST_COLLECTOR_PIDS; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  if [[ "$TEST_STDIN_OPEN" == "1" ]]; then
    exec 9>&-
  fi
  [[ -z "$TEST_ROOT" ]] || rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

"$APP" >/tmp/burnbar-launch.log 2>&1 &
APP_PID=$!
sleep 6
if ! kill -0 "$APP_PID" 2>/dev/null; then
  echo "FAIL: BurnBar not running"
  tail -5 /tmp/burnbar-launch.log
  exit 1
fi

SIDECAR_PID=$(pgrep -P "$APP_PID" -f '/burnbar-sidecar watch$' | head -1 || true)
if [[ -z "$SIDECAR_PID" ]]; then
  echo "FAIL: watch sidecar not running under BurnBar $APP_PID"
  exit 1
fi
echo "PID $APP_PID SIDECAR $SIDECAR_PID"
COLLECTOR_PIDS=$(pgrep -P "$SIDECAR_PID" || true)

kill -TERM "$APP_PID"
wait "$APP_PID" 2>/dev/null || true
APP_PID=""
for _ in {1..40}; do
  kill -0 "$SIDECAR_PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$SIDECAR_PID" 2>/dev/null; then
  echo "FAIL: orphan watch sidecar $SIDECAR_PID"
  exit 1
fi
SIDECAR_PID=""
for pid in $COLLECTOR_PIDS; do
  for _ in {1..40}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "FAIL: orphan collector process $pid"
    exit 1
  fi
done
COLLECTOR_PIDS=""
echo "PASS no orphan watch sidecar or collector"

# The real collector can finish between polls. Exercise the assembled sidecar's
# SIGTERM path deterministically with a parser that stays alive until killed.
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/burnbar-launch.XXXXXX")
mkdir -p "$TEST_ROOT/claude" "$TEST_ROOT/codex" "$TEST_ROOT/cache"
mkfifo "$TEST_ROOT/stdin"
exec 9<>"$TEST_ROOT/stdin"
TEST_STDIN_OPEN=1
env \
  HOME="$TEST_ROOT" \
  CLAUDE_CONFIG_DIR="$TEST_ROOT/claude" \
  CODEX_HOME="$TEST_ROOT/codex" \
  BURNBAR_CACHE_DIR="$TEST_ROOT/cache" \
  BURNBAR_CCUSAGE="$(pwd)/scripts/fixtures/blocking-ccusage.mjs" \
  WHOBURNEDMORE_PRICING_OFFLINE=1 \
  "$(pwd)/dist/BurnBar.app/Contents/Resources/burnbar-sidecar" watch \
  <"$TEST_ROOT/stdin" >"$TEST_ROOT/watch.log" 2>&1 &
TEST_SIDECAR_PID=$!
for _ in {1..40}; do
  TEST_COLLECTOR_PIDS=$(pgrep -P "$TEST_SIDECAR_PID" || true)
  [[ -n "$TEST_COLLECTOR_PIDS" ]] && break
  sleep 0.1
done
if [[ -z "$TEST_COLLECTOR_PIDS" ]]; then
  echo "FAIL: deterministic watch check never started a collector"
  tail -5 "$TEST_ROOT/watch.log"
  exit 1
fi

if ! kill -0 "$TEST_SIDECAR_PID" 2>/dev/null; then
  echo "FAIL: deterministic watch exited before shutdown"
  tail -5 "$TEST_ROOT/watch.log"
  exit 1
fi
kill -TERM "$TEST_SIDECAR_PID"
wait "$TEST_SIDECAR_PID" 2>/dev/null || true
TEST_SIDECAR_PID=""
exec 9>&-
TEST_STDIN_OPEN=0
for pid in $TEST_COLLECTOR_PIDS; do
  for _ in {1..40}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "FAIL: deterministic watch check orphaned collector $pid"
    exit 1
  fi
done
TEST_COLLECTOR_PIDS=""
echo "PASS deterministic watch shutdown terminated active collectors"
