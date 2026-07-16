import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitOrThrow } from '../src/world/git.js';
import { cloudGitSource, sshSource } from '../src/world/cloud-source.js';

describe('cloud repository source resolution', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  it('uses a local repository origin and normalizes GitHub HTTPS to SSH', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cloud-source-')); dirs.push(repo);
    await gitOrThrow(repo, ['init', '-q']);
    await gitOrThrow(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app']);
    await expect(cloudGitSource(repo)).resolves.toEqual({ source: 'git@github.com:acme/app.git', localPath: repo });
  });

  it('accepts direct SSH and converts conventional HTTPS remotes', () => {
    expect(sshSource('git@github.com:acme/app.git')).toBe('git@github.com:acme/app.git');
    expect(sshSource('ssh://git@example.com/acme/app.git')).toBe('ssh://git@example.com/acme/app.git');
    expect(sshSource('https://gitlab.com/acme/app.git')).toBe('git@gitlab.com:acme/app.git');
    expect(sshSource('/srv/git/app.git')).toBeUndefined();
  });

  it('explains when a local repository has no network remote', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cloud-source-')); dirs.push(repo);
    await gitOrThrow(repo, ['init', '-q']);
    await expect(cloudGitSource(repo)).rejects.toThrow(/has no git remote/);
  });
});
