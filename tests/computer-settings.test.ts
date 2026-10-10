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
import { assertComputerFits, computerLimits, type ComputerLimits } from '../src/domain/computer-limits.js';

/** The Computer in Task defaults is the execution policy (wiki features/computers):
 * `/api/defaults` projects it into every layer, and saving Task defaults writes
 * it back there — never into a settings row. */
describe('Computer defaults', () => {
  let dir: string, store: Store, gateway: Gateway, base: string, priorHome: string | undefined, api: KarmaxApi;
  const updates: unknown[] = [];
  const signals: unknown[][] = [];
  let tokens: TokenAuthority;
  let close: () => Promise<void>;
  let token: string;
  const connected = new Set(['e2b']);
  // What each provider account allows here (the real service learns it from the provider).
  const ceilings: Record<string, ComputerLimits> = { e2b: { cpu: 64, memoryMb: 262_144, diskGb: 2048 } };
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
    const client = { workflow: { getHandle: () => ({ query: async () => [], signal: async (...args: unknown[]) => { signals.push(args); },
      executeUpdate: async (_name: string, options: { args: unknown[] }) => { updates.push(options.args[0]); return { applied: [] }; } }),
      start: async () => ({}) } } as any;
    const providerConnections = { available: async (_organizationId: string, provider: string) => connected.has(provider),
      list: async () => [],
      limits: async (_organizationId: string, provider: string) => computerLimits(provider, ceilings[provider]),
      assertFits: async (_organizationId: string, provider: string | undefined, spec: any) => {
        if (provider) assertComputerFits(spec, computerLimits(provider, ceilings[provider]), provider);
      } } as any;
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

  // compute-disk item 1: ask only for what the account can give; never cap quietly.
  it('refuses a computer bigger than the organization\'s account allows, wherever it is set', async () => {
    const before = ceilings.e2b;
    ceilings.e2b = { cpu: 8, memoryMb: 8192, diskGb: 29 };
    try {
      const project = await store.createProject('Ceilings', { worldProvider: 'e2b' });
      const create = (computer: unknown) => json('POST', `/api/projects/${project.id}/tasks`, { workflow: 'software-dev', draft: true,
        params: { prompt: 'big data', computer } });
      expect(await create({ diskGb: 50 })).toMatchObject({ status: 400, body: { error: 'Disk can be at most 29 GB on this E2B account' } });
      expect(await create({ memoryMb: 16_384 })).toMatchObject({ status: 400, body: { error: 'Memory can be at most 8 GB on this E2B account' } });
      expect((await create({ diskGb: 29, cpu: 8 })).status).toBe(200);
      // Task defaults: the project's and the organization's Computer.
      expect(await json('PUT', `/api/settings/project/${project.id}/__common__`, { values: { computer: { diskGb: 40 } } }))
        .toMatchObject({ status: 400, body: { error: 'Disk can be at most 29 GB on this E2B account' } });
      expect(await json('PUT', `/api/organizations/${project.organizationId}/settings/__common__`, { values: {
        computer: { provider: 'e2b', cpu: 16 } } })).toMatchObject({ status: 400, body: { error: 'CPU can be at most 8 on this E2B account' } });
      // The execution policy API judges the same sizes.
      expect((await json('PUT', `/api/projects/${project.id}/execution-policy`, { override: { resources: { diskGb: 64 } } })).status).toBe(400);
      // A running task's Parameters.
      const task = await store.createTask({ projectId: project.id, title: 'Rebuild', workflow: 'software-dev',
        workflowVersion: '1.27.0', params: { prompt: 'x' } });
      const editor = (await tokens.mintPrincipal('user:editor', ['task:edit', 'task:read'], project.id)).token;
      await expect(api.updateParams(editor, task.id, { computer: { diskGb: 30 } })).rejects.toThrow('Disk can be at most 29 GB on this E2B account');
      expect((await api.updateParams(editor, task.id, { computer: { diskGb: 29 } })).applied).toContain('computer');
    } finally { ceilings.e2b = before; }
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
    // The Computer is the platform's: no workflow reads it, so none judges it.
    expect(updates).toEqual([]);
    expect((await store.getTask(task.id))!.params.computer).toEqual({ provider: 'e2b', cpu: 4, diskGb: 50 });
    // A world made before machines were recorded learns the size it was made at.
    expect((await store.currentWorld(task.id))!.meta?.computer).toEqual({ cpu: 2, memoryMb: 2048 });
    expect((await store.effectiveTaskConfig(project.id, task.id)).resources).toMatchObject({ cpu: 4, memoryMb: 2048, diskGb: 50 });
  });

  // pramana#3: a task started before the Computer existed has no edit window for
  // it in its workflow input, so the workflow refused every resize and the form
  // stayed greyed out — exactly when it ran out of disk.
  it('resizes a task started before the Computer existed, until it ends', async () => {
    const project = await store.createProject('Older', { worldProvider: 'e2b' });
    const task = await store.createTask({ projectId: project.id, title: 'Out of disk', workflow: 'software-dev',
      workflowVersion: '1.20.0', params: { prompt: 'x' } });
    await store.registerWorld({ version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1, root: '/w',
      workspaceRoot: '/w', branch: `tavya/${task.id}`, base: 'main', meta: { projectId: project.id } }, project.id);
    const view = { taskId: task.id, workflow: 'software-dev', stage: 'do', status: 'waiting', actions: [], editableParams: ['target'] } as any;
    await store.saveView(task.id, view);
    const editor = (await tokens.mintPrincipal('user:editor', ['task:edit', 'task:read'], project.id)).token;
    expect((await api.getTaskView(editor, task.id))?.editableParams).toEqual(['target', 'computer']);
    updates.length = 0;
    // The old workflow would refuse a patch naming `computer`; it never sees one.
    expect((await api.updateParams(editor, task.id, { computer: { diskGb: 25 } })).applied).toEqual(['computer']);
    expect(updates).toEqual([]);
    expect((await store.getTask(task.id))!.params.computer).toEqual({ diskGb: 25 });
    // Other fields still go to the workflow, which judges their windows.
    await api.updateParams(editor, task.id, { computer: { diskGb: 30 }, target: 'next' });
    expect(updates).toEqual([{ target: 'next' }]);
    for (const ended of [{ status: 'done' }, { status: 'waiting', pointOfNoReturnPassed: true }]) {
      await store.saveView(task.id, { ...view, ...ended });
      expect((await api.getTaskView(editor, task.id))?.editableParams ?? []).not.toContain('computer');
      await expect(api.updateParams(editor, task.id, { computer: { diskGb: 40 } })).rejects.toThrow(/can't be resized/);
    }
  });

  // pramana#3 (2026-10-09): its owner set the disk to 30, then 50 GB while the
  // agent waited on a rebuild job. A world waiting on a job never parks, so it
  // never moved; nobody was told, and the agent, asked, found 22 GB and waited
  // "for word that the disk size has changed".
  it('tells a live task\'s agent how to reach its new size, and shows the size as pending', async () => {
    const project = await store.createProject('Pending', { worldProvider: 'e2b', resources: { cpu: 2, memoryMb: 2048 } });
    const task = await store.createTask({ projectId: project.id, title: 'Rebuild', workflow: 'software-dev',
      workflowVersion: '1.27.0', params: { prompt: 'x' } });
    const handle = { version: 2, kind: 'e2b', provider: 'e2b', id: task.id, generation: 1, root: '/w', workspaceRoot: '/w',
      branch: `tavya/${task.id}`, base: 'main', meta: { projectId: project.id, computer: { cpu: 2, memoryMb: 2048 } } } as any;
    await store.registerWorld(handle, project.id);
    await store.saveView(task.id, { taskId: task.id, workflow: 'software-dev', stage: 'do', status: 'waiting',
      waitingFor: { kind: 'job' }, actions: [], editableParams: [] } as any);
    const editor = (await tokens.mintPrincipal('user:editor', ['task:edit', 'task:read'], project.id)).token;
    expect((await api.getTaskView(editor, task.id))?.computerChange).toBeUndefined();
    signals.length = 0;

    await api.updateParams(editor, task.id, { computer: { diskGb: 50 } });
    expect((await api.getTaskView(editor, task.id))?.computerChange)
      .toEqual({ from: { cpu: 2, memoryMb: 2048 }, to: { cpu: 2, memoryMb: 2048, diskGb: 50 } });
    expect(signals).toHaveLength(1);
    const [name, message, role] = signals[0] as [string, { text: string }, string];
    expect([name, role]).toEqual(['followUp', 'do']);
    expect(message.text).toMatch(/computer change\]/);
    expect(message.text).toContain('2 CPU · 2 GB · 50 GB disk');
    expect(message.text).toMatch(/pause\(3\) without jobs/);
    expect(message.text).toMatch(/stop_job/);

    // The agent resizing itself already knows; a parked world simply moves.
    const agent = (await tokens.mint({ taskId: task.id, profileId: 'mock', role: 'do', principal: 'user:editor', projectId: project.id,
      ceiling: ['task:edit', 'task:read'], grantorCaps: ['task:edit', 'task:read'] })).token;
    await api.updateParams(agent, task.id, { computer: { diskGb: 40 } });
    await store.setWorldState(handle, 'parked');
    await api.updateParams(editor, task.id, { computer: { diskGb: 30 } });
    expect(signals).toHaveLength(1);
    // Back to the size it has: nothing pending.
    await api.updateParams(editor, task.id, { computer: { diskGb: null } });
    expect((await api.getTaskView(editor, task.id))?.computerChange).toBeUndefined();
  });
});
