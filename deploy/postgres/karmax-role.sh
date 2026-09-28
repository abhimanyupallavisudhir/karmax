#!/bin/sh
# Applies karmax-role.sql as the superuser (PGHOST/PGUSER/PGPASSWORD) on every
# turnkey start, after Temporal's schema job has created the karmax database.
#
# The app's URL lives in the karmax_database volume, which only this job and
# the app mount. It is generated here the first time rather than by
# deploy/karmax: an update runs the installed release's deploy/karmax, which
# knows nothing of a host file this release adds, and Compose refuses to mount
# a missing one. Nothing needs to back it up: every start sets the role's
# password from it, so a lost volume only means a new password.
set -eu

file=${KARMAX_DATABASE_URL_FILE:-/run/karmax-database/database_url}
if [ ! -s "$file" ]; then
  password=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'postgres://karmax:%s@postgresql:5432/karmax\n' "$password" > "$file.new"
  # The app runs as its own uid; the volume is reachable only by root and
  # the two containers that mount it.
  chmod 644 "$file.new"
  mv "$file.new" "$file"
fi
url=$(cat "$file")
password=$(printf '%s\n' "$url" | sed -n 's|^postgres://karmax:\([0-9a-f]\{64\}\)@postgresql:5432/karmax$|\1|p')
[ -n "$password" ] || {
  echo "$file must hold the postgres://karmax:<64 hex>@postgresql:5432/karmax this job generates; delete it to generate a new one" >&2
  exit 1
}
PGOPTIONS="-c karmax.app_role=karmax -c karmax.app_password=$password -c karmax.private_databases=temporal,temporal_visibility" \
  psql -v ON_ERROR_STOP=1 -d karmax -f "$(dirname "$0")/karmax-role.sql"
echo 'The karmax database belongs to the karmax role.'
