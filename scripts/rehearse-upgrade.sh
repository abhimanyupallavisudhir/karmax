#!/usr/bin/env bash
# Rehearses a release upgrade on a production-shaped turnkey stack:
#
#   scripts/rehearse-upgrade.sh [--from REV] [--to REV] [--work DIR] [--keep]
#                               [--no-runner] [--before-update CMD]
#
# FROM (default origin/master, the deployed revision) is installed from a
# scratch clone with its own `deploy/karmax up`, seeded with production-shaped
# data through its HTTP API (scripts/rehearsal/client.ts) and backed up with its
# `deploy/karmax backup`. It is then upgraded to TO (default HEAD) the way the
# Deploy workflow upgrades production: TO's own `deploy/karmax update <sha>`,
# through TO's update-runner.sh when it has one (--no-runner skips the runner,
# as deploy.yml did before it, to tell the runner's failures from the
# release's; --before-update runs an operator's workaround in the install
# first). Everything is verified through TO's API; then the pre-update
# backup is restored onto a fresh TO stack and verified again. Timings are
# printed; any failure exits non-zero.
#
# Nothing reaches production or spends credit: the stack is its own Compose
# project, agents are the mock, worlds come from a local E2B stand-in
# (scripts/rehearsal/fake-e2b.ts) and the card is the vault-card rail. Needs
# Linux, Docker with Compose v2 and ~10 GB of disk. The wiki page
# ops/release-and-deploy ("Rehearsing an upgrade") lists the traps.
set -euo pipefail

HARNESS=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REHEARSAL=$HARNESS/rehearsal
SOURCE_REPO=$(git -C "$HARNESS" rev-parse --show-toplevel)
FROM=origin/master
TO=HEAD
WORK=''
KEEP=0
RUNNER=1
BEFORE_UPDATE=''
DOMAIN=rehearse.localhost
# A project of its own, so the rehearsal never touches an installation's
# `karmax` containers or volumes on the same host. deploy/karmax runs every
# Compose command without -p, so it honours this.
export COMPOSE_PROJECT_NAME=karmax-rehearse
SANDBOX_IMAGE=karmax-rehearsal-sandbox
SANDBOX_NETWORK=karmax-rehearsal-sandboxes
FAKE_E2B=karmax-rehearsal-e2b
# The client and the E2B stand-in are TypeScript run by Node's type stripping,
# in containers: nothing on the host but Docker, and outside the process tree a
# sandbox's memory guard may kill.
NODE_IMAGE=node:22-bookworm-slim
E2B_API_PORT=${REHEARSAL_E2B_PORT:-13000}
E2B_ENVD_PORT=$((E2B_API_PORT + 1))

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from) FROM=$2; shift 2 ;;
    --to) TO=$2; shift 2 ;;
    --work) WORK=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --no-runner) RUNNER=0; shift ;;
    --before-update) BEFORE_UPDATE=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; echo "rehearse: unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "rehearse: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

FROM_SHA=$(git -C "$SOURCE_REPO" rev-parse --verify "$FROM^{commit}") || die "unknown --from revision: $FROM"
TO_SHA=$(git -C "$SOURCE_REPO" rev-parse --verify "$TO^{commit}") || die "unknown --to revision: $TO"
[ "$FROM_SHA" != "$TO_SHA" ] || die "--from and --to are the same commit ($FROM_SHA)"
WORK=${WORK:-${TMPDIR:-/tmp}/karmax-rehearsal-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$WORK/logs"
WORK=$(CDPATH='' cd -- "$WORK" && pwd)
[ -z "$(ls -A "$WORK" | grep -v '^logs$' || true)" ] || die "--work $WORK is not empty"
LOGS=$WORK/logs
STATE=$WORK/state.json

# ---------------------------------------------------------------- bookkeeping
declare -a RESULTS=() TIMINGS=()
FAILED=0
record() { RESULTS+=("$(printf '%-4s %s' "$1" "$2")"); [ "$1" != FAIL ] || FAILED=1; }
timing() { TIMINGS+=("$(printf '%-44s %5ss' "$1" "$2")"); }

# step NAME LOG COMMAND... runs COMMAND with its output on screen and in
# $LOGS/LOG, and records its duration and outcome.
step() {
  local name=$1 log=$2 started status; shift 2
  say "$name"
  started=$(date +%s)
  set +e
  "$@" 2>&1 | tee "$LOGS/$log"
  status=${PIPESTATUS[0]}
  set -e
  timing "$name" $(( $(date +%s) - started ))
  if [ "$status" -eq 0 ]; then record ok "$name"; else record FAIL "$name (exit $status; $LOGS/$log)"; fi
  return "$status"
}

summary() {
  say 'Rehearsal summary'
  echo "from  $FROM ($FROM_SHA)"
  echo "to    $TO ($TO_SHA)"
  echo "work  $WORK"
  echo; echo 'Timings:'; printf '  %s\n' "${TIMINGS[@]}"
  echo; echo 'Results:'; printf '  %s\n' "${RESULTS[@]}"
  if [ -f "$STATE" ]; then
    docker run --rm -v "$STATE:/state.json:ro" "$NODE_IMAGE" node -e \
      'for (const gap of JSON.parse(require("fs").readFileSync("/state.json", "utf8")).gaps ?? []) console.log(`  GAP  ${gap}`)'
  fi
  echo
  if [ "$FAILED" -eq 0 ]; then echo 'REHEARSAL PASSED'; else echo 'REHEARSAL FAILED'; fi
}
abort() { summary; exit 1; }

# ---------------------------------------------------------------- stack helpers
by_project() { docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" "$@"; }
app_container() { by_project --filter status=running --filter label=com.docker.compose.service=app | head -n 1; }
app_url() {
  local id address
  id=$(app_container); [ -n "$id" ] || { echo 'rehearse: no running app container' >&2; return 1; }
  address=$(docker inspect -f "{{(index .NetworkSettings.Networks \"${COMPOSE_PROJECT_NAME}_default\").IPAddress}}" "$id")
  printf 'http://%s:4505\n' "$address"
}
# Everything the rehearsal's Compose project owns, volumes included. The E2B
# stand-in's sandboxes are not the project's and survive, as E2B's would.
wipe_project() {
  local ids
  ids=$(by_project); [ -z "$ids" ] || docker rm -f $ids >/dev/null
  ids=$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
  [ -z "$ids" ] || docker volume rm $ids >/dev/null
  docker network rm "${COMPOSE_PROJECT_NAME}_default" >/dev/null 2>&1 || true
}
wipe_sandboxes() {
  local ids
  docker rm -f "$FAKE_E2B" >/dev/null 2>&1 || true
  ids=$(docker ps -aq --filter label=karmax.rehearsal.sandbox); [ -z "$ids" ] || docker rm -f $ids >/dev/null
  docker network rm "$SANDBOX_NETWORK" >/dev/null 2>&1 || true
}

# The seed/verify client runs on the stack's network and calls the app with
# the headers Caddy would forward. Caddy itself is bypassed: it never gets a
# certificate for a .localhost name (its only TLS policy is the previews'
# on-demand one, whose permission check refuses it).
client() {
  docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" --user "$(id -u):$(id -g)" \
    -v "$REHEARSAL:/rehearsal:ro" -v "$WORK:/work" "$NODE_IMAGE" \
    node --experimental-strip-types --no-warnings /rehearsal/client.ts "$@" \
    --app http://app:4505 --origin "https://$DOMAIN" --state /work/state.json
}

# Point the app at the E2B stand-in. $KARMAX_HOME/karmax.env is the operator's
# settings file, loaded at start (the real environment wins), and it lives in
# the data volume, so an update's new app reads it on its first boot.
use_fake_e2b() {
  [ -n "$E2B_HOST" ] || { echo "rehearse: the E2B stand-in has no address" >&2; return 1; }
  local id dc; id=$(app_container)
  if ! docker exec "$id" grep -q '^E2B_API_URL=' /var/lib/karmax/karmax.env 2>/dev/null; then
    docker exec "$id" sh -c "printf 'E2B_API_URL=http://%s:%s\nE2B_SANDBOX_URL=http://%s:%s\n' \
      $E2B_HOST $E2B_API_PORT $E2B_HOST $E2B_ENVD_PORT >> /var/lib/karmax/karmax.env"
    docker restart "$id" >/dev/null
    until docker exec "$id" node -e "fetch('http://127.0.0.1:4505/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do sleep 2; done
    echo "The app now uses the E2B stand-in at $E2B_HOST:$E2B_API_PORT."
  fi
}

# Follows every app container the project starts (an old release's updater
# replaces a failed candidate on rollback, and its logs with it) and notes when
# each first answered /api/health/ready: the first boot.
watch_app() {
  local seen=' ' id
  trap 'kill $(jobs -p) 2>/dev/null; exit 0' TERM
  while :; do
    id=$(app_container)
    if [ -n "$id" ] && [ "${seen#* "$id" }" = "$seen" ]; then
      seen="$seen$id "
      docker logs -f "$id" > "$LOGS/app-$id.log" 2>&1 &
      (
        started=$(date +%s)
        until docker exec "$id" node -e "fetch('http://127.0.0.1:4505/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
          docker inspect "$id" >/dev/null 2>&1 || exit 0
          sleep 1
        done
        echo "$id $started $(date +%s)" >> "$LOGS/boots.txt"
      ) &
    fi
    sleep 1
  done
}

WATCHER=''
cleanup() {
  [ -z "$WATCHER" ] || kill "$WATCHER" 2>/dev/null || true
  docker logs "$FAKE_E2B" > "$LOGS/fake-e2b.log" 2>&1 || true
  jobs -p | xargs -r kill 2>/dev/null || true
  if [ "$KEEP" -eq 0 ]; then wipe_project; wipe_sandboxes; fi
  docker image rm "$COMPOSE_PROJECT_NAME-warm-app" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------------------------------------------------------------- preflight
say "Rehearsing $FROM ($FROM_SHA) -> $TO ($TO_SHA) in $WORK"
docker info >/dev/null 2>&1 || die 'Docker is not running or not accessible (sudo dockerd &; sudo chmod 666 /var/run/docker.sock)'
docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'
docker image inspect "$NODE_IMAGE" >/dev/null 2>&1 || docker pull -q "$NODE_IMAGE" >/dev/null
[ -z "$(by_project)" ] || { echo "Removing the previous rehearsal's $COMPOSE_PROJECT_NAME project…"; wipe_project; }
wipe_sandboxes
for port in 80 443; do
  [ -z "$(docker ps -q --filter "publish=$port")" ] || die "port $port is published by another container; stop it first (docker ps --filter publish=$port)"
done
free_gb=$(df -Pk "$WORK" | awk 'NR == 2 { print int($4 / 1048576) }')
[ "$free_gb" -ge 10 ] || echo "rehearse: warning: only ${free_gb} GB free; image builds need several (docker builder prune -af frees cache)" >&2

# ---------------------------------------------------------------- the E2B stand-in
# Sandboxes live on a network of their own, so they outlive the stack (and the
# restore's fresh stack sees the same ones, as it would on E2B). The stand-in
# runs on this host, reached by the app through the docker0 bridge address.
E2B_HOST=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
start_fake_e2b() {
  docker build -q -t "$SANDBOX_IMAGE" -f "$REHEARSAL/sandbox.Dockerfile" "$REHEARSAL"
  docker network create "$SANDBOX_NETWORK" >/dev/null
  docker run -d --name "$FAKE_E2B" --network "$SANDBOX_NETWORK" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$REHEARSAL:/rehearsal:ro" \
    -p "$E2B_HOST:$E2B_API_PORT:$E2B_API_PORT" -p "$E2B_HOST:$E2B_ENVD_PORT:$E2B_ENVD_PORT" "$NODE_IMAGE" \
    node --experimental-strip-types --no-warnings /rehearsal/fake-e2b.ts --host 0.0.0.0 \
    --api-port "$E2B_API_PORT" --envd-port "$E2B_ENVD_PORT" --image "$SANDBOX_IMAGE" --network "$SANDBOX_NETWORK" >/dev/null
  local attempt=0
  until docker logs "$FAKE_E2B" 2>&1 | grep -q "listening on 0.0.0.0:$E2B_ENVD_PORT"; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 50 ] || { docker logs "$FAKE_E2B"; return 1; }
    sleep 0.2
  done
  echo "E2B stand-in on $E2B_HOST:$E2B_API_PORT (envd $E2B_ENVD_PORT)"
}
step 'Start the E2B stand-in' fake-e2b-start.log start_fake_e2b || abort

# ---------------------------------------------------------------- scratch origin
# A local bare origin whose master is FROM, and an install clone of it, as on
# the VPS. The updater deploys only descendants of origin/master, so TO is
# published later as a master that contains it.
git init -q --bare "$WORK/origin.git"
git -C "$SOURCE_REPO" push -q "$WORK/origin.git" "$FROM_SHA:refs/heads/master" "$TO_SHA:refs/heads/rehearsal-to"
git clone -q "$WORK/origin.git" "$WORK/install"
if git -C "$WORK/origin.git" merge-base --is-ancestor "$FROM_SHA" "$TO_SHA"; then
  DEPLOY_SHA=$TO_SHA
else
  # Not a descendant: deploy exactly TO's tree on top of FROM. Merging instead
  # can combine the two into an app that neither revision is.
  DEPLOY_SHA=$(git -C "$WORK/origin.git" commit-tree "$TO_SHA^{tree}" -p "$FROM_SHA" -p "$TO_SHA" -m "Rehearse deploying $TO_SHA")
fi

# ---------------------------------------------------------------- warm TO's build
# The update builds TO's image while FROM's stack runs, and on a small host
# npm ci inside that build is OOM-killed. Building it now, with nothing running,
# lets the update's build come from BuildKit's cache.
warm_build() {
  local warm=$WORK/warm
  git clone -q "$WORK/origin.git" "$warm" && git -C "$warm" checkout -q --detach "$DEPLOY_SHA"
  KARMAX_DOMAIN=$DOMAIN KARMAX_PREVIEW_DOMAIN=preview.$DOMAIN POSTGRES_PASSWORD=warm \
    docker compose -p "$COMPOSE_PROJECT_NAME-warm" --project-directory "$warm/deploy" --env-file /dev/null \
    -f "$warm/deploy/compose.turnkey.yml" build --pull app
  # Keep the image until the end: with containerd's image store, removing it
  # also drops the cached layers the update's build is meant to reuse.
  rm -rf "$warm"
}
step 'Warm the TO image build (not timed as the update)' warm-build.log warm_build || abort

# ---------------------------------------------------------------- a. install FROM
cd "$WORK/install"
step 'a. Install FROM (deploy/karmax up)' up-from.log ./deploy/karmax up "$DOMAIN" || abort
step '   Point FROM at the E2B stand-in' e2b-from.log use_fake_e2b || abort

# ---------------------------------------------------------------- b. seed
step 'b. Seed through the FROM API' seed.log client seed || abort
step '   Verify the seed on FROM (baseline)' verify-from.log client verify --phase from || abort

# ---------------------------------------------------------------- c. backup
BACKUP=$WORK/backup
step 'c. Backup (FROM deploy/karmax backup)' backup.log ./deploy/karmax backup "$BACKUP" || abort

# ---------------------------------------------------------------- d. update
# As .github/workflows/deploy.yml does on the VPS: the updater that runs is the
# deployed revision's own deploy/karmax, fetched with `git show`, so a release
# can repair the updater that deploys it. A revision with deploy/update-runner.sh
# runs it detached through the runner and is polled until it settles.
deploy_like_production() {
  local key status
  git fetch -q --prune origin '+refs/heads/master:refs/remotes/origin/master'
  git merge-base --is-ancestor "$DEPLOY_SHA" refs/remotes/origin/master || { echo 'deployment SHA is not on master'; return 1; }
  git show "$DEPLOY_SHA:deploy/karmax" > ./deploy/.karmax-update && chmod 700 ./deploy/.karmax-update
  if [ "$RUNNER" -eq 0 ] || ! git cat-file -e "$DEPLOY_SHA:deploy/update-runner.sh" 2>/dev/null; then
    ./deploy/.karmax-update update "$DEPLOY_SHA"; status=$?
    rm -f ./deploy/.karmax-update; return "$status"
  fi
  git show "$DEPLOY_SHA:deploy/update-runner.sh" > ./deploy/.karmax-runner && chmod 700 ./deploy/.karmax-runner
  key="$(date +%s)-1"
  ./deploy/.karmax-runner start "$DEPLOY_SHA" "$key" ./deploy/.karmax-update || { rm -f ./deploy/.karmax-*; return 1; }
  rm -f ./deploy/.karmax-update ./deploy/.karmax-runner
  until [ -f "deploy/.updates/$key/log" ]; do sleep 1; done
  tail -n +1 -f "deploy/.updates/$key/log" & local tailer=$! waited=0
  # The Deploy workflow gives up after 30 minutes of polling; so does this.
  while [ "$(cat "deploy/.updates/$key/status")" = running ] && [ "$waited" -lt 1800 ]; do sleep 2; waited=$((waited + 2)); done
  sleep 1; kill "$tailer" 2>/dev/null || true
  status=$(cat "deploy/.updates/$key/status")
  echo "update runner status: $status"
  [ "$status" = success ]
}
git -C "$WORK/origin.git" update-ref refs/heads/master "$DEPLOY_SHA"
if [ -n "$BEFORE_UPDATE" ]; then
  export REHEARSAL_TO_SHA=$DEPLOY_SHA
  step '   Before the update (--before-update)' before-update.log sh -c "$BEFORE_UPDATE" || true
fi
previous_app=$(app_container)
watch_app & WATCHER=$!
update_started=$(date +%s)
updated=0
if step "d. Update to TO (TO's deploy/karmax update ${DEPLOY_SHA:0:12})" update.log deploy_like_production; then
  deployed=$(git -C "$WORK/install" rev-parse HEAD)
  if [ "$deployed" = "$DEPLOY_SHA" ]; then updated=1
  else record FAIL "the install is at $deployed after the update, not $DEPLOY_SHA"; fi
fi
# The first boot: from the new app container's start to its first ready
# answer. The container FROM ran before the update does not count.
sleep 2
current_app=$(app_container)
if [ "$updated" -eq 1 ] && [ -n "$current_app" ] && [ "$current_app" != "$previous_app" ]; then
  boot=$(awk -v id="$current_app" '$1 == id { print $3 - $2 }' "$LOGS/boots.txt" 2>/dev/null | tail -n 1)
  [ -z "$boot" ] || timing '   First boot of TO (app start to ready)' "$boot"
fi

# ---------------------------------------------------------------- e. verify TO
doctor_role() {
  local out; out=$(./deploy/karmax doctor 2>&1) || { echo "$out"; return 1; }
  echo "$out"
  echo "$out" | grep -q 'as the superuser' && { echo 'rehearse: doctor reports the app connected as the superuser'; return 1; }
  echo "$out" | grep -q 'The app connects to PostgreSQL as karmax, not a superuser' \
    || { echo 'rehearse: doctor does not report the app connected as the karmax role'; return 1; }
}
# Periodic jobs (retention, reconciliation, sweeps) run at boot and then on
# timers; one that throws on real data only says so in the app's log.
background_jobs() {
  local id; id=$(app_container)
  if docker logs "$id" 2>&1 | grep -E -A12 '\] job failed|Unhandled(Promise)?Rejection|uncaughtException'; then
    echo "rehearse: the app's background jobs failed (docker logs $id)"; return 1
  fi
  echo "No background job failed in app container ${id:0:12}."
}
if [ "$updated" -eq 0 ]; then
  record FAIL 'e. skipped: the update did not complete, so there is no TO to verify'
elif [ -z "$(app_container)" ]; then
  record FAIL 'e. no app is running after the update; nothing to verify'
else
  step 'e. Verify every record through the TO API' verify-to.log client verify --phase upgraded --resume || true
  step '   doctor: the app connects as its own role' doctor.log doctor_role || true
  step "   The app's background jobs run cleanly" jobs-to.log background_jobs || true
fi

# ---------------------------------------------------------------- f. restore
[ -z "$WATCHER" ] || kill "$WATCHER" 2>/dev/null || true; WATCHER=''
say 'Replacing the upgraded stack with a fresh TO stack'
wipe_project
git clone -q "$WORK/origin.git" "$WORK/restore"
git -C "$WORK/restore" checkout -q --detach "$DEPLOY_SHA"
cd "$WORK/restore"
# Answers the confirmation the restore asks for, whatever its wording.
restore() { printf '%s\n' "${CONFIRM:-RESTORE}" | ./deploy/karmax restore "$@"; }
# Releases before CI-37 wrote no SHA256SUMS, and a restore that requires one
# refuses their backups; one that also verifies signatures refuses unsigned
# checksums unless told --accept-unsigned-v1. The refusal is recorded as a
# failure; the rest of the restore is then still exercised the way an operator
# would get past it: on a copy, with checksums written over the unchanged files.
with_checksums() {
  local accept=()
  cp -a "$BACKUP" "$BACKUP-checksummed"
  (cd "$BACKUP-checksummed" && sha256sum *.dump deployment-secrets/* control-plane/manifest.json > SHA256SUMS)
  local CONFIRM=RESTORE
  if grep -q -- '--accept-unsigned-v1' ./deploy/karmax; then accept=(--accept-unsigned-v1); CONFIRM='RESTORE UNSIGNED'; fi
  restore "${accept[@]}" "$BACKUP-checksummed"
}
restored=0
if step 'f. Install a fresh TO stack (deploy/karmax up)' up-fresh.log ./deploy/karmax up "$DOMAIN"; then
  if step 'f. Restore the pre-update backup (deploy/karmax restore)' restore.log restore "$BACKUP"; then
    restored=1
  elif [ ! -f "$BACKUP/SHA256SUMS" ] && grep -q 'backup is missing checksums' "$LOGS/restore.log"; then
    step '   Restore it again with operator-written checksums' restore-checksummed.log with_checksums && restored=1
  fi
fi
if [ "$restored" -eq 1 ] && step '   Point the restored stack at the E2B stand-in' e2b-restore.log use_fake_e2b; then
  step 'f. Verify every record after the restore' verify-restore.log client verify --phase restored --resume || true
  step '   doctor after the restore' doctor-restore.log doctor_role || true
  step "   The restored app's background jobs run cleanly" jobs-restore.log background_jobs || true
fi

summary
[ "$FAILED" -eq 0 ]
