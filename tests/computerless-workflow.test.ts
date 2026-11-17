import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { bootHarness, type Harness } from './helpers/harness.js';
import { newId } from '../src/util/id.js';
import type { WorldHandle } from '../src/world/types.js';
import { IRREVERSIBLE_CAPABILITIES } from '../src/platform/capabilities.js';

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

  it('cannot start on a subscription login: it says so instead of waiting', async () => {
    const project = await h.store.createProject(newId('Assistant'), { worldProvider: 'worktree', defaultBase: 'main' });
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    // No API key anywhere: only a login could serve Codex, and a login needs a computer.
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
    }, { timeout: 60_000 }).toMatch(/runs only on a computer|needs an API key|can't run without a computer/i);
    await h.client.workflow.getHandle(task.id).cancel().catch(() => undefined);
    } finally {
      for (const [name, value] of Object.entries(keys)) if (value !== undefined) process.env[name] = value;
    }
  }, 120_000);
});
