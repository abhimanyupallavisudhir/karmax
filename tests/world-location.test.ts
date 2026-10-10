import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { WorkspaceService } from '../src/world/workspace.js';
import { resourceSecretHandle } from '../src/domain/resource-drivers.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import { pinLocation, workingFolder, worldCheckoutNames } from '../src/domain/world-location.js';
import type { ResourceTarget } from '../src/domain/types.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('pinning a location to its checkout', () => {
  it('pins as the location resolves now: in the only checkout, else under its first folder', () => {
    expect(pinLocation({ path: 'data' }, ['site'])).toEqual({ path: 'data', repository: 'site' });
    // In a one-repository project a folder named like the repository is just a folder.
    expect(pinLocation({ path: 'site/data' }, ['site'])).toEqual({ path: 'site/data', repository: 'site' });
    expect(pinLocation({ path: 'api/config/sa.json' }, ['api', 'web'])).toEqual({ path: 'config/sa.json', repository: 'api' });
    // A root-level path of a multi-repository project has no checkout; a pinned one stays.
    const root = { path: 'datasets' };
    expect(pinLocation(root, ['api', 'web'])).toBe(root);
    const pinned = { path: 'x', repository: 'web' };
    expect(pinLocation(pinned, ['site'])).toBe(pinned);
    expect(worldCheckoutNames(['git@github.com:acme/site.git', '/src/other/site', 'https://github.com/acme/api'])).toEqual(['site', 'site-2', 'api']);
    expect([workingFolder(['site']), workingFolder(['api', 'web']), workingFolder([])]).toEqual(['site', '.', '.']);
  });
});

async function repository(dir: string, name: string): Promise<string> {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  await git(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

async function fixture(names: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-location-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repos: Record<string, string> = {};
  for (const name of [...names, 'extra']) repos[name] = await repository(dir, name);
  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const project = await store.createProject('Fleet', { repos: names.map((name) => repos[name]!) });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const resources = new ProjectResourceService(store, worlds,
    new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
  let count = 0;
  const secret = async (name: string, target: ResourceTarget, value: string) => {
    const id = `resource_secret_${++count}`;
    await broker.registerHandle(resourceSecretHandle(id), value, INSTALLATION_SCOPE);
    return store.createResourceAttachment({ id, organizationId: project.organizationId!, projectId: project.id, name,
      driver: 'secret@1', target, access: 'read', isolation: 'fork', source: {},
      credentialHandles: [resourceSecretHandle(id)], publish: 'discard' });
  };
  const data = (name: string, target: string) => store.createResourceAttachment({ organizationId: project.organizationId!,
    projectId: project.id, name, driver: 'volume@1', target: { kind: 'path', path: target }, access: 'write', isolation: 'fork',
    source: {}, credentialHandles: [], publish: 'discard' });
  const open = async () => {
    const current = (await store.getProject(project.id))!.config.repos!;
    const task = await store.createTask({ projectId: project.id, title: 'Work', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } });
    const world = await worlds.create('worktree', { taskId: task.id, repos: current, base: 'main' });
    cleanups.push(() => world.destroy());
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    return world;
  };
  const targets = async () => Object.fromEntries((await store.listResourceAttachments(project.id, true)).map((entry) => [entry.name, entry.target]));
  return { repos, store, project, resources, secret, data, open, targets };
}

describe('a project gaining or losing repositories keeps its data and secrets where they were', () => {
  it('pins the only repository\'s locations when a second one is added', async () => {
    const f = await fixture(['site']);
    await f.secret('sa.json', { kind: 'path', path: 'config/sa.json' }, '{"k":1}');
    await f.secret('.env:TOKEN', { kind: 'environment', name: 'TOKEN', dotenv: { path: '.env' } }, 't');
    await f.secret('SHARED', { kind: 'environment', name: 'SHARED' }, 'everywhere');
    const raw = await f.data('raw', 'data');
    await f.resources.importFiles(raw.id, [{ path: 'a.csv', data: Buffer.from('id\n1\n') }]);
    const before = await f.open();
    expect(await before.readFile('config/sa.json')).toBe('{"k":1}');

    await f.store.updateProjectConfig(f.project.id, { repos: [f.repos.site!, f.repos.extra!] });
    expect(await f.targets()).toEqual({
      'sa.json': { kind: 'path', path: 'config/sa.json', repository: 'site' },
      '.env:TOKEN': { kind: 'environment', name: 'TOKEN', dotenv: { path: '.env', repository: 'site' } },
      SHARED: { kind: 'environment', name: 'SHARED' },
      raw: { kind: 'path', path: 'data', repository: 'site' } });
    // A new world has the files in the site checkout, not at the root beside it.
    const after = await f.open();
    expect(await after.readFile('site/config/sa.json')).toBe('{"k":1}');
    expect(await after.readFile('site/.env')).toBe('TOKEN=t\n');
    expect(await after.readFile('site/data/a.csv')).toBe('id\n1\n');
    expect((await after.exec('test', ['-e', 'config'])).code).toBe(1);
    // A world that started with one repository still finds them.
    await f.resources.refresh(before);
    expect(await before.readFile('config/sa.json')).toBe('{"k":1}');
  });

  it('pins each repository\'s locations when all but one are removed; root-level ones stay', async () => {
    const f = await fixture(['api', 'web']);
    await f.secret('sa.json', { kind: 'path', path: 'api/config/sa.json' }, '{"api":1}');
    await f.secret('notes', { kind: 'path', path: 'shared/notes.txt' }, 'n');
    await f.store.updateProjectConfig(f.project.id, { repos: [f.repos.api!] });
    expect(await f.targets()).toEqual({
      'sa.json': { kind: 'path', path: 'config/sa.json', repository: 'api' },
      notes: { kind: 'path', path: 'shared/notes.txt' } });
    const world = await f.open();
    expect(await world.readFile('config/sa.json')).toBe('{"api":1}');
  });

  it('leaves locations alone when the working folder does not move', async () => {
    const f = await fixture(['api', 'web']);
    await f.secret('sa.json', { kind: 'path', path: 'api/config/sa.json' }, '{}');
    await f.store.updateProjectConfig(f.project.id, { repos: [f.repos.api!, f.repos.web!, f.repos.extra!] });
    expect((await f.targets())['sa.json']).toEqual({ kind: 'path', path: 'api/config/sa.json' });
  });

  it('pins through repository attachment too, and the workspace manifest keeps its paths', async () => {
    const f = await fixture(['site']);
    const site = await f.store.upsertRepository({ organizationId: f.project.organizationId!, provider: 'github', providerId: '1',
      owner: 'acme', name: 'site', sshUrl: 'git@github.com:acme/site.git', defaultBranch: 'main', private: true });
    const api = await f.store.upsertRepository({ organizationId: f.project.organizationId!, provider: 'github', providerId: '2',
      owner: 'acme', name: 'api', sshUrl: 'git@github.com:acme/api.git', defaultBranch: 'main', private: true });
    await f.store.attachProjectRepository({ projectId: f.project.id, repositoryId: site.id });
    await f.data('raw', 'data');
    const workspace = new WorkspaceService(f.store);
    expect((await workspace.project(f.project.id)).resources.map((resource) => resource.path)).toEqual(['site/data']);
    await f.store.attachProjectRepository({ projectId: f.project.id, repositoryId: api.id });
    expect((await workspace.project(f.project.id)).resources.map((resource) => resource.path)).toEqual(['site/data']);
    await f.store.detachProjectRepository(f.project.id, site.id);
    // Gone with its repository, not moved into the remaining one.
    expect((await workspace.project(f.project.id)).resources.map((resource) => resource.path)).toEqual(['site/data']);
  });
});
