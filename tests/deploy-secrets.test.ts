import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployDir = path.join(repoRoot, 'deploy');

/**
 * Run the real `deploy/karmax up` far enough to write its secrets, with a stub
 * `docker` on PATH. The stub answers the preflight checks and then fails the
 * build step, so `set -e` stops the script the moment configuration is done —
 * no images, no containers, but the genuine code path under test.
 */
function generateSecrets(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-secrets-'));
  const sandbox = path.join(home, 'deploy');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(sandbox);
  fs.mkdirSync(bin);
  for (const file of ['karmax', 'compose.turnkey.yml']) {
    fs.copyFileSync(path.join(deployDir, file), path.join(sandbox, file));
  }
  fs.chmodSync(path.join(sandbox, 'karmax'), 0o755);
  fs.writeFileSync(
    path.join(bin, 'docker'),
    '#!/bin/sh\nfor a in "$@"; do [ "$a" = up ] && exit 1; done\nexit 0\n',
    { mode: 0o755 },
  );
  rerunUp(sandbox);
  return path.join(sandbox, '.secrets');
}

function rerunUp(sandbox: string) {
  try {
    execFileSync('sh', [path.join(sandbox, 'karmax'), 'up', 'karmax.example.com'], {
      env: { ...process.env, PATH: `${path.join(sandbox, '..', 'bin')}:${process.env.PATH ?? ''}` },
      stdio: 'ignore',
    });
  } catch {
    // Expected: the stub fails the build step once configuration has happened.
  }
}

describe('turnkey update deploys an exact validated revision', () => {
  const script = fs.readFileSync(path.join(deployDir, 'karmax'), 'utf8');
  const update = script.split('cmd_update() {')[1]?.split('\n}')[0] ?? '';

  it('fails instead of rebuilding an unknown revision when the checkout is dirty', () => {
    expect(update).toContain('status --porcelain');
    expect(update).toContain('cannot deploy an exact validated revision');
  });

  it('requires the requested commit to belong to origin/master and never pulls latest', () => {
    expect(update).toContain('merge-base --is-ancestor "$target" "$upstream"');
    expect(update).toContain('checkout --detach "$target"');
    expect(update).not.toContain('pull --ff-only');
  });

  it('skips delayed deployments instead of rolling production backwards', () => {
    expect(update).toContain('Skipping superseded deployment');
  });

  it('uses candidate backup code so an old backup bug cannot block its own fix', () => {
    expect(update).toContain('cmd_backup_candidate');
    expect(script).toContain('dc run --rm --no-deps app npm run backup');
  });

  // An update never runs `configure`, so a secret a new release mounts would be
  // missing and Compose would refuse to start it; so would a restore of an
  // older backup's secrets directory.
  it('creates any missing secret before building an update or starting a restore', () => {
    expect(update.indexOf('ensure_secrets')).toBeGreaterThan(update.indexOf('checkout --detach "$target"'));
    expect(update.indexOf('ensure_secrets')).toBeLessThan(update.indexOf('dc build --pull app'));
    const restore = script.split('cmd_restore() {')[1]?.split('\n}')[0] ?? '';
    expect(restore.indexOf('ensure_secrets')).toBeGreaterThan(restore.indexOf('mv "$staged_secrets" "$SECRETS_DIR"'));
    expect(restore.indexOf('ensure_secrets')).toBeLessThan(restore.lastIndexOf('dc up -d postgresql'));
  });

  it('backs up and restores the PostgreSQL application database', () => {
    expect(script).toContain('pg_dump -U temporal -Fc karmax');
    expect(script).toContain('for dump in karmax temporal temporal-visibility');
    expect(script).toContain('pg_restore -U temporal --no-owner --no-privileges -d "$database"');
  });

  it('applies a staged domain migration transactionally with the validated update', () => {
    expect(update).toContain('pending_domain=$(env_value KARMAX_PENDING_DOMAIN)');
    expect(update).toContain('configure "$pending_domain" "$pending_preview"');
    expect(update).toContain('restore_migration');
    expect(script).toContain('KARMAX_LEGACY_DOMAIN');
  });

  it.each(['exit 1', 'kill -TERM $$'])('restores and retains the migration backup on %s', (stop) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-migration-recovery-'));
    const envFile = path.join(dir, '.turnkey.env');
    const backup = `${envFile}.migration.test`;
    const original = 'KARMAX_DOMAIN=krmax.example.com\nPOSTGRES_PASSWORD=preserved\n';
    fs.writeFileSync(envFile, 'KARMAX_DOMAIN=tavya.example.com\n');
    fs.writeFileSync(backup, original, { mode: 0o600 });
    const recovery = update.slice(update.indexOf("migration_backup=''"), update.indexOf('pending_domain='));
    try {
      const result = spawnSync('sh', ['-c', `set -eu\nnote() { :; }\n${recovery}\nmigration_backup="$ENV_FILE.migration.test"\n${stop}`], {
        env: { ...process.env, ENV_FILE: envFile }, encoding: 'utf8',
      });
      expect(result.status).toBe(stop === 'exit 1' ? 1 : 143);
      expect(fs.readFileSync(envFile, 'utf8')).toBe(original);
      expect(fs.readFileSync(backup, 'utf8')).toBe(original);
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('turnkey restore preflight', () => {
  it('rejects a backup without checksums before stopping the running instance', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-restore-preflight-'));
    try {
      const sandbox = path.join(home, 'deploy');
      const backup = path.join(home, 'backup');
      const bin = path.join(home, 'bin');
      fs.mkdirSync(sandbox);
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(backup, 'control-plane'), { recursive: true });
      fs.mkdirSync(path.join(backup, 'deployment-secrets'));
      fs.writeFileSync(path.join(backup, 'control-plane', 'manifest.json'), '{}');
      fs.writeFileSync(path.join(backup, 'temporal.dump'), 'invalid');
      fs.writeFileSync(path.join(backup, 'temporal-visibility.dump'), 'invalid');
      fs.writeFileSync(path.join(sandbox, '.turnkey.env'), 'KARMAX_DOMAIN=example.test\n');
      fs.copyFileSync(path.join(deployDir, 'karmax'), path.join(sandbox, 'karmax'));
      fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${home}/docker.log"\nexit 0\n`, { mode: 0o755 });
      const result = spawnSync('sh', [path.join(sandbox, 'karmax'), 'restore', backup], {
        input: 'RESTORE\n', encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('checksum');
      expect(fs.readFileSync(path.join(home, 'docker.log'), 'utf8')).not.toMatch(/\bdown\b|dropdb/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('turnkey backup publication', () => {
  it('leaves no visible backup directory when a database dump fails', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-publish-'));
    try {
      const sandbox = path.join(home, 'deploy');
      const bin = path.join(home, 'bin');
      const backup = path.join(home, 'manual-backup');
      fs.mkdirSync(sandbox);
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(sandbox, '.turnkey.env'), 'KARMAX_DOMAIN=example.test\n');
      fs.copyFileSync(path.join(deployDir, 'karmax'), path.join(sandbox, 'karmax'));
      fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\ncase "$*" in *"pg_dump -U temporal -Fc temporal") exit 7;; esac\nexit 0\n`, { mode: 0o755 });
      const result = spawnSync('sh', [path.join(sandbox, 'karmax'), 'backup', backup], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(backup)).toBe(false);
      expect(fs.readdirSync(home).some(name => name.startsWith('manual-backup.partial'))).toBe(false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('turnkey deployment secrets', () => {
  const secretsDir = generateSecrets();
  const secrets = ['auth_secret', 'vault_key', 'world_ref_key'];

  // An update runs the installed release's script, which cannot generate a
  // host secret a newer release adds; Compose would refuse to mount it. So
  // new credentials come from a job instead (postgres/karmax-role.sh).
  it('generates every secret the compose profile mounts, and mounts no new one', () => {
    const compose = fs.readFileSync(path.join(deployDir, 'compose.turnkey.yml'), 'utf8');
    const mounted = Object.keys(parse(compose).secrets as Record<string, unknown>);
    expect(mounted.sort()).toEqual([...secrets].sort());
    for (const name of secrets) {
      expect(fs.existsSync(path.join(secretsDir, name)), `${name} was not generated`).toBe(true);
    }
  });

  // The app container runs as its own uid and compose bind-mounts these files
  // with host ownership intact, so a 0600 secret makes the container die on
  // boot with EACCES on /run/secrets/auth_secret — which is exactly what a
  // fresh `./deploy/karmax up` used to do.
  it('leaves secrets readable by the unprivileged uid the app container runs as', () => {
    for (const name of secrets) {
      const mode = fs.statSync(path.join(secretsDir, name)).mode & 0o777;
      expect(mode & 0o004, `${name} is mode ${mode.toString(8)}; the container uid cannot read it`).toBe(0o004);
    }
  });

  // Widening the files is only safe because nothing else can traverse into the
  // directory holding them.
  it('keeps the directory itself private to the operator', () => {
    expect(fs.statSync(secretsDir).mode & 0o077).toBe(0);
  });

  it('runs the app container as a non-root user, which is why the mode matters', () => {
    const dockerfile = fs.readFileSync(path.join(deployDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^USER\s+(?!root)\S+/m);
  });

  it('keeps application code root-owned after switching to the runtime user', () => {
    const dockerfile = fs.readFileSync(path.join(deployDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).not.toContain('--chown=karmax:karmax');
    expect(dockerfile).not.toMatch(/chown[^\n]*\/app/);
    expect(dockerfile).toContain('USER karmax');
  });
});

it('keeps migration copies and backup data out of Git and Docker build contexts', () => {
  const migration = 'deploy/.turnkey.env.migration.1234';
  const ignored = execFileSync('git', ['check-ignore', migration, 'deploy/backups/snapshot/key'], {
    cwd: repoRoot, encoding: 'utf8',
  });
  expect(ignored).toContain(migration);
  expect(ignored).toContain('deploy/backups/snapshot/key');
  const dockerignore = fs.readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8');
  expect(dockerignore).toContain('deploy/.turnkey.env*');
  expect(dockerignore).toContain('deploy/backups');
});

describe('hosted credential connector runtime', () => {
  const dockerfile = fs.readFileSync(path.join(deployDir, 'Dockerfile'), 'utf8');

  it('installs GnuPG so Git-backed unix pass entries can be decrypted', () => {
    const runtime = dockerfile.split('FROM node:22-bookworm-slim').at(-1) ?? '';
    expect(runtime).toMatch(/apt-get install[^\n]*\bgnupg\b/);
    expect(runtime).toMatch(/apt-get install[^\n]*\bage\b/);
  });
});
