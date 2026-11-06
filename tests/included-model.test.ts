// tavya's included model (wiki features/included-model): an OpenCode model on
// OpenRouter that tavya pays for, charged to the organization's compute
// credit through a key of its own whose limit follows that credit.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { INCLUDED_MODEL_DEFAULT, includedModel, includedModelKey, includedModelRelativeCost, resetIncludedModelPrices, includedModelOutOfCredit, includedModelView, isIncludedModel,
  removeIncludedModelKey, saveIncludedModel, seedIncludedModelDefaults, syncIncludedModelUsage } from '../src/agent/included-model.js';
import { ComputeCreditExhausted, computeCredit, computeMonth, startComputeTrial } from '../src/world/managed-compute.js';
import { organizationProfileId } from '../src/agent/profiles.js';
import { projectReadiness } from '../src/platform/readiness.js';

/** OpenRouter's key-management API, as far as tavya uses it. */
const keys = new Map<string, { key: string; limit: number | null; usage: number; disabled: boolean; name: string }>();
const calls: Array<{ method: string; path: string; body?: any; auth?: string }> = [];
let server: http.Server;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method!, path: req.url!, body, auth: req.headers.authorization });
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      // OpenRouter's public model list (no key), as far as prices go.
      if (req.method === 'GET' && req.url === '/models') return send(200, { data: [
        { id: 'xiaomi/mimo-v2.6-pro', pricing: { prompt: '0.000000435', completion: '0.00000087', input_cache_read: '0.0000000036' } },
        { id: 'openai/gpt-6.1-sol', pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000001' } },
        { id: 'xiaomi/mimo-v2.6-flash', pricing: { prompt: '0.00000014', completion: '0.00000028', input_cache_read: '0.0000000028' } } ] });
      if (req.headers.authorization !== 'Bearer mgmt-key') return send(401, { error: { message: 'bad key' } });
      const hash = req.url!.match(/^\/keys\/([^/]+)$/)?.[1];
      if (req.method === 'POST' && req.url === '/keys') {
        const id = `hash${keys.size + 1}`;
        keys.set(id, { key: `sk-or-${id}`, limit: body.limit ?? null, usage: 0, disabled: false, name: body.name });
        return send(201, { data: { hash: id, name: body.name, limit: body.limit }, key: `sk-or-${id}` });
      }
      const key = hash ? keys.get(hash) : undefined;
      if (!key) return send(404, { error: { message: 'not found' } });
      if (req.method === 'GET') return send(200, { data: { hash, ...key, key: undefined } });
      if (req.method === 'PATCH') { Object.assign(key, body); return send(200, { data: { hash, ...key, key: undefined } }); }
      if (req.method === 'DELETE') { keys.delete(hash!); return send(200, { deleted: true }); }
      send(405, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  process.env.KARMAX_OPENROUTER_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { delete process.env.KARMAX_OPENROUTER_API_URL; await new Promise((resolve) => server.close(resolve)); });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); keys.clear(); calls.length = 0; });

const T = Date.UTC(2026, 10, 6, 12);

async function fixture(options: { hosted?: boolean; configure?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-included-model-'));
  const store = await Store.create(':memory:', { hosted: options.hosted ?? true });
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const broker = new CredentialBroker(new Vault(dir));
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  if (options.configure !== false) await saveIncludedModel(store, broker, { managementKey: 'mgmt-key' });
  /** What the key spent at OpenRouter, in USD, as if a turn had run on it. */
  const spend = (usd: number) => { for (const key of keys.values()) key.usage += usd; };
  return { store, broker, organization, spend };
}

describe('included model settings', () => {
  it('needs an OpenRouter management key, defaults to MiMo-V2.6-Pro and is hosted only', async () => {
    const f = await fixture({ configure: false });
    expect(await includedModel(f.store, f.broker)).toBeUndefined();
    await expect(saveIncludedModel(f.store, f.broker, {})).rejects.toThrow(/management key is required/);
    await expect(saveIncludedModel(f.store, f.broker, { managementKey: 'k', model: 'not a model' })).rejects.toThrow(/OpenRouter model id/);
    expect(await saveIncludedModel(f.store, f.broker, { managementKey: 'mgmt-key' })).toEqual({ model: INCLUDED_MODEL_DEFAULT, enabled: true });
    expect(INCLUDED_MODEL_DEFAULT).toBe('xiaomi/mimo-v2.6-pro');
    expect(await includedModel(f.store, f.broker)).toEqual({ model: INCLUDED_MODEL_DEFAULT, enabled: true });
    expect(await includedModelView(f.store, f.broker, computeMonth(T))).toMatchObject({ agentModel: 'openrouter/xiaomi/mimo-v2.6-pro',
      keyConfigured: true, organizations: 0 });
    expect(JSON.stringify(await includedModelView(f.store, f.broker, computeMonth(T)))).not.toContain('mgmt-key');
    expect(isIncludedModel({ provider: 'opencode', model: 'openrouter/xiaomi/mimo-v2.6-pro' }, await includedModel(f.store))).toBe(true);
    expect(isIncludedModel({ provider: 'claude', model: 'openrouter/xiaomi/mimo-v2.6-pro' }, await includedModel(f.store))).toBe(false);
    // Any OpenRouter model runs on the credit; other vendors need their own key.
    expect(isIncludedModel({ provider: 'opencode', model: 'openrouter/openai/gpt-6.1-sol' }, await includedModel(f.store))).toBe(true);
    expect(isIncludedModel({ provider: 'opencode', model: 'openai/gpt-6.1-sol' }, await includedModel(f.store))).toBe(false);
    // Switched off, nothing offers it.
    await saveIncludedModel(f.store, f.broker, { enabled: false });
    expect(await includedModel(f.store, f.broker)).toBeUndefined();

    const self = await fixture({ hosted: false });
    expect(await includedModel(self.store, self.broker)).toBeUndefined();
  });

  it('makes a new organization\'s Task defaults run on it, and moves them along when the model changes', async () => {
    const f = await fixture();
    expect(await seedIncludedModelDefaults(f.store, f.broker, f.organization.id)).toBe(true);
    const doAgent = await f.store.getProfile(organizationProfileId(f.organization.id, 'do'));
    expect(doAgent).toMatchObject({ provider: 'opencode', model: 'openrouter/xiaomi/mimo-v2.6-pro', role: 'do' });
    expect(doAgent?.effort).toBeUndefined();
    // A default the organization changed is its own.
    await f.store.upsertProfile({ ...doAgent!, provider: 'claude', model: 'claude-opus-5-5' });
    await saveIncludedModel(f.store, f.broker, { model: 'z-ai/glm-5.3-flash' });
    expect(await f.store.getProfile(organizationProfileId(f.organization.id, 'do'))).toMatchObject({ provider: 'claude' });
    expect(await f.store.getProfile(organizationProfileId(f.organization.id, 'responder')))
      .toMatchObject({ provider: 'opencode', model: 'openrouter/z-ai/glm-5.3-flash' });
  });
});

describe('the organization\'s OpenRouter key', () => {
  it('is made on its first turn with a limit of what its credit has left at OpenRouter\'s prices, and follows the credit', async () => {
    const f = await fixture();
    await startComputeTrial(f.store, f.organization.id, 'owner', T); // $5 at tavya's prices: $2.50 at OpenRouter's
    const key = await includedModelKey(f.store, f.broker, f.organization.id, T + 1000);
    expect(key).toBe('sk-or-hash1');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/keys', body: { name: `tavya ${f.organization.id}`, limit: 2.5 }, auth: 'Bearer mgmt-key' });

    // A turn spends $0.40 at OpenRouter: $0.80 of credit, booked to the task.
    f.spend(0.4);
    expect(await syncIncludedModelUsage(f.store, f.broker, f.organization.id, { taskId: 'task_1' }, T + 2000)).toBe(400_000);
    expect(await syncIncludedModelUsage(f.store, f.broker, f.organization.id, undefined, T + 3000)).toBe(0);
    const credit = await computeCredit(f.store, f.organization.id, T + 3000);
    expect(credit).toMatchObject({ usedMicros: 800_000, availableMicros: 4_200_000 });
    expect(credit.byProvider).toEqual([{ provider: 'openrouter', usedMicros: 800_000, seconds: 0 }]);
    const booked = (await f.store.usageSummary(f.organization.id, T, T + 10_000));
    expect(booked.byFundingSource.managed).toBe(400_000);

    // The next turn's limit: what it spent plus what the credit has left.
    expect(await includedModelKey(f.store, f.broker, f.organization.id, T + 4000)).toBe('sk-or-hash1');
    expect(keys.get('hash1')!.limit).toBe(2.5);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('refuses a turn without credit as Out of compute, naming the agent settings, and closes the key once spent', async () => {
    const f = await fixture();
    const refused = await includedModelKey(f.store, f.broker, f.organization.id, T).catch((error) => error);
    expect(refused).toBeInstanceOf(ComputeCreditExhausted);
    expect(refused.message).toMatch(/connect your own agent login or API key in Settings → Agents/);
    expect(keys.size).toBe(0);

    await startComputeTrial(f.store, f.organization.id, 'owner', T);
    await includedModelKey(f.store, f.broker, f.organization.id, T + 1000);
    f.spend(2.5); // the whole trial
    const spent = await includedModelOutOfCredit(f.store, f.broker, f.organization.id, { taskId: 'task_1' }, T + 2000);
    expect(spent).toBeInstanceOf(ComputeCreditExhausted);
    expect(spent!.message).toMatch(/^Out of compute: your \$5\.00 free trial is used up/);
    expect(keys.get('hash1')!.limit).toBe(2.5);
    await expect(includedModelKey(f.store, f.broker, f.organization.id, T + 3000)).rejects.toBeInstanceOf(ComputeCreditExhausted);
  });

  it('counts its spend against the same credit as tavya\'s computers', async () => {
    const f = await fixture();
    await startComputeTrial(f.store, f.organization.id, 'owner', T);
    await f.store.recordUsage({ id: 'usage:e2b:1', organizationId: f.organization.id, provider: 'e2b', kind: 'world.active',
      quantity: 3600, unit: 'second', costMicros: 1_000_000, startedAt: T, endedAt: T + 1000, fundingSource: 'managed' }); // $2 of compute
    await includedModelKey(f.store, f.broker, f.organization.id, T + 2000);
    expect(keys.get('hash1')!.limit).toBe(1.5); // $3 left at tavya's prices
  });

  it('is deleted at OpenRouter with its organization', async () => {
    const f = await fixture();
    await startComputeTrial(f.store, f.organization.id, 'owner', T);
    await includedModelKey(f.store, f.broker, f.organization.id, T);
    await removeIncludedModelKey(f.store, f.broker, f.organization.id);
    expect(keys.size).toBe(0);
    expect(await f.store.kvGet(`included-model:key:${f.organization.id}`)).toBeUndefined();
  });
});

describe('readiness', () => {
  it('counts the included model as able to run an agent with no login of the organization\'s own', async () => {
    const f = await fixture();
    const project = await f.store.createProject('Cloud', { worldProvider: 'e2b' }, f.organization.id);
    const readiness = await projectReadiness({ store: f.store, hosted: true, broker: f.broker }, { organizationId: f.organization.id, projectId: project.id },
      [{ provider: 'opencode', model: 'openrouter/xiaomi/mimo-v2.6-pro' }, { provider: 'claude', model: 'claude-opus-5-5' }]);
    expect(readiness.agents.map((agent) => agent.ready)).toEqual([true, false]);
    expect(readiness.agents[0]).toMatchObject({ cost: 1 });
  });

  it('says how many times the included model\'s price another OpenRouter model costs a task', async () => {
    resetIncludedModelPrices();
    const f = await fixture();
    const project = await f.store.createProject('Cloud', { worldProvider: 'e2b' }, f.organization.id);
    const ask = () => projectReadiness({ store: f.store, hosted: true, broker: f.broker }, { organizationId: f.organization.id, projectId: project.id },
      [{ provider: 'opencode', model: 'openrouter/openai/gpt-6.1-sol' }, { provider: 'opencode', model: 'openrouter/xiaomi/mimo-v2.6-flash' }]);
    // A typical task: 5% uncached input, 95% cached, 0.2% as much output — GPT-6.1 Sol's $0.10 cached input dominates.
    expect((await ask()).agents.map((agent) => [agent.ready, agent.cost])).toEqual([[true, 8], [true, 0.4]]);
    expect(await includedModelRelativeCost({ model: 'xiaomi/mimo-v2.6-pro', enabled: true }, 'openrouter/unknown/model')).toBeUndefined();
  });
});

describe('admission', () => {
  it('admits a managed turn on the included model without an owner\'s spend cap', async () => {
    const f = await fixture();
    const project = await f.store.createProject('Cloud', { worldProvider: 'e2b' }, f.organization.id);
    const task = await f.store.createTask({ projectId: project.id, title: 'Run', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'Run' } as any });
    const base = { organizationId: f.organization.id, projectId: project.id, taskId: task.id, provider: 'openrouter',
      model: 'openrouter/xiaomi/mimo-v2.6-pro', fundingSource: 'managed' as const };
    await expect(f.store.admitAgentUsage({ ...base, id: 'adm_legacy' })).rejects.toThrow(/spend cap/);
    expect(await f.store.admitAgentUsage({ ...base, id: 'adm_1', included: true })).toEqual({ reused: false });
  });
});

describe('a turn on the included model', () => {
  async function turnFixture(adapter: (input: any) => Promise<any>) {
    const f = await fixture();
    await startComputeTrial(f.store, f.organization.id, 'owner', Date.now() - 60_000);
    const project = await f.store.createProject('Cloud', {}, f.organization.id);
    const task = await f.store.createTask({ projectId: project.id, title: 'Work', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'work' } as any });
    const { WorldRegistry } = await import('../src/world/registry.js');
    const { ProfileResolver } = await import('../src/agent/profiles.js');
    const { makeCoreActivities } = await import('../src/activities/core.js');
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    cleanups.push(() => world.destroy());
    const adapters = new Map([['opencode', { provider: 'opencode', runTurn: adapter }]]) as any;
    const core = makeCoreActivities({ store: f.store, worlds, adapters, broker: f.broker, profiles: new ProfileResolver(f.store, 'claude') } as any);
    const agents = { do: { provider: 'opencode', model: 'openrouter/xiaomi/mimo-v2.6-pro' } };
    const input = { taskId: task.id, projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'just-do', agents };
    const run = () => core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`, agentSlotGranted: true,
      agentAdmissionManaged: true, worldHandle: world.handle, messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }], task: input } as any);
    return { ...f, core, task, project, input, run };
  }

  it('needs no credential of the organization\'s own, runs on its OpenRouter key and charges the credit', async () => {
    let seen: any;
    const f = await turnFixture(async (input) => {
      seen = input.resolvedAuth;
      for (const key of keys.values()) key.usage += 0.25; // the turn's tokens at OpenRouter
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'done',
        usage: { inputTokens: 10_000, outputTokens: 500, totalTokens: 10_500 } };
    });
    expect(await f.core.resolveCredentialOrder({ taskId: f.task.id, projectId: f.project.id, provider: 'opencode', role: 'do', task: f.input as any }))
      .toEqual([]);
    await f.run();
    expect(seen).toEqual({ apiKey: 'sk-or-hash1' });
    const credit = await computeCredit(f.store, f.organization.id);
    expect(credit.usedMicros).toBe(500_000);
    const costs = await f.store.db.prepare("SELECT taskId, costMicros, fundingSource, metadata FROM usage_events WHERE kind='agent.cost'").all() as any[];
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ taskId: f.task.id, costMicros: 250_000, fundingSource: 'managed' });
    expect(JSON.parse(costs[0].metadata)).toMatchObject({ costBasis: 'included-model-key-usage' });
  });

  it('waits for more credit, Out of compute, when the credit ran out during the turn', async () => {
    const f = await turnFixture(async () => {
      for (const key of keys.values()) key.usage += 2.5; // all of the trial
      throw new Error('OpenRouter: 402 Key limit exceeded');
    });
    await expect(f.run()).rejects.toMatchObject({ type: 'world-capacity', message: expect.stringMatching(/^Out of compute: your \$5\.00 free trial is used up/) });
    // And the next turn does not start.
    await expect(f.run()).rejects.toMatchObject({ type: 'world-capacity' });
  });
});
