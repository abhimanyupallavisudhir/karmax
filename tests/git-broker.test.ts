import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeProvider } from '../src/world/worktree.js';
import { brokerFinalizeMerge, brokerImportTaskBranch, brokerPublishBranch, brokerRefreshUpstream } from '../src/world/git-broker.js';
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

    // An open review terminal can inspect another revision without changing the
    // task branch. Publishing must still transfer the named task ref, not HEAD.
    await gitOrThrow(world.handle.root, ['switch', '--detach', '-q', 'main']);
    expect(await brokerPublishBranch(world, env)).toEqual({ pushed: ['source'], skipped: [] });
    const collaborator = await provider.create({ taskId: 'collaborator', repo: source, base: 'main' });
    collaborator.handle.repo = sshRemote;
    collaborator.handle.repos![0]!.repo = sshRemote;
    const imported = await brokerImportTaskBranch(collaborator, world.handle, 'cloud-task', env);
    expect(imported).toEqual([expect.objectContaining({ repo: 'source', branch: 'karmax/cloud-task',
      ref: 'refs/karmax/tasks/cloud-task/source' })]);
    expect((await git(collaborator.handle.root, ['show', `${imported[0]!.ref}:feature.txt`])).stdout)
      .toContain('landed through broker');

    const result = await brokerFinalizeMerge(world, 'main', { name: 'Karmax Test', email: 'karmax@example.com' }, env);
    expect(result.merged).toBe(true);
    expect(result.landedFiles).toContain('feature.txt');

    const verify = path.join(root, 'verify');
    await gitOrThrow(root, ['clone', '-q', remote, verify]);
    expect(fs.readFileSync(path.join(verify, 'feature.txt'), 'utf8')).toContain('landed through broker');
    const branch = await git(remote, ['show-ref', '--verify', 'refs/heads/karmax/cloud-task']);
    expect(branch.code).toBe(0);
    const refreshed = await brokerRefreshUpstream(collaborator, env, 'main');
    expect(refreshed[0]).toMatchObject({ branch: 'main', ref: 'refs/remotes/origin/main', sha: result.sha });
  });

  it('lands in the authoritative local checkout (not origin) when the world was provisioned from a local path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-broker-local-'));
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
    const world = await provider.create({ taskId: 'cloud-local-task', repo: source, base: 'main' });
    const baseSha = (await git(source, ['rev-parse', 'main'])).stdout.trim();
    await world.writeFile('feature.txt', 'landed in the local checkout\n');
    await gitOrThrow(world.handle.root, ['add', '-A']);
    await gitOrThrow(world.handle.root, ['commit', '-q', '-m', 'feature']);
    // A real sandbox's branch exists only remotely; this stand-in world shares
    // the source repo's refs, so detach its HEAD to release the branch ref.
    await gitOrThrow(world.handle.root, ['switch', '--detach', '-q']);

    // The sandbox sees only the SSH remote; `localPath` marks the host checkout
    // as the authoritative repository. Meanwhile the local checkout advances
    // past origin — exactly the state concurrent worktree-world merges create.
    const sshRemote = 'git@example:remote.git';
    world.handle.repo = sshRemote;
    Object.assign(world.handle.repos![0]!, { repo: sshRemote, localPath: source, baseSha });
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'git@example:',
    };
    fs.writeFileSync(path.join(source, 'local-work.txt'), 'landed by a worktree world\n');
    await gitOrThrow(source, ['add', '-A']);
    await gitOrThrow(source, ['commit', '-q', '-m', 'local work origin never saw']);
    const originMainBefore = (await git(remote, ['rev-parse', 'main'])).stdout.trim();

    // Publish persists the branch in the local checkout without touching origin.
    expect(await brokerPublishBranch(world, env)).toEqual({ pushed: ['source'], skipped: [] });
    expect((await git(source, ['rev-parse', '--verify', 'refs/heads/karmax/cloud-local-task'])).code).toBe(0);
    expect((await git(remote, ['show-ref', 'refs/heads/karmax/cloud-local-task'])).code).not.toBe(0);

    // refresh_upstream serves the LOCAL target state, so the merge agent can
    // resolve conflicts against the same history the merge will land on.
    const refreshed = await brokerRefreshUpstream(world, env, 'main');
    expect(refreshed[0]!.sha).toBe((await git(source, ['rev-parse', 'main'])).stdout.trim());

    const result = await brokerFinalizeMerge(world, 'main', { name: 'Karmax Test', email: 'karmax@example.com' }, env);
    expect(result.merged).toBe(true);
    expect(result.landedFiles).toContain('feature.txt');
    // The merge landed in the local checkout, on top of its local-only history…
    expect(fs.readFileSync(path.join(source, 'feature.txt'), 'utf8')).toContain('landed in the local checkout');
    expect(fs.readFileSync(path.join(source, 'local-work.txt'), 'utf8')).toContain('worktree world');
    expect((await git(source, ['rev-parse', 'main'])).stdout.trim()).toBe(result.sha);
    // …and origin's target never moved: pushes belong to the remote policy.
    expect((await git(remote, ['rev-parse', 'main'])).stdout.trim()).toBe(originMainBefore);

    // A collaborator world imports the task branch from the local checkout too.
    const collaborator = await provider.create({ taskId: 'local-collab', repo: source, base: 'main' });
    Object.assign(collaborator.handle.repos![0]!, { repo: sshRemote, localPath: source });
    const imported = await brokerImportTaskBranch(collaborator, world.handle, 'cloud-local-task', env);
    expect((await git(collaborator.handle.root, ['show', `${imported[0]!.ref}:feature.txt`])).stdout)
      .toContain('landed in the local checkout');
  });
});
