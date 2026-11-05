#!/bin/bash
# One take: restore the pristine demo, start it, record, stop. Usage: record.sh <out-dir> [scenes]
set -uo pipefail
T=$(cd "$(dirname "$0")" && pwd); K=$(cd "$T/../.." && pwd); D=${DEMO_DIR:-/tmp/demo}
WIKI=${KARMAX_WIKI:-$(ls -d "$K"/../krmax-wiki-* 2>/dev/null | head -1)}; PANAGENT=${PANAGENT:-$K/../panagent}
TEMPORAL_CLI=${TEMPORAL_CLI:-$HOME/.temporalio/bin/temporal}
OUT=${1:-$D/rec}; APP=http://127.0.0.1:48950
pkill -f "$D/home/temporal" 2>/dev/null; pkill -f "KARMAX_HOME=$D/home" 2>/dev/null; sleep 1
# A server from an interrupted take (setsid outlives its job) would share the home.
for pid in $(ss -ltnpH "sport = :48950" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill -TERM "$pid"; done; sleep 1
chmod -R u+w $D/home $D/repos 2>/dev/null; rm -rf $D/home $D/repos
cd $D && tar -xzf pristine.tgz
python3 $T/script.py >/dev/null
setsid env -i PATH="$PATH" HOME=$D/fakehome LANG=C.UTF-8 TZ=UTC TEMPORAL_CLI=$TEMPORAL_CLI ANTHROPIC_API_KEY=sk-ant-demo-not-a-key OPENAI_API_KEY=sk-demo-not-a-key bash -c "cd $K && KARMAX_HOME=$D/home KARMAX_PORT=48950 KARMAX_AGENT_PROVIDER=mock KARMAX_MOCK_SCRIPT=$D/script.json exec npx tsx src/main.ts" > $D/record-server.log 2>&1 &
SERVER=$!
for i in $(seq 120); do curl -sf $APP/api/meta >/dev/null && break; sleep 1; done
sleep 4
cd $T && node ${DIRECTOR:-director.cjs} "$OUT" ${2:-}
CODE=$?
kill -TERM -$SERVER 2>/dev/null; sleep 2; pkill -f "$D/home/temporal" 2>/dev/null
echo "director exit $CODE"
exit $CODE
