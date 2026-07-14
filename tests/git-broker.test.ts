import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeProvider } from '../src/world/worktree.js';
import { brokerFinalizeMerge, brokerPublishBranch } from '../src/world/git-broker.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';

describe('cloud Git broker', () => {
  const cleanups: string[] = [];
  afterEach(() => { for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  it('transfers a cloud branch by bundle and lands it without exposing the SSH credential to the world', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-broker-test-'));
    cleanups.push(root);
    const source = path.join(root, 'source');
    const remote = path.join(root, 'remote.git');
    const worlds = path.join(root, 'worlds');
    fs.mkdirSync(source);
    await gitOrThrow(source, ['init', '-q', '-b', 'main']);
    await ensureIdentity(source);
    fs.writeFileSync(path.join(source, 'README.md'), '# base\n');
    await gitOrThrow(source, ['add', '-A']);
    await gitOrThrow(source, ['commit', '-q', '-m', 'base']);
    await gitOrThrow(root, ['clone', '-q', '--bare', source, remote]);

    const provider = new WorktreeProvider(worlds);
    const world = await provider.create({ taskId: 'cloud-task', repo: source, base: 'main' });
    await world.writeFile('feature.txt', 'landed through broker\n');
    await gitOrThrow(world.handle.root, ['add', '-A']);
    await gitOrThrow(world.handle.root, ['commit', '-q', '-m', 'feature']);

    // Git still sees an SSH-shaped remote. Test-only url rewriting maps it to a
    // local bare repo, exercising the same trusted host clone/push path without
    // starting an SSH daemon or using credentials.
    const sshRemote = 'git@example:remote.git';
    world.handle.repo = sshRemote;
    world.handle.repos![0]!.repo = sshRemote;
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'git@example:',
    };

    expect(await brokerPublishBranch(world, env)).toEqual({ pushed: ['source'], skipped: [] });
    const result = await brokerFinalizeMerge(world, 'main', { name: 'Karmax Test', email: 'karmax@example.com' }, env);
    expect(result.merged).toBe(true);
    expect(result.landedFiles).toContain('feature.txt');

    const verify = path.join(root, 'verify');
    await gitOrThrow(root, ['clone', '-q', remote, verify]);
    expect(fs.readFileSync(path.join(verify, 'feature.txt'), 'utf8')).toContain('landed through broker');
    const branch = await git(remote, ['show-ref', '--verify', 'refs/heads/karmax/cloud-task']);
    expect(branch.code).toBe(0);
  });
});
