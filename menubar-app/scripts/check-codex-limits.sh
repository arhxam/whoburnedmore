#!/usr/bin/env bash
# Rubric item 4: codex rate-limits parsing — fixture tests green AND the
# compiled binary emits a codex provider object on this machine.
set -euo pipefail
cd "$(dirname "$0")/.."

VITEST_OUT=$(npx vitest run --root sidecar codex-limits --reporter=verbose 2>&1 | tail -6)
if echo "$VITEST_OUT" | grep -qE "failed"; then
  echo "FAIL: codex-limits vitest fixtures"; echo "$VITEST_OUT"; exit 1
fi
echo "$VITEST_OUT" | grep -q "passed" || { echo "FAIL: no vitest pass line"; exit 1; }

if [[ ! -x sidecar/dist/burnbar-sidecar ]]; then
  (cd sidecar && bun build --compile --outfile dist/burnbar-sidecar ./src/main.ts >/dev/null)
fi

OUT=$(sidecar/dist/burnbar-sidecar limits)
echo "$OUT" | /usr/bin/python3 -c "
import json, sys
d = json.load(sys.stdin)
assert 'codex' in d, 'no codex provider object'
print('PASS codex.present=%s planType=%s' % (d['codex']['present'], d['codex']['planType']))
"
