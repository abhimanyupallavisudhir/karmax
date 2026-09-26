import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorktreeProvider } from '../src/world/worktree.js';
import { brokerEnrollRepository, brokerFinalizeMerge, brokerImportTaskBranch, brokerPublishBranch, brokerPushBranches, brokerRefreshUpstream } from '../src/world/git-broker.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';

describe('cloud Git broker', () => {
  const cleanups: string[] = [];
  afterEach(() => { for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  it('locks local landing worktree administration (WD-23)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-landing-lock-')); cleanups.push(root);
    const source = path.join(root, 'source'); fs.mkdirSync(source);
    await gitOrThrow(source, ['init', '-qb', 'main']); await ensureIdentity(source);
    await gitOrThrow(source, ['commit', '--allow-empty', '-qm', 'base']);
    const sandbox = path.join(root, 'sandbox'); await gitOrThrow(root, ['clone', '-q', source, sandbox]);
    const world = await new WorktreeProvider(path.join(root, 'worlds')).create({ taskId: 'landing', repo: sandbox, base: 'main' });
    await world.writeFile('feature', 'work');
    await gitOrThrow(world.handle.root, ['add', '.']); await gitOrThrow(world.handle.root, ['commit', '-qm', 'work']);
    Object.assign(world.handle.repos![0]!, { repo: 'git@example:repo.git', localPath: source });
    world.handle.kind = 'e2b';
    const gitModule = await import('../src/world/git.js');
    const run = gitModule.git;
    const locks: boolean[] = [];
    const spy = vi.spyOn(gitModule, 'git').mockImplementation((cwd, args, opts) => {
      if (args[0] === 'worktree' && args.some(arg => arg.includes('.karmax-land-')))
        locks.push(fs.existsSync(path.join(source, '.git', 'karmax-worktree.lock')));
      return run(cwd, args, opts);
    });
    try {
      expect((await brokerFinalizeMerge(world, 'main', undefined, {})).merged).toBe(true);
      expect(locks.length).toBeGreaterThanOrEqual(2);
      expect(locks.every(Boolean)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it.each(['../escape', '/absolute', '.', '..', 'nested/name'])('rejects unsafe enrollment names before world access (WD-24): %s', async name => {
    const exec = vi.fn();
    const world = { handle: { root: '/workspace', repos: [] }, exec, writeFileBuffer: vi.fn() } as any;
    await expect(brokerEnrollRepository(world, { source: 'git@example:repo.git', name, branch: 'task', base: 'main' }, {}))
      .rejects.toThrow('checkout name');
    expect(exec).not.toHaveBeenCalled();
  });

  it('publishes independent repositories concurrently with bounded fan-out (LT-10)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-parallel-')); cleanups.push(root);
    const repos: string[] = [];
    for (let i = 0; i < 5; i++) {
      const repo = path.join(root, `repo${i}`); fs.mkdirSync(repo);
      await gitOrThrow(repo, ['init', '-qb', 'main']); await ensureIdentity(repo);
      await gitOrThrow(repo, ['commit', '--allow-empty', '-qm', 'base']); repos.push(repo);
    }
    const world = await new WorktreeProvider(path.join(root, 'worlds')).create({ taskId: 'parallel', repos, base: 'main' });
    let active = 0, peak = 0;
    const exec = world.exec.bind(world);
    world.exec = async (...args) => {
      peak = Math.max(peak, ++active);
      try { await new Promise(resolve => setTimeout(resolve, 30)); return await exec(...args); }
      finally { active--; }
    };
    const result = await brokerPublishBranch(world, {});
    expect(result.skipped).toEqual([]);
    expect(result.pushed).toEqual(world.handle.repos!.map(repo => repo.name));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    await world.destroy();
  });

  it('enrolls an attached empty private repo, publishes the parent, and bootstraps a child checkout/import without leaking credentials', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-broker-enrollment-'));
    cleanups.push(root);
    const makeSource = async (name: string) => {
      const source = path.join(root, name);
      fs.mkdirSync(source);
      await gitOrThrow(source, ['init', '-q', '-b', 'main']);
      await ensureIdentity(source);
      fs.writeFileSync(path.join(source, 'README.md'), `# ${name}\n`);
      await gitOrThrow(source, ['add', '-A']);
      await gitOrThrow(source, ['commit', '-q', '-m', 'base']);
      return source;
    };
    const [first, second] = [await makeSource('first'), await makeSource('second')];
    const empty = path.join(root, 'empty.git');
    await gitOrThrow(root, ['init', '-q', '--bare', empty]);
    const sshRemote = 'git@example:empty.git';
    const secret = 'private-installation-token-must-not-enter-world';
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'git@example:',
      KARMAX_TEST_INSTALLATION_TOKEN: secret,
    };
    const auth = vi.fn(async () => ({ env }));
    const provider = new WorktreeProvider(path.join(root, 'worlds'));
    const parent = await provider.create({ taskId: 'parent', repos: [first, second], base: 'main' });

    const enrolled = await brokerEnrollRepository(parent, {
      source: sshRemote, name: 'empty', branch: parent.handle.branch, base: 'main', target: 'main',
      identity: { name: 'Karmax Test', email: 'karmax@example.com' },
    }, auth);
    expect(enrolled).toMatchObject({ name: 'empty', branch: 'karmax/parent', base: 'main', sourceAuthority: 'origin' });
    expect((await git(empty, ['rev-parse', '--verify', 'refs/heads/main'])).code).toBe(0);
    expect((await git(enrolled.root, ['branch', '--show-current'])).stdout.trim()).toBe('karmax/parent');
    expect((await git(enrolled.root, ['config', '--get', 'remote.origin.url'])).stdout.trim()).toBe(sshRemote);
    expect(fs.readFileSync(path.join(enrolled.root, '.git', 'config'), 'utf8')).not.toContain(secret);

    fs.writeFileSync(path.join(enrolled.root, 'parent.txt'), 'parent work\n');
    await gitOrThrow(enrolled.root, ['add', '-A']);
    await gitOrThrow(enrolled.root, ['commit', '-q', '-m', 'parent work']);
    expect(await brokerPublishBranch(parent, auth)).toEqual({ pushed: ['first', 'second', 'empty'], skipped: [] });
    expect((await git(empty, ['rev-parse', '--verify', 'refs/heads/karmax/parent'])).code).toBe(0);

    const child = await provider.create({ taskId: 'child', repos: [first, second], base: 'main' });
    const childRepo = await brokerEnrollRepository(child, {
      source: sshRemote, name: 'empty', branch: child.handle.branch, base: parent.handle.branch, target: parent.handle.branch,
      identity: { name: 'Karmax Test', email: 'karmax@example.com' },
    }, auth);
    expect((await git(childRepo.root, ['show', 'HEAD:parent.txt'])).stdout).toContain('parent work');
    const imported = await brokerImportTaskBranch(child, parent.handle, 'parent', auth);
    expect(imported).toEqual(expect.arrayContaining([
      expect.objectContaining({ repo: 'empty', branch: 'karmax/parent', ref: 'refs/karmax/tasks/parent/empty' }),
    ]));
    expect((await git(childRepo.root, ['show', 'refs/karmax/tasks/parent/empty:parent.txt'])).stdout)
      .toContain('parent work');
    expect(auth).toHaveBeenCalled();
  });

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
    expect(refreshed.refs[0]).toMatchObject({ branch: 'main', ref: 'refs/remotes/origin/main', sha: result.sha });
  });

  it('publishes a live local worktree branch without SSH or a self-fetch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-broker-worktree-'));
    cleanups.push(root);
    const source = path.join(root, 'source');
    const worlds = path.join(root, 'worlds');
    fs.mkdirSync(source);
    await gitOrThrow(source, ['init', '-q', '-b', 'main']);
    await ensureIdentity(source);
    fs.writeFileSync(path.join(source, 'README.md'), '# base\n');
    await gitOrThrow(source, ['add', '-A']);
    await gitOrThrow(source, ['commit', '-q', '-m', 'base']);

    const provider = new WorktreeProvider(worlds);
    const world = await provider.create({ taskId: 'local-publish', repo: source, base: 'main' });
    await world.writeFile('feature.txt', 'still checked out\n');
    await gitOrThrow(world.handle.root, ['add', '-A']);
    await gitOrThrow(world.handle.root, ['commit', '-q', '-m', 'feature']);
    expect((await git(world.handle.root, ['branch', '--show-current'])).stdout.trim()).toBe('karmax/local-publish');

    const auth = vi.fn(async () => {
      throw new Error('local publication must not request remote credentials');
    });
    expect(await brokerPublishBranch(world, auth)).toEqual({ pushed: ['source'], skipped: [] });
    expect(auth).not.toHaveBeenCalled();
    expect((await git(source, ['rev-parse', 'refs/heads/karmax/local-publish'])).stdout.trim())
      .toBe((await git(world.handle.root, ['rev-parse', 'HEAD'])).stdout.trim());
  });

  it('publishes an origin-authoritative local worktree through the remote broker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-broker-pr-worktree-'));
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
    const world = await provider.create({ taskId: 'pr-publish', repo: source, base: 'main' });
    await world.writeFile('feature.txt', 'published to GitHub authority\n');
    await gitOrThrow(world.handle.root, ['add', '-A']);
    await gitOrThrow(world.handle.root, ['commit', '-q', '-m', 'feature']);

    const sshRemote = 'git@example:remote.git';
    Object.assign(world.handle.repos![0]!, { source: sshRemote, localPath: source, sourceAuthority: 'origin' });
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'git@example:',
    };
    expect(await brokerPublishBranch(world, env)).toEqual({ pushed: ['source'], skipped: [] });
    expect((await git(remote, ['rev-parse', 'refs/heads/karmax/pr-publish'])).stdout.trim())
      .toBe((await git(world.handle.root, ['rev-parse', 'HEAD'])).stdout.trim());
  });

  it('absorbs a remote child merge when checkpoint publication races the parent branch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-broker-child-race-'));
    cleanups.push(root);
    const source = path.join(root, 'source');
    const remote = path.join(root, 'remote.git');
    const worlds = path.join(root, 'worlds');
    const child = path.join(root, 'child');
    fs.mkdirSync(source);
    await gitOrThrow(source, ['init', '-q', '-b', 'main']);
    await ensureIdentity(source);
    fs.writeFileSync(path.join(source, 'README.md'), '# base\n');
    await gitOrThrow(source, ['add', '-A']);
    await gitOrThrow(source, ['commit', '-q', '-m', 'base']);
    await gitOrThrow(root, ['clone', '-q', '--bare', source, remote]);

    const provider = new WorktreeProvider(worlds);
    const world = await provider.create({ taskId: 'parent-race', repo: source, base: 'main' });
    await world.writeFile('parent.txt', 'parent work\n');
    await gitOrThrow(world.handle.root, ['add', '-A']);
    await gitOrThrow(world.handle.root, ['commit', '-q', '-m', 'parent work']);

    const sshRemote = 'git@example:remote.git';
    world.handle.repo = sshRemote;
    world.handle.repos![0]!.repo = sshRemote;
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'git@example:',
    };
    expect(await brokerPublishBranch(world, env)).toEqual({ pushed: ['source'], skipped: [] });
    const parentHead = (await git(world.handle.root, ['rev-parse', 'HEAD'])).stdout.trim();

    await gitOrThrow(root, ['clone', '-q', remote, child]);
    await ensureIdentity(child);
    await gitOrThrow(child, ['switch', '-q', '-c', world.handle.branch, `origin/${world.handle.branch}`]);
    await gitOrThrow(child, ['switch', '-q', '-c', 'child-change']);
    fs.writeFileSync(path.join(child, 'child.txt'), 'approved child work\n');
    await gitOrThrow(child, ['add', '-A']);
    await gitOrThrow(child, ['commit', '-q', '-m', 'child work']);
    await gitOrThrow(child, ['switch', '-q', world.handle.branch]);
    await gitOrThrow(child, ['merge', '--no-ff', '-q', '-m', 'merge child', 'child-change']);
    await gitOrThrow(child, ['push', '-q', 'origin', world.handle.branch]);
    const mergedHead = (await git(child, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(mergedHead).not.toBe(parentHead);

    expect(await brokerPublishBranch(world, env, { source: parentHead })).toEqual({ pushed: ['source'], skipped: [] });
    expect((await git(world.handle.root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(mergedHead);
    expect(fs.readFileSync(path.join(world.handle.root, 'child.txt'), 'utf8')).toBe('approved child work\n');
    expect((await git(remote, ['rev-parse', `refs/heads/${world.handle.branch}`])).stdout.trim()).toBe(mergedHead);
  });

  it('replaces a rebased task branch only when its recorded remote-head lease still matches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-broker-lease-'));
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
    const world = await provider.create({ taskId: 'lease-repair', repo: source, base: 'main' });
    await world.writeFile('feature.txt', 'first proposal\n');
    await gitOrThrow(world.handle.root, ['add', '-A']);
    await gitOrThrow(world.handle.root, ['commit', '-q', '-m', 'first proposal']);
    const firstHead = (await git(world.handle.root, ['rev-parse', 'HEAD'])).stdout.trim();

    const sshRemote = 'git@example:remote.git';
    world.handle.repo = sshRemote;
    world.handle.repos![0]!.repo = sshRemote;
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'git@example:',
    };
    const observed: Record<string, string> = {};
    const record = (repo: { name: string }, head: string) => { observed[repo.name] = head; };
    expect(await brokerPublishBranch(world, env, observed, record)).toEqual({ pushed: ['source'], skipped: [] });
    expect(observed).toEqual({ source: firstHead });

    // An unchanged published tip is verified at origin without exporting the
    // sandbox branch again. Dirty files remain the checkpoint layer's concern.
    const exec = vi.spyOn(world, 'exec');
    await world.writeFile('uncommitted.txt', 'retain me in the filesystem checkpoint');
    expect(await brokerPublishBranch(world, env, observed, record)).toEqual({ pushed: ['source'], skipped: [] });
    expect(exec.mock.calls.some(([command, args]) => command === 'git' && args?.includes('bundle'))).toBe(false);
    expect(await world.readFile('uncommitted.txt')).toContain('retain me');

    // A stale local publication record must not hide deletion at origin.
    await gitOrThrow(remote, ['update-ref', '-d', `refs/heads/${world.handle.branch}`]);
    exec.mockClear();
    expect(await brokerPublishBranch(world, env, observed, record)).toEqual({ pushed: ['source'], skipped: [] });
    expect(exec.mock.calls.some(([command, args]) => command === 'git' && args?.includes('bundle'))).toBe(true);
    expect((await git(remote, ['rev-parse', `refs/heads/${world.handle.branch}`])).stdout.trim()).toBe(firstHead);
    exec.mockRestore();

    // Model a repair rebase: replace the proposal commit instead of merging the
    // old task branch, making an ordinary push non-fast-forward by design.
    await gitOrThrow(world.handle.root, ['reset', '--hard', '-q', 'main']);
    await world.writeFile('feature.txt', 'repaired proposal\n');
    await gitOrThrow(world.handle.root, ['add', '-A']);
    await gitOrThrow(world.handle.root, ['commit', '-q', '-m', 'repaired proposal']);
    const repairedHead = (await git(world.handle.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const unleased = await brokerPushBranches(world, env);
    expect(unleased.pushed).toEqual([]);
    expect(unleased.errors?.source).toMatch(/remote task branch non-fast-forward.*Reconnect GitHub will not fix/i);
    expect((await git(remote, ['rev-parse', `refs/heads/${world.handle.branch}`])).stdout.trim()).toBe(firstHead);
    expect(await brokerPublishBranch(world, env, observed, record))
      .toEqual({ pushed: ['source'], skipped: [] });
    expect(observed).toEqual({ source: repairedHead });
    expect((await git(remote, ['rev-parse', 'refs/heads/karmax/lease-repair'])).stdout.trim()).toBe(repairedHead);

    // A stale lease cannot overwrite a newer writer.
    await gitOrThrow(world.handle.root, ['reset', '--hard', '-q', 'main']);
    await world.writeFile('feature.txt', 'another repair\n');
    await gitOrThrow(world.handle.root, ['add', '-A']);
    await gitOrThrow(world.handle.root, ['commit', '-q', '-m', 'another repair']);
    const refused = await brokerPushBranches(world, env, undefined, { source: firstHead });
    expect(refused.pushed).toEqual([]);
    expect(refused.skipped).toEqual(['source']);
    expect(refused.errors?.source).toMatch(/remote task branch non-fast-forward.*Reconnect GitHub will not fix/i);
    expect(observed).toEqual({ source: repairedHead });
    expect((await git(remote, ['rev-parse', 'refs/heads/karmax/lease-repair'])).stdout.trim()).toBe(repairedHead);
  });

  // `git fetch` and `git commit` start `git maintenance run --auto`, which
  // current Git detaches. Left running in a throwaway clone, it was still
  // writing .git/objects when the broker deleted the clone, so CI saw a
  // completed publish reported as failed with ENOTEMPTY.
  it('never starts Git maintenance in its throwaway clones', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-broker-maintenance-'));
    cleanups.push(root);
    const makeSource = async (name: string) => {
      const source = path.join(root, name);
      fs.mkdirSync(source);
      await gitOrThrow(source, ['init', '-q', '-b', 'main']);
      await ensureIdentity(source);
      fs.writeFileSync(path.join(source, 'README.md'), `# ${name}\n`);
      await gitOrThrow(source, ['add', '-A']);
      await gitOrThrow(source, ['commit', '-q', '-m', 'base']);
      return source;
    };
    // Enrollment adds a checkout beside the others, so the world needs the
    // multi-repository layout.
    const repos = [await makeSource('first'), await makeSource('second')];
    await gitOrThrow(root, ['init', '-q', '--bare', path.join(root, 'empty.git')]);
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'git@example:',
    };
    const world = await new WorktreeProvider(path.join(root, 'worlds')).create({ taskId: 'maintenance', repos, base: 'main' });
    const trace = path.join(root, 'trace2.json');
    const previous = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = trace;
    try {
      const enrolled = await brokerEnrollRepository(world, {
        source: 'git@example:empty.git', name: 'empty', branch: world.handle.branch, base: 'main', target: 'main',
        identity: { name: 'Karmax Test', email: 'karmax@example.com' },
      }, env);
      fs.writeFileSync(path.join(enrolled.root, 'work.txt'), 'work\n');
      await gitOrThrow(enrolled.root, ['add', '-A']);
      await gitOrThrow(enrolled.root, ['commit', '-q', '-m', 'work']);
      expect(await brokerPublishBranch(world, env)).toEqual({ pushed: ['first', 'second', 'empty'], skipped: [] });
    } finally {
      if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = previous;
    }
    const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const repository = new Map(events.filter((event) => event.event === 'def_repo').map((event) => [event.sid, event.worktree]));
    const maintained = events
      .filter((event) => ['start', 'child_start'].includes(event.event)
        && /(^| )(maintenance run|gc --auto)( |$)/.test(event.argv.slice(1).join(' ')))
      .map((event) => String(repository.get(event.sid)));
    // The world's own checkout keeps Git's default, which shows the trace works.
    expect(maintained.some((repo) => repo.startsWith(world.handle.root))).toBe(true);
    expect(maintained.filter((repo) => /karmax-git-(broker|enroll)-/.test(repo))).toEqual([]);
    const clones = events.filter(event => event.event === 'start' && event.argv.includes('clone')
      && event.argv.some((arg: string) => arg.includes('karmax-git-broker-')));
    expect(clones.length).toBeGreaterThan(0);
    expect(clones.every(event => event.argv.includes('--single-branch'))).toBe(true);
  });

  it('preserves the underlying error for every skipped repository', async () => {
    const world = {
      handle: {
        kind: 'e2b',
        id: 'broken-publish',
        root: '/workspace',
        branch: 'karmax/broken-publish',
        base: 'main',
        repos: [{
          name: 'app',
          repo: '/not-an-ssh-remote',
          root: '/workspace',
          branch: 'karmax/broken-publish',
          base: 'main',
        }],
      },
    } as any;
    expect(await brokerPublishBranch(world, {})).toEqual({
      pushed: [],
      skipped: ['app'],
      errors: { app: 'Git broker requires an SSH remote' },
    });
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

    // Project-authority refresh serves the LOCAL target state, so a local merge
    // agent resolves against the same history the merge will land on.
    const refreshed = await brokerRefreshUpstream(world, env, 'main');
    expect(refreshed.refs[0]!.sha).toBe((await git(source, ['rev-parse', 'main'])).stdout.trim());

    // PR-policy tasks land on GitHub instead. Their refresh must bypass the
    // local authority and may need to force-correct a divergent seeded
    // origin/* ref back to the actual remote tip.
    const remoteRefreshed = await brokerRefreshUpstream(world, env, 'main', 'origin');
    expect(remoteRefreshed.refs[0]!.sha).toBe(originMainBefore);
    expect((await git(world.handle.root, ['rev-parse', 'refs/remotes/origin/main'])).stdout.trim()).toBe(originMainBefore);

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

  it('reports a partial upstream refresh without discarding repositories already refreshed', async () => {
    const calls: string[] = [];
    const world = {
      handle: {
        kind: 'e2b', id: 'partial-refresh', root: '/workspace', branch: 'karmax/partial-refresh', base: 'main',
        repos: [
          { name: 'app', repo: 'git@example:app.git', root: '/workspace/app', branch: 'karmax/partial-refresh', base: 'main' },
          { name: 'wiki', repo: '/not-an-ssh-remote', root: '/workspace/wiki', branch: 'karmax/partial-refresh', base: 'main' },
        ],
      },
      async exec(command: string, args: string[], options: { cwd: string }) {
        calls.push(`${options.cwd}:${command} ${args.join(' ')}`);
        if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main'))
          return { code: 0, stdout: 'abc123\n', stderr: '' };
        if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' };
        if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      async writeFileBuffer() {},
    } as any;
    const auth = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.file:///tmp/does-not-matter/.insteadOf',
      GIT_CONFIG_VALUE_0: 'git@example:',
    };

    // The fake cannot produce the app bundle, so use a host-local authority for
    // the successful repo and leave the wiki deliberately invalid.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-partial-refresh-'));
    cleanups.push(root);
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    await gitOrThrow(source, ['init', '-q', '-b', 'main']);
    await ensureIdentity(source);
    fs.writeFileSync(path.join(source, 'README.md'), 'base\n');
    await gitOrThrow(source, ['add', '-A']);
    await gitOrThrow(source, ['commit', '-q', '-m', 'base']);
    world.handle.repos[0].localPath = source;

    const refreshed = await brokerRefreshUpstream(world, auth, 'main');
    expect(refreshed.refs).toEqual([expect.objectContaining({ repo: 'app', branch: 'main' })]);
    expect(refreshed.skipped).toEqual(['wiki']);
    expect(refreshed.errors?.wiki).toMatch(/SSH remote/);
    expect(calls.some((call) => call.startsWith('/workspace/app:git fetch'))).toBe(true);
  });
});
