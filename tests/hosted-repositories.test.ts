import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdentityService } from '../src/auth/identity.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { HostedGit, hostedCloneUrl, registerHostedGit } from '../src/world/hosted-git.js';
import type { Repository } from '../src/domain/types.js';
import { paths } from '../src/config/paths.js';
import { wikiRoot as projectWikiRoot } from '../src/wiki/wiki.js';

/**
 * Repositories tavya hosts, through the gateway: made with the API, used with
 * `git` and a person's own token, kept out of projects on GitHub, deleted and
 * moved to GitHub (wiki features/hosted-repositories).
 */
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Nadia', GIT_AUTHOR_EMAIL: 'nadia@example.com', GIT_COMMITTER_NAME: 'Nadia', GIT_COMMITTER_EMAIL: 'nadia@example.com' };
/** Git runs as its own process: the gateway it talks to is in this one. */
const git = (cwd: string, args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
  execFile('git', args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) =>
    resolve({ code: error ? Number((error as { code?: unknown }).code) || 1 : 0, stdout: stdout.trim(), stderr })));

let dir: string;
let store: Store;
let url: string;
let cookie: string;
let organizationId: string;
let close: () => Promise<void>;
const previousDeployment = process.env.KARMAX_DEPLOYMENT;
const previousGateway = process.env.KARMAX_GATEWAY_URL;
/** The GitHub the move goes to: bare repositories on disk, by `owner/name`. */
const github = new Map<string, string>();

beforeAll(async () => {
  process.env.KARMAX_DEPLOYMENT = 'hosted';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-hosted-repositories-'));
  const port = await findFreePortFrom(48530);
  const identity = await IdentityService.open(':memory:', { baseURL: `http://127.0.0.1:${port}` });
  store = await Store.create(':memory:', { hosted: true });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const hostedGit = new HostedGit({ store, objects: new LocalObjectStore(path.join(dir, 'objects')), broker, cacheDir: path.join(dir, 'cache') });
  registerHostedGit(hostedGit);
  const githubApp = new Proxy({
    configured: async () => true,
    async createRepository(connectionId: string, _userId: string, input: { name: string }) {
      const connection = await store.getGitConnection(connectionId);
      const bare = path.join(dir, 'github', `${connection!.accountLogin}-${input.name}.git`);
      fs.mkdirSync(bare, { recursive: true });
      await git(bare, ['init', '-q', '--bare']);
      github.set(`${connection!.accountLogin}/${input.name}`, bare);
      return store.upsertRepository({ organizationId: connection!.organizationId, provider: 'github', owner: connection!.accountLogin,
        name: input.name, sshUrl: `git@github.com:${connection!.accountLogin}/${input.name}.git`, defaultBranch: 'main', private: true,
        gitConnectionId: connection!.id });
    },
    // A project wiki moving with its code: made like any repository (a retry would adopt it).
    async ensureRepository(connectionId: string, userId: string, input: { name: string }) {
      return github.has(`${(await store.getGitConnection(connectionId))!.accountLogin}/${input.name}`)
        ? (await store.listRepositories(organizationId)).find((candidate) => candidate.provider === 'github' && candidate.name === input.name)!
        : this.createRepository(connectionId, userId, input);
    },
    async brokerCredentials(repository: Repository) {
      // The installation token's stand-in: the GitHub URL, rewritten to the repository on disk.
      return { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${github.get(`${repository.owner}/${repository.name}`)}.insteadOf`,
        GIT_CONFIG_VALUE_0: repository.sshUrl }, mirrorScope: repository.id };
    },
  }, { get: (target, key) => (target as any)[key] ?? (async () => undefined) }) as any;
  const gateway = await Gateway.create({
    api: {} as any, store, bus: new KarmaxBus(), tokens: new TokenAuthority(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), client: {} as any, taskQueue: 'test', staticDir: process.cwd(),
    agentInfo: { provider: 'mock', reason: 'hosted repositories test' }, identity,
    authorization: await AuthorizationService.create(store), worlds: new WorldRegistry(), broker, hosted: true, hostedGit, githubApp,
  });
  const running = await gateway.listen(port);
  url = running.url;
  // Where the broker reaches tavya's Git (a project wiki's publication).
  process.env.KARMAX_GATEWAY_URL = url;
  close = async () => { await running.close(); registerHostedGit(undefined); };
  const setup = await fetch(`${url}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Nadia', email: 'nadia@example.com', password: 'long-enough-password' }) });
  expect(setup.status).toBe(200);
  cookie = setup.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
  organizationId = 'org_personal';
});

afterAll(async () => {
  await close?.();
  await store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (previousDeployment === undefined) delete process.env.KARMAX_DEPLOYMENT; else process.env.KARMAX_DEPLOYMENT = previousDeployment;
  if (previousGateway === undefined) delete process.env.KARMAX_GATEWAY_URL; else process.env.KARMAX_GATEWAY_URL = previousGateway;
});

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const call = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${url}${route}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json().catch(() => undefined) as any };
};
const token = async (level: string) => (await call('POST', '/api/user/tokens', { name: level, level, expiresInDays: 1 })).body.token as string;
const withToken = (cloneUrl: string, secret: string) => cloneUrl.replace('http://', `http://x:${secret}@`);
const workdir = () => { const work = fs.mkdtempSync(path.join(dir, 'work-')); cleanups.push(() => fs.rmSync(work, { recursive: true, force: true })); return work; };

describe('repositories tavya hosts, through the gateway', () => {
  it('are made with the API, start a project that lands by pushing, and take a person\'s own token in git', async () => {
    const created = await call('POST', `/api/organizations/${organizationId}/repositories/create`, { provider: 'tavya', name: 'notes' });
    expect(created.status).toBe(200);
    const repository = created.body as Repository;
    expect(repository).toMatchObject({ provider: 'tavya', name: 'notes', owner: organizationId, defaultBranch: 'main',
      sshUrl: `tavya:${repository.id}/notes.git` });
    expect((await call('POST', `/api/organizations/${organizationId}/repositories/create`, { provider: 'tavya', name: 'Notes' })).status).toBe(409);
    expect((await call('POST', `/api/organizations/${organizationId}/repositories/create`, { provider: 'tavya', name: 'no spaces' })).status).toBe(400);

    const project = (await call('POST', `/api/organizations/${organizationId}/projects`, { name: 'Notes', repos: [repository.sshUrl] })).body;
    expect((await store.effectiveProjectConfig(project.id))).toMatchObject({ repos: [repository.sshUrl], remote: 'push' });

    const writer = await token('developer');
    const clone = path.join(workdir(), 'notes');
    const cloned = await git(path.dirname(clone), ["clone", "-q", withToken(hostedCloneUrl(url, repository), writer), clone]);
    expect(cloned.stderr).toBe("");
    expect(cloned.code).toBe(0);
    fs.writeFileSync(path.join(clone, 'todo.md'), '- buy milk\n');
    await git(clone, ['add', '.']); await git(clone, ['commit', '-qm', 'Todo']);
    const pushedMain = await git(clone, ['push', '-q', 'origin', 'main']);
    expect(pushedMain.stderr).toBe('');
    expect(pushedMain.code).toBe(0);
    expect((await store.getHostedRepository(repository.id))!.refs['refs/heads/main']).toBe((await git(clone, ['rev-parse', 'HEAD'])).stdout);

    // A viewer reads, never writes; a token that is not one reads nothing.
    const viewer = await token('viewer');
    const read = path.join(workdir(), 'notes');
    expect((await git(path.dirname(read), ['clone', '-q', withToken(hostedCloneUrl(url, repository), viewer), read])).code).toBe(0);
    fs.writeFileSync(path.join(read, 'todo.md'), '- nothing\n');
    await git(read, ['commit', '-qam', 'Nope']);
    expect((await git(read, ['push', '-q', 'origin', 'main'])).code).not.toBe(0);
    expect((await git(workdir(), ['clone', '-q', withToken(hostedCloneUrl(url, repository), 'tvp_not-a-token'), 'x'])).code).not.toBe(0);

    // A project's repositories live all on tavya or all on GitHub.
    const onGithub = await store.upsertRepository({ organizationId, provider: 'github', owner: 'acme', name: 'site',
      sshUrl: 'git@github.com:acme/site.git', defaultBranch: 'main', private: true });
    const mixed = await call('PUT', `/api/projects/${project.id}/repository-sources`, { repos: [repository.sshUrl, onGithub.sshUrl] });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error).toMatch(/all on tavya or all on GitHub/);
    expect((await store.listProjectRepositories(project.id)).map((linked) => linked.repositoryId)).toEqual([repository.id]);

    // Deleted only once no project uses it, and its data with it.
    expect((await call('DELETE', `/api/organizations/${organizationId}/repositories/${repository.id}`)).status).toBe(409);
    expect((await call('PUT', `/api/projects/${project.id}/repository-sources`, { repos: [] })).status).toBe(200);
    expect((await call('DELETE', `/api/organizations/${organizationId}/repositories/${repository.id}`)).status).toBe(200);
    expect(await store.getRepository(repository.id)).toBeUndefined();
    expect(await store.getHostedRepository(repository.id)).toBeUndefined();
    // GitHub's are deleted on GitHub.
    expect((await call('DELETE', `/api/organizations/${organizationId}/repositories/${onGithub.id}`)).status).toBe(400);
  });

  it('clone with the tavya CLI, its own sign-in the only credential, and take pushes back', async () => {
    const repository = (await call('POST', `/api/organizations/${organizationId}/repositories/create`, { provider: 'tavya', name: 'cli-notes' })).body as Repository;
    const project = (await call('POST', `/api/organizations/${organizationId}/projects`, { name: 'CLI notes', repos: [repository.sshUrl] })).body;
    const laptop = workdir();
    const tavya = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile(process.execPath, [path.resolve('bin/tavya.js'), ...args], { cwd: laptop, timeout: 60_000,
        env: { ...gitEnv, TAVYA_URL: url, KARMAX_TOKEN: '', KARMAX_GATEWAY_URL: '', TAVYA_CONFIG_DIR: path.join(laptop, '.config'),
          TAVYA_CACHE_DIR: path.join(laptop, '.cache'), TAVYA_NO_KEYCHAIN: '1', TAVYA_TOKEN: personal } },
      (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: unknown }).code) || 1 : 0, stdout, stderr })));
    const personal = await token('developer');
    const cloned = await tavya(['clone', project.id, 'ws']);
    expect(cloned.stderr).not.toMatch(/failed/);
    expect(cloned.code).toBe(0);
    const checkout = fs.existsSync(path.join(laptop, 'ws', 'cli-notes', '.git')) ? path.join(laptop, 'ws', 'cli-notes') : path.join(laptop, 'ws');
    expect((await git(checkout, ['log', '--format=%s'])).stdout).toBe('Create cli-notes');
    // Git asks `tavya git-credential` for this server, and nothing else.
    expect((await git(checkout, ['remote', 'get-url', 'origin'])).stdout).toBe(hostedCloneUrl(url, repository));
    fs.writeFileSync(path.join(checkout, 'idea.md'), 'one\n');
    await git(checkout, ['add', '.']); await git(checkout, ['commit', '-qm', 'Idea']);
    const pushed = await new Promise<{ code: number; stderr: string }>((resolve) => execFile('git', ['push', '-q', 'origin', 'main'],
      { cwd: checkout, env: { ...gitEnv, TAVYA_URL: url, TAVYA_TOKEN: personal, TAVYA_CONFIG_DIR: path.join(laptop, '.config'), TAVYA_NO_KEYCHAIN: '1' } },
      (error, _stdout, stderr) => resolve({ code: error ? 1 : 0, stderr })));
    expect(pushed.stderr).toBe('');
    expect((await store.getHostedRepository(repository.id))!.refs['refs/heads/main']).toBe((await git(checkout, ['rev-parse', 'HEAD'])).stdout);
  });

  it('moves to GitHub with every branch, taking its place in the project, which then opens pull requests', async () => {
    const repository = (await call('POST', `/api/organizations/${organizationId}/repositories/create`, { provider: 'tavya', name: 'shop' })).body as Repository;
    const project = (await call('POST', `/api/organizations/${organizationId}/projects`, { name: 'Shop', repos: [repository.sshUrl] })).body;
    const clone = path.join(workdir(), 'shop');
    await git(path.dirname(clone), ['clone', '-q', withToken(hostedCloneUrl(url, repository), await token('developer')), clone]);
    fs.writeFileSync(path.join(clone, 'index.html'), '<h1>Shop</h1>\n');
    await git(clone, ['add', '.']); await git(clone, ['commit', '-qm', 'Page']);
    await git(clone, ['push', '-q', 'origin', 'main']);
    await git(clone, ['push', '-q', 'origin', 'main:refs/heads/draft']);

    // The project's wiki is on tavya with its code (tavya-error 1d0724aaf3e40071).
    const wikiRoot = projectWikiRoot(paths().content, 'project', project.id);
    let wiki: Repository | undefined;
    for (let i = 0; i < 100 && !(wiki && (await store.getHostedRepository(wiki.id))?.refs['refs/heads/main']); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      wiki = (await store.projectWiki(project.id))?.repository;
    }
    expect(wiki).toMatchObject({ provider: 'tavya', name: `shop-wiki-${project.id.slice(-8)}` });
    expect((await store.getHostedRepository(wiki!.id))!.refs['refs/heads/main']).toBe((await git(wikiRoot, ['rev-parse', 'main'])).stdout);

    const connection = await store.upsertGitConnection({ organizationId, provider: 'github', installationId: '1', accountLogin: 'nadia' });
    const moved = await call('POST', `/api/organizations/${organizationId}/repositories/${repository.id}/move-to-github`, { gitConnectionId: connection.id });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ provider: 'github', owner: 'nadia', name: 'shop', sshUrl: 'git@github.com:nadia/shop.git' });
    const bare = github.get('nadia/shop')!;
    const tip = (await git(clone, ['rev-parse', 'main'])).stdout;
    expect((await git(bare, ['rev-parse', 'refs/heads/main'])).stdout).toBe(tip);
    expect((await git(bare, ['rev-parse', 'refs/heads/draft'])).stdout).toBe(tip);
    expect((await store.listProjectRepositories(project.id)).map((linked) => linked.repositoryId)).toEqual([moved.body.id]);
    expect(await store.effectiveProjectConfig(project.id)).toMatchObject({ repos: ['git@github.com:nadia/shop.git'], remote: 'pr' });
    expect(await store.getRepository(repository.id)).toBeUndefined();
    expect(await store.getHostedRepository(repository.id)).toBeUndefined();
    // Its wiki went along: one host per project.
    const movedWiki = (await store.projectWiki(project.id))?.repository;
    expect(movedWiki).toMatchObject({ provider: 'github', owner: 'nadia', name: wiki!.name, private: true });
    expect((await git(github.get(`nadia/${wiki!.name}`)!, ['rev-parse', 'refs/heads/main'])).stdout)
      .toBe((await git(wikiRoot, ['rev-parse', 'main'])).stdout);
    expect((await git(wikiRoot, ['remote', 'get-url', 'origin'])).stdout).toBe(movedWiki!.sshUrl);
    expect(await store.getRepository(wiki!.id)).toBeUndefined();
    expect(await store.getHostedRepository(wiki!.id)).toBeUndefined();
  });
});
