import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { BudgetService } from '../src/autonomy/payments.js';
import * as credentialFill from '../src/autonomy/fill.js';
import * as cardFill from '../src/autonomy/card-fill.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(['container', 'e2b'] as const)('fills the browser where the %s task runs it (AU-11)', async kind => {
  const fillViaCdp = vi.spyOn(credentialFill, 'fillViaCdp').mockResolvedValue({ origin: 'https://shop.example.com' });
  const fillCardInWorld = vi.spyOn(cardFill, 'fillCardInWorld').mockResolvedValue({ origin: 'https://shop.example.com' });
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
      await ctx.fillPaymentCard({ requestId: 'request', cdpUrl: 'http://127.0.0.1:9222', selectors: { number: '#number', expiry: '#expiry', cvc: '#cvc' } });
      return { termination: { kind: 'success', status: 'mock.completed' }, output: 'done' };
    } }]]) });
  const handle = await core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
  const world = await worlds.open(handle);
  const open = vi.spyOn(worlds, 'open').mockResolvedValue({ ...world, handle: { ...handle, kind } });
  try {
    await core.runAgentTurn({ taskId: task.id, role: 'do', worldHandle: { ...handle, kind }, messages: [],
      task: { projectId: project.id, title: task.title, prompt: '', project: {}, workflow: 'just-do' } as any });
    expect(fillCardInWorld).toHaveBeenCalledTimes(kind === 'e2b' ? 1 : 0);
    expect(fillViaCdp).toHaveBeenCalledTimes(kind === 'container' ? 3 : 0);
  } finally {
    open.mockRestore();
    await core.destroyWorld(handle);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
