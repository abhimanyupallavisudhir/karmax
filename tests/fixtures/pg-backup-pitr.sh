#!/bin/bash
# Point-in-time restore through karmax-pg-backup (deploy/postgres/pg-backup.sh),
# end to end: a cluster archiving every WAL segment with the real script, a base
# backup, two transactions either side of a recovery target, and a restore into
# an empty data directory that must hold the first and not the second.
#
# The bucket is a file:// prefix, so only the transport differs from R2. Runs on
# a host with PostgreSQL's server binaries, WAL-G and jq on PATH
# (tests/pg-backup.test.ts), and inside the PostgreSQL image in CI. Needs
# KEYS=<dir> holding pg_backup_public_key and private.asc (OpenPGP, armored),
# and other.asc, an unrelated private key.
set -euo pipefail
script=${KARMAX_PG_BACKUP_SCRIPT:-/usr/local/bin/karmax-pg-backup}
: "${KEYS:?KEYS must name a directory with pg_backup_public_key and private.asc}"
work=$(mktemp -d)
stop() { [ ! -f "$1/postmaster.pid" ] || pg_ctl -D "$1" -m immediate stop >/dev/null 2>&1 || true; }
trap 'stop "$work/data"; stop "$work/restore"; rm -rf "$work"' EXIT
mkdir -m 700 "$work/secrets" "$work/sock" "$work/bucket"
cp "$KEYS/pg_backup_public_key" "$work/secrets/"
# PITR_PREFIX/PITR_ENDPOINT run the same drill against a real bucket, with its
# key in $KEYS/pg_backup_access_key_id and pg_backup_secret_access_key.
if [ -n "${PITR_PREFIX:-}" ]; then
  cp "$KEYS/pg_backup_access_key_id" "$KEYS/pg_backup_secret_access_key" "$work/secrets/"
  export KARMAX_PG_BACKUP_ENDPOINT=${PITR_ENDPOINT:?PITR_ENDPOINT is required with PITR_PREFIX}
fi
export KARMAX_PG_BACKUP_SECRETS=$work/secrets KARMAX_PG_BACKUP_PREFIX=${PITR_PREFIX:-"file://$work/bucket"}
export PGDATA=$work/data PGHOST=$work/sock PGUSER=karmax_admin PGPORT=55432
step() { echo "== $*"; }

step 'archive_command reports success when backups are off'
( unset KARMAX_PG_BACKUP_PREFIX; "$script" wal-push /nonexistent )
status=0; ( unset KARMAX_PG_BACKUP_PREFIX; "$script" status ) || status=$?
[ "$status" = 1 ]

step 'a cluster that archives through the script'
initdb -A trust -U "$PGUSER" -D "$PGDATA" >/dev/null
cat >> "$PGDATA/postgresql.auto.conf" <<EOF
wal_level = replica
archive_mode = on
archive_command = '$script wal-push %p'
archive_timeout = 60
listen_addresses = ''
unix_socket_directories = '$PGHOST'
EOF
pg_ctl -D "$PGDATA" -w -l "$work/server.log" start >/dev/null
psql -XqA -d postgres -c 'CREATE DATABASE karmax'
psql -XqA -d karmax -c 'CREATE TABLE tasks (id TEXT PRIMARY KEY); CREATE TABLE events (seq SERIAL, ts BIGINT NOT NULL, payload TEXT)'

step 'status fails until a base backup exists'
status=0; "$script" status || status=$?
[ "$status" = 2 ]

step 'a base backup'
"$script" backup

archived() {
  local wal; wal=$(psql -XAt -d postgres -c 'SELECT pg_walfile_name(pg_switch_wal())')
  for _ in $(seq 1 150); do
    [ "$(psql -XAt -d postgres -c "SELECT last_archived_wal >= '$wal' FROM pg_stat_archiver")" = t ] && return 0
    sleep 0.2
  done
  echo "segment $wal was not archived" >&2; cat "$work/server.log" >&2; return 1
}
step 'a transaction before the target and one after it'
psql -XqA -d karmax -c "INSERT INTO tasks VALUES ('kept'); INSERT INTO events (ts, payload) VALUES (1000, 'before')"
archived
target=$(psql -XAt -d postgres -c "SELECT now()")
sleep 1.2
psql -XqA -d karmax -c "INSERT INTO tasks VALUES ('lost'); INSERT INTO events (ts, payload) VALUES (2000, 'after')"
archived

step 'status reports archiving and the base backup as current'
"$script" status

step "restore to $target"
mkdir -m 700 "$work/restore"
out=$(PGDATA=$work/restore KARMAX_PG_BACKUP_PRIVATE_KEY=$KEYS/private.asc "$script" restore --to "$target")
echo "$out"
grep -q 'karmax: 1 tasks' <<< "$out"

step 'the restored cluster holds what preceded the target and nothing after it'
cat >> "$work/restore/postgresql.auto.conf" <<EOF
unix_socket_directories = '$work/sock'
port = 55433
EOF
pg_ctl -D "$work/restore" -w -l "$work/restored.log" start >/dev/null
[ "$(psql -XAt -p 55433 -d karmax -c "SELECT string_agg(id, ',' ORDER BY id) FROM tasks")" = kept ]
[ "$(psql -XAt -p 55433 -d karmax -c "SELECT string_agg(payload, ',') FROM events")" = before ]
[ "$(psql -XAt -p 55433 -d postgres -c 'SHOW archive_mode')" = off ]

step 'the backup is unreadable without the private key'
fail() { echo "FAILED: $*" >&2; exit 1; }
if grep -rqa -e "'before'" -e 'kept' "$work/bucket"; then fail 'the bucket holds plaintext'; fi
mkdir -m 700 "$work/nokey" "$work/other"
if PGDATA=$work/nokey KARMAX_PG_BACKUP_PRIVATE_KEY=$KEYS/pg_backup_public_key "$script" restore 2>"$work/nokey.err"; then
  fail 'restored with a public key'
fi
grep -q 'not an armored OpenPGP private key' "$work/nokey.err" || fail "unexpected refusal: $(cat "$work/nokey.err")"
# Another private key cannot decrypt it either, and says so rather than hanging.
status=0
PGDATA=$work/other KARMAX_PG_BACKUP_PRIVATE_KEY=$KEYS/other.asc timeout 120 "$script" restore >"$work/other.log" 2>&1 || status=$?
[ "$status" != 0 ] || fail 'restored with the wrong private key'
[ "$status" != 124 ] || fail 'a restore with the wrong private key hung'

echo 'PITR OK'
