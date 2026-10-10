import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Continuous off-host PostgreSQL backups (deploy/postgres/pg-backup.sh): the
// whole point-in-time restore through WAL-G, on this host's PostgreSQL. CI also
// runs the same scenario inside the shipped PostgreSQL image (deploy artifacts).
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const onPath = (name: string) => (process.env.PATH ?? '').split(':').map((dir) => path.join(dir, name))
  .find((file) => fs.existsSync(file));
const serverBin = [...(onPath('initdb') ? [path.dirname(onPath('initdb')!)] : []),
  ...(fs.existsSync('/usr/lib/postgresql') ? fs.readdirSync('/usr/lib/postgresql').sort().reverse()
    .map((version) => `/usr/lib/postgresql/${version}/bin`) : [])].find((dir) => fs.existsSync(path.join(dir, 'pg_ctl')));
const walg = process.env.KARMAX_TEST_WALG ?? onPath('wal-g');
const ready = !!serverBin && !!walg && !!onPath('gpg') && !!onPath('jq');

describe.skipIf(!ready)('off-host PostgreSQL backups (WAL-G)', () => {
  it('restores to a point in time between two transactions, and only with the backup\'s private key', () => {
    const keys = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-pg-backup-keys-'));
    try {
      const generated = spawnSync('bash', [path.join(repoRoot, 'tests/fixtures/pg-backup-keys.sh'), keys], { encoding: 'utf8' });
      expect(generated.status, generated.stderr).toBe(0);
      const result = spawnSync('bash', [path.join(repoRoot, 'tests/fixtures/pg-backup-pitr.sh')], {
        encoding: 'utf8', timeout: 240_000,
        env: { ...process.env, KEYS: keys, KARMAX_PG_BACKUP_SCRIPT: path.join(repoRoot, 'deploy/postgres/pg-backup.sh'),
          PATH: `${serverBin}:${path.dirname(walg!)}:${process.env.PATH ?? ''}` },
      });
      expect(result.stdout.trim().split('\n').at(-1), `${result.stdout}\n${result.stderr}`).toBe('PITR OK');
    } finally { fs.rmSync(keys, { recursive: true, force: true }); }
  }, 300_000);
});
