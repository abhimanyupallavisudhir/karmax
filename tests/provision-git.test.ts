import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { provisionGitCredentials, provisionGitRepos, type ProvisionTarget } from '../src/world/provision-git.js';
import { worldRepoTarget } from '../src/world/types.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';

const pexec = promisify(execFile);

function fakeTarget(handler: (command: string) => { stdout?: string; stderr?: string; code?: number } | undefined) {
  const commands: string[] = [];
  const target: ProvisionTarget = {
    async run(command) {
      commands.push(command);
      const result = handler(command) ?? {};
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 };
    },
    async writeFile() {},
  };
  return { target, commands };
}

const OPTIONS = { root: '/w', home: '/home/u', sshUrlError: 'ssh only', copyGlobsWarning: 'no globs' };

describe('shared cloud world git provisioning', () => {
  afterEach(() => {
    delete process.env.KARMAX_WORLD_CLONE_RETRIES;
    delete process.env.KARMAX_WORLD_CLONE_RETRY_MS;
  });

  it('creates a plain directory without invoking Git when there are no repositories', async () => {
    const { target, commands } = fakeTarget(() => undefined);
    const provisioned = await provisionGitRepos(target, { taskId: 't0', base: 'main', repos: [] }, OPTIONS);
    expect(provisioned).toMatchObject({ root: '/w', repos: [] });
    expect(commands.some((command) => /\bgit\b/.test(command))).toBe(false);
  });

  it('honors a nested layout for a single cloud repository so another branch can be added', async () => {
    const { target } = fakeTarget((command) => command.includes('rev-parse') ? { stdout: 'a'.repeat(40) } : undefined);
    const result = await provisionGitRepos(target, { taskId: 'nested', base: 'main',
      repo: 'git@github.com:acme/app.git', layout: 'nested' }, OPTIONS);
    expect(result.repos[0]?.root).toBe('/w/app');
  });

  it('retries a transient clone failure after clearing the partial checkout', async () => {
    process.env.KARMAX_WORLD_CLONE_RETRY_MS = '0';
    let cloneAttempts = 0;
    const { target, commands } = fakeTarget((command) => {
      if (command.includes('git clone')) return { code: ++cloneAttempts === 1 ? 128 : 0, stderr: 'early EOF' };
      if (command.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n` };
      return undefined;
    });
    const { repos } = await provisionGitRepos(target, { taskId: 't1', base: 'main', repo: 'git@github.com:acme/app.git' }, OPTIONS);
    expect(cloneAttempts).toBe(2);
    expect(commands.some((command) => command.startsWith("rm -rf '/w'"))).toBe(true);
    expect(repos[0]).toMatchObject({ repo: 'git@github.com:acme/app.git', baseSha: 'a'.repeat(40) });
  });

  it('gives up after the configured retry budget with the underlying error', async () => {
    process.env.KARMAX_WORLD_CLONE_RETRIES = '1';
    process.env.KARMAX_WORLD_CLONE_RETRY_MS = '0';
    let cloneAttempts = 0;
    const { target } = fakeTarget((command) => {
      if (command.includes('git clone')) { cloneAttempts++; return { code: 128, stderr: 'connection reset' }; }
      return undefined;
    });
    await expect(provisionGitRepos(target, { taskId: 't1', base: 'main', repo: 'git@github.com:acme/app.git' }, OPTIONS))
      .rejects.toThrow(/connection reset/);
    expect(cloneAttempts).toBe(2);
  });

  it('rejects non-SSH sources with the provider message before running any command', async () => {
    const { target, commands } = fakeTarget(() => undefined);
    await expect(provisionGitRepos(target, { taskId: 't1', base: 'main', repo: 'https://github.com/acme/app.git' }, OPTIONS))
      .rejects.toThrow('ssh only');
    expect(commands).toHaveLength(0);
  });

  it('clones an SSH-shaped GitHub remote with an ephemeral HTTPS App token', async () => {
    const commands: string[] = [];
    const writes = new Map<string, string>();
    const target: ProvisionTarget = {
      async run(command) {
        commands.push(command);
        return { stdout: command.includes('rev-parse') ? `${'a'.repeat(40)}\n` : '', stderr: '', code: 0 };
      },
      async writeFile(file, content) { writes.set(file, String(content)); },
    };
    const spec = {
      taskId: 'token-clone', base: 'main', repo: 'git@github.com:acme/app.git',
      gitCredentials: { httpsTokens: { 'git@github.com:acme/app.git': 'short-lived-token' } },
    };
    await provisionGitCredentials(target, spec, OPTIONS.home);
    await provisionGitRepos(target, spec, OPTIONS);

    const clone = commands.find((command) => command.includes('git clone'))!;
    expect(clone).toContain('url.https://github.com/.insteadOf');
    expect(clone).toContain('GIT_ASKPASS=');
    expect(clone).not.toContain('short-lived-token');
    expect([...writes.values()]).toContain('short-lived-token');
    expect([...writes.values()].join('\n')).toContain('x-access-token');
  });

  it('reports copied compatibility files as ephemeral world paths', async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-copy-globs-'));
    fs.writeFileSync(path.join(source, '.env.local'), 'SECRET=1\n');
    const writes: string[] = [];
    const { target } = fakeTarget((command) => command.includes('rev-parse')
      ? { stdout: `${'a'.repeat(40)}\n` }
      : undefined);
    target.writeFile = async (file) => { writes.push(file); };
    try {
      const provisioned = await provisionGitRepos(target, {
        taskId: 't1', base: 'main', repo: 'git@github.com:acme/app.git',
        copyGlobs: ['.env*'], copySources: [source],
      }, OPTIONS);
      expect(provisioned.ephemeralPaths).toEqual(['.env.local']);
      expect(writes).toContain('/w/.env.local');
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it('keeps a plain workspace beside a companion repository', async () => {
    const { target, commands } = fakeTarget((command) => {
      if (command.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n` };
      return undefined;
    });
    const provisioned = await provisionGitRepos(target, {
      taskId: 't1', base: 'main', repo: 'git@github.com:acme/project-wiki.git', scratch: true,
    }, OPTIONS);
    expect(provisioned.workdir).toBe('/w/scratch');
    expect(provisioned.repos[0]).toMatchObject({
      repo: 'git@github.com:acme/project-wiki.git',
      root: '/w/project-wiki',
    });
    expect(commands.some((command) => command.includes("git -C '/w/scratch' init"))).toBe(false);
  });
});

/** Drives provisioning against a plain host directory, standing in for a cloud
 * sandbox. Test-only url rewriting maps the SSH-shaped remote to a local bare
 * repo, exercising the exact provisioning command stream without a network. */
function hostTarget(env: Record<string, string>): ProvisionTarget {
  return {
    async run(command, timeoutMs) {
      try {
        const { stdout, stderr } = await pexec('bash', ['-c', command], {
          timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
        });
        return { stdout, stderr, code: 0 };
      } catch (e: any) {
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e), code: e.code ?? 1 };
      }
    },
    async writeFile(remotePath, content) {
      await fs.promises.mkdir(path.dirname(remotePath), { recursive: true });
      await fs.promises.writeFile(remotePath, content);
    },
  };
}

describe('seeding a cloud world from its local checkout', () => {
  const cleanups: string[] = [];
  afterEach(() => { for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  async function makeRepoPair(prefix: string): Promise<{ root: string; source: string; env: Record<string, string> }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(root);
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    await gitOrThrow(source, ['init', '-q', '-b', 'main']);
    await ensureIdentity(source);
    fs.writeFileSync(path.join(source, 'README.md'), '# base\n');
    await gitOrThrow(source, ['add', '-A']);
    await gitOrThrow(source, ['commit', '-q', '-m', 'base']);
    await gitOrThrow(root, ['clone', '-q', '--bare', source, path.join(root, 'remote.git')]);
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'git@example:',
    };
    return { root, source, env };
  }

  it.each(['master', 'release'])('records the fallback base and preserves an independent %s target', async (targetBranch) => {
    const { root, env } = await makeRepoPair('karmax-missing-base-');
    const remote = path.join(root, 'remote.git');
    await gitOrThrow(remote, ['branch', 'release', 'main']);
    const world = path.join(root, 'world');
    const result = await provisionGitRepos(hostTarget(env), {
      taskId: 'fallback', base: 'master', target: targetBranch, repo: 'git@example:remote.git',
    }, { ...OPTIONS, root: world, home: root });
    expect(result.repos[0]).toMatchObject({ base: 'main', target: targetBranch === 'master' ? 'main' : 'release' });
    expect(worldRepoTarget(result.repos[0]!, 'release')).toBe('release');
    expect(result.warnings.join('\n')).toContain(targetBranch === 'master'
      ? 'Base and target branch changed to "main" because "master" did not exist'
      : 'Base branch changed to "main" because "master" did not exist');
    expect(await gitOrThrow(world, ['rev-parse', 'HEAD'])).toBe(await gitOrThrow(remote, ['rev-parse', 'main']));
    expect((await git(world, ['show-ref', '--verify', '--quiet', 'refs/heads/master'])).code).not.toBe(0);
  });

  it.each(['master', 'trunk'])('uses the actual remote default %s rather than assuming main', async (defaultBranch) => {
    const { root, env } = await makeRepoPair('karmax-default-branch-');
    const remote = path.join(root, 'remote.git');
    await gitOrThrow(remote, ['branch', '-m', 'main', defaultBranch]);
    const result = await provisionGitRepos(hostTarget(env), {
      taskId: 'fallback', base: 'main', target: 'main', repo: 'git@example:remote.git',
    }, { ...OPTIONS, root: path.join(root, 'world'), home: root });
    expect(result.repos[0]).toMatchObject({ base: defaultBranch, target: defaultBranch });
    expect(result.warnings[0]).toContain(`Base and target branch changed to "${defaultBranch}" because "main" did not exist`);
  });

  it('keeps a second repository on its existing target when the first repository falls back', async () => {
    const { root, env } = await makeRepoPair('karmax-multi-fallback-');
    const second = path.join(root, 'second.git');
    await gitOrThrow(root, ['clone', '-q', '--bare', path.join(root, 'remote.git'), second]);
    await gitOrThrow(second, ['branch', '-m', 'main', 'master']);
    const result = await provisionGitRepos(hostTarget(env), {
      taskId: 'multi', base: 'master', target: 'master', repos: ['git@example:remote.git', 'git@example:second.git'],
    }, { ...OPTIONS, root: path.join(root, 'world'), home: root });
    expect(result.repos.map(repo => repo.base)).toEqual(['main', 'master']);
    expect(result.repos.map(repo => worldRepoTarget(repo, 'main'))).toEqual(['main', 'master']);
    expect(result.warnings).toHaveLength(1);
  });

  it('rejects a distinct missing target during setup instead of redirecting it', async () => {
    const { root, env } = await makeRepoPair('karmax-missing-target-');
    await expect(provisionGitRepos(hostTarget(env), {
      taskId: 'missing-target', base: 'master', target: 'release', repo: 'git@example:remote.git',
    }, { ...OPTIONS, root: path.join(root, 'world'), home: root })).rejects.toThrow('target branch "release" does not exist');
  });

  it('does not fall back when an explicitly reviewed branch is missing', async () => {
    const { root, env } = await makeRepoPair('karmax-missing-review-');
    await expect(provisionGitRepos(hostTarget(env), {
      taskId: 'missing-review', base: 'main', branch: 'karmax/missing', repo: 'git@example:remote.git',
    }, { ...OPTIONS, root: path.join(root, 'world'), home: root })).rejects.toThrow('no remote branch "karmax/missing"');
  });

  it('forks off the local branch state when the checkout is ahead of origin', async () => {
    const { root, source, env } = await makeRepoPair('karmax-provision-seed-');
    // The local checkout moves ahead of origin — the state local-only merges
    // leave behind. The world must fork off the LOCAL branch state.
    fs.writeFileSync(path.join(source, 'local-only.txt'), 'never pushed\n');
    await gitOrThrow(source, ['add', '-A']);
    await gitOrThrow(source, ['commit', '-q', '-m', 'local-only work']);
    const localMain = (await git(source, ['rev-parse', 'main'])).stdout.trim();

    const world = path.join(root, 'world');
    const { repos, warnings } = await provisionGitRepos(hostTarget(env), {
      taskId: 'seeded-task', repos: ['git@example:remote.git'], base: 'main', copySources: [source],
    }, { root: world, home: root, sshUrlError: 'ssh required', copyGlobsWarning: 'no host checkout' });

    expect(warnings).toEqual([]);
    expect(repos[0]).toMatchObject({ repo: 'git@example:remote.git', localPath: source, baseSha: localMain });
    expect((await git(world, ['rev-parse', 'refs/remotes/origin/main'])).stdout.trim()).toBe(localMain);
    expect((await git(world, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('karmax/seeded-task');
    expect(fs.readFileSync(path.join(world, 'local-only.txt'), 'utf8')).toContain('never pushed');
    expect(fs.existsSync(path.join(world, '.karmax-seed.bundle'))).toBe(false);
  });

  it('keeps the cloned origin target authoritative for PR-policy worlds', async () => {
    const { root, source, env } = await makeRepoPair('karmax-provision-origin-');
    const writer = path.join(root, 'writer');
    await gitOrThrow(root, ['clone', '-q', path.join(root, 'remote.git'), writer]);
    await ensureIdentity(writer);
    fs.writeFileSync(path.join(writer, 'remote-only.txt'), 'new target state\n');
    await gitOrThrow(writer, ['add', '-A']);
    await gitOrThrow(writer, ['commit', '-q', '-m', 'advance origin']);
    await gitOrThrow(writer, ['push', '-q', 'origin', 'main']);
    const remoteMain = (await git(writer, ['rev-parse', 'main'])).stdout.trim();
    const localMain = (await git(source, ['rev-parse', 'main'])).stdout.trim();
    expect(remoteMain).not.toBe(localMain);

    const remoteSource = 'git@example:remote.git';
    const world = path.join(root, 'world');
    const { repos, warnings } = await provisionGitRepos(hostTarget(env), {
      taskId: 'origin-task', repos: [remoteSource], base: 'main', copySources: [source],
      repositoryAuthorities: { [remoteSource]: 'origin' },
    }, { root: world, home: root, sshUrlError: 'ssh required', copyGlobsWarning: 'no host checkout' });

    expect(warnings).toEqual([]);
    expect(repos[0]).toMatchObject({
      repo: remoteSource, localPath: source, sourceAuthority: 'origin', baseSha: remoteMain,
    });
    expect((await git(world, ['rev-parse', 'refs/remotes/origin/main'])).stdout.trim()).toBe(remoteMain);
    expect((await git(world, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(remoteMain);
    expect(fs.readFileSync(path.join(world, 'remote-only.txt'), 'utf8')).toContain('new target state');
  });

  it('reviews a branch that exists only in the local checkout', async () => {
    const { root, source, env } = await makeRepoPair('karmax-provision-branch-');
    await gitOrThrow(source, ['branch', 'karmax/other-task']);

    const world = path.join(root, 'world');
    const { repos } = await provisionGitRepos(hostTarget(env), {
      taskId: 'review-task', repos: ['git@example:remote.git'], base: 'main', branch: 'karmax/other-task',
      copySources: [source],
    }, { root: world, home: root, sshUrlError: 'ssh required', copyGlobsWarning: 'no host checkout' });

    expect(repos[0]!.branch).toBe('karmax/other-task');
    expect((await git(world, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('karmax/other-task');
  });
});
