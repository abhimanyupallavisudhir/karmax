import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
  try {
    execFileSync('sh', [path.join(sandbox, 'karmax'), 'up', 'karmax.example.com'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: 'ignore',
    });
  } catch {
    // Expected: the stub fails the build step once configuration has happened.
  }
  return path.join(sandbox, '.secrets');
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

  it('backs up and restores the PostgreSQL application database', () => {
    expect(script).toContain('pg_dump -U temporal -Fc karmax');
    expect(script).toContain('pg_restore -U temporal -d karmax');
    expect(script).toContain('for database in karmax temporal temporal_visibility');
  });

  it('applies a staged domain migration transactionally with the validated update', () => {
    expect(update).toContain('pending_domain=$(env_value KARMAX_PENDING_DOMAIN)');
    expect(update).toContain('configure "$pending_domain" "$pending_preview"');
    expect(update).toContain('restore_migration');
    expect(script).toContain('KARMAX_LEGACY_DOMAIN');
  });
});

describe('turnkey deployment secrets', () => {
  const secretsDir = generateSecrets();
  const secrets = ['auth_secret', 'vault_key', 'world_ref_key'];

  it('generates every secret the compose profile mounts', () => {
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
});

describe('hosted credential connector runtime', () => {
  const dockerfile = fs.readFileSync(path.join(deployDir, 'Dockerfile'), 'utf8');

  it('installs GnuPG so Git-backed unix pass entries can be decrypted', () => {
    const runtime = dockerfile.split('FROM node:22-bookworm-slim').at(-1) ?? '';
    expect(runtime).toMatch(/apt-get install[^\n]*\bgnupg\b/);
  });
});
