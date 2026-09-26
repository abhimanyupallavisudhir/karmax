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
