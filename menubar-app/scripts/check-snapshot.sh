#!/usr/bin/env bash
# Rubric item 2: the compiled sidecar reports this machine's real burn.
# Builds if missing, runs `snapshot`, asserts today.totalTokens > 0 and >= 2 tools.
set -euo pipefail
cd "$(dirname "$0")/.."

CCU_DEFAULT=$(ls ../../node_modules/.pnpm/@ccusage+ccusage-darwin-arm64*/node_modules/@ccusage/ccusage-darwin-arm64/bin/ccusage 2>/dev/null | head -1 || true)
export BURNBAR_CCUSAGE="${BURNBAR_CCUSAGE:-$CCU_DEFAULT}"

if [[ ! -x sidecar/dist/burnbar-sidecar ]]; then
  (cd sidecar && bun build --compile --outfile dist/burnbar-sidecar ./src/main.ts >/dev/null)
fi

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
sidecar/dist/burnbar-sidecar snapshot > "$OUT" 2>/dev/null

/usr/bin/python3 - "$OUT" <<'EOF'
import json, sys
s = json.load(open(sys.argv[1]))
tokens = s["today"]["totalTokens"]
tools = s["toolsFound"]
assert tokens > 0, f"today.totalTokens={tokens}, expected > 0"
assert len(tools) >= 2, f"toolsFound={tools}, expected >= 2"
print(f"PASS today.totalTokens={tokens} tools={tools}")
EOF
