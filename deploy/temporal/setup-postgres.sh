#!/bin/sh
# Derived from temporalio/samples-server's PostgreSQL setup job. Creation and
# base setup are idempotent at the job boundary; update-schema is fail-closed.
set -eu

: "${POSTGRES_SEEDS:?POSTGRES_SEEDS is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${SQL_PASSWORD:?SQL_PASSWORD is required}"

port=${DB_PORT:-5432}
echo 'Waiting for PostgreSQL...'
nc -z -w 10 "$POSTGRES_SEEDS" "$port"

# These commands return non-zero when the database/base schema already exists,
# including after a restore. The update operations below then validate the
# database and apply every missing version; connection/auth/schema failures do
# not get swallowed.
temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "$port" --db temporal create || true
temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "$port" --db temporal setup-schema -v 0.0 || true
temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "$port" --db temporal_visibility create || true
temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "$port" --db temporal_visibility setup-schema -v 0.0 || true

temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "$port" --db temporal \
  update-schema -d /etc/temporal/schema/postgresql/v12/temporal/versioned
temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "$port" --db temporal_visibility \
  update-schema -d /etc/temporal/schema/postgresql/v12/visibility/versioned
echo 'Temporal PostgreSQL schemas are ready.'
