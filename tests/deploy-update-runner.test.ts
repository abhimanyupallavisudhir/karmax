import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('keeps an update running after its SSH-like launcher exits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-detached-update-'));
  try {
    const deploy = path.join(root, 'deploy');
    fs.mkdirSync(deploy);
    const runner = path.join(deploy, 'update-runner.sh');
    fs.copyFileSync(new URL('../deploy/update-runner.sh', import.meta.url), runner);
    const updater = path.join(root, 'updater');
    fs.writeFileSync(updater, '#!/bin/sh\nsleep 1\nprintf done > "$(dirname "$0")/../done"\n', { mode: 0o755 });
    const sha = 'a'.repeat(40);
    const launched = spawnSync('sh', [runner, 'start', sha, 'test-1', updater], { encoding: 'utf8' });
    expect(launched.status, launched.stderr).toBe(0);
    const statusFile = path.join(deploy, '.updates/test-1/status');
    let status = '';
    for (let i = 0; i < 40; i++) {
      status = fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf8').trim() : '';
      if (status === 'success' || status.startsWith('failed:')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(status).toBe('success');
    expect(fs.readFileSync(path.join(deploy, '.updates/done'), 'utf8')).toBe('done');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('hands the updater the release image named by digest, and refuses anything else', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-detached-image-'));
  try {
    const deploy = path.join(root, 'deploy');
    fs.mkdirSync(deploy);
    const runner = path.join(deploy, 'update-runner.sh');
    fs.copyFileSync(new URL('../deploy/update-runner.sh', import.meta.url), runner);
    const updater = path.join(root, 'updater');
    fs.writeFileSync(updater, '#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/../args"\n', { mode: 0o755 });
    const sha = 'b'.repeat(40);
    const image = `ghcr.io/owner/karmax-app@sha256:${'c'.repeat(64)}`;
    for (const bad of ['ghcr.io/owner/karmax-app:latest', `${image}; rm -rf /`, `--image=${image}`]) {
      const refused = spawnSync('sh', [runner, 'start', sha, 'refused', updater, bad], { encoding: 'utf8' });
      expect(refused.status).toBe(2);
      expect(fs.existsSync(path.join(deploy, '.updates/refused'))).toBe(false);
    }
    const launched = spawnSync('sh', [runner, 'start', sha, 'image-1', updater, image], { encoding: 'utf8' });
    expect(launched.status, launched.stderr).toBe(0);
    const statusFile = path.join(deploy, '.updates/image-1/status');
    let status = '';
    for (let i = 0; i < 40 && !(status === 'success' || status.startsWith('failed:')); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      status = fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf8').trim() : '';
    }
    expect(status).toBe('success');
    expect(fs.readFileSync(path.join(deploy, '.updates/args'), 'utf8').trim().split('\n'))
      .toEqual(['update', sha, '--image', image]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
