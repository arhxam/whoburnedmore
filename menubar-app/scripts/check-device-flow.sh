#!/usr/bin/env bash
# Rubric item 9 (v2): device-flow start against the REAL prod endpoint.
set -euo pipefail
API="${BURNBAR_API_BASE:-https://api.whoburnedmore.com}"
RESP=$(curl -sS -X POST "$API/v1/auth/device" -H 'Content-Type: application/json' -d '{}')
echo "$RESP" | /usr/bin/python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d.get('userCode') and d.get('verifyUrl') and d.get('deviceCode'), d
print('PASS userCode=%s verifyUrl=%s' % (d['userCode'], d['verifyUrl']))
"
