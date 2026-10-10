#!/bin/bash
# Continuous off-host PostgreSQL backups with WAL-G (wiki ops/production-tavya,
# ops/privacy-and-recovery-runbook). Installed in the PostgreSQL image as
# /usr/local/bin/karmax-pg-backup:
#
#   wal-push PATH         archive_command: ship one WAL segment off-host
#   wal-fetch NAME PATH   restore_command during a point-in-time restore
#   run                   the pg-backup service: a base backup every interval
#   backup                one base backup now
#   status                is archiving current, and how old is the newest base backup
#   restore [--to TIME]   restore into an empty PGDATA, replay WAL to TIME (default:
#                         everything archived), promote, and report what it holds
#
# Configuration comes from the environment and /run/secrets, read on every call
# so archive_command needs no restart when it changes. With no
# KARMAX_PG_BACKUP_PREFIX it is off: WAL is recycled as before and `run` idles.
# The bucket's lock and lifecycle rules own retention, so nothing here deletes.
set -euo pipefail

SELF=$(readlink -f "$0")
SECRETS=${KARMAX_PG_BACKUP_SECRETS:-/run/secrets}
PGDATA=${PGDATA:-/var/lib/postgresql/data}

die() { echo "karmax-pg-backup: $*" >&2; exit 1; }
secret() { [ -r "$SECRETS/$1" ] && tr -d '\r\n' < "$SECRETS/$1" || true; }
configured() { [ -n "${KARMAX_PG_BACKUP_PREFIX:-}" ]; }

# WAL-G reads its settings from the environment. Encryption is OpenPGP: the host
# holds only the public key, so it can write backups but not read them; the
# private key that restores them is kept off-host and given to `restore` alone.
walg_env() {
  configured || die 'off-host backups are not configured (KARMAX_PG_BACKUP_PREFIX is empty)'
  export WALG_S3_PREFIX="$KARMAX_PG_BACKUP_PREFIX"
  case "$WALG_S3_PREFIX" in
    s3://*) ;;
    file://*) export WALG_FILE_PREFIX=${WALG_S3_PREFIX#file://}; unset WALG_S3_PREFIX ;;
    *) die "KARMAX_PG_BACKUP_PREFIX must be s3://bucket/path (or file:///path for tests)" ;;
  esac
  if [ -n "${WALG_S3_PREFIX:-}" ]; then
    export AWS_ENDPOINT=${KARMAX_PG_BACKUP_ENDPOINT:?KARMAX_PG_BACKUP_ENDPOINT is required for an s3:// prefix}
    export AWS_REGION=${KARMAX_PG_BACKUP_REGION:-auto} AWS_S3_FORCE_PATH_STYLE=true
    AWS_ACCESS_KEY_ID=$(secret pg_backup_access_key_id); AWS_SECRET_ACCESS_KEY=$(secret pg_backup_secret_access_key)
    [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] || die "the backup bucket's keys are missing from $SECRETS"
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  fi
  local key=${KARMAX_PG_BACKUP_PRIVATE_KEY:-$SECRETS/pg_backup_public_key}
  [ -s "$key" ] || die "the backup encryption key is missing ($key)"
  export WALG_PGP_KEY_PATH=$key
  export WALG_COMPRESSION_METHOD=zstd WALG_PREVENT_WAL_OVERWRITE=true
  export WALG_UPLOAD_CONCURRENCY=${WALG_UPLOAD_CONCURRENCY:-4} WALG_UPLOAD_DISK_CONCURRENCY=1
  export PGHOST=${PGHOST:-/var/run/postgresql} PGUSER=${PGUSER:-${POSTGRES_USER:-postgres}} PGDATABASE=postgres
}

cmd_wal_push() {
  [ $# -eq 1 ] || die 'usage: wal-push PATH'
  # Off: report success, so PostgreSQL recycles the segment as it did before.
  configured || exit 0
  walg_env
  exec wal-g wal-push "$1"
}

cmd_wal_fetch() {
  [ $# -eq 2 ] || die 'usage: wal-fetch NAME PATH'
  walg_env
  exec wal-g wal-fetch "$1" "$2"
}

# R2's bucket lock answers a write to an existing key with 409, which WAL-G
# retries without end; a base backup can therefore never run unbounded.
backup_push() { timeout "${KARMAX_PG_BACKUP_TIMEOUT_HOURS:-6}h" wal-g backup-push "$PGDATA"; }

cmd_backup() {
  walg_env
  backup_push
}

# Newest base backup's finish time in Unix seconds, or nothing.
latest_backup_epoch() {
  wal-g backup-list --json 2>/dev/null | jq -r '[.[] | (.finish_time // .time)] | map(sub("\\.[0-9]+"; "") | fromdateiso8601) | max // empty'
}

cmd_run() {
  if ! configured; then
    echo 'karmax-pg-backup: off-host backups are not configured; idling'
    exec sleep infinity
  fi
  walg_env
  local hours=${KARMAX_PG_BACKUP_INTERVAL_HOURS:-24}
  case "$hours" in ''|*[!0-9]*|0) die 'KARMAX_PG_BACKUP_INTERVAL_HOURS must be a positive whole number' ;; esac
  local interval=$((hours * 3600)) retry=900
  until pg_isready -q; do sleep 5; done
  while :; do
    local latest due now
    latest=$(latest_backup_epoch || true)
    now=$(date +%s)
    due=$(( ${latest:-0} + interval ))
    if [ "$now" -ge "$due" ]; then
      echo "karmax-pg-backup: base backup starting at $(date -u +%FT%TZ)"
      if backup_push; then
        echo "karmax-pg-backup: base backup finished at $(date -u +%FT%TZ)"
        continue
      fi
      echo "karmax-pg-backup: base backup failed; retrying in $((retry / 60)) minutes" >&2
      sleep "$retry"
      continue
    fi
    sleep $(( due - now < retry ? due - now : retry ))
  done
}

# Exit 0 when current, 1 when not configured, 2 when stale or failing.
# WAL older than KARMAX_PG_BACKUP_MAX_LAG_MINUTES that is still waiting to be
# archived is data a lost host would lose.
cmd_status() {
  configured || { echo 'Off-host PostgreSQL backups are not configured.'; exit 1; }
  walg_env
  local lag_limit=$(( ${KARMAX_PG_BACKUP_MAX_LAG_MINUTES:-10} * 60 ))
  local base_limit=$(( (${KARMAX_PG_BACKUP_INTERVAL_HOURS:-24} + 6) * 3600 ))
  local archiver pending oldest last_ok last_fail failed_wal
  archiver=$(psql -XAtF '|' -v ON_ERROR_STOP=1 -c "SELECT
      (SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'),
      coalesce((SELECT floor(extract(epoch FROM now() - min(modification))) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'), 0),
      coalesce(floor(extract(epoch FROM last_archived_time)), 0), coalesce(floor(extract(epoch FROM last_failed_time)), 0),
      coalesce(last_failed_wal, '')
    FROM pg_stat_archiver") || { echo 'PostgreSQL did not answer the archiver query.'; exit 2; }
  IFS='|' read -r pending oldest last_ok last_fail failed_wal <<< "$archiver"
  local now status=0 latest
  now=$(date +%s)
  if [ "$oldest" -gt "$lag_limit" ]; then
    echo "WAL is not reaching the bucket: $pending segment(s) waiting, the oldest for $((oldest / 60)) minutes." >&2
    [ "$last_fail" -le "$last_ok" ] || echo "Last failure: $failed_wal at $(date -u -d "@$last_fail" +%FT%TZ)." >&2
    status=2
  else
    echo "WAL archiving is current: $pending segment(s) waiting$( [ "$last_ok" -gt 0 ] \
      && echo "; the last one archived $(( (now - last_ok) / 60 )) minutes ago" || echo '; nothing archived yet')."
  fi
  latest=$(latest_backup_epoch || true)
  if [ -z "$latest" ]; then
    echo 'There is no base backup in the bucket yet.' >&2; status=2
  elif [ $((now - latest)) -gt "$base_limit" ]; then
    echo "The newest base backup is $(( (now - latest) / 3600 )) hours old." >&2; status=2
  else
    echo "Newest base backup: $(date -u -d "@$latest" +%FT%TZ) ($(( (now - latest) / 3600 )) hours ago)."
  fi
  exit "$status"
}

# Point-in-time restore into this container's empty PGDATA. It never archives
# (archive_mode=off), listens on its socket only, and promotes at the target,
# so it can neither write to the bucket nor be mistaken for production.
cmd_restore() {
  local target=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) target=${2:?--to needs a time, e.g. "2026-10-08 12:00:00+00"}; shift 2 ;;
      *) die "unknown restore option: $1" ;;
    esac
  done
  [ -n "${KARMAX_PG_BACKUP_PRIVATE_KEY:-}" ] || die 'restore needs KARMAX_PG_BACKUP_PRIVATE_KEY, the off-host private key file'
  # WAL-G waits forever when handed only a public key.
  grep -q 'BEGIN PGP PRIVATE KEY BLOCK' "$KARMAX_PG_BACKUP_PRIVATE_KEY" 2>/dev/null \
    || die "$KARMAX_PG_BACKUP_PRIVATE_KEY is not an armored OpenPGP private key"
  walg_env
  [ -d "$PGDATA" ] && [ -z "$(ls -A "$PGDATA" 2>/dev/null)" ] || die "PGDATA ($PGDATA) must be an empty directory"
  # The newest base backup that finished before the target (any, for latest).
  local epoch=9999999999 backup
  [ -z "$target" ] || epoch=$(date -u -d "$target" +%s) || die "cannot read the target time: $target"
  backup=$(wal-g backup-list --json | jq -r --argjson t "$epoch" \
    '[.[] | select(((.finish_time // .time) | sub("\\.[0-9]+"; "") | fromdateiso8601) <= $t)] | max_by(.finish_time // .time) | .backup_name // empty')
  [ -n "$backup" ] || die "no base backup finished before ${target:-now}"
  # backup-fetch retries forever on a key that cannot decrypt; a small part
  # of the same backup fails at once instead.
  wal-g st cat "basebackups_005/$backup/tar_partitions/backup_label.tar.zst" --decrypt >/dev/null \
    || die "$KARMAX_PG_BACKUP_PRIVATE_KEY cannot decrypt base backup $backup: is it this installation's backup key?"
  echo "karmax-pg-backup: fetching base backup $backup"
  wal-g backup-fetch "$PGDATA" "$backup"
  chmod 700 "$PGDATA"
  {
    echo "restore_command = '$SELF wal-fetch %f %p'"
    echo "archive_mode = off"
    echo "recovery_target_action = 'promote'"
    [ -z "$target" ] || echo "recovery_target_time = '$target'"
  } >> "$PGDATA/postgresql.auto.conf"
  touch "$PGDATA/recovery.signal"
  # Its own socket and no TCP for this start only: the copy cannot collide
  # with, or be reached as, the server it came from.
  local sock; sock=$(mktemp -d)
  export PGHOST=$sock
  echo "karmax-pg-backup: replaying WAL${target:+ to $target}"
  if ! pg_ctl -D "$PGDATA" -w -t 3600 -l "$PGDATA/restore.log" -o "-c listen_addresses='' -c unix_socket_directories='$sock'" start; then
    tail -n 30 "$PGDATA/restore.log" >&2; die 'the restored server did not start'
  fi
  until [ "$(psql -XAtc 'SELECT pg_is_in_recovery()')" = f ]; do sleep 2; done
  echo "karmax-pg-backup: restored; last replayed transaction: $(psql -XAtc "SELECT coalesce(pg_last_xact_replay_timestamp()::text, 'none (no WAL after the base backup)')")"
  psql -XAtF ' ' -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE NOT datistemplate ORDER BY 1"
  if [ "$(psql -XAtc "SELECT count(*) FROM pg_database WHERE datname = 'karmax'")" = 1 ]; then
    psql -XAt -d karmax -c "SELECT 'karmax: ' || (SELECT count(*) FROM tasks) || ' tasks, newest event ' || coalesce((SELECT to_timestamp(max(ts) / 1000.0)::text FROM events), 'none')" \
      || echo 'karmax: tables not readable (an older schema?)'
  fi
  pg_ctl -D "$PGDATA" -w stop -m fast
  rmdir "$sock"
}

command=${1:-}
[ $# -eq 0 ] || shift
case "$command" in
  wal-push) cmd_wal_push "$@" ;;
  wal-fetch) cmd_wal_fetch "$@" ;;
  run) cmd_run ;;
  backup) cmd_backup ;;
  status) cmd_status ;;
  restore) cmd_restore "$@" ;;
  *) die 'usage: karmax-pg-backup wal-push|wal-fetch|run|backup|status|restore' ;;
esac
