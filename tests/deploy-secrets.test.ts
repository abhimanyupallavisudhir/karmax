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
