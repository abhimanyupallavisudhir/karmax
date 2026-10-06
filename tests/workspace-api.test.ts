import { afterEach, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { ProjectEnvironment } from '../src/store/project-environment.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { WorldHandoffService } from '../src/world/handoff.js';
import { runHostRestic } from '../src/world/restic.js';
import { DEFAULT_AUTHORIZATION_PROFILES } from '../src/platform/authorization.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const capsOf = (level: string) => DEFAULT_AUTHORIZATION_PROFILES.find((profile) => profile.id === level)!.capabilities;

/** A real gateway, store, vault and repository server, with real restic: what
 * the tavya CLI talks to (wiki planned/tavya-cli). */
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-workspace-api-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const project = await store.createProject('Site Builder');
  const repository = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
    providerId: '1', owner: 'acme', name: 'site', sshUrl: 'git@github.com:acme/site.git', defaultBranch: 'main', private: true });
  await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
  const wiki = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
    providerId: '2', owner: 'acme', name: 'site-wiki', sshUrl: 'git@github.com:acme/site-wiki.git', defaultBranch: 'main', private: true });
  await store.setProjectWikiRepository(project.id, wiki.id);
  await new ProjectEnvironment(store).setSpec(project.id, { install: { site: ['npm ci'] }, setup: ['apt-get install -y jq'] });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
  const tokens = new TokenAuthority(store);
  const client = { workflow: { getHandle: () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', resources });
  const handoffs = new WorldHandoffService(store, worlds, {} as any, undefined, undefined, path.join(dir, 'checkouts'), resources);
  const gateway = await Gateway.create({ api, store, tokens, client, worlds, taskQueue: 'test', resources, broker, handoffs,
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(), staticDir: 'web',
    agentInfo: { provider: 'mock', reason: 'workspace api test' } });
  const server = await gateway.listen(await findFreePortFrom(49_700));
  cleanups.push(() => server.close());
  const data = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'raw_data', driver: 'volume@1', target: { kind: 'path', path: 'data' }, access: 'write', isolation: 'fork',
    source: {}, credentialHandles: [], publish: 'review' });
  const corpus = Array.from({ length: 20 }, (_, i) => ({ path: `pages/${i}.txt`, data: crypto.randomBytes(500 + i) }));
  const first = await resources.importFiles(data.id, corpus);
  const post = async (pathname: string, token: string, body: unknown = {}) => fetch(`${server.url}${pathname}`,
    { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = async (pathname: string, token: string) => fetch(`${server.url}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
  const tokenFor = async (level: string) => (await tokens.mintPrincipal('user:alice', capsOf(level), project.id)).token;
  return { dir, store, project, broker, resources, data, first, corpus, server, post, get, tokenFor };
}

it('describes a project as the world tasks get: layout, repositories with the wiki, resources, secret names, install commands', async () => {
  const f = await fixture();
  await f.post(`/api/projects/${f.project.id}/secrets`, await f.tokenFor('maintainer'), { env: 'API_KEY=s3cret\n' });
  const response = await f.get(`/api/projects/${f.project.id}/workspace`, await f.tokenFor('viewer'));
  expect(response.status).toBe(200);
  const manifest = await response.json();
  expect(manifest).toMatchObject({ version: 1, project: { id: f.project.id, name: 'Site Builder' }, directory: 'site-builder', workdir: 'site',
    repositories: [{ name: 'site', role: 'development', sshUrl: 'git@github.com:acme/site.git', branch: 'main' },
      { name: 'site-wiki', role: 'project-wiki', sshUrl: 'git@github.com:acme/site-wiki.git', branch: 'main' }],
    resources: [{ id: f.data.id, name: 'raw_data', path: 'site/data', shape: 'directory', access: 'write',
      revisionId: f.first.id, files: 20, transferable: true }],
    secrets: [{ name: 'API_KEY', variable: 'API_KEY', configured: true }],
    install: [{ repository: 'site', commands: ['npm ci'] }] });
  expect(JSON.stringify(manifest)).not.toContain('s3cret');
  // /api/meta tells the CLI the oldest version it still speaks to.
  expect((await (await fetch(`${f.server.url}/api/meta`)).json()).cli).toEqual({ minVersion: '1.0.0' });
});

it('pulls a version with a read grant and pushes a new one with an append grant, refusing a stale base', async () => {
  const f = await fixture();
  const developer = await f.tokenFor('developer');
  const read = await (await f.post(`/api/projects/${f.project.id}/resources/${f.data.id}/read-grant`, developer)).json();
  expect(read).toMatchObject({ revisionId: f.first.id, snapshot: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(read.env.RESTIC_REPOSITORY).toMatch(new RegExp(`^rest:${f.server.url}/resource-repositories/${f.data.id}@`));
  const local = path.join(f.dir, 'laptop', 'data');
  expect((await runHostRestic(['restore', read.snapshot, '--target', local, '--no-lock', '--no-cache'], read.env)).code).toBe(0);
  for (const file of f.corpus) expect(fs.readFileSync(path.join(local, file.path)).equals(file.data)).toBe(true);

  // A Developer may read the data but not change the project's version.
  expect((await f.post(`/api/projects/${f.project.id}/resources/${f.data.id}/append-grant`, developer)).status).toBe(403);
  const maintainer = await f.tokenFor('maintainer');
  fs.writeFileSync(path.join(local, 'pages/new.txt'), 'added on a laptop');
  fs.rmSync(path.join(local, 'pages/0.txt'));
  const append = await (await f.post(`/api/projects/${f.project.id}/resources/${f.data.id}/append-grant`, maintainer,
    { baseRevisionId: f.first.id })).json();
  expect(append.parent).toBe(read.snapshot);
  const backup = await runHostRestic(['backup', '--json', '--host', 'tavya', '--ignore-inode', '--no-cache', '--parent', append.parent, '.'],
    append.env, { cwd: local });
  expect(backup.code).toBe(0);
  const snapshot = JSON.parse(backup.stdout.trim().split('\n').pop()!).snapshot_id;

  const stale = await f.post(`/api/projects/${f.project.id}/resources/${f.data.id}/revisions`, maintainer, { snapshot, baseRevisionId: 'resource-revision_other' });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'resource_changed', currentRevisionId: f.first.id });
  const saved = await (await f.post(`/api/projects/${f.project.id}/resources/${f.data.id}/revisions`, maintainer,
    { snapshot, baseRevisionId: f.first.id })).json();
  expect(saved).toMatchObject({ unchanged: false, revision: { parentRevisionId: f.first.id, files: 20 } });
  expect(saved.revision.sealedRef).toBeUndefined();
  expect((await f.store.getResourceAttachment(f.data.id))?.currentRevisionId).toBe(saved.revision.id);
  expect(await f.store.auditRecentByActionPrefix('resource:workspace-save')).toHaveLength(1);

  // Saving the same files again makes no new version.
  const again = await runHostRestic(['backup', '--json', '--host', 'tavya', '--ignore-inode', '--no-cache', '--parent', snapshot, '.'],
    (await (await f.post(`/api/projects/${f.project.id}/resources/${f.data.id}/append-grant`, maintainer)).json()).env, { cwd: local });
  const unchanged = await (await f.post(`/api/projects/${f.project.id}/resources/${f.data.id}/revisions`, maintainer,
    { snapshot: JSON.parse(again.stdout.trim().split('\n').pop()!).snapshot_id, baseRevisionId: saved.revision.id })).json();
  expect(unchanged).toMatchObject({ unchanged: true, revision: { id: saved.revision.id } });
  // A snapshot the repository does not have is refused.
  expect((await f.post(`/api/projects/${f.project.id}/resources/${f.data.id}/revisions`, maintainer,
    { snapshot: 'f'.repeat(64), baseRevisionId: saved.revision.id })).status).toBe(400);
});

it('gives secret values only with project:secret:use, audited per name', async () => {
  const f = await fixture();
  const maintainer = await f.tokenFor('maintainer');
  await f.post(`/api/projects/${f.project.id}/secrets`, maintainer, { env: 'API_KEY=s3cret\nDB_URL=postgres://x\n' });
  await f.post(`/api/projects/${f.project.id}/secrets`, maintainer, { name: 'service-account.json', value: '{"k":1}', file: 'config/sa.json' });
  expect((await f.post(`/api/projects/${f.project.id}/secrets/values`, await f.tokenFor('viewer'))).status).toBe(403);
  const response = await f.post(`/api/projects/${f.project.id}/secrets/values`, await f.tokenFor('developer'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const { secrets } = await response.json();
  expect(secrets).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'API_KEY', variable: 'API_KEY', value: 's3cret' }),
    expect.objectContaining({ name: 'DB_URL', variable: 'DB_URL', value: 'postgres://x' }),
    expect.objectContaining({ name: 'service-account.json', file: 'config/sa.json', value: '{"k":1}' })]));
  const only = await (await f.post(`/api/projects/${f.project.id}/secrets/values`, await f.tokenFor('developer'), { names: ['DB_URL'] })).json();
  expect(only.secrets.map((secret: { name: string }) => secret.name)).toEqual(['DB_URL']);
  expect(await f.store.auditRecentByActionPrefix('resource:secret-read')).toHaveLength(4);
});

it('replaces a task world\'s private copy with a workspace snapshot exactly (files it lacks are deleted)', async () => {
  const f = await fixture();
  const repo = path.join(f.dir, 'repo'); fs.mkdirSync(repo);
  const { gitOrThrow, ensureIdentity } = await import('../src/world/git.js');
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'data/\n');
  await gitOrThrow(repo, ['add', '-A']); await gitOrThrow(repo, ['commit', '-qm', 'base']);
  const task = await f.store.createTask({ projectId: f.project.id, title: 'Laptop push', workflow: 'software-dev', workflowVersion: '1.26.0', params: { prompt: 'x' } });
  const worlds = (f.resources as any).worlds as WorldRegistry;
  const world = await worlds.create('worktree', { taskId: task.id, repo, base: 'main' });
  cleanups.push(() => world.destroy());
  world.handle = await f.resources.materialize(f.project.id, task.id, world, 1);
  fs.writeFileSync(path.join(world.handle.root, 'data', 'agent-only.txt'), 'made in the world');

  const local = path.join(f.dir, 'laptop-data'); fs.mkdirSync(path.join(local, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(local, 'pages', 'only.txt'), 'from the laptop');
  const maintainer = await f.tokenFor('maintainer');
  const append = await (await f.post(`/api/tasks/${task.id}/resources/${f.data.id}/append-grant`, maintainer)).json();
  const backup = await runHostRestic(['backup', '--json', '--host', 'tavya', '--ignore-inode', '--no-cache', '.'], append.env, { cwd: local });
  const snapshot = JSON.parse(backup.stdout.trim().split('\n').pop()!).snapshot_id;
  await f.resources.importWorkspaceSnapshot(task.id, world, f.data.id, snapshot);
  const files = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name))).sort();
  expect(files(path.join(world.handle.root, 'data'))).toEqual(['pages/only.txt']);
  // The task workspace reads the version its world started from.
  const read = await (await f.post(`/api/tasks/${task.id}/resources/${f.data.id}/read-grant`, await f.tokenFor('viewer'))).json();
  expect(read.revisionId).toBe(f.first.id);
  // A read-only resource cannot be pushed into a task.
  await f.store.updateResourceAttachment(f.data.id, { access: 'read', publish: 'discard' });
  expect((await f.post(`/api/tasks/${task.id}/resources/${f.data.id}/append-grant`, maintainer)).status).toBe(403);
});
