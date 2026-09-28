import { afterEach, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { wikiRoot, writeWikiPage } from '../src/wiki/wiki.js';

let store: Store;
let home: string;
let world: any;
afterEach(async () => { vi.restoreAllMocks(); await world?.destroy(); await store?.close(); if (home) fs.rmSync(home, { recursive: true, force: true }); });
async function fixture(options: { goal?: boolean; remoteWiki?: boolean } = {}) {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-review-'));
  store = await Store.create(':memory:');
  const project = await store.createProject('Prompt');
  const task = await store.createTask({ projectId: project.id, title: 'Work', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
  const worlds = new WorldRegistry();
  world = await worlds.create('memory', { taskId: task.id, base: 'main' });
  vi.spyOn(worlds, 'open').mockResolvedValue(world);
  if (options.remoteWiki) world.handle.repos = [{ name: 'wiki', role: 'project-wiki', repo: 'wiki',
    root: `${world.handle.root}/not-on-host`, base: 'main', branch: 'task' }];
  let prompt = '';
  const core = makeCoreActivities({ store, worlds, contentDir: home, profiles: new ProfileResolver(store, 'mock'),
    adapters: new Map([['mock', { provider: 'mock', runTurn: async (input: any) => {
      prompt = input.systemPrompt;
      return { output: 'done', termination: { kind: 'success', status: 'fixture' } };
    } }]]) as any });
  const run = async () => { await core.runAgentTurn({ taskId: task.id, role: 'do', agentSlotGranted: true,
    worldHandle: world.handle, messages: [], task: { taskId: task.id, projectId: project.id, title: 'Work', prompt: 'work',
      project: {}, goalMode: options.goal, agents: { do: { provider: 'mock' } } } } as any); return prompt; };
  return { project, task, run };
}

it('RT-18 retains the organization built-in override in goal mode', async () => {
  const { project, run } = await fixture({ goal: true });
  writeWikiPage(wikiRoot(home, 'organization', project.organizationId!), '@builtin/how-to-work', 'CUSTOM WORKING INSTRUCTIONS');
  const prompt = await run();
  expect(prompt).toContain('CUSTOM WORKING INSTRUCTIONS');
  expect(prompt).toContain('Goal mode is active');
});

it.each(['SKILL.md', 'MEMORY.md'])('RT-13 enumerates only the wiki checkout for %s', async page => {
  const { run } = await fixture({ remoteWiki: true });
  const list = vi.spyOn(world, 'listFiles').mockRejectedValue(new Error('whole world traversal forbidden'));
  fs.mkdirSync(path.join(home, 'guide'));
  fs.writeFileSync(path.join(home, 'guide', page), 'fixture');
  const exec = vi.spyOn(world, 'exec').mockImplementation(async (command: any, args: any) => ({
    ...await promisify(execFile)(command, args, { cwd: home }), code: 0,
  }));
  vi.spyOn(world, 'readFileBuffer').mockResolvedValue(Buffer.from('---\nlabels: default\n---\nLIVE WIKI INSTRUCTION'));
  expect(await run()).toContain('LIVE WIKI INSTRUCTION');
  expect(list).not.toHaveBeenCalled();
  expect(exec).toHaveBeenCalledWith('bash', expect.any(Array), expect.objectContaining({ cwd: world.handle.repos[0].root }));
});

it('RT-13 retains organization context if the remote wiki snapshot fails', async () => {
  const { project, run } = await fixture({ remoteWiki: true });
  writeWikiPage(wikiRoot(home, 'organization', project.organizationId!), 'policy', '---\nlabels: default\n---\nORGANIZATION CONTEXT');
  vi.spyOn(world, 'listFiles').mockRejectedValue(new Error('offline'));
  vi.spyOn(world, 'exec').mockRejectedValue(new Error('offline'));
  expect(await run()).toContain('ORGANIZATION CONTEXT');
});

it('RT-14 shares a task read across prompt and authorization preparation', async () => {
  const { task, run } = await fixture();
  const get = vi.spyOn(store, 'getTask');
  const attempts = vi.spyOn(store, 'attemptsOf');
  await run();
  expect(get.mock.calls.filter(([id]) => id === task.id)).toHaveLength(1);
  expect(attempts).not.toHaveBeenCalled();
});

it('RT-14 queues a remote turn for its world lease without another task read', async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-review-'));
  store = await Store.create(':memory:');
  const project = await store.createProject('Remote');
  const task = await store.createTask({ projectId: project.id, title: 'Work', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'fixture' } });
  const handle = await store.registerWorld({ id: task.id, kind: 'e2b', root: '/workspace', branch: 'task', base: 'main' }, project.id) as any;
  await store.createRunnerPool({ id: 'pool', organizationId: project.organizationId!, name: 'Pool', provider: 'e2b',
    mode: 'customer', capacity: { activeWorlds: 1, cpu: 2, memoryMb: 2048, gpu: 0 }, enabled: true });
  const worlds = new WorldRegistry();
  world = await worlds.create('memory', { taskId: task.id, base: 'main' });
  world.handle = handle;
  worlds.register({ kind: 'e2b', capabilities: { remote: true }, open: async () => world, status: async () => 'ready' } as any);
  const runners = { acquire: vi.fn(async () => ({ leaseId: (await store.requestWorldLease({ runnerPoolId: 'pool',
    organizationId: project.organizationId!, projectId: project.id, taskId: task.id, worldId: task.id })).id, runnerPoolId: 'pool' })) };
  const core = makeCoreActivities({ store, worlds, runners: runners as any, contentDir: home, profiles: new ProfileResolver(store, 'mock'),
    adapters: new Map([['mock', { provider: 'mock', runTurn: async () => ({ output: 'done', termination: { kind: 'success', status: 'fixture' } }) }]]) as any });
  vi.spyOn(Context, 'current').mockReturnValue({ heartbeat() {}, cancellationSignal: new AbortController().signal,
    info: { attempt: 1, workflowExecution: { runId: 'run', workflowId: task.id }, activityId: 'turn', currentAttemptScheduledTimestampMs: Date.now() } } as any);
  const get = vi.spyOn(store, 'getTask');
  await core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#1`, agentSlotGranted: true, worldHandle: handle, messages: [],
    task: { taskId: task.id, projectId: project.id, title: 'Work', prompt: 'work', project: {}, agents: { do: { provider: 'mock' } } } } as any);
  expect(runners.acquire).toHaveBeenCalledOnce();
  expect(get.mock.calls.filter(([id]) => id === task.id)).toHaveLength(1);
});


it('RT-14 polls execution state without parsing stored conversation', async () => {
  const { task } = await fixture();
  await store.db.prepare('UPDATE tasks SET lastView=?, conversation=? WHERE id=?').run(
    JSON.stringify({ status: 'waiting', agentTurn: { state: 'running' } }), 'intentionally invalid conversation', task.id);
  expect(await store.taskExecutionState(task.id)).toEqual({ status: 'waiting', agentTurn: true });
});
