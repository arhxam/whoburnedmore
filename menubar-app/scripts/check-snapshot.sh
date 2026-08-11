#!/usr/bin/env bash
# Rubric item 2: the compiled sidecar reports this machine's real burn.
# Builds if missing, runs `snapshot`, asserts today.totalTokens > 0 and >= 2 tools.
set -euo pipefail
cd "$(dirname "$0")/.."

CCU_VERSION=$(node -p "require('./node_modules/ccusage/package.json').version")
CCU_ARCH="arm64"
[[ "$(uname -m)" == "x86_64" ]] && CCU_ARCH="x64"
CCU_DEFAULT="../../node_modules/.pnpm/@ccusage+ccusage-darwin-${CCU_ARCH}@${CCU_VERSION}/node_modules/@ccusage/ccusage-darwin-${CCU_ARCH}/bin/ccusage"
export BURNBAR_CCUSAGE="${BURNBAR_CCUSAGE:-$CCU_DEFAULT}"
CCU_TEMP=""
if [[ ! -x "$BURNBAR_CCUSAGE" ]]; then
  CCU_TEMP=$(mktemp)
  cp "$BURNBAR_CCUSAGE" "$CCU_TEMP"
  chmod +x "$CCU_TEMP"
  export BURNBAR_CCUSAGE="$CCU_TEMP"
fi

if [[ ! -x sidecar/dist/burnbar-sidecar ]]; then
  (cd sidecar && bun build --compile --outfile dist/burnbar-sidecar ./src/main.ts >/dev/null)
fi

OUT=$(mktemp)
trap 'rm -f "$OUT" "$CCU_TEMP"' EXIT
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
