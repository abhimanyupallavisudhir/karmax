#!/bin/bash
# grade: put the hidden test in place and run it
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$1" || exit 1
T=tests/agent-mail.test.ts
cp "$HERE/hidden.test.ts.txt" "$T"
NODE_OPTIONS=--max-old-space-size=1500 timeout 900 npx vitest run "$T" 2>&1 | tail -30
exit ${PIPESTATUS[0]}
