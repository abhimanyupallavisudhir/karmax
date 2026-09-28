#!/bin/sh
# Keep a validated deployment alive when the CI runner loses its SSH session.
set -eu

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-}" = run ]; then DEPLOY_DIR=$(dirname "$(dirname "$DEPLOY_DIR")"); fi
UPDATES="$DEPLOY_DIR/.updates"
command=${1:-}
sha=${2:-}
key=${3:-}
case "$sha" in ''|*[!0-9a-fA-F]*) echo 'invalid update SHA' >&2; exit 2;; esac
[ "${#sha}" -eq 40 ] || { echo 'invalid update SHA length' >&2; exit 2; }
case "$key" in ''|*[!A-Za-z0-9_-]*) echo 'invalid update key' >&2; exit 2;; esac
run="$UPDATES/$key"

case "$command" in
  start)
    updater=${4:-}
    [ -f "$updater" ] || { echo 'validated updater is missing' >&2; exit 2; }
    umask 077
    mkdir -p "$UPDATES"
    mkdir "$run" || { echo "update $key already exists" >&2; exit 1; }
    cp "$updater" "$run/karmax"
    cp "$0" "$run/runner"
    chmod 700 "$run/karmax" "$run/runner"
    printf 'running\n' > "$run/status"
    nohup setsid sh "$run/runner" run "$sha" "$key" </dev/null >"$run/log" 2>&1 &
    echo "Detached deployment $key (pid $!)."
    ;;
  run)
    code=0
    # The runner's own files are private (start's umask 077), but the updater
    # checks out the release the image copies with its modes and runs as the
    # app user: under 077 every source it changed became unreadable to the app,
    # and so did the rollback's. Its secrets set their own umask.
    ( flock -n 9 || exit 73; umask 022; KARMAX_DEPLOY_DIR="$DEPLOY_DIR" "$run/karmax" update "$sha" ) 9>"$UPDATES/host.lock" || code=$?
    if [ "$code" -eq 0 ]; then printf 'success\n' > "$run/status.next"
    else printf 'failed:%s\n' "$code" > "$run/status.next"; fi
    mv "$run/status.next" "$run/status"
    exit "$code"
    ;;
  *) echo 'usage: update-runner.sh start SHA KEY UPDATER' >&2; exit 2;;
esac
