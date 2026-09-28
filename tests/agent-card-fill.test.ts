import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { BudgetService } from '../src/autonomy/payments.js';
import * as credentialFill from '../src/autonomy/fill.js';
import * as cardFill from '../src/autonomy/card-fill.js';
import * as connectionRuntime from '../src/mcp/connections/runtime.js';
import * as taskBrowser from '../src/autonomy/task-browser.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

// Containers (WD-6) and V2 cloud sandboxes run the agent and its browser MCP
// inside the world; a local world drives the host browser its agent launched.
// Neither is ever an endpoint the agent names (AU-32).
it.each([
  ['container', { kind: 'container' }, true],
  ['cloud', { kind: 'e2b', version: 2, sealedProviderRef: 'sealed' }, true],
  ['local', { kind: 'memory' }, false],
] as const)('fills the browser where the %s task runs it (AU-11)', async (_name, shape, inWorld) => {
  vi.spyOn(connectionRuntime, 'prepareConnections').mockResolvedValue([]);
  const fillViaCdp = vi.spyOn(credentialFill, 'fillViaCdp').mockResolvedValue({ origin: 'https://shop.example.com' });
  const fillCardInWorld = vi.spyOn(cardFill, 'fillCardInWorld').mockResolvedValue({ origin: 'https://shop.example.com' });
  const ownBrowser = vi.spyOn(taskBrowser, 'localTaskBrowserUrl').mockReturnValue('http://127.0.0.1:45999');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-card-routing-'));
  vi.stubEnv('KARMAX_HOME', dir);
  vi.stubEnv('KARMAX_AGENT_MIN_FREE_MB', '0');
  vi.stubEnv('KARMAX_AGENT_MAX_LOAD_FACTOR', '0');
  const store = await Store.create(':memory:');
  const worlds = new WorldRegistry();
  const project = await store.createProject('Card routing');
  const task = await store.createTask({ projectId: project.id, title: 'Fill', workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
  const card = { id: 'card', provider: 'test' };
  vi.spyOn(store, 'getCard').mockResolvedValue(card);
  vi.spyOn(BudgetService.prototype, 'claimFill').mockResolvedValue({ request: { id: 'request', cardId: 'card' }, domain: 'shop.example.com' });
  vi.spyOn(BudgetService.prototype, 'cards').mockResolvedValue([card] as any);
  const details = { number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2030 };
  const core = makeCoreActivities({ store, worlds, profiles: new ProfileResolver(store, 'mock'),
    payments: {} as any, paymentRegistry: { forCard: () => ({ retrieveCardDetails: async () => details }) } as any,
    adapters: new Map([['mock', { provider: 'mock', runTurn: async (_input: any, ctx: any) => {
      await ctx.fillPaymentCard({ requestId: 'request', cdpUrl: 'http://127.0.0.1:1', selectors: { number: '#number', expiry: '#expiry', cvc: '#cvc' } });
      return { termination: { kind: 'success', status: 'mock.completed' }, output: 'done' };
    } }]]) });
  const handle = await core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
  const world = await worlds.open(handle);
  const shaped = { ...handle, ...shape } as typeof handle;
  const open = vi.spyOn(worlds, 'open').mockResolvedValue(Object.assign(Object.create(Object.getPrototypeOf(world)), world, { handle: shaped }));
  try {
    await core.runAgentTurn({ taskId: task.id, role: 'do', worldHandle: shaped, messages: [],
      task: { projectId: project.id, title: task.title, prompt: '', project: {}, workflow: 'just-do' } as any });
    expect(fillCardInWorld).toHaveBeenCalledTimes(inWorld ? 1 : 0);
    expect(fillViaCdp).toHaveBeenCalledTimes(inWorld ? 0 : 3);
    for (const [, call] of fillCardInWorld.mock.calls) expect(call.cdpUrl).toBe('http://127.0.0.1:9222');
    for (const [call] of fillViaCdp.mock.calls) expect(call.cdpUrl).toBe('http://127.0.0.1:45999');
    expect(ownBrowser.mock.calls).toEqual(inWorld ? [] : [[task.id]]);
  } finally {
    open.mockRestore();
    await core.destroyWorld(handle);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #367 review item 16: a fill attempt (three per reservation) is counted only
// once there is a browser of the task's own to type into.
it('finds the task\'s browser before counting a fill attempt', async () => {
  vi.spyOn(connectionRuntime, 'prepareConnections').mockResolvedValue([]);
  vi.spyOn(taskBrowser, 'localTaskBrowserUrl').mockImplementation(() => { throw new Error('this task has no browser of its own open'); });
  const claimFill = vi.spyOn(BudgetService.prototype, 'claimFill').mockResolvedValue({ request: { id: 'request', cardId: 'card' }, domain: 'shop.example.com' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-card-attempt-'));
  vi.stubEnv('KARMAX_HOME', dir);
  vi.stubEnv('KARMAX_AGENT_MIN_FREE_MB', '0');
  vi.stubEnv('KARMAX_AGENT_MAX_LOAD_FACTOR', '0');
  const store = await Store.create(':memory:');
  const worlds = new WorldRegistry();
  const project = await store.createProject('Card attempts');
  const task = await store.createTask({ projectId: project.id, title: 'Fill', workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
  let failure: unknown;
  const core = makeCoreActivities({ store, worlds, profiles: new ProfileResolver(store, 'mock'),
    payments: {} as any, paymentRegistry: { forCard: () => ({ retrieveCardDetails: async () => ({}) }) } as any,
    adapters: new Map([['mock', { provider: 'mock', runTurn: async (_input: any, ctx: any) => {
      failure = await ctx.fillPaymentCard({ requestId: 'request', selectors: { number: '#number', expiry: '#expiry', cvc: '#cvc' } }).catch((e: unknown) => e);
      return { termination: { kind: 'success', status: 'mock.completed' }, output: 'done' };
    } }]]) });
  const handle = await core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
  try {
    await core.runAgentTurn({ taskId: task.id, role: 'do', worldHandle: handle, messages: [],
      task: { projectId: project.id, title: task.title, prompt: '', project: {}, workflow: 'just-do' } as any });
    expect(String(failure)).toMatch(/no browser of its own/);
    expect(claimFill).not.toHaveBeenCalled();
  } finally {
    await core.destroyWorld(handle);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
