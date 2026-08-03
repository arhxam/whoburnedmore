#!/usr/bin/env bash
# Live-seam check (rubric item 3): Claude Code Keychain OAuth -> Anthropic usage
# endpoint. Prints the HTTP status and the top-level field names of the JSON
# response. The access token stays in this process's memory only — it is never
# printed, logged, or written to disk.
set -euo pipefail

TOKEN=$(security find-generic-password -w -s "Claude Code-credentials" \
  | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])")

if [[ -z "$TOKEN" ]]; then
  echo "FAIL: no accessToken in Keychain item" >&2
  exit 1
fi

RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT

STATUS=$(curl -sS -o "$RESP" -w '%{http_code}' "https://api.anthropic.com/api/oauth/usage" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "User-Agent: claude-code/2.1.0")

echo "HTTP $STATUS"
/usr/bin/python3 - "$RESP" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
print("fields:", sorted(d.keys()))
for k in ("five_hour", "seven_day"):
    v = d.get(k)
    if isinstance(v, dict):
        print(f"{k}: utilization={v.get('utilization')} resets_at={v.get('resets_at')}")
lims = d.get("limits")
if isinstance(lims, list):
    for l in lims:
        scope = (l.get("scope") or {}).get("model", {}) if isinstance(l.get("scope"), dict) else {}
        print(f"limit kind={l.get('kind')} percent={l.get('percent')} resets_at={l.get('resets_at')} model={scope.get('display_name')}")
EOF

[[ "$STATUS" == "200" ]] || exit 1
