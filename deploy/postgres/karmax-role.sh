#!/bin/sh
# Applies karmax-role.sql as the superuser (PGHOST/PGUSER/PGPASSWORD) on every
# turnkey start, after Temporal's schema job has created the karmax database.
# The app's password comes from the URL deploy/karmax generated for it.
set -eu

url=$(cat "${KARMAX_DATABASE_URL_FILE:-/run/secrets/database_url}")
password=$(printf '%s\n' "$url" | sed -n 's|^postgres://karmax:\([0-9a-f]\{64\}\)@postgresql:5432/karmax$|\1|p')
[ -n "$password" ] || {
  echo 'database_url must be the postgres://karmax:<64 hex>@postgresql:5432/karmax that deploy/karmax generates' >&2
  exit 1
}
PGOPTIONS="-c karmax.app_role=karmax -c karmax.app_password=$password -c karmax.private_databases=temporal,temporal_visibility" \
  psql -v ON_ERROR_STOP=1 -d karmax -f "$(dirname "$0")/karmax-role.sql"
echo 'The karmax database belongs to the karmax role.'
