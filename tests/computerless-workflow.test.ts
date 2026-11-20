import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { bootHarness, type Harness } from './helpers/harness.js';
import { newId } from '../src/util/id.js';
import type { WorldHandle } from '../src/world/types.js';
import { IRREVERSIBLE_CAPABILITIES } from '../src/platform/capabilities.js';
import { projectReadiness } from '../src/platform/readiness.js';

// Real Temporal, activities and gateway, the mock agent (wiki
// features/computerless-tasks): a task whose Computer is None is an ordinary
// task — conversation, follow-ups, Review, Done — that never gets a machine.
describe('a task without a computer', () => {
  let h: Harness;
  let gateway: Awaited<ReturnType<Harness['startGateway']>>;
  const created: string[] = [];
  beforeAll(async () => {
    h = await bootHarness('mock');
    gateway = await h.startGateway();
    // The agent's platform tools reach this gateway, as a turn's do in production.
    process.env.KARMAX_GATEWAY_URL = gateway.internalUrl;
    const create = h.worlds.create.bind(h.worlds);
    h.worlds.create = async (kind, spec) => { created.push(kind); return create(kind, spec); };
  }, 60_000);
  afterAll(async () => {
    delete process.env.KARMAX_GATEWAY_URL;
    await gateway?.close();
    await h?.stop();
  });

  const view = async (taskId: string) => h.client.workflow.getHandle(taskId).query<any>('view');
  const said = (current: any) => current.messages.filter((message: any) => message.role === 'agent').map((message: any) => message.text).join('\n');

  it('runs its turns with platform tools only, takes follow-ups and is Done at Confirm, with no machine and no compute', async () => {
    // A project with a repository: the task still gets no checkout, branch or PR.
    const repo = await h.makeRepo('site');
    const project = await h.store.createProject(newId('Assistant'), { repos: [repo], worldProvider: 'worktree', defaultBase: 'main' });
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const started = Date.now();
    const task = await h.api.createTask(token, { projectId: project.id, workflow: 'software-dev', params: {
      computer: { provider: 'none' },
      prompt: '@tool platform_request {"method": "GET", "path": "/api/tasks/__SELF_TASK__"}\n@say Looked myself up.',
    } });
    expect((task.params._authorization as { heldBack?: string[] }).heldBack).toEqual(IRREVERSIBLE_CAPABILITIES);
    await expect.poll(async () => (await view(task.id)).stage, { timeout: 30_000 }).toBe('review');
    // Starting took seconds, not a sandbox's boot.
    expect(Date.now() - started).toBeLessThan(20_000);
    const first = await view(task.id);
    expect(said(first)).toContain('Looked myself up.');
    expect(first.branch).toBeUndefined();
    const world = (await h.store.currentWorld(task.id)) as WorldHandle;
    expect(world).toMatchObject({ kind: 'none', repos: [] });
    const activities = (await h.store.eventsOfType(task.id, 'agent.activity')).map((event) => event.payload as any);
    const call = activities.filter((activity) => String(activity.title).endsWith('platform_request')).at(-1);
    expect(call).toMatchObject({ phase: 'completed' });
    expect(call.detail).toContain(task.id);

    // A follow-up reaches the same conversation; a world tool is not there to call.
    await h.client.workflow.getHandle(task.id).signal('followUp', { id: 'f1', role: 'user', ts: Date.now(),
      text: `@tool find_task {"project_id": "${project.id}", "number": ${task.num ?? 1}}\n@tool start_job {"command": "echo hi"}` });
    await expect.poll(async () => said(await view(task.id)), { timeout: 30_000 }).toMatch(/no tool start_job/);
    expect(said(await view(task.id))).toMatch(/find_task: /);
    await expect.poll(async () => (await view(task.id)).stage, { timeout: 30_000 }).toBe('review');

    await h.client.workflow.getHandle(task.id).signal('confirm');
    expect(await h.client.workflow.getHandle(task.id).result()).toEqual({ stage: 'done' });
    expect((await view(task.id)).status).toBe('done');

    // No machine: only the none world was made, nothing was provisioned, cloned or checkpointed.
    expect(created).toEqual(['none']);
    const events = (await h.store.eventsSince(task.id, 0)).map((event) => event.type);
    expect(events).not.toContain('world.provisioning');
    expect(events).not.toContain('checkpoint.created');
    expect(fs.existsSync(world.root)).toBe(false);
    const rows = await (h.store as any).db.prepare('SELECT kind FROM usage_events WHERE taskId=?').all(task.id) as Array<{ kind: string }>;
    expect(rows.filter((row) => row.kind.startsWith('world.') || row.kind === 'preview.active')).toEqual([]);

    // It replays against the code that recorded it.
    const workflowsPath = fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url));
    await Worker.runReplayHistory({ workflowsPath }, await h.client.workflow.getHandle(task.id).fetchHistory());
  }, 180_000);

  it('creates a sub-task, which also runs without a computer (no git snapshot of a world that has none)', async () => {
    const project = await h.store.createProject(newId('Assistant sub'), { worldProvider: 'worktree', defaultBase: 'main' });
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const task = await h.api.createTask(token, { projectId: project.id, workflow: 'software-dev', params: {
      computer: { provider: 'none' },
      prompt: '@tool create_sub_task {"title": "Look it up", "prompt": "@say Found it."}\n@say Asked a sub-task.',
    } });
    await expect.poll(async () => (await h.store.listTasks(project.id)).filter((t: any) => t.parentTaskId === task.id).length,
      { timeout: 60_000 }).toBe(1);
    const child = (await h.store.listTasks(project.id)).find((t: any) => t.parentTaskId === task.id)!;
    await expect.poll(async () => said(await view(child.id)), { timeout: 60_000 }).toContain('Found it.');
    expect((await h.store.currentWorld(child.id) as WorldHandle).kind).toBe('none');
    const current = await view(task.id);
    expect(JSON.stringify(current.error ?? '')).not.toMatch(/git|computer/i);
    await h.client.workflow.getHandle(child.id).cancel().catch(() => undefined);
    await h.client.workflow.getHandle(task.id).cancel().catch(() => undefined);
  }, 120_000);

  it('with neither a login nor a key, it says so instead of waiting', async () => {
    const project = await h.store.createProject(newId('Assistant'), { worldProvider: 'worktree', defaultBase: 'main' });
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    // No API key and no Codex login anywhere: a login could run its CLI here (self-hosted), but there is none.
    const keys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
    const task = await h.api.createTask(token, { projectId: project.id, workflow: 'software-dev', params: {
      computer: { provider: 'none' }, prompt: 'hello', 'agent:do': { provider: 'codex', model: 'gpt-5.5' },
    } });
    await expect.poll(async () => {
      const current = await view(task.id);
      return JSON.stringify(current.messages) + JSON.stringify(current.error ?? '') + JSON.stringify(current.waitingFor ?? '');
    }, { timeout: 60_000 }).toMatch(/A Codex login or an API key is needed: there is neither here/);
    await h.client.workflow.getHandle(task.id).cancel().catch(() => undefined);
    } finally {
      for (const [name, value] of Object.entries(keys)) if (value !== undefined) process.env[name] = value;
    }
  }, 120_000);

  it('on hosted, never spends the worker\'s own API key: with no key of the organization\'s, it is refused as readiness says, and no request goes out', async () => {
    // The model API the worker's key would reach: nothing may arrive here.
    const requests: string[] = [];
    const modelApi = http.createServer((req, res) => { requests.push(req.url ?? ''); res.writeHead(500); res.end('must not be called'); });
    await new Promise<void>((resolve) => modelApi.listen(0, '127.0.0.1', resolve));
    const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, KARMAX_ANTHROPIC_BASE_URL: process.env.KARMAX_ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-operator';
    process.env.KARMAX_ANTHROPIC_BASE_URL = `http://127.0.0.1:${(modelApi.address() as AddressInfo).port}`;
    const store = h.store as { hosted: boolean };
    store.hosted = true;
    try {
      const project = await h.store.createProject(newId('Assistant'), { worldProvider: 'e2b', defaultBase: 'main' });
      const agent = { provider: 'claude' as const, model: 'claude-opus-5-5' };
      const readiness = await projectReadiness({ store: h.store, hosted: true, broker: h.broker }, { organizationId: 'org_personal', projectId: project.id },
        [agent], { computerless: true });
      const gap = readiness.agents[0]!.need?.computerless;
      expect(readiness.agents[0]!.ready).toBe(false);
      expect(gap).toMatch(/Claude Code login or an API key is needed/);
      const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
      const task = await h.api.createTask(token, { projectId: project.id, workflow: 'software-dev', params: {
        computer: { provider: 'none' }, prompt: 'hello', 'agent:do': agent,
      } });
      await expect.poll(async () => {
        const current = await view(task.id);
        return JSON.stringify(current.messages) + JSON.stringify(current.error ?? '') + JSON.stringify(current.waitingFor ?? '');
      }, { timeout: 60_000 }).toContain(gap!.slice(0, 60));
      expect(requests).toEqual([]);
      await h.client.workflow.getHandle(task.id).cancel().catch(() => undefined);
    } finally {
      store.hosted = false;
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
      await new Promise<void>((resolve) => modelApi.close(() => resolve()));
    }
  }, 120_000);
});
