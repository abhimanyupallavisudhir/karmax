#!/bin/bash
# Throwaway OpenPGP keys for tests/fixtures/pg-backup-pitr.sh: the backup key
# (pg_backup_public_key, private.asc) and an unrelated one (other.asc).
set -euo pipefail
dir=${1:?usage: pg-backup-keys.sh DIR}
mkdir -p "$dir"
for name in backup other; do
  export GNUPGHOME; GNUPGHOME=$(mktemp -d)
  gpg --batch --quiet --pinentry-mode loopback --passphrase '' \
    --quick-gen-key "karmax $name test <$name@test.invalid>" rsa3072 encrypt never 2>/dev/null
  if [ "$name" = backup ]; then
    gpg --armor --export > "$dir/pg_backup_public_key"
    gpg --armor --pinentry-mode loopback --passphrase '' --export-secret-keys > "$dir/private.asc"
  else
    gpg --armor --pinentry-mode loopback --passphrase '' --export-secret-keys > "$dir/other.asc"
  fi
  rm -rf "$GNUPGHOME"
done
# Throwaway keys, read by the container's postgres user in CI.
chmod 755 "$dir"; chmod 644 "$dir"/*
