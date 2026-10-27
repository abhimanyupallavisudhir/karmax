import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import type { WorldHandle, WorldProvider } from '../src/world/types.js';

// Deleting a project terminates its tasks' workflows, then deletes their
// worlds. On 2026-10-24 tavya.io's deletion of a project stopped at a world
// whose machine was already gone (a hibernated VM world, which it woke to
// delete): the project stayed, but its two running tasks (#737, #747) had
// been terminated as "project deleted". A world must never be woken to be
// deleted, and one the provider can't delete now must not leave a project
// half-deleted when the lifecycle sweep's orphan reaper deletes it later.
let directory: string;
let store: Store;
let server: Awaited<ReturnType<Gateway['listen']>>;
let headers: Record<string, string>;
let worlds: WorldRegistry;
const terminate = vi.fn(async () => {});
let port = 49460;
let organizationId: string;

/** A VM-like cloud provider: open wakes the machine, destroy deletes it. */
function vmProvider(destroy: (handle: WorldHandle) => Promise<void>) {
  const provider = {
    kind: 'hetzner', parkable: true,
    create: vi.fn(async () => { throw new Error('not used'); }),
    open: vi.fn(async (handle: WorldHandle) => {
      throw Object.assign(new Error(`the hetzner machine of this world no longer exists (${handle.id})`), { status: 404 });
    }),
    destroy: vi.fn(destroy),
    listSandboxes: vi.fn(async () => []),
  };
  return provider as typeof provider & WorldProvider;
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-project-deletion-'));
  store = await Store.create(':memory:');
  worlds = new WorldRegistry();
  const tokens = new TokenAuthority();
  const client = { workflow: { getHandle: () => ({ terminate }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: directory });
  const gateway = await Gateway.create({ store, tokens, worlds, client, api,
    authorization: await AuthorizationService.create(store), taskQueue: 'test', staticDir: path.resolve('web'),
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
    agentInfo: { provider: 'mock', reason: 'project deletion worlds' } });
  server = await gateway.listen(await findFreePortFrom(port += 10));
  const { token } = await (await fetch(`${server.url}/api/session`)).json() as { token: string };
  headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  organizationId = (await store.createOrganization({ name: 'Customer', ownerUserId: 'me' })).id;
});

afterEach(async () => {
  terminate.mockReset();
  await server.close();
  await store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function taskWithWorld(projectId: string, state: 'ready' | 'parked' | 'hibernated') {
  const task = await store.createTask({ projectId, title: state, workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } });
  const handle = await store.registerWorld({ id: task.id, kind: 'hetzner', root: '/workspace', branch: 'task', base: 'main' }, projectId);
  if (state !== 'ready') await store.setWorldState(handle, state);
  return handle;
}

/** `null` sends no body at all. */
const deleteProject = (project: { id: string; name: string }, confirmName: string | null = project.name) =>
  fetch(`${server.url}/api/projects/${project.id}`, { method: 'DELETE', headers,
    ...(confirmName === null ? {} : { body: JSON.stringify({ confirmName }) }) });

it('deletes a project without waking its worlds, and skips worlds whose machine is already deleted', async () => {
  const provider = vmProvider(async () => {});
  worlds.register(provider);
  const project = await store.createProject('Doomed', {}, organizationId);
  const ready = await taskWithWorld(project.id, 'ready');
  const parked = await taskWithWorld(project.id, 'parked');
  const hibernated = await taskWithWorld(project.id, 'hibernated');

  const response = await deleteProject(project);
  expect(response.status).toBe(200);
  expect(await store.getProject(project.id)).toBeUndefined();
  expect(provider.open).not.toHaveBeenCalled();
  const destroyed = provider.destroy.mock.calls.map(([handle]) => handle.id).sort();
  expect(destroyed).toEqual([ready.id, parked.id].sort());
  expect(destroyed).not.toContain(hibernated.id);
});

it('a world its provider cannot delete now does not leave the project half-deleted', async () => {
  // The orphan reaper deletes a sandbox whose task no longer exists.
  const provider = vmProvider(async (handle) => {
    if (handle.meta?.flaky) throw new Error('hetzner API: 503 service unavailable');
    throw Object.assign(new Error('the hetzner machine of this world no longer exists'), { status: 404 });
  });
  worlds.register(provider);
  const project = await store.createProject('Doomed', {}, organizationId);
  const gone = await taskWithWorld(project.id, 'parked');
  const flaky = await store.updateWorldMeta(await taskWithWorld(project.id, 'ready'), { flaky: true });

  const response = await deleteProject(project);
  expect(response.status).toBe(200);
  expect(await store.getProject(project.id)).toBeUndefined();
  expect(provider.destroy.mock.calls.map(([handle]) => handle.id).sort()).toEqual([gone.id, flaky.id].sort());
});

it('a world of a provider without an orphan reaper still blocks deletion until it is deleted', async () => {
  const provider = vmProvider(async () => { throw new Error('disk busy'); });
  delete (provider as Partial<typeof provider>).listSandboxes;
  worlds.register(provider);
  const project = await store.createProject('Doomed', {}, organizationId);
  await taskWithWorld(project.id, 'ready');

  const response = await deleteProject(project);
  expect(response.status).toBe(500);
  expect(await store.getProject(project.id)).toBeDefined();
});

it('deleting a project requires typing its name, before anything is stopped', async () => {
  const project = await store.createProject('Main product', {}, organizationId);
  await store.createTask({ projectId: project.id, title: 'Running', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } });

  for (const confirmName of [null, '', 'main product', 'Other']) {
    const refused = await deleteProject(project, confirmName);
    expect(refused.status, String(confirmName)).toBe(400);
    expect((await refused.json() as { error: string }).error).toMatch(/Main product/);
  }
  expect(terminate).not.toHaveBeenCalled();
  expect(await store.getProject(project.id)).toBeDefined();

  expect((await deleteProject(project)).status).toBe(200);
  expect(terminate).toHaveBeenCalled();
  expect(await store.getProject(project.id)).toBeUndefined();
});
