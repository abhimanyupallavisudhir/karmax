import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store/db.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { wikiRoot } from '../src/wiki/wiki.js';
import { commitProjectWiki, ensureProjectWikiRepository, projectWikiBranchView } from '../src/wiki/repository.js';
import { organizationSkillsDir, projectSkillsDir } from '../src/resolve/skills.js';

// A deleted tenant's content must leave the content directory with its
// metadata, and only that tenant's: siblings keep theirs.
let directory: string;
let store: Store;
let api: KarmaxApi;
let server: Awaited<ReturnType<Gateway['listen']>>;
let headers: Record<string, string>;
const terminate = vi.fn(async () => {});
// A fresh port per test: the client's pooled sockets still point at the last server.
let port = 49060;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-tenant-content-'));
  store = await Store.create(':memory:');
  const worlds = new WorldRegistry(), tokens = new TokenAuthority();
  const client = { workflow: { getHandle: () => ({ terminate }) } } as any;
  api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api,
    authorization: await AuthorizationService.create(store), taskQueue: 'test', staticDir: path.resolve('web'),
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
    agentInfo: { provider: 'mock', reason: 'isolated tenant content deletion' } });
  server = await gateway.listen(await findFreePortFrom(port += 10));
  const { token } = await (await fetch(`${server.url}/api/session`)).json() as { token: string };
  headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
});

afterEach(async () => {
  vi.restoreAllMocks();
  terminate.mockReset();
  await server.close();
  await store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

/** Everything the content directory holds for one project: its wiki repository
 * with a page, a branch view, a saved skill, and a task's cached wiki copy. */
async function projectContent(projectId: string) {
  const repository = ensureProjectWikiRepository(directory, projectId);
  fs.writeFileSync(path.join(repository, 'secret.md'), `private notes of ${projectId}\n`);
  commitProjectWiki(repository, 'add page');
  execFileSync('git', ['-C', repository, 'branch', 'task/one']);
  const view = projectWikiBranchView(directory, projectId, 'task/one');
  const skill = path.join(projectSkillsDir(directory, projectId), 'resolve', 'fix.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '# fix\n');
  const task = await store.createTask({ projectId, title: 'Task', workflow: 'just-do', workflowVersion: '1',
    params: { prompt: 'x', draft: true } });
  const snapshot = await (api as any).remoteWikiReads.read(task.id, 'world:1', async (root: string) => {
    fs.writeFileSync(path.join(root, 'secret.md'), `cached notes of ${projectId}\n`);
  }) as string;
  return { paths: [repository, view, skill, snapshot] };
}

function organizationContent(organizationId: string) {
  const page = path.join(wikiRoot(directory, 'organization', organizationId), 'guide', 'SKILL.md');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, `---\nname: guide\n---\nprivate guide of ${organizationId}\n`);
  const skill = path.join(organizationSkillsDir(directory, organizationId), 'resolve', 'fix.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '# fix\n');
  return { paths: [page, skill] };
}

const exists = (paths: string[]) => paths.map((p) => fs.existsSync(p));
const all = (paths: string[], value: boolean) => paths.map(() => value);
/** Every path under the content directory that still names a deleted tenant. */
const leftovers = (ids: string[]) => (fs.readdirSync(directory, { recursive: true }) as string[])
  .filter((entry) => ids.some((id) => entry.split(path.sep).includes(id)));

it('deleting a project removes its wiki, branch views, skills and cached wiki copies, and a sibling keeps its own', async () => {
  const organization = await store.createOrganization({ name: 'Customer', ownerUserId: 'me' });
  const project = await store.createProject('Deleted', {}, organization.id);
  const sibling = await store.createProject('Sibling', {}, organization.id);
  const removed = await projectContent(project.id);
  const kept = await projectContent(sibling.id);
  const organizationKept = organizationContent(organization.id);

  const response = await fetch(`${server.url}/api/projects/${project.id}`, { method: 'DELETE', headers });
  expect(response.status).toBe(200);

  expect(exists(removed.paths)).toEqual(all(removed.paths, false));
  expect(leftovers([project.id])).toEqual([]);
  expect(exists(kept.paths)).toEqual(all(kept.paths, true));
  expect(exists(organizationKept.paths)).toEqual(all(organizationKept.paths, true));
  expect(fs.readFileSync(path.join(kept.paths[1]!, 'secret.md'), 'utf8')).toContain(sibling.id);
});

it('deleting an organization removes its wiki, skills and projects\' content, and another organization keeps everything', async () => {
  const organization = await store.createOrganization({ name: 'Departing', ownerUserId: 'me' });
  const other = await store.createOrganization({ name: 'Staying', ownerUserId: 'me' });
  const projects = [await store.createProject('One', {}, organization.id), await store.createProject('Two', {}, organization.id)];
  const retained = await store.createProject('Retained', {}, other.id);
  const removed = [organizationContent(organization.id), ...(await Promise.all(projects.map((p) => projectContent(p.id))))]
    .flatMap((content) => content.paths);
  const kept = [organizationContent(other.id), await projectContent(retained.id)].flatMap((content) => content.paths);

  const response = await fetch(`${server.url}/api/organizations/${organization.id}`, {
    method: 'DELETE', headers, body: JSON.stringify({ confirmSlug: organization.slug }),
  });
  expect(response.status).toBe(200);

  expect(exists(removed)).toEqual(all(removed, false));
  expect(fs.existsSync(wikiRoot(directory, 'organization', organization.id))).toBe(false);
  expect(fs.existsSync(organizationSkillsDir(directory, organization.id))).toBe(false);
  for (const project of projects) {
    expect(fs.existsSync(wikiRoot(directory, 'project', project.id))).toBe(false);
    expect(fs.existsSync(projectSkillsDir(directory, project.id))).toBe(false);
  }
  expect(leftovers([organization.id, ...projects.map((p) => p.id)])).toEqual([]);
  expect(exists(kept)).toEqual(all(kept, true));
});

it('a retried organization deletion after an external-cleanup failure still removes the content', async () => {
  const organization = await store.createOrganization({ name: 'Flaky', ownerUserId: 'me' });
  const project = await store.createProject('Flaky project', {}, organization.id);
  const removed = [organizationContent(organization.id), await projectContent(project.id)].flatMap((content) => content.paths);
  const deletion = () => fetch(`${server.url}/api/organizations/${organization.id}`, {
    method: 'DELETE', headers, body: JSON.stringify({ confirmSlug: organization.slug }),
  });

  terminate.mockRejectedValueOnce(new Error('temporal is unavailable'));
  expect((await deletion()).status).toBe(500);
  expect(await store.getOrganization(organization.id)).toBeDefined();

  expect((await deletion()).status).toBe(200);
  expect(await store.getOrganization(organization.id)).toBeUndefined();
  expect(exists(removed)).toEqual(all(removed, false));
  expect(leftovers([organization.id, project.id])).toEqual([]);
});

it('refuses an id that does not name exactly one tenant directory, before removing anything', async () => {
  const project = await store.createProject('Bystander', {}, 'org_personal');
  const content = await projectContent(project.id);
  for (const id of ['', '.', '..', '../wiki', 'a/b'])
    await expect(api.removeTenantContent({ organizationId: id, projectIds: [project.id] })).rejects.toThrow(/refusing/);
  await expect(api.removeTenantContent({ projectIds: [project.id, '..'] })).rejects.toThrow(/refusing/);
  expect(exists(content.paths)).toEqual(all(content.paths, true));
});
