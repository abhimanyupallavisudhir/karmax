import { memoryTransaction } from './helpers/memory-transaction.js';
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
import { GitProfiles, gitHandle, inheritPersonalGithubProfile, userGitScope } from '../src/autonomy/git-profiles.js';
import { remotePolicyOf } from '../src/domain/types.js';
import { Store } from '../src/store/db.js';

/** Git & GitHub configuration (PLAN-git-config.md): the GitProfile registry,
 *  worktree-scoped identity materialization, JIT credential env, remote policy. */

let tmp: string;
let broker: CredentialBroker;
let profiles: GitProfiles;
let kv: Map<string, string>;
let transaction: ReturnType<typeof memoryTransaction>;
const store = {
  transaction: <T>(operation: () => Promise<T>) => transaction(operation),
  kvGet: (k: string) => kv.get(k),
  kvSet: (k: string, v: string) => void kv.set(k, v),
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-gitp-'));
  kv = new Map();
  transaction = memoryTransaction(kv);
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
  it('assigns the legacy flat registry only to org_personal', async () => {
    kv.set('git:profiles', JSON.stringify([{ name: 'legacy', userName: 'Old', userEmail: 'old@example.test' }]));
    expect((await profiles.get('legacy'))?.userName).toBe('Old');
    expect((await new GitProfiles(store, broker, path.join(tmp, 'state'), 'org_other').list())).toEqual([]);
  });

  it('saves, lists, defaults and deletes profiles; secrets live in the vault as flags', async () => {
    (await profiles.save({ name: 'personal', userName: 'Jane', userEmail: 'jane@example.com', githubToken: 'ghp_secret' }));
    (await profiles.save({ name: 'work', userName: 'Jane W', userEmail: 'jane@corp.com' }));
    expect((await profiles.list()).map((p) => p.name).sort()).toEqual(['personal', 'work']);
    const p = (await profiles.get('personal'))!;
    expect(p.githubToken).toBe(true); // a flag — never the secret
    expect(p.sshKey).toBeUndefined();
    expect(broker.hasHandle(gitHandle('personal', 'token'))).toBe(true);
    expect(JSON.stringify([...kv.entries()])).not.toContain('ghp_secret'); // registry carries no secret

    // default: none → set → cleared on delete
    expect((await profiles.resolve({}))).toBeUndefined();
    (await profiles.setDefault('personal'));
    expect((await profiles.resolve({}))?.name).toBe('personal');
    expect((await profiles.resolve({ gitProfile: 'work' }))?.name).toBe('work'); // project selection wins
    (await profiles.delete('personal'));
    expect((await profiles.get('personal'))).toBeUndefined();
    expect(broker.hasHandle(gitHandle('personal', 'token'))).toBe(false);
    expect((await profiles.resolve({}))).toBeUndefined();
  });

  it('re-saving with a blank secret keeps the stored one; a new value replaces it', async () => {
    (await profiles.save({ name: 'p', userName: 'J', userEmail: 'j@x.com', githubToken: 'tok-1' }));
    (await profiles.save({ name: 'p', userName: 'J2', userEmail: 'j2@x.com' })); // no token supplied
    expect((await profiles.get('p'))!.userName).toBe('J2');
    expect((await profiles.get('p'))!.githubToken).toBe(true);
    expect((await profiles.env((await profiles.get('p'))!, {})).GH_TOKEN).toBe('tok-1');
    (await profiles.save({ name: 'p', userName: 'J2', userEmail: 'j2@x.com', githubToken: 'tok-2' }));
    expect((await profiles.env((await profiles.get('p'))!, {})).GH_TOKEN).toBe('tok-2');
  });

  it('isolates same-named profiles and vault handles between organizations', async () => {
    const acme = new GitProfiles(store, broker, path.join(tmp, 'state'), 'org_acme');
    const beta = new GitProfiles(store, broker, path.join(tmp, 'state'), 'org_beta');
    (await acme.save({ name: 'work', userName: 'Acme Bot', userEmail: 'bot@acme.test', githubToken: 'acme-token' }));
    (await beta.save({ name: 'work', userName: 'Beta Bot', userEmail: 'bot@beta.test', githubToken: 'beta-token' }));
    (await acme.setDefault('work'));

    expect((await acme.resolve({}))?.userEmail).toBe('bot@acme.test');
    expect((await beta.resolve({}))).toBeUndefined();
    expect((await acme.env((await acme.get('work'))!, {})).GH_TOKEN).toBe('acme-token');
    expect((await beta.env((await beta.get('work'))!, {})).GH_TOKEN).toBe('beta-token');
    expect(gitHandle('work', 'token', 'org_acme')).not.toBe(gitHandle('work', 'token', 'org_beta'));

    (await acme.delete('work'));
    expect((await beta.get('work'))?.userEmail).toBe('bot@beta.test');
    expect(broker.hasHandle(gitHandle('work', 'token', 'org_beta'))).toBe(true);
    expect((await acme.preflight({})).tier).toBe('unconfigured');
  });

  it('stores each user’s development identity outside every organization registry', async () => {
    const jane = new GitProfiles(store, broker, path.join(tmp, 'state'), userGitScope('user_jane'));
    const sam = new GitProfiles(store, broker, path.join(tmp, 'state'), userGitScope('user_sam'));
    (await jane.save({ name: 'main', userName: 'Jane Dev', userEmail: 'jane@example.test', githubToken: 'jane-token' }));
    (await jane.setDefault('main'));
    (await sam.save({ name: 'main', userName: 'Sam Dev', userEmail: 'sam@example.test', githubToken: 'sam-token' }));
    (await sam.setDefault('main'));

    expect((await jane.resolve({}))?.userEmail).toBe('jane@example.test');
    expect((await sam.resolve({}))?.userEmail).toBe('sam@example.test');
    expect((await profiles.list())).toEqual([]);
    expect((await jane.env((await jane.get('main'))!, {})).GH_TOKEN).toBe('jane-token');
    expect((await sam.env((await sam.get('main'))!, {})).GH_TOKEN).toBe('sam-token');
  });

  it('infers the default commit identity from GitHub and keeps signing optional', async () => {
    const user = new GitProfiles(store, broker, path.join(tmp, 'state'), userGitScope('user_jane'));
    expect((await user.saveGithubIdentity({ id: 12345, login: 'jane-dev', name: 'Jane Developer' }))).toMatchObject({
      name: 'github', userName: 'Jane Developer', userEmail: '12345+jane-dev@users.noreply.github.com',
      github: { id: '12345', login: 'jane-dev' },
    });
    expect((await user.defaultProfile())).toBe('github');
    expect((await user.saveGithubSigningKey('PRIVATE SIGNING KEY'))).toMatchObject({ signingKey: true });
    expect(broker.hasHandle(gitHandle('github', 'signing', userGitScope('user_jane')))).toBe(true);
    // Reconnecting refreshes public identity without dropping the signing key.
    expect((await user.saveGithubIdentity({ id: '12345', login: 'jane-renamed' }))).toMatchObject({
      userName: 'jane-renamed', userEmail: '12345+jane-renamed@users.noreply.github.com', signingKey: true,
    });
  });

  it('keeps per-account custom identities separate and supports an organization automation identity', async () => {
    const user = new GitProfiles(store, broker, path.join(tmp, 'state'), userGitScope('user_jane'));
    (await user.saveGithubIdentity({ id: '1', login: 'first', name: 'First Person' }));
    (await user.saveGithubIdentity({ id: '2', login: 'second' }));
    (await user.saveGithubCustomIdentity('2', { userName: 'Release Author', userEmail: 'release@example.test', signingKey: 'SIGN' }));
    expect((await user.githubProfile('1'))).toMatchObject({ name: 'github', userName: 'First Person' });
    expect((await user.githubProfile('2'))).toMatchObject({ name: 'github-2', userName: 'Release Author',
      userEmail: 'release@example.test', customIdentity: { userName: 'Release Author', userEmail: 'release@example.test' }, signingKey: true });
    expect((await user.setActiveGithub('2')).name).toBe('github-2');

    const organization = new GitProfiles(store, broker, path.join(tmp, 'state'), 'org_acme');
    expect((await organization.saveAutomationIdentity({ userName: 'Acme Bot' }))).toMatchObject({
      userName: 'Acme Bot', userEmail: 'tavya+org-acme@localhost', customIdentity: { userName: 'Acme Bot' },
    });
    expect((await organization.saveAutomationIdentity({}))).toMatchObject({ userName: 'tavya' });
  });

  it('lets an empty organization link its default to an authorized user profile without copying secrets', async () => {
    const user = new GitProfiles(store, broker, path.join(tmp, 'state'), userGitScope('user_jane'));
    (await user.save({ name: 'main', userName: 'Jane Dev', userEmail: 'jane@example.test', githubToken: 'jane-token' }));
    (await user.setDefault('main'));
    const organization = new GitProfiles(store, broker, path.join(tmp, 'state'), 'org_acme');

    const linked = (await organization.reuseUserProfile(user));
    expect(linked.source).toEqual({ kind: 'user', userId: 'user_jane', profile: 'main' });
    expect((await organization.defaultProfile())).toBe('main');
    expect((await organization.env(linked, {})).GH_TOKEN).toBe('jane-token');
    (await user.save({ name: 'main', userName: 'Jane Updated', userEmail: 'new@example.test', githubToken: 'rotated-token' }));
    expect((await organization.get('main'))).toMatchObject({ userName: 'Jane Updated', userEmail: 'new@example.test' });
    expect((await organization.env((await organization.get('main'))!, {})).GH_TOKEN).toBe('rotated-token');
    expect(broker.hasHandle(gitHandle('main', 'token', 'org_acme'))).toBe(false);
    await expect((async () => (await organization.reuseUserProfile(user)))()).rejects.toThrow(/already configured/i);
  });

  it('inherits a GitHub profile when the user connects before their personal workspace exists', async () => {
    const db = (await Store.create(':memory:'));
    const user = new GitProfiles(db, broker, path.join(tmp, 'state'), userGitScope('user_jane'));
    (await user.saveGithubIdentity({ id: '12345', login: 'jane-dev', name: 'Jane Developer' }));
    const personal = (await db.createOrganization({ name: "Jane's workspace", kind: 'personal', ownerUserId: 'user_jane' }));

    expect((await inheritPersonalGithubProfile(db, broker, 'user_jane'))).toMatchObject({
      github: { id: '12345', login: 'jane-dev' },
      source: { kind: 'user', userId: 'user_jane', profile: 'github' },
    });
    expect((await new GitProfiles(db, broker, path.join(tmp, 'state'), personal.id).resolve(undefined))).toMatchObject({
      userName: 'Jane Developer',
      source: { kind: 'user', userId: 'user_jane', profile: 'github' },
    });
    (await db.close());
  });

  it('inherits after workspace creation but never replaces organization GitHub configuration', async () => {
    const db = (await Store.create(':memory:'));
    const inherited = (await db.createOrganization({ name: "Jane's workspace", kind: 'personal', ownerUserId: 'user_jane' }));
    const configured = (await db.createOrganization({ name: "Pat's workspace", kind: 'personal', ownerUserId: 'user_pat' }));
    const jane = new GitProfiles(db, broker, path.join(tmp, 'state'), userGitScope('user_jane'));
    const pat = new GitProfiles(db, broker, path.join(tmp, 'state'), userGitScope('user_pat'));
    (await jane.saveGithubIdentity({ id: '1', login: 'jane' }));
    (await pat.saveGithubIdentity({ id: '2', login: 'pat' }));
    (await db.upsertGitConnection({ organizationId: configured.id, provider: 'github', installationId: '99',
      accountLogin: 'pat', accountType: 'User' }));

    expect((await inheritPersonalGithubProfile(db, broker, 'user_jane'))?.source?.userId).toBe('user_jane');
    expect((await new GitProfiles(db, broker, path.join(tmp, 'state'), inherited.id).defaultProfile())).toBe('github');
    expect((await inheritPersonalGithubProfile(db, broker, 'user_pat'))).toBeUndefined();
    expect((await new GitProfiles(db, broker, path.join(tmp, 'state'), configured.id).list())).toEqual([]);
    (await db.close());
  });

  it('env(): ssh key materialized 0600 with GIT_SSH_COMMAND; token → GH_TOKEN + askpass', async () => {
    (await profiles.save({ name: 'p', userName: 'J', userEmail: 'j@x.com', sshKey: 'FAKE-KEY-MATERIAL', githubToken: 'tok' }));
    const env = (await profiles.env((await profiles.get('p'))!, {}));
    expect(env.GIT_SSH_COMMAND).toMatch(/^ssh -i .* -o IdentitiesOnly=yes -o UserKnownHostsFile=.* -o StrictHostKeyChecking=accept-new$/);
    const keyPath = env.GIT_SSH_COMMAND!.match(/^ssh -i (\S+)/)![1]!;
    const knownHostsPath = env.GIT_SSH_COMMAND!.match(/UserKnownHostsFile=(\S+)/)![1]!;
    expect(fs.readFileSync(keyPath, 'utf8')).toBe('FAKE-KEY-MATERIAL\n');
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(knownHostsPath, 'utf8')).toBe('');
    expect(fs.statSync(knownHostsPath).mode & 0o777).toBe(0o600);
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
    (await profiles.save({ name: 'signer', userName: 'Alice', userEmail: 'alice@x.com', signingKey: fs.readFileSync(keyFile, 'utf8') }));
    const identity = (await profiles.identity((await profiles.get('signer'))!, {}));
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
    const store2 = (await Store.create(':memory:'));
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
    const store2 = (await Store.create(':memory:'));
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
      const store2 = (await Store.create(':memory:'));
      // register the profile in THIS store (the activities read the same kv table)
      const gp = new GitProfiles(store2, broker);
      (await gp.save({ name: 'personal', userName: 'Jane', userEmail: 'jane@example.com' }));
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

  it('attributes development to the human task creator instead of the organization account', async () => {
    process.env.KARMAX_HOME = path.join(tmp, 'creator-home');
    try {
      const repo = await makeRepo('creator-repo');
      const { Store } = await import('../src/store/db.js');
      const { WorldRegistry } = await import('../src/world/registry.js');
      const { ProfileResolver } = await import('../src/agent/profiles.js');
      const { makeCoreActivities } = await import('../src/activities/core.js');
      const store2 = (await Store.create(':memory:'));
      const organization = (await store2.createOrganization({ name: 'Acme', ownerUserId: 'jane' }));
      const project = (await store2.createProject('Product', { repos: [repo] }, organization.id));
      const orgProfiles = new GitProfiles(store2, broker, undefined, organization.id);
      (await orgProfiles.save({ name: 'shared', userName: 'Acme Bot', userEmail: 'bot@acme.test' }));
      (await orgProfiles.setDefault('shared'));
      const userProfiles = new GitProfiles(store2, broker, undefined, userGitScope('jane'));
      (await userProfiles.save({ name: 'main', userName: 'Jane Dev', userEmail: 'jane@example.test' }));
      (await userProfiles.setDefault('main'));
      const task = (await store2.createTask({
        projectId: project.id,
        title: 'Change product',
        workflow: 'software-dev',
        workflowVersion: '1.0.0',
        params: { prompt: 'change it' },
        createdBy: { kind: 'user', userId: 'jane' },
      }));
      const worlds = new WorldRegistry();
      worlds.register(new WorktreeProvider(path.join(tmp, 'creator-worlds')));
      const core = makeCoreActivities({ store: store2, worlds, adapters: new Map(), profiles: new ProfileResolver(store2, 'mock'), broker });

      const handle = await core.createWorld({ taskId: task.id, projectId: project.id, repo, base: 'main', target: 'main', kind: 'worktree' });
      expect(handle.meta).toMatchObject({ gitProfile: 'main', gitProfileScope: userGitScope('jane') });
      const world = await worlds.open(handle);
      const cwd = handle.workdir ?? handle.root;
      await world.writeFile(path.relative(handle.root, path.join(cwd, 'creator.txt')), 'owned by Jane');
      await git(cwd, ['add', '-A']);
      expect((await git(cwd, ['commit', '-q', '-m', 'work'])).code).toBe(0);
      expect((await git(handle.workdir ?? handle.root, ['log', '-1', '--format=%an <%ae>'])).stdout.trim())
        .toBe('Jane Dev <jane@example.test>');
      await core.destroyWorld(handle);
    } finally {
      delete process.env.KARMAX_HOME;
    }
  });

  it('fails closed on personal credentials and host Git identity for another organization', async () => {
    process.env.KARMAX_HOME = path.join(tmp, 'tenant-home');
    try {
      const repo = await makeRepo('tenant-repo');
      const { Store } = await import('../src/store/db.js');
      const { WorldRegistry } = await import('../src/world/registry.js');
      const { ProfileResolver } = await import('../src/agent/profiles.js');
      const { makeCoreActivities } = await import('../src/activities/core.js');
      const store2 = (await Store.create(':memory:'));
      const organization = (await store2.createOrganization({ name: 'Acme' }));
      const project = (await store2.createProject('Acme project', {}, organization.id));
      (await broker.registerHandle('claude:personal-key', 'must-not-leak'));
      const worlds = new WorldRegistry();
      worlds.register(new WorktreeProvider(path.join(tmp, 'tenant-worlds')));
      const core = makeCoreActivities({
        store: store2,
        worlds,
        adapters: new Map(),
        profiles: new ProfileResolver(store2, 'claude'),
        broker,
      });

      const order = await core.resolveCredentialOrder({
        taskId: 'tenant-task',
        projectId: project.id,
        provider: 'claude',
      });
      expect(order).toEqual([`missing:${organization.id}:claude`]);
      expect(order).not.toContain('key:handle:claude:personal-key');

      const organizationHandle = `claude:${organization.id}:work`;
      (await broker.registerHandle(organizationHandle, 'tenant-key'));
      (await store2.upsertProfile({
        id: 'do-default',
        name: 'Do',
        role: 'do',
        provider: 'claude',
        capabilities: [],
        // A historical profile restriction is ignored; the scoped Credentials
        // policy is the only routing authority.
        allowedAccounts: ['key:claude:personal-key'],
      }));
      expect(await core.resolveCredentialOrder({
        taskId: 'tenant-task',
        projectId: project.id,
        provider: 'claude',
        role: 'do',
        task: { projectId: project.id } as any,
      })).toEqual([`key:handle:${organizationHandle}`]);

      const handle = await core.createWorld({
        taskId: 'tenant-task',
        projectId: project.id,
        repo,
        base: 'main',
        target: 'main',
        kind: 'worktree',
      });
      const world = await worlds.open(handle);
      const cwd = handle.workdir ?? handle.root;
      await world.writeFile(path.relative(handle.root, path.join(cwd, 'tenant.txt')), 'isolated');
      await git(cwd, ['add', '-A']);
      const committed = await git(cwd, ['commit', '-q', '-m', 'tenant']);
      expect(committed.code, committed.stderr).toBe(0);
      expect((await git(cwd, ['log', '-1', '--format=%an <%ae>'])).stdout.trim())
        .toBe(`tavya <tavya+${organization.id.replace(/[^a-z0-9.-]/gi, '-')}@localhost>`);
      await core.destroyWorld(handle);
    } finally {
      delete process.env.KARMAX_HOME;
    }
  });
});
