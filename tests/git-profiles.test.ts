import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { WorktreeProvider } from '../src/world/worktree.js';
import { finalizeMerge } from '../src/world/merge.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitProfiles, gitHandle } from '../src/autonomy/git-profiles.js';
import { remotePolicyOf } from '../src/domain/types.js';

/** Git & GitHub configuration (PLAN-git-config.md): the GitProfile registry,
 *  worktree-scoped identity materialization, JIT credential env, remote policy. */

let tmp: string;
let broker: CredentialBroker;
let profiles: GitProfiles;
let kv: Map<string, string>;
const store = {
  kvGet: (k: string) => kv.get(k),
  kvSet: (k: string, v: string) => void kv.set(k, v),
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-gitp-'));
  kv = new Map();
  broker = new CredentialBroker(new Vault(path.join(tmp, 'vault')));
  profiles = new GitProfiles(store, broker, path.join(tmp, 'state'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function makeRepo(name: string): Promise<string> {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'index.js'), 'console.log(1)\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

describe('GitProfiles registry (PLAN-git-config §3)', () => {
  it('saves, lists, defaults and deletes profiles; secrets live in the vault as flags', () => {
    profiles.save({ name: 'personal', userName: 'Jane', userEmail: 'jane@example.com', githubToken: 'ghp_secret' });
    profiles.save({ name: 'work', userName: 'Jane W', userEmail: 'jane@corp.com' });
    expect(profiles.list().map((p) => p.name).sort()).toEqual(['personal', 'work']);
    const p = profiles.get('personal')!;
    expect(p.githubToken).toBe(true); // a flag — never the secret
    expect(p.sshKey).toBeUndefined();
    expect(broker.hasHandle(gitHandle('personal', 'token'))).toBe(true);
    expect(JSON.stringify([...kv.entries()])).not.toContain('ghp_secret'); // registry carries no secret

    // default: none → set → cleared on delete
    expect(profiles.resolve({})).toBeUndefined();
    profiles.setDefault('personal');
    expect(profiles.resolve({})?.name).toBe('personal');
    expect(profiles.resolve({ gitProfile: 'work' })?.name).toBe('work'); // project selection wins
    profiles.delete('personal');
    expect(profiles.get('personal')).toBeUndefined();
    expect(broker.hasHandle(gitHandle('personal', 'token'))).toBe(false);
    expect(profiles.resolve({})).toBeUndefined();
  });

  it('re-saving with a blank secret keeps the stored one; a new value replaces it', () => {
    profiles.save({ name: 'p', userName: 'J', userEmail: 'j@x.com', githubToken: 'tok-1' });
    profiles.save({ name: 'p', userName: 'J2', userEmail: 'j2@x.com' }); // no token supplied
    expect(profiles.get('p')!.userName).toBe('J2');
    expect(profiles.get('p')!.githubToken).toBe(true);
    expect(profiles.env(profiles.get('p')!, {}).GH_TOKEN).toBe('tok-1');
    profiles.save({ name: 'p', userName: 'J2', userEmail: 'j2@x.com', githubToken: 'tok-2' });
    expect(profiles.env(profiles.get('p')!, {}).GH_TOKEN).toBe('tok-2');
  });

  it('env(): ssh key materialized 0600 with GIT_SSH_COMMAND; token → GH_TOKEN + askpass', () => {
    profiles.save({ name: 'p', userName: 'J', userEmail: 'j@x.com', sshKey: 'FAKE-KEY-MATERIAL', githubToken: 'tok' });
    const env = profiles.env(profiles.get('p')!, {});
    expect(env.GIT_SSH_COMMAND).toMatch(/^ssh -i .* -o IdentitiesOnly=yes$/);
    const keyPath = env.GIT_SSH_COMMAND!.match(/^ssh -i (\S+)/)![1]!;
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('FAKE-KEY-MATERIAL\n');
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(env.GH_TOKEN).toBe('tok');
    expect(fs.statSync(env.GIT_ASKPASS!).mode & 0o777).toBe(0o700);
    // the askpass script answers with the env token, holding no secret itself
    expect(fs.readFileSync(env.GIT_ASKPASS!, 'utf8')).not.toContain('tok');
  });
});

describe('worktree-scoped identity (PLAN-git-config §4A)', () => {
  it('two concurrent worlds commit as different identities; the source repo config is untouched', async () => {
    const repo = await makeRepo('repo');
    const provider = new WorktreeProvider(path.join(tmp, 'worlds'));
    const w1 = await provider.create({ taskId: 'a1', repo, base: 'main', gitIdentity: { name: 'Alice', email: 'alice@x.com' } });
    const w2 = await provider.create({ taskId: 'a2', repo, base: 'main', gitIdentity: { name: 'Bob', email: 'bob@y.com' } });

    for (const [w, f] of [[w1, 'a.txt'], [w2, 'b.txt']] as const) {
      await w.writeFile(f, 'hi');
      await git(w.handle.root, ['add', '-A']);
      await git(w.handle.root, ['commit', '-q', '-m', 'work']);
    }
    expect((await git(w1.handle.root, ['log', '-1', '--format=%an <%ae>'])).stdout.trim()).toBe('Alice <alice@x.com>');
    expect((await git(w2.handle.root, ['log', '-1', '--format=%an <%ae>'])).stdout.trim()).toBe('Bob <bob@y.com>');
    // the shared repo config carries no profile identity (only the extension enable)
    const shared = await git(repo, ['config', '--local', 'user.name']);
    expect(shared.stdout.trim()).not.toBe('Alice');
    expect(shared.stdout.trim()).not.toBe('Bob');
    await w1.destroy();
    await w2.destroy();
  });

  it('merge commits on the target carry the profile identity too (§4A, via -c injection)', async () => {
    const repo = await makeRepo('repo2');
    const provider = new WorktreeProvider(path.join(tmp, 'worlds'));
    const id = { name: 'Alice', email: 'alice@x.com' };
    const world = await provider.create({ taskId: 'm1', repo, base: 'main', target: 'main', gitIdentity: id });
    await world.writeFile('f.txt', 'x');
    await git(world.handle.root, ['add', '-A']);
    await git(world.handle.root, ['commit', '-q', '-m', 'work']);
    const res = await finalizeMerge(world, 'main', id);
    expect(res.merged).toBe(true);
    expect((await git(repo, ['log', '-1', '--format=%an <%ae>', 'main'])).stdout.trim()).toBe('Alice <alice@x.com>');
    await world.destroy();
  });

  it('SSH commit signing: signed commits in the world when the profile has a signing key', async () => {
    let pub: string;
    const keyFile = path.join(tmp, 'sk');
    try {
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', keyFile]);
      pub = fs.readFileSync(`${keyFile}.pub`, 'utf8').trim();
    } catch {
      return; // no ssh-keygen on this host — skip
    }
    profiles.save({ name: 'signer', userName: 'Alice', userEmail: 'alice@x.com', signingKey: fs.readFileSync(keyFile, 'utf8') });
    const identity = profiles.identity(profiles.get('signer')!, {});
    expect(identity.signingKeyPath).toBeTruthy();
    // git signs with the private key; it needs the .pub alongside for ssh signing
    fs.writeFileSync(`${identity.signingKeyPath}.pub`, `${pub}\n`);

    const repo = await makeRepo('repo3');
    const provider = new WorktreeProvider(path.join(tmp, 'worlds'));
    const world = await provider.create({ taskId: 's1', repo, base: 'main', gitIdentity: identity });
    await world.writeFile('f.txt', 'x');
    await git(world.handle.root, ['add', '-A']);
    const c = await git(world.handle.root, ['commit', '-q', '-m', 'signed work']);
    expect(c.code).toBe(0);
    // the commit object carries an SSH signature
    const raw = await git(world.handle.root, ['cat-file', 'commit', 'HEAD']);
    expect(raw.stdout).toContain('gpgsig');
    expect(raw.stdout).toContain('SSH SIGNATURE');
    await world.destroy();
  });
});

describe('remote policy (PLAN-git-config §5)', () => {
  it('remotePolicyOf: explicit remote wins; deprecated openGithubPr maps to pr; default none', () => {
    expect(remotePolicyOf(undefined)).toBe('none');
    expect(remotePolicyOf({})).toBe('none');
    expect(remotePolicyOf({ openGithubPr: true })).toBe('pr');
    expect(remotePolicyOf({ openGithubPr: true, remote: 'none' })).toBe('none');
    expect(remotePolicyOf({ remote: 'push' })).toBe('push');
  });

  it('pushTarget pushes the landed target to each repo origin (local bare origin)', async () => {
    const repo = await makeRepo('repo4');
    const origin = path.join(tmp, 'origin.git');
    await gitOrThrow(tmp, ['init', '-q', '--bare', '-b', 'main', origin]);
    await git(repo, ['remote', 'add', 'origin', origin]);
    await git(repo, ['push', '-q', 'origin', 'main']);

    const { Store } = await import('../src/store/db.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const { ProfileResolver } = await import('../src/agent/profiles.js');
    const { makeCoreActivities } = await import('../src/activities/core.js');
    const store2 = new Store(':memory:');
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(tmp, 'worlds')));
    const core = makeCoreActivities({ store: store2, worlds, adapters: new Map(), profiles: new ProfileResolver(store2, 'mock'), broker });

    const handle = await core.createWorld({ taskId: 'p1', repo, base: 'main', target: 'main', kind: 'worktree' });
    const world = await worlds.open(handle);
    await world.writeFile('pushed.txt', 'x');
    await git(handle.root, ['add', '-A']);
    await git(handle.root, ['commit', '-q', '-m', 'work']);
    const merged = await core.finalizeMergeActivity(handle, 'main');
    expect(merged.merged).toBe(true);

    const r = await core.pushTarget(handle, 'main');
    expect(r.pushed).toHaveLength(1);
    expect((await git(origin, ['show', 'main:pushed.txt'])).stdout).toBe('x');
    await core.destroyWorld(handle);
  });

  it('pushTarget skips (never throws) when there is no origin remote', async () => {
    const repo = await makeRepo('repo5');
    const { Store } = await import('../src/store/db.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const { ProfileResolver } = await import('../src/agent/profiles.js');
    const { makeCoreActivities } = await import('../src/activities/core.js');
    const store2 = new Store(':memory:');
    const worlds = new WorldRegistry();
    worlds.register(new WorktreeProvider(path.join(tmp, 'worlds')));
    const core = makeCoreActivities({ store: store2, worlds, adapters: new Map(), profiles: new ProfileResolver(store2, 'mock'), broker });
    const handle = await core.createWorld({ taskId: 'p2', repo, base: 'main', target: 'main', kind: 'worktree' });
    const r = await core.pushTarget(handle, 'main');
    expect(r.pushed).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    await core.destroyWorld(handle);
  });

  it('createWorld with a gitProfile stamps the handle and worlds commit as the profile', async () => {
    process.env.KARMAX_HOME = path.join(tmp, 'home'); // GitProfiles inside activities uses paths()
    try {
      const repo = await makeRepo('repo6');
      const { Store } = await import('../src/store/db.js');
      const { WorldRegistry } = await import('../src/world/registry.js');
      const { ProfileResolver } = await import('../src/agent/profiles.js');
      const { makeCoreActivities } = await import('../src/activities/core.js');
      const store2 = new Store(':memory:');
      // register the profile in THIS store (the activities read the same kv table)
      const gp = new GitProfiles(store2, broker);
      gp.save({ name: 'personal', userName: 'Jane', userEmail: 'jane@example.com' });
      const worlds = new WorldRegistry();
      worlds.register(new WorktreeProvider(path.join(tmp, 'worlds')));
      const core = makeCoreActivities({ store: store2, worlds, adapters: new Map(), profiles: new ProfileResolver(store2, 'mock'), broker });

      const handle = await core.createWorld({ taskId: 'g1', repo, base: 'main', target: 'main', kind: 'worktree', gitProfile: 'personal' });
      expect(handle.meta?.gitProfile).toBe('personal');
      const world = await worlds.open(handle);
      await world.writeFile('f.txt', 'x');
      await git(handle.root, ['add', '-A']);
      await git(handle.root, ['commit', '-q', '-m', 'work']);
      expect((await git(handle.root, ['log', '-1', '--format=%an <%ae>'])).stdout.trim()).toBe('Jane <jane@example.com>');
      // merge commits carry it too (finalizeMergeActivity resolves the identity)
      const merged = await core.finalizeMergeActivity(handle, 'main');
      expect(merged.merged).toBe(true);
      expect((await git(repo, ['log', '-1', '--format=%an <%ae>', 'main'])).stdout.trim()).toBe('Jane <jane@example.com>');
      await core.destroyWorld(handle);
    } finally {
      delete process.env.KARMAX_HOME;
    }
  });
});
