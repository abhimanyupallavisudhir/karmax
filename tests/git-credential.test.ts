import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { materializeGitCredential } from '../src/world/git-credential.js';

describe('short-lived GitHub Git credentials', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  it('rewrites SSH-shaped remotes to HTTPS and serves the token through askpass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-token-'));
    dirs.push(dir);
    const { env } = materializeGitCredential(dir, {
      httpsToken: 'installation-secret',
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
      },
    });

    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
      GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
      GIT_CONFIG_VALUE_2: 'ssh://git@ssh.github.com:443/',
    });
    expect(Object.values(env).join('\n')).not.toContain('installation-secret');
    expect(execFileSync(env.GIT_ASKPASS!, ['Username for github'], { encoding: 'utf8' }).trim()).toBe('x-access-token');
    expect(execFileSync(env.GIT_ASKPASS!, ['Password for github'], { encoding: 'utf8' }).trim()).toBe('installation-secret');
  });
});
