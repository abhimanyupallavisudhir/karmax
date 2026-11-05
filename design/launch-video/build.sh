#!/bin/bash
# Builds the demo tavya from nothing: a clone of the personal organization
# (private projects and tasks filtered out), then snapshots it for recording.
# Run fetch.py first (the production snapshot). Needs the karmax, panagent and wiki checkouts.
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd); K=$(cd "$T/../.." && pwd); D=${DEMO_DIR:-/tmp/demo}
WIKI=${KARMAX_WIKI:-$(ls -d "$K"/../krmax-wiki-* 2>/dev/null | head -1)}; PANAGENT=${PANAGENT:-$K/../panagent}
TEMPORAL_CLI=${TEMPORAL_CLI:-$HOME/.temporalio/bin/temporal}
export WIKI DEMO_DIR=$D
mkdir -p $D/assets $D/fakehome && cp -r $T/assets/. $D/assets/
APP=http://127.0.0.1:48950

# ── repositories the projects point at ──
rm -rf $D/repos && mkdir -p $D/repos && cd $D/repos
git clone -q $K karmax.git && git -C karmax.git checkout -q -B master && git -C karmax.git remote remove origin
git -C karmax.git branch | grep -v '^\*' | xargs -r git -C karmax.git branch -D -q || true
git -C karmax.git rm -q .github/workflows/deploy.yml
git -C karmax.git -c user.name="Abhimanyu Pallavi Sudhir" -c user.email=abhimanyu@tavya.io commit -qm "Drop the old deploy workflow"
git clone -q $PANAGENT panagent.git && git -C panagent.git checkout -q -B master && git -C panagent.git remote remove origin
git -C panagent.git branch | grep -v '^\*' | xargs -r git -C panagent.git branch -D -q || true
mkdir -p cv.git/cv && cp $D/assets/cv.tex cv.git/cv/cv.tex && git -C cv.git init -q -b master && git -C cv.git add -A \
  && git -C cv.git -c user.name="Abhimanyu Pallavi Sudhir" -c user.email=abhimanyu@tavya.io commit -qm "CV"

# ── a fresh home and server ──
chmod -R u+w $D/home 2>/dev/null || true; rm -rf $D/home
setsid env -i PATH="$PATH" HOME=$D/fakehome LANG=C.UTF-8 TZ=UTC TEMPORAL_CLI=$TEMPORAL_CLI ANTHROPIC_API_KEY=sk-ant-demo-not-a-key OPENAI_API_KEY=sk-demo-not-a-key bash -c "cd $K && KARMAX_HOME=$D/home KARMAX_PORT=48950 KARMAX_AGENT_PROVIDER=mock KARMAX_MOCK_SCRIPT=$D/script.json exec npx tsx src/main.ts" > $D/build-server.log 2>&1 &
SERVER=$!
trap 'kill -TERM -$SERVER 2>/dev/null || true' EXIT
for i in $(seq 120); do curl -sf $APP/api/meta >/dev/null && break; sleep 1; done
cd $D
node $T/setup.cjs
node $T/seed-projects.cjs
. $T/api.sh
OLD=$(api GET /api/projects | python3 -c "import json,sys;print([p['id'] for p in json.load(sys.stdin) if p['name']=='My project'][0])")
api DELETE /api/projects/$OLD '{"confirmName":"My project"}' >/dev/null
api POST /api/cards '{"label":"abhimanyu","provider":"vault-card","cap":100000,"currency":"usd","details":{"number":"4242424242424242","cvc":"123","expMonth":12,"expYear":2029}}' >/dev/null
api POST /api/user/tokens '{"name":"laptop","expiresInDays":30}' > $D/cli-token.json
python3 $T/seed-tasks.py
# The pre-installed "Repair GitHub workflow" series would fill every list.
for id in $(python3 -c "import sqlite3;print(' '.join(r[0] for r in sqlite3.connect('$D/home/state/karmax.db').execute(\"select id from tasks where title like 'Repair GitHub workflow%'\")))"); do api DELETE /api/tasks/$id >/dev/null; done
python3 $T/seed-extras.py
python3 $T/script.py
sleep 3
kill -TERM -$SERVER; wait $SERVER 2>/dev/null || true
trap - EXIT
# Temporal's dev server outlives the app by design; snapshot it stopped too.
pkill -f "$D/home/temporal" 2>/dev/null || true
sleep 2
cd $D && rm -f pristine.tgz && tar -czf pristine.tgz home repos script.json projects.json state.json cli-token.json
echo "built: $(du -sh pristine.tgz | cut -f1)"
