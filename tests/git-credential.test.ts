import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { materializeGitCredential } from '../src/world/git-credential.js';

describe('short-lived GitHub Git credentials', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  // WD-22: Git asks configured credential helpers BEFORE askpass, so an
  // operator-level `credential.helper` (store, osxkeychain, …) answered a
  // tenant operation with the operator's own credential — and `store` would
  // have saved the tenant's token into the operator's ~/.git-credentials.
  it('uses the materialized credential even when the operator configured a credential helper', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-git-token-'));
    dirs.push(dir);
    const helper = path.join(dir, 'operator-helper');
    fs.writeFileSync(helper, '#!/bin/sh\n[ "$1" = get ] && printf "username=operator\\npassword=operator-secret\\n"\nexit 0\n', { mode: 0o700 });
    const globalConfig = path.join(dir, 'operator.gitconfig');
    fs.writeFileSync(globalConfig, `[credential]\n\thelper = ${helper}\n`);
    const { env } = materializeGitCredential(dir, { httpsToken: 'installation-secret' });
    const filled = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
      env: { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_GLOBAL: globalConfig, ...env },
    });
    expect(filled).toContain('password=installation-secret');
    expect(filled).not.toContain('operator');
  });

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
