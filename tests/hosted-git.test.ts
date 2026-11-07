import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { HOSTED_GIT_ROUTE, HostedGit, hostedCloneCredential, hostedCloneUrl, hostedRepositoryUrl, packPartKey, registerHostedGit,
  repositoryBrokerCredentials } from '../src/world/hosted-git.js';
import { provisionGitCredentials, provisionGitRepos, type ProvisionTarget } from '../src/world/provision-git.js';
import { runLocalCommand } from '../src/world/local-execution.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { brokerFinalizeMerge, brokerPublishBranch } from '../src/world/git-broker.js';
import { projectRepositoryCredential } from '../src/world/project-files.js';
import { readMirrored } from '../src/world/git-mirror.js';
import { materializeGitCredential } from '../src/world/git-credential.js';
import { newId } from '../src/util/id.js';
import type { Repository } from '../src/domain/types.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Nadia', GIT_AUTHOR_EMAIL: 'nadia@example.com', GIT_COMMITTER_NAME: 'Nadia', GIT_COMMITTER_EMAIL: 'nadia@example.com' };
/** Git runs as its own process: the server it talks to is in this one, so it must not block it. */
const run = (cwd: string, args: string[], env: NodeJS.ProcessEnv = gitEnv) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile('git', args, { cwd, env, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: unknown }).code) || 1 : 0, stdout, stderr }));
  });
const must = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => {
  const result = await run(cwd, args, env);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/** Tokens a person might hold: one that may read, one that may write. */
const PEOPLE: Record<string, 'read' | 'write'> = { 'reader-token': 'read', 'writer-token': 'write' };

async function fixture(options: { storageAvailable?: (bytes: number) => boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-hosted-git-'));
  const store = await Store.create(':memory:', { hosted: true });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const id = newId('repo');
  const repository: Repository = await store.upsertRepository({ id, organizationId: organization.id, provider: 'tavya',
    owner: organization.id, name: 'app', sshUrl: hostedRepositoryUrl(id, 'app'), defaultBranch: 'main', private: true });
  const pushed: string[][] = [];
  const host = (cache: string) => new HostedGit({ store, objects, broker, cacheDir: path.join(dir, cache),
    authorize: async (token, _repository, access) => PEOPLE[token] === 'write' || (PEOPLE[token] === 'read' && access === 'read'),
    storageAvailable: async (_organization, bytes) => options.storageAvailable?.(bytes) ?? true,
    onPushed: (_repository, changed) => pushed.push(changed) });
  const serve = async (hosted: HostedGit) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith(HOSTED_GIT_ROUTE)) { res.writeHead(404); return void res.end(); }
      void hosted.handle(req, res, url.pathname.slice(HOSTED_GIT_ROUTE.length) + url.search);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const hosted = host('cache-a');
  const base = await serve(hosted);
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  /** A clone URL that carries `token` as the password, as a credential helper would supply it. */
  const authed = (url: string, token: string) => url.replace('http://', `http://x:${token}@`);
  const work = (name: string) => fs.mkdtempSync(path.join(dir, `${name}-`));
  return { dir, store, broker, objects, organization, repository, hosted, host, serve, base, authed, work, pushed };
}

describe('repositories tavya hosts', () => {
  it('starts with a first commit on its default branch, and takes and serves pushes over smart HTTP', async () => {
    const f = await fixture();
    await f.hosted.create(f.repository);
    const url = f.authed(hostedCloneUrl(f.base, f.repository), 'writer-token');
    const clone = path.join(f.work('one'), 'app');
    await must(path.dirname(clone), ['clone', '-q', url, clone]);
    expect(await must(clone, ['branch', '--show-current'])).toBe('main');
    expect(await must(clone, ['log', '--format=%s'])).toBe('Create app');

    fs.writeFileSync(path.join(clone, 'README.md'), '# app\nsecret-looking plaintext\n');
    await must(clone, ['add', '.']); await must(clone, ['commit', '-qm', 'Readme']);
    await must(clone, ['push', '-q', 'origin', 'main']);
    await must(clone, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(clone, 'feature.txt'), 'more\n');
    await must(clone, ['add', '.']); await must(clone, ['commit', '-qm', 'Feature']);
    await must(clone, ['push', '-q', 'origin', 'feature']);
    expect(f.pushed).toEqual([['refs/heads/main'], ['refs/heads/feature']]);

    const state = await f.store.getHostedRepository(f.repository.id);
    expect(state).toMatchObject({ head: 'refs/heads/main', version: 3,
      refs: { 'refs/heads/main': await must(clone, ['rev-parse', 'main']), 'refs/heads/feature': await must(clone, ['rev-parse', 'feature']) } });
    expect(state!.packs).toHaveLength(3);
    expect(state!.bytes).toBe(state!.packs.reduce((total, pack) => total + pack.bytes, 0));
    // Sealed: the store never holds the repository's content in the clear.
    for (const pack of state!.packs) {
      const stored = await f.objects.get(packPartKey(state!, pack.id, 0));
      expect(stored.subarray(0, 4).toString()).toBe('KRG1');
      expect(stored.includes(Buffer.from('PACK'))).toBe(false);
    }
    // What a push stored, the store's references name; nothing else.
    expect(await f.store.objectKeyReferenced(packPartKey(state!, state!.packs[1]!.id, 0))).toBe(true);
    expect(await f.store.objectKeyReferenced(packPartKey(state!, 'p-gone', 0))).toBe(false);
  });

  it('keeps every push in the object store: a host with no cache, or a new one, serves the same repository', async () => {
    const f = await fixture();
    await f.hosted.create(f.repository);
    const clone = path.join(f.work('one'), 'app');
    await must(path.dirname(clone), ['clone', '-q', f.authed(hostedCloneUrl(f.base, f.repository), 'writer-token'), clone]);
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(clone, `${n}.txt`), `${n}\n`);
      await must(clone, ['add', '.']); await must(clone, ['commit', '-qm', `Commit ${n}`]);
      await must(clone, ['push', '-q', 'origin', 'main']);
    }
    const tip = await must(clone, ['rev-parse', 'HEAD']);
    // The cache is disposable.
    fs.rmSync(path.join(f.dir, 'cache-a'), { recursive: true, force: true });
    const again = path.join(f.work('two'), 'app');
    await must(path.dirname(again), ['clone', '-q', f.authed(hostedCloneUrl(f.base, f.repository), 'reader-token'), again]);
    expect(await must(again, ['rev-parse', 'HEAD'])).toBe(tip);
    expect(fs.readFileSync(path.join(again, '3.txt'), 'utf8')).toBe('3\n');

    // Another host, its own cache, the same database and store; then the first
    // host catches up with a push the other took.
    const other = await f.serve(f.host('cache-b'));
    const third = path.join(f.work('three'), 'app');
    await must(path.dirname(third), ['clone', '-q', f.authed(hostedCloneUrl(other, f.repository), 'writer-token'), third]);
    fs.writeFileSync(path.join(third, '4.txt'), '4\n');
    await must(third, ['add', '.']); await must(third, ['commit', '-qm', 'Commit 4']);
    await must(third, ['push', '-q', 'origin', 'main']);
    await must(clone, ['pull', '-q', '--ff-only', 'origin', 'main']);
    expect(await must(clone, ['rev-parse', 'HEAD'])).toBe(await must(third, ['rev-parse', 'HEAD']));
  });

  it('asks for a token, keeps unknown and forbidden alike, and lets a reader only read', async () => {
    const f = await fixture();
    await f.hosted.create(f.repository);
    const url = hostedCloneUrl(f.base, f.repository);
    const anonymous = await fetch(`${url}/info/refs?service=git-upload-pack`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^Basic realm="tavya"/);
    const basic = (token: string) => ({ authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` });
    expect((await fetch(`${url}/info/refs?service=git-upload-pack`, { headers: basic('stranger') })).status).toBe(404);
    expect((await fetch(`${f.base}/git/repo_nothere/app.git/info/refs?service=git-upload-pack`, { headers: basic('writer-token') })).status).toBe(404);
    // Only the smart protocol: no browsing the repository's files.
    expect((await fetch(`${url}/HEAD`, { headers: basic('writer-token') })).status).toBe(404);

    const clone = path.join(f.work('reader'), 'app');
    await must(path.dirname(clone), ['clone', '-q', f.authed(url, 'reader-token'), clone]);
    fs.writeFileSync(path.join(clone, 'x.txt'), 'x\n');
    await must(clone, ['add', '.']); await must(clone, ['commit', '-qm', 'Nope']);
    expect((await run(clone, ['push', '-q', 'origin', 'main'])).code).not.toBe(0);
    expect((await f.store.getHostedRepository(f.repository.id))!.version).toBe(1);

    // A signed grant opens only its own repository, and a read grant only reads.
    const read = await f.hosted.tokens.mint({ repository: f.repository.id, access: 'read', expiresAt: Date.now() + 60_000 });
    const elsewhere = await f.hosted.tokens.mint({ repository: 'repo_other', access: 'write', expiresAt: Date.now() + 60_000 });
    const expired = await f.hosted.tokens.mint({ repository: f.repository.id, access: 'write', expiresAt: Date.now() - 1 });
    expect((await fetch(`${url}/info/refs?service=git-upload-pack`, { headers: basic(read) })).status).toBe(200);
    expect((await fetch(`${url}/info/refs?service=git-receive-pack`, { headers: basic(read) })).status).toBe(404);
    expect((await fetch(`${url}/info/refs?service=git-upload-pack`, { headers: basic(elsewhere) })).status).toBe(404);
    expect((await fetch(`${url}/info/refs?service=git-upload-pack`, { headers: basic(expired) })).status).toBe(404);
    expect((await fetch(`${url}/info/refs?service=git-upload-pack`, { headers: basic(`${read.slice(0, -2)}xx`) })).status).toBe(404);
  });

  it('refuses a push over the storage quota and keeps the repository as it was', async () => {
    let room = true;
    const f = await fixture({ storageAvailable: () => room });
    await f.hosted.create(f.repository);
    const clone = path.join(f.work('one'), 'app');
    await must(path.dirname(clone), ['clone', '-q', f.authed(hostedCloneUrl(f.base, f.repository), 'writer-token'), clone]);
    const before = await f.store.getHostedRepository(f.repository.id);
    room = false;
    fs.writeFileSync(path.join(clone, 'big.txt'), 'x'.repeat(10_000));
    await must(clone, ['add', '.']); await must(clone, ['commit', '-qm', 'Too much']);
    const refused = await run(clone, ['push', 'origin', 'main']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/507|storage is full/i);
    expect(await f.store.getHostedRepository(f.repository.id)).toEqual(before);
    // The cache did not keep the refused ref either.
    const fresh = path.join(f.work('two'), 'app');
    await must(path.dirname(fresh), ['clone', '-q', f.authed(hostedCloneUrl(f.base, f.repository), 'reader-token'), fresh]);
    expect(await must(fresh, ['log', '--format=%s'])).toBe('Create app');
    room = true;
    await must(clone, ['push', '-q', 'origin', 'main']);
    expect((await f.store.getHostedRepository(f.repository.id))!.version).toBe(before!.version + 1);
  });

  it('rewrites a long history of packs as one, deleting the old ones', async () => {
    const f = await fixture();
    await f.hosted.create(f.repository);
    const clone = path.join(f.work('one'), 'app');
    await must(path.dirname(clone), ['clone', '-q', f.authed(hostedCloneUrl(f.base, f.repository), 'writer-token'), clone]);
    const first = (await f.store.getHostedRepository(f.repository.id))!.packs[0]!;
    for (let n = 0; n < 24; n++) {
      fs.writeFileSync(path.join(clone, 'n.txt'), `${n}\n`);
      await must(clone, ['add', '.']); await must(clone, ['commit', '-qm', `n ${n}`]);
      await must(clone, ['push', '-q', 'origin', 'main']);
    }
    const state = (await f.store.getHostedRepository(f.repository.id))!;
    expect(state.packs).toHaveLength(1);
    expect(state.packs[0]!.id).not.toBe(first.id);
    await expect(f.objects.get(packPartKey(state, first.id, 0))).rejects.toThrow();
    fs.rmSync(path.join(f.dir, 'cache-a'), { recursive: true, force: true });
    const again = path.join(f.work('two'), 'app');
    await must(path.dirname(again), ['clone', '-q', f.authed(hostedCloneUrl(f.base, f.repository), 'reader-token'), again]);
    expect(await must(again, ['rev-parse', 'HEAD'])).toBe(await must(clone, ['rev-parse', 'HEAD']));
    expect(Number(await must(again, ['rev-list', '--count', 'HEAD']))).toBe(25);
  });

  it('gives the Git broker a credential that reaches it by the repository\'s stable tavya: URL', async () => {
    const f = await fixture();
    await f.hosted.create(f.repository);
    const previous = process.env.KARMAX_GATEWAY_URL;
    process.env.KARMAX_GATEWAY_URL = f.base;
    cleanups.push(() => { if (previous === undefined) delete process.env.KARMAX_GATEWAY_URL; else process.env.KARMAX_GATEWAY_URL = previous; });
    const credential = await f.hosted.brokerCredentials(f.repository);
    expect(credential.mirrorScope).toBe(f.repository.id);
    const scratch = f.work('broker');
    const material = materializeGitCredential(scratch, credential);
    const env = { ...gitEnv, ...material.env };
    const clone = path.join(scratch, 'app');
    await must(scratch, ['clone', '-q', f.repository.sshUrl, clone], env);
    fs.writeFileSync(path.join(clone, 'task.txt'), 'done\n');
    await must(clone, ['add', '.']); await must(clone, ['commit', '-qm', 'Task']);
    await must(clone, ['push', '-q', 'origin', 'HEAD:refs/heads/tavya/task_1'], env);
    expect((await f.store.getHostedRepository(f.repository.id))!.refs['refs/heads/tavya/task_1']).toBe(await must(clone, ['rev-parse', 'HEAD']));
  });

  it('serves a repository whose name contains ".git"', async () => {
    const f = await fixture();
    const id = newId('repo');
    const pages = await f.store.upsertRepository({ id, organizationId: f.organization.id, provider: 'tavya',
      owner: f.organization.id, name: 'my.github-io', sshUrl: hostedRepositoryUrl(id, 'my.github-io'), defaultBranch: 'main', private: true });
    await f.hosted.create(pages);
    const clone = path.join(f.work('pages'), 'site');
    await must(path.dirname(clone), ['clone', '-q', f.authed(hostedCloneUrl(f.base, pages), 'writer-token'), clone]);
    fs.writeFileSync(path.join(clone, 'index.html'), '<h1>hi</h1>\n');
    await must(clone, ['add', '.']); await must(clone, ['commit', '-qm', 'Page']);
    await must(clone, ['push', '-q', 'origin', 'main']);
    expect((await f.store.getHostedRepository(id))!.refs['refs/heads/main']).toBe(await must(clone, ['rev-parse', 'HEAD']));
  });

  it('deletes its packs and row with the repository', async () => {
    const f = await fixture();
    await f.hosted.create(f.repository);
    const state = (await f.store.getHostedRepository(f.repository.id))!;
    await f.hosted.remove(f.repository);
    expect(await f.store.getHostedRepository(f.repository.id)).toBeUndefined();
    await expect(f.objects.get(packPartKey(state, state.packs[0]!.id, 0))).rejects.toThrow();
    expect(fs.existsSync(path.join(f.dir, 'cache-a', `${f.repository.id}.git`))).toBe(false);
  });
});


describe('a task on a repository tavya hosts', () => {
  it('is set up from it with a read grant, and lands in it through the Git broker', async () => {
    const f = await fixture();
    await f.hosted.create(f.repository);
    registerHostedGit(f.hosted);
    const saved = { gateway: process.env.KARMAX_GATEWAY_URL, public: process.env.KARMAX_PUBLIC_URL };
    process.env.KARMAX_GATEWAY_URL = f.base;
    process.env.KARMAX_PUBLIC_URL = f.base;
    cleanups.push(() => {
      registerHostedGit(undefined);
      for (const [key, value] of [['KARMAX_GATEWAY_URL', saved.gateway], ['KARMAX_PUBLIC_URL', saved.public]] as const)
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });

    // Set-up in the sandbox: a clone of the stable tavya: URL with a read grant
    // and its rewrite to the public address, as a cloud world gets them.
    const clone = await hostedCloneCredential(f.repository);
    expect(clone.base).toBe(`${f.base}/git/`);
    const sandbox = f.work('sandbox');
    const home = path.join(sandbox, 'home');
    const target: ProvisionTarget = {
      run: (command, timeoutMs) => runLocalCommand('bash', ['-c', command], { env: { ...gitEnv, HOME: home }, timeoutMs }),
      async writeFile(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode: 0o700 }); },
    };
    const spec = { taskId: 'task_1', base: 'main', repo: f.repository.sshUrl,
      gitCredentials: { httpsTokens: { [f.repository.sshUrl]: clone.token }, hostedGitBase: clone.base } };
    await provisionGitCredentials(target, spec, home);
    const provisioned = await provisionGitRepos(target, spec,
      { root: path.join(sandbox, 'w'), home, sshUrlError: 'not a repository', copyGlobsWarning: 'nothing copied' });
    expect(provisioned.repos[0]).toMatchObject({ repo: f.repository.sshUrl, base: 'main' });
    expect(await must(provisioned.root, ['log', '--format=%s', 'origin/main'])).toBe('Create app');
    // A read grant reads, and no more.
    const refused = await run(provisioned.root, ['push', 'origin', 'HEAD:refs/heads/sneaky'],
      { ...gitEnv, HOME: home, GIT_ASKPASS: path.join(home, '.ssh/karmax-auth-askpass-0'), GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${clone.base}.insteadOf`, GIT_CONFIG_VALUE_0: 'tavya:' });
    expect(refused.code).not.toBe(0);

    // The agent's work, in a world the broker sees as a cloud one.
    const local = path.join(f.work('origin'), 'app');
    await must(path.dirname(local), ['clone', '-q', f.authed(hostedCloneUrl(f.base, f.repository), 'reader-token'), local]);
    const world = await new WorktreeProvider(path.join(f.dir, 'worlds')).create({ taskId: 'task_1', repo: local, base: 'main' });
    world.handle.kind = 'e2b';
    Object.assign(world.handle.repos![0]!, { repo: f.repository.sshUrl });
    delete world.handle.repos![0]!.localPath;
    fs.writeFileSync(path.join(world.handle.root, 'hello.txt'), 'hi\n');
    await must(world.handle.root, ['add', '.']);
    await must(world.handle.root, ['commit', '-qm', 'Say hi']);
    const auth = async () => repositoryBrokerCredentials(f.repository, undefined);
    const published = await brokerPublishBranch(world, auth);
    expect(published).toEqual({ pushed: [world.handle.repos![0]!.name], skipped: [] });
    const branch = world.handle.repos![0]!.branch;
    expect((await f.store.getHostedRepository(f.repository.id))!.refs[`refs/heads/${branch}`]).toBe(await must(world.handle.root, ['rev-parse', 'HEAD']));

    const landed = await brokerFinalizeMerge(world, 'main', { name: 'tavya', email: 'tavya@example.com' }, auth);
    expect(landed.merged).toBe(true);
    const state = (await f.store.getHostedRepository(f.repository.id))!;
    expect(state.refs['refs/heads/main']).toBe(landed.sha);
    const after = path.join(f.work('after'), 'app');
    await must(path.dirname(after), ['clone', '-q', f.authed(hostedCloneUrl(f.base, f.repository), 'reader-token'), after]);
    expect(fs.readFileSync(path.join(after, 'hello.txt'), 'utf8')).toBe('hi\n');
  });
});

describe('the Files tab', () => {
  it('reads a project\'s tavya repository through the project\'s credential, as it reads GitHub\'s', async () => {
    const f = await fixture();
    await f.hosted.create(f.repository);
    registerHostedGit(f.hosted);
    const saved = process.env.KARMAX_GATEWAY_URL;
    process.env.KARMAX_GATEWAY_URL = f.base;
    cleanups.push(() => { registerHostedGit(undefined); if (saved === undefined) delete process.env.KARMAX_GATEWAY_URL; else process.env.KARMAX_GATEWAY_URL = saved; });
    const clone = path.join(f.work('one'), 'app');
    await must(path.dirname(clone), ['clone', '-q', f.authed(hostedCloneUrl(f.base, f.repository), 'writer-token'), clone]);
    fs.writeFileSync(path.join(clone, 'README.md'), '# app\n');
    await must(clone, ['add', '.']); await must(clone, ['commit', '-qm', 'Readme']);
    await must(clone, ['push', '-q', 'origin', 'main']);

    const project = await f.store.createProject('App', {}, f.organization.id);
    await f.store.attachProjectRepository({ projectId: project.id, repositoryId: f.repository.id });
    const credential = await projectRepositoryCredential(f.store, { hosted: true })(project.id, f.repository.sshUrl);
    const scratch = f.work('files');
    const env = materializeGitCredential(scratch, credential).env;
    const listed = await readMirrored(f.repository.sshUrl, env, { branch: 'main', scratch, scope: credential.mirrorScope },
      async (repository, commit) => (await must(repository, ['ls-tree', '--name-only', commit])).split('\n'));
    expect(listed).toEqual(['README.md']);
  });
});
