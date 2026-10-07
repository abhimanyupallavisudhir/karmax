import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFreePortFrom } from '../src/util/ports.js';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { KarmaxApi } from '../src/platform/api.js';
import { seedProfiles } from '../src/agent/profiles.js';

/** The Computer in Task defaults is the execution policy (wiki features/computers):
 * `/api/defaults` projects it into every layer, and saving Task defaults writes
 * it back there — never into a settings row. */
describe('Computer defaults', () => {
  let dir: string, store: Store, gateway: Gateway, base: string, priorHome: string | undefined, api: KarmaxApi;
  const updates: unknown[] = [];
  let tokens: TokenAuthority;
  let close: () => Promise<void>;
  let token: string;
  const connected = new Set(['e2b']);
  const json = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };

  beforeAll(async () => {
    priorHome = process.env.KARMAX_HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-settings-'));
    process.env.KARMAX_HOME = dir;
    store = await Store.create(':memory:');
    await seedProfiles(store, 'mock');
    tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const client = { workflow: { getHandle: () => ({ query: async () => [],
      executeUpdate: async (_name: string, options: { args: unknown[] }) => { updates.push(options.args[0]); return { applied: [] }; } }),
      start: async () => ({}) } } as any;
    const providerConnections = { available: async (_organizationId: string, provider: string) => connected.has(provider),
      list: async () => [] } as any;
    api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test', contentDir: dir, providerConnections });
    gateway = await Gateway.create({ store, tokens, worlds, client, api, bus: new KarmaxBus(), providerConnections,
      contributions: new ContributionRegistry(), overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'),
      agentInfo: { provider: 'mock', reason: 'computer settings test' } });
    const running = await gateway.listen(await findFreePortFrom(48920));
    base = running.url;
    close = running.close;
    token = (await (await fetch(`${base}/api/session`)).json() as any).token;
  });
  afterAll(async () => {
    await close?.();
    if (priorHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = priorHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows and saves the organization and project computer through Task defaults', async () => {
    const project = await store.createProject('Machines');
    const organizationId = project.organizationId!;
    const defaults = async () => (await json('GET', `/api/defaults/${project.id}/software-dev`)).body;
    let shown = await defaults();
    expect(shown.global.inherited.computer).toEqual({ provider: 'worktree', cpu: 2, memoryMb: 2048, flavor: 'headless',
      hibernateAfterDays: 7, network: { unrestricted: true } });
    expect(shown.project.own.computer).toEqual({});
    expect(shown.task.inherited.computer).toMatchObject({ provider: 'worktree', cpu: 2 });
    // The old Agent-environment field is gone from every layer.
    expect(shown.task.inherited).not.toHaveProperty('worldProvider');

    // Organization: a bigger machine with more disk, on E2B. The row keeps the
    // other Task defaults and never a copy of the Computer.
    expect((await json('PUT', `/api/organizations/${organizationId}/settings/__common__`, { values: {
      target: 'main', computer: { provider: 'e2b', cpu: 4, memoryMb: 8192, diskGb: 40 } } })).status).toBe(200);
    expect(await store.getOrganizationExecutionPolicy(organizationId)).toMatchObject({ worldProvider: 'e2b',
      resources: { cpu: 4, memoryMb: 8192, diskGb: 40 } });
    expect(await store.getSettings(`organization:${organizationId}`, '__common__')).toEqual({ target: 'main' });

    // Project: only more disk and a shorter hibernation; the rest is inherited.
    expect((await json('PUT', `/api/settings/project/${project.id}/__common__`, { values: {
      computer: { diskGb: 50, hibernateAfterDays: 1 } } })).status).toBe(200);
    shown = await defaults();
    expect(shown.project.own.computer).toEqual({ diskGb: 50, hibernateAfterDays: 1 });
    expect(shown.task.inherited.computer).toEqual({ provider: 'e2b', cpu: 4, memoryMb: 8192, diskGb: 50, flavor: 'headless',
      hibernateAfterDays: 1, network: { unrestricted: true } });

    // The organization drops its disk: the project's own disk still applies.
    await json('PUT', `/api/organizations/${organizationId}/settings/__common__`, { values: { computer: { provider: 'e2b', cpu: 4, memoryMb: 8192 } } });
    expect((await store.getOrganizationExecutionPolicy(organizationId)).resources).not.toHaveProperty('diskGb');
    expect((await store.effectiveProjectConfig((await store.getProject(project.id))!)).resources).toMatchObject({ cpu: 4, diskGb: 50 });

    // A form that does not own the Computer leaves it alone; null resets the project.
    await json('PUT', `/api/settings/project/${project.id}/__common__`, { values: { target: 'main' } });
    expect((await store.getProject(project.id))!.config.resources).toEqual({ diskGb: 50 });
    await json('PUT', `/api/settings/project/${project.id}/__common__`, { values: { computer: null } });
    expect((await store.getProject(project.id))!.config).not.toHaveProperty('resources');
    expect((await store.getProject(project.id))!.config).not.toHaveProperty('hibernateAfterMs');
  });

  it('refuses a computer that is out of range or not connected', async () => {
    const project = await store.createProject('Refusals');
    const refused = await json('PUT', `/api/settings/project/${project.id}/__common__`, { values: { computer: { provider: 'daytona' } } });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringMatching(/daytona is not connected/) } });
    expect((await json('PUT', `/api/settings/project/${project.id}/__common__`, { values: { computer: { cpu: 0 } } })).status).toBe(400);
    // Nothing was half-saved.
    expect(await store.getSettings(project.id, '__common__')).toBeUndefined();
  });

  it('keeps a task\'s own computer sparse and validated', async () => {
    const project = await store.createProject('Task computers');
    const draft = await json('POST', `/api/projects/${project.id}/tasks`, { workflow: 'software-dev', draft: true,
      params: { prompt: 'big job', computer: { diskGb: '60', cpu: '' } } });
    expect(draft.status).toBe(200);
    expect((await store.getTask(draft.body.id))!.params.computer).toEqual({ diskGb: 60 });
    const legacy = await json('POST', `/api/projects/${project.id}/tasks`, { workflow: 'software-dev', draft: true,
      params: { prompt: 'old client', worldProvider: 'e2b' } });
    expect((await store.getTask(legacy.body.id))!.params.computer).toEqual({ provider: 'e2b' });
    expect((await json('POST', `/api/projects/${project.id}/tasks`, { workflow: 'software-dev', draft: true,
      params: { prompt: 'too big', computer: { diskGb: 100_000 } } })).status).toBe(400);
  });

  it('resizes a running task\'s computer but never swaps it for another', async () => {
    const project = await store.createProject('Running', { worldProvider: 'e2b', resources: { cpu: 2, memoryMb: 2048 } });
    const task = await store.createTask({ projectId: project.id, title: 'Disk full', workflow: 'software-dev',
      workflowVersion: '1.27.0', params: { prompt: 'x' } });
    await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1, root: '/w',
      workspaceRoot: '/w', branch: `tavya/${task.id}`, base: 'main', meta: { projectId: project.id } }, project.id);
    const editor = (await tokens.mintPrincipal('user:editor', ['task:edit', 'task:read'], project.id)).token;
    await expect(api.updateParams(editor, task.id, { computer: { provider: 'daytona', diskGb: 50 } }))
      .rejects.toThrow(/provider can't change/);
    await expect(api.updateParams(editor, task.id, { computer: { flavor: 'desktop' } })).rejects.toThrow(/experience/);
    expect(updates).toEqual([]);
    const result = await api.updateParams(editor, task.id, { computer: { provider: 'e2b', cpu: '4', diskGb: 50 } });
    expect(result.applied).toContain('computer');
    // The workflow judges the edit window; the platform keeps the value.
    expect(updates).toEqual([{ computer: { provider: 'e2b', cpu: 4, diskGb: 50 } }]);
    expect((await store.getTask(task.id))!.params.computer).toEqual({ provider: 'e2b', cpu: 4, diskGb: 50 });
    // A world made before machines were recorded learns the size it was made at.
    expect((await store.currentWorld(task.id))!.meta?.computer).toEqual({ cpu: 2, memoryMb: 2048 });
    expect((await store.effectiveTaskConfig(project.id, task.id)).resources).toMatchObject({ cpu: 4, memoryMb: 2048, diskGb: 50 });
  });
});
