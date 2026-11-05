#!/usr/bin/env bash
# (Re)build the demo clone's data from the export, then put it in the given scenes.
# Usage: design/launch-video/prepare.sh [scene…]   (defaults: tidy busy)
set -euo pipefail
cd "$(dirname "$0")"
EXPORT=${EXPORT:-/home/user/karmax/demo-export}
HOME_DIR=${KARMAX_HOME:-/home/user/demo/home}
USER_ID=${DEMO_USER_ID:-$(python3 -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute(\"SELECT userId FROM organization_memberships WHERE organizationId='org_personal' AND role='owner'\").fetchone()[0])" "$HOME_DIR/state/karmax.db")}
python3 import.py "$EXPORT" "$HOME_DIR" "$USER_ID" >/dev/null
./hold.sh "$EXPORT/unfinished.txt" >/dev/null
if [ $# -eq 0 ]; then set -- tidy busy; fi
python3 -I stage.py "$HOME_DIR" "$@"
