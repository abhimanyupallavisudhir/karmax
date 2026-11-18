// Model gateways (wiki features/model-gateways): Claude Code and Codex on the
// organization's compute credit — through an operator-added gateway (off by
// default, its key kept on the control plane behind tavya's proxy) or through
// OpenRouter with the organization's included-model key.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { organizationScope } from '../src/autonomy/vault-keys.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { saveIncludedModel } from '../src/agent/included-model.js';
import { resetModelPrices, catalogueModelId } from '../src/agent/model-prices.js';
import {
  creditRail, deleteModelGateway, gatewayCostMicros, gatewayGrant, issueGatewayToken, modelGateways, modelGatewaysView,
  openRouterHarnessModel, pruneGatewayTokens, revokeGatewayToken, saveModelGateway, servingGateways, UsageMeter,
} from '../src/agent/model-gateways.js';
import { proxyModelGateway } from '../src/gateway/model-gateway-proxy.js';
import { computeCredit, computeMonth, startComputeTrial } from '../src/world/managed-compute.js';
import { defaultAgentProfile, projectReadiness } from '../src/platform/readiness.js';
import { organizationProfileId } from '../src/agent/profiles.js';

// ── A mock OpenRouter (catalogue + key management) ──────────────────────────
const keys = new Map<string, { key: string; limit: number | null; usage: number; disabled: boolean }>();
let openRouter: http.Server;
// ── A mock operator gateway: records what reached it, answers with usage ───
const upstreamCalls: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
let upstream: http.Server;
let upstreamUrl: string;
// ── tavya's proxy route, as the gateway serves it ───────────────────────────
let proxy: http.Server;
let proxyDeps: { store: Store; broker?: CredentialBroker } | undefined;
let proxyUrl: string;

const SSE_ANTHROPIC = [
  'event: message_start', `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5-5',
    usage: { input_tokens: 1_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2_000, output_tokens: 1 } } })}`, '',
  'event: content_block_delta', `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })}`, '',
  'event: message_delta', `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 500 } })}`, '',
  'event: message_stop', 'data: {"type":"message_stop"}', '', ''].join('\n');

beforeAll(async () => {
  // OpenRouter's API lives under /api/v1; its Anthropic endpoint under /api.
  openRouter = http.createServer((req, res) => { req.url = req.url!.replace(/^\/api\/v1/, ''); routeOpenRouter(req, res); });
  await new Promise<void>((resolve) => openRouter.listen(0, '127.0.0.1', () => resolve()));
  process.env.KARMAX_OPENROUTER_API_URL = `http://127.0.0.1:${(openRouter.address() as AddressInfo).port}/api/v1`;

  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      upstreamCalls.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      if (req.url!.startsWith('/v1/messages') && body?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' });
        // Split mid-line: the meter must join chunks.
        const half = Math.floor(SSE_ANTHROPIC.length / 2);
        res.write(SSE_ANTHROPIC.slice(0, half));
        setTimeout(() => res.end(SSE_ANTHROPIC.slice(half)), 5);
        return;
      }
      if (req.url!.startsWith('/v1/responses')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'resp_1', model: body.model, output: [],
          usage: { input_tokens: 30_000, input_tokens_details: { cached_tokens: 20_000 }, output_tokens: 1_000 } }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"nope"}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  proxy = http.createServer((req, res) => {
    if (!proxyDeps || !req.url!.startsWith('/api/model-gateway')) { res.writeHead(404); return res.end(); }
    void proxyModelGateway(proxyDeps, req, res, req.url!.slice('/api/model-gateway'.length));
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  process.env.KARMAX_GATEWAY_URL = proxyUrl;
});

function routeOpenRouter(req: http.IncomingMessage, res: http.ServerResponse) {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/models') return send(200, { data: [
      { id: 'deepseek/deepseek-v4.1-flash-1017', pricing: { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000003' } },
      { id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000002', input_cache_write: '0.000005' } },
      { id: 'anthropic/claude-haiku-5.5', pricing: { prompt: '0.0000001', completion: '0.0000005', input_cache_read: '0.00000001', input_cache_write: '0.000000125' } },
      { id: '~anthropic/claude-opus-latest', pricing: { prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000002', input_cache_write: '0.000005' } },
      { id: 'openai/gpt-6.1-sol', pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000001' } } ] });
    if (req.headers.authorization !== 'Bearer mgmt-key') return send(401, { error: { message: 'bad key' } });
    const hash = req.url!.match(/^\/keys\/([^/]+)$/)?.[1];
    if (req.method === 'POST' && req.url === '/keys') {
      const id = `hash${keys.size + 1}`;
      keys.set(id, { key: `sk-or-${id}`, limit: body.limit ?? null, usage: 0, disabled: false });
      return send(201, { data: { hash: id, limit: body.limit }, key: `sk-or-${id}` });
    }
    const key = hash ? keys.get(hash) : undefined;
    if (!key) return send(404, { error: { message: 'not found' } });
    if (req.method === 'GET') return send(200, { data: { hash, ...key, key: undefined } });
    if (req.method === 'PATCH') { Object.assign(key, body); return send(200, { data: { hash, ...key, key: undefined } }); }
    send(405, {});
  });
}

afterAll(async () => {
  delete process.env.KARMAX_OPENROUTER_API_URL;
  delete process.env.KARMAX_GATEWAY_URL;
  await Promise.all([openRouter, upstream, proxy].map((server) => new Promise((resolve) => server.close(resolve))));
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  keys.clear(); upstreamCalls.length = 0; proxyDeps = undefined; resetModelPrices();
});

async function fixture(options: { hosted?: boolean; included?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-model-gateways-'));
  const store = await Store.create(':memory:', { hosted: options.hosted ?? true });
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  await startComputeTrial(store, organization.id, 'owner', Date.now() - 60_000);
  if (options.included) await saveIncludedModel(store, broker, { managementKey: 'mgmt-key' });
  const project = await store.createProject('Cloud', {}, organization.id);
  const homes = path.join(dir, 'homes');
  return { dir, store, broker, organization, project, homes };
}

const gatewayInput = (overrides: Record<string, unknown> = {}) => ({ name: 'Company proxy', harnesses: ['claude', 'codex'] as any,
  baseUrl: `${upstreamUrl}/v1/`, models: ['claude-opus-5-5', 'claude-haiku-5-5', 'gpt-6.1-sol'], priceMultiplier: 0.3, apiKey: 'gw-secret', ...overrides });

describe('operator gateways: settings', () => {
  it('are off until the operator turns one on, need a key, and never show it', async () => {
    const f = await fixture();
    expect(await modelGateways(f.store)).toEqual([]);
    await expect(saveModelGateway(f.store, f.broker, undefined, gatewayInput({ apiKey: undefined }))).rejects.toThrow(/API key is required/);
    const saved = await saveModelGateway(f.store, f.broker, undefined, gatewayInput());
    // Off by default; the URL is the address before /v1.
    expect(saved).toMatchObject({ id: expect.stringMatching(/^gw_/), enabled: false, baseUrl: upstreamUrl, priceMultiplier: 0.3 });
    expect(await servingGateways(f.store, f.broker, { provider: 'claude', model: 'claude-opus-5-5' })).toEqual([]);
    const view = await modelGatewaysView(f.store, f.broker, computeMonth(Date.now()));
    expect(view).toEqual([expect.objectContaining({ id: saved.id, keyConfigured: true, unpriced: [], costMicros: 0 })]);
    expect(JSON.stringify(view)).not.toContain('gw-secret');
    // Editing keeps the key when none is given.
    const on = await saveModelGateway(f.store, f.broker, saved.id, { enabled: true });
    expect(on).toMatchObject({ enabled: true, name: 'Company proxy' });
    expect(await servingGateways(f.store, f.broker, { provider: 'claude', model: 'claude-opus-5-5' })).toEqual([expect.objectContaining({ id: saved.id })]);
    expect(await deleteModelGateway(f.store, f.broker, saved.id)).toBe(true);
    expect(await f.broker.hasHandle(`model-gateway:installation:${saved.id}:key`)).toBe(false);
  });

  it('refuses what it could not use', async () => {
    const f = await fixture();
    for (const [change, error] of [[{ name: '' }, /name/], [{ baseUrl: 'ftp://x' }, /http/], [{ baseUrl: 'https://u:p@x.example' }, /credentials/],
      [{ harnesses: ['opencode'] }, /harnesses/], [{ models: [] }, /models/], [{ priceMultiplier: 0 }, /priceMultiplier/],
      [{ priceMultiplier: 'cheap' }, /priceMultiplier/]] as const)
      await expect(saveModelGateway(f.store, f.broker, undefined, gatewayInput(change as any))).rejects.toThrow(error);
    await expect(saveModelGateway(f.store, f.broker, 'gw_missing', { enabled: true })).rejects.toMatchObject({ status: 404 });
  });

  it('serves a model cheapest first, only from gateways that are on, serve its harness and list it, at a known list price', async () => {
    const f = await fixture();
    const dear = await saveModelGateway(f.store, f.broker, undefined, gatewayInput({ name: 'Dear', priceMultiplier: 0.9, enabled: true }));
    const cheap = await saveModelGateway(f.store, f.broker, undefined, gatewayInput({ name: 'Cheap', priceMultiplier: 0.3, enabled: true }));
    await saveModelGateway(f.store, f.broker, undefined, gatewayInput({ name: 'Off', priceMultiplier: 0.1 }));
    await saveModelGateway(f.store, f.broker, undefined, gatewayInput({ name: 'Codex only', priceMultiplier: 0.1, harnesses: ['codex'], enabled: true }));
    await saveModelGateway(f.store, f.broker, undefined, gatewayInput({ name: 'Unpriced', priceMultiplier: 0.1, models: ['claude-mystery-9'], enabled: true }));
    const serving = await servingGateways(f.store, f.broker, { provider: 'claude', model: 'claude-opus-5-5' });
    expect(serving.map((gateway) => gateway.id)).toEqual([cheap.id, dear.id]);
    expect(await servingGateways(f.store, f.broker, { provider: 'claude', model: 'claude-mystery-9' })).toEqual([]);
    expect(await servingGateways(f.store, f.broker, { provider: 'opencode', model: 'openrouter/x/y' })).toEqual([]);
    const view = await modelGatewaysView(f.store, f.broker, computeMonth(Date.now()));
    expect(view.find((gateway) => gateway.name === 'Unpriced')?.unpriced).toEqual(['claude-mystery-9']);
  });
});

describe('which rail a Claude Code or Codex turn takes on the credit', () => {
  it('maps harness model ids to OpenRouter\'s', () => {
    expect(catalogueModelId('claude-opus-5-5')).toBe('anthropic/claude-opus-5.5');
    expect(catalogueModelId('claude-sonnet-4-5-20250929')).toBe('anthropic/claude-sonnet-4.5');
    expect(catalogueModelId('opus[1m]')).toBe('~anthropic/claude-opus-latest');
    expect(catalogueModelId('gpt-6.1-sol')).toBe('openai/gpt-6.1-sol');
    expect(openRouterHarnessModel('claude', 'opus[1m]')).toBe('~anthropic/claude-opus-latest[1m]');
    expect(openRouterHarnessModel('claude', 'gpt-6.1-sol')).toBeUndefined();
    expect(openRouterHarnessModel('codex', 'gpt-6.1-sol')).toBe('openai/gpt-6.1-sol');
    expect(openRouterHarnessModel('codex', 'claude-opus-5-5')).toBeUndefined();
  });

  it('is an operator gateway first, then OpenRouter, else none', async () => {
    const f = await fixture({ included: true });
    const claude = { provider: 'claude' as const, model: 'claude-opus-5-5' };
    expect(await creditRail(f.store, f.broker, claude)).toEqual({ kind: 'openrouter', model: 'anthropic/claude-opus-5.5' });
    expect(await creditRail(f.store, f.broker, { provider: 'codex', model: 'gpt-6.1-sol' })).toEqual({ kind: 'openrouter', model: 'openai/gpt-6.1-sol' });
    // A model OpenRouter does not list does not run there.
    expect(await creditRail(f.store, f.broker, { provider: 'claude', model: 'claude-mystery-9' })).toBeUndefined();
    const gateway = await saveModelGateway(f.store, f.broker, undefined, gatewayInput({ enabled: true }));
    expect(await creditRail(f.store, f.broker, claude)).toMatchObject({ kind: 'gateway', gateway: { id: gateway.id }, model: 'claude-opus-5-5' });
    expect(await creditRail(f.store, f.broker, { provider: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash-1017' })).toEqual({ kind: 'included' });
    // Without the included model (OpenRouter) and with the gateway off: nothing.
    await saveIncludedModel(f.store, f.broker, { enabled: false });
    await saveModelGateway(f.store, f.broker, gateway.id, { enabled: false });
    expect(await creditRail(f.store, f.broker, claude)).toBeUndefined();
  });
});

describe('metering', () => {
  it('reads Anthropic and Responses usage, streamed or not, and prices it at the multiplier × list price', () => {
    const anthropic = new UsageMeter('claude');
    for (let i = 0; i < SSE_ANTHROPIC.length; i += 37) anthropic.push(Buffer.from(SSE_ANTHROPIC.slice(i, i + 37)));
    expect(anthropic.result()).toEqual({ inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 100_000, cacheWriteTokens: 2_000, model: 'claude-opus-5-5' });
    const plain = new UsageMeter('claude');
    plain.push(JSON.stringify({ type: 'message', model: 'm', usage: { input_tokens: 7, output_tokens: 3 } }));
    expect(plain.result()).toMatchObject({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 0 });
    const responses = new UsageMeter('codex');
    responses.push(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'r' } })}\n\n`);
    responses.push(`data: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-6.1-sol',
      usage: { input_tokens: 30_000, input_tokens_details: { cached_tokens: 20_000 }, output_tokens: 1_000 } } })}\n\n`);
    expect(responses.result()).toEqual({ inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 20_000, cacheWriteTokens: 0, model: 'gpt-6.1-sol' });
    // A stream cut after message_start still counts its input.
    const cut = new UsageMeter('claude');
    cut.push(SSE_ANTHROPIC.split('event: content_block_delta')[0]!);
    expect(cut.result()).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 100_000 });
    // Opus at list: 1k × $4/M + 500 × $20/M + 100k × $0.2/M + 2k × $5/M = $0.044; × 0.3.
    const price = { prompt: 0.000004, completion: 0.00002, cache: 0.0000002, cacheWrite: 0.000005 };
    expect(gatewayCostMicros({ inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 100_000, cacheWriteTokens: 2_000 }, price, 0.3)).toBe(13_200);
  });
});

describe('the proxy', () => {
  async function proxied(options: { enabled?: boolean } = {}) {
    const f = await fixture();
    const gateway = await saveModelGateway(f.store, f.broker, undefined, gatewayInput({ enabled: options.enabled ?? true }));
    const task = await f.store.createTask({ projectId: f.project.id, title: 'Work', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'w' } as any });
    proxyDeps = { store: f.store, broker: f.broker };
    const token = await issueGatewayToken(f.store, { gatewayId: gateway.id, harness: 'claude', organizationId: f.organization.id, projectId: f.project.id, taskId: task.id });
    const call = (body: unknown, auth = token, route = '/v1/messages?beta=true') => fetch(`${proxyUrl}/api/model-gateway${route}`, {
      method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body) });
    return { ...f, gateway, task, token, call };
  }

  it('forwards a turn\'s request with the gateway\'s key, streams the answer back and books what it used', async () => {
    const f = await proxied();
    const response = await f.call({ model: 'claude-opus-5-5', stream: true, max_tokens: 10, messages: [] });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe(SSE_ANTHROPIC);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]).toMatchObject({ url: '/v1/messages?beta=true', body: { model: 'claude-opus-5-5' } });
    // The gateway's key, never the turn's token.
    expect(upstreamCalls[0]!.headers).toMatchObject({ authorization: 'Bearer gw-secret', 'x-api-key': 'gw-secret', 'anthropic-version': '2023-06-01' });
    expect(JSON.stringify(upstreamCalls[0]!.headers)).not.toContain(f.token);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const costs = await f.store.db.prepare("SELECT taskId, provider, costMicros, fundingSource, metadata FROM usage_events WHERE kind='agent.cost'").all() as any[];
    expect(costs).toEqual([expect.objectContaining({ taskId: f.task.id, provider: `gateway:${f.gateway.id}`, costMicros: 13_200, fundingSource: 'managed' })]);
    expect(JSON.parse(costs[0].metadata)).toMatchObject({ costBasis: 'model-gateway-list-price', model: 'claude-opus-5-5', priceMultiplier: 0.3 });
    // On the credit, at the organization's multiplier (2×).
    expect((await computeCredit(f.store, f.organization.id)).usedMicros).toBe(26_400);
  });

  it('prices each request at its own model\'s list price: a sub-agent on Haiku costs Haiku\'s', async () => {
    const f = await proxied();
    await (await f.call({ model: 'claude-haiku-5-5', stream: true, messages: [] })).text();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 1k × $0.1/M + 500 × $0.5/M + 100k × $0.01/M + 2k × $0.125/M = $0.0016; × 0.3.
    const costs = await f.store.db.prepare("SELECT costMicros, metadata FROM usage_events WHERE kind='agent.cost'").all() as any[];
    expect(costs.map((row) => [row.costMicros, JSON.parse(row.metadata).model])).toEqual([[480, 'claude-haiku-5-5']]);
  });

  it('refuses a revoked or unknown token, a gateway switched off, an unpriced model and a spent credit', async () => {
    const f = await proxied();
    expect((await f.call({ model: 'claude-opus-5-5' }, 'tmg_unknown')).status).toBe(401);
    expect((await f.call({ model: 'claude-mystery-9' })).status).toBe(400);
    await saveModelGateway(f.store, f.broker, f.gateway.id, { enabled: false });
    expect((await f.call({ model: 'claude-opus-5-5' })).status).toBe(403);
    await saveModelGateway(f.store, f.broker, f.gateway.id, { enabled: true });
    // The whole $5 trial, booked: the next request is refused, Out of compute.
    await f.store.recordUsage({ organizationId: f.organization.id, provider: 'e2b', kind: 'world.active', quantity: 1, unit: 'second',
      costMicros: 2_500_000, startedAt: Date.now() - 1000, endedAt: Date.now(), fundingSource: 'managed' });
    const spent = await f.call({ model: 'claude-opus-5-5' });
    expect(spent.status).toBe(402);
    expect(((await spent.json()) as any).error.message).toMatch(/^Out of credits: .*Plan & billing \(\S+\/settings#settings-plan\)/);
    await revokeGatewayToken(f.store, f.token);
    expect((await f.call({ model: 'claude-opus-5-5' })).status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('forgets tokens of turns that never ended', async () => {
    const f = await fixture();
    const token = await issueGatewayToken(f.store, { gatewayId: 'gw_x', harness: 'codex', organizationId: f.organization.id }, Date.now() - 8 * 24 * 3600_000);
    await pruneGatewayTokens(f.store);
    expect(await gatewayGrant(f.store, token, Date.now() - 8 * 24 * 3600_000 + 1)).toBeUndefined();
  });
});

describe('a Claude Code or Codex turn on the credit', () => {
  async function turnFixture(provider: 'claude' | 'codex', model: string, adapter: (input: any) => Promise<any>, options: { included?: boolean } = {}) {
    const f = await fixture({ included: options.included });
    const task = await f.store.createTask({ projectId: f.project.id, title: 'Work', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'work' } as any });
    const { WorldRegistry } = await import('../src/world/registry.js');
    const { ProfileResolver } = await import('../src/agent/profiles.js');
    const { makeCoreActivities } = await import('../src/activities/core.js');
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    cleanups.push(() => world.destroy());
    const adapters = new Map([[provider, { provider, runTurn: adapter }]]) as any;
    const configHomes = new ConfigHomeManager(f.homes);
    const core = makeCoreActivities({ store: f.store, worlds, adapters, broker: f.broker, configHomes, profiles: new ProfileResolver(f.store, 'claude') } as any);
    const input = { taskId: task.id, projectId: f.project.id, title: task.title, prompt: 'work', project: {}, workflow: 'just-do',
      agents: { do: { provider, model } } };
    const run = () => core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`, agentSlotGranted: true,
      agentAdmissionManaged: true, worldHandle: world.handle, messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }], task: input } as any);
    const order = () => core.resolveCredentialOrder({ taskId: task.id, projectId: f.project.id, provider, role: 'do', task: input as any });
    proxyDeps = { store: f.store, broker: f.broker };
    return { ...f, task, run, order };
  }

  it('runs Claude Code through an operator gateway via tavya\'s proxy, in a home of its own, and charges the credit for what the gateway reported', async () => {
    let auth: any;
    let status = 0;
    const f = await turnFixture('claude', 'claude-opus-5-5', async (input) => {
      auth = input.resolvedAuth;
      // What Claude Code does with ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN.
      const response = await fetch(`${auth.gateway.baseUrl}/v1/messages`, { method: 'POST',
        headers: { authorization: `Bearer ${auth.gateway.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: auth.gateway.model, stream: true, messages: [] }) });
      status = response.status;
      await response.text();
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'done',
        usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 100_000, cacheWriteTokens: 2_000 } };
    });
    const gateway = await saveModelGateway(f.store, f.broker, undefined, gatewayInput({ enabled: true }));
    // No login is leased: nothing of the organization's own runs it.
    expect(await f.order()).toEqual([]);
    await f.run();
    expect(status).toBe(200);
    expect(auth.gateway).toMatchObject({ baseUrl: `${proxyUrl}/api/model-gateway`, apiKey: expect.stringMatching(/^tmg_/), model: 'claude-opus-5-5',
      env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-5-5' } });
    expect(auth.apiKey).toBeUndefined();
    // A Claude home of its own, never the operator's or a login's.
    expect(auth.configHome).toContain(path.join('gateway-homes'));
    expect(auth.configHome).toContain(f.organization.id);
    // The key stayed on the control plane; the token ended with the turn.
    expect(JSON.stringify(auth)).not.toContain('gw-secret');
    expect(await gatewayGrant(f.store, auth.gateway.apiKey)).toBeUndefined();
    const costs = await f.store.db.prepare("SELECT taskId, provider, costMicros FROM usage_events WHERE kind='agent.cost'").all() as any[];
    expect(costs).toEqual([{ taskId: f.task.id, provider: `gateway:${gateway.id}`, costMicros: 13_200 }]);
    // The harness's own report is kept as tokens, never charged twice.
    const tokens = await f.store.db.prepare("SELECT fundingSource FROM usage_events WHERE kind='agent.tokens'").all() as any[];
    expect(tokens).toEqual([{ fundingSource: 'managed' }]);
  });

  it('runs Codex through OpenRouter on the organization\'s key when no operator gateway serves it', async () => {
    let auth: any;
    const f = await turnFixture('codex', 'gpt-6.1-sol', async (input) => {
      auth = input.resolvedAuth;
      for (const key of keys.values()) key.usage += 0.1;
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    }, { included: true });
    expect(await f.order()).toEqual([]);
    await f.run();
    expect(auth.gateway).toEqual({ baseUrl: `${process.env.KARMAX_OPENROUTER_API_URL}`, apiKey: 'sk-or-hash1', model: 'openai/gpt-6.1-sol' });
    const costs = await f.store.db.prepare("SELECT provider, costMicros, metadata FROM usage_events WHERE kind='agent.cost'").all() as any[];
    expect(costs).toEqual([expect.objectContaining({ provider: 'openrouter', costMicros: 100_000 })]);
  });

  it('gives Claude Code OpenRouter\'s Anthropic endpoint and its model ids', async () => {
    let auth: any;
    const f = await turnFixture('claude', 'claude-opus-5-5', async (input) => {
      auth = input.resolvedAuth;
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'done' };
    }, { included: true });
    await f.run();
    expect(auth.gateway).toMatchObject({ baseUrl: process.env.KARMAX_OPENROUTER_API_URL!.replace(/\/v1$/, ''), apiKey: 'sk-or-hash1',
      model: 'anthropic/claude-opus-5.5', env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: '~anthropic/claude-haiku-latest' } });
  });

  it('still says which login is missing when nothing serves it, and waits Out of compute without credit', async () => {
    const none = await turnFixture('claude', 'claude-opus-5-5', async () => ({ termination: { kind: 'success', status: 'end_turn' } }));
    expect((await none.order())[0]).toMatch(/^missing:/);
    await expect(none.run()).rejects.toThrow(/no usable claude credential/);
    const spent = await turnFixture('claude', 'claude-opus-5-5', async () => ({ termination: { kind: 'success', status: 'end_turn' } }));
    await saveModelGateway(spent.store, spent.broker, undefined, gatewayInput({ enabled: true }));
    await spent.store.recordUsage({ organizationId: spent.organization.id, provider: 'e2b', kind: 'world.active', quantity: 1, unit: 'second',
      costMicros: 2_500_000, startedAt: Date.now() - 1000, endedAt: Date.now(), fundingSource: 'managed' });
    await expect(spent.run()).rejects.toMatchObject({ type: 'world-capacity', message: expect.stringMatching(/^Out of credits/) });
  });

  it('prefers a login of the organization\'s own', async () => {
    const f = await turnFixture('claude', 'claude-opus-5-5', async () => ({ termination: { kind: 'success', status: 'end_turn' } }));
    await saveModelGateway(f.store, f.broker, undefined, gatewayInput({ enabled: true }));
    await f.broker.registerHandle(`anthropic:${f.organization.id}:main`, 'sk-ant-own', organizationScope(f.organization.id));
    expect(await f.order()).toEqual([expect.not.stringMatching(/^missing:/)]);
  });
});

describe('readiness and the default agent', () => {
  it('counts a Claude or Codex model a gateway serves as runnable on the credit, naming the gateway and what it costs', async () => {
    const f = await fixture({ included: true });
    const deps = { store: f.store, hosted: true, broker: f.broker };
    const scope = { organizationId: f.organization.id, projectId: f.project.id };
    const [opus, mystery] = (await projectReadiness(deps, scope, [{ provider: 'claude', model: 'claude-opus-5-5' },
      { provider: 'claude', model: 'claude-mystery-9' }])).agents;
    expect(opus).toMatchObject({ ready: true, gateway: 'OpenRouter', cost: expect.any(Number) });
    expect(opus!.cost!).toBeGreaterThan(10);
    expect(mystery).toMatchObject({ ready: false, need: { provider: 'claude' } });
    await saveModelGateway(f.store, f.broker, undefined, gatewayInput({ enabled: true, priceMultiplier: 0.3 }));
    const [viaGateway] = (await projectReadiness(deps, scope, [{ provider: 'claude', model: 'claude-opus-5-5' }])).agents;
    expect(viaGateway).toMatchObject({ ready: true, gateway: 'Company proxy' });
    expect(viaGateway!.cost!).toBeCloseTo(opus!.cost! * 0.3, 0);
  });

  it('keeps the included model as the default of an organization without a login, though Claude could run on its credit', async () => {
    const f = await fixture({ included: true });
    fs.mkdirSync(f.homes, { recursive: true });
    const deps = { store: f.store, hosted: true, broker: f.broker, configHomes: new ConfigHomeManager(f.homes) };
    const defaults = await defaultAgentProfile(deps, 'do', { organizationId: f.organization.id, projectId: f.project.id }, 'claude');
    expect(defaults).toMatchObject({ included: true, profile: { provider: 'opencode' } });
    // A Task default is inherited, so the same holds for the organization's own: Claude on the credit
    // costs tens of times the included model, so a task gets it only when someone picks it.
    await f.store.upsertProfile({ id: organizationProfileId(f.organization.id, 'do'), name: 'Do', role: 'do', provider: 'claude', model: 'claude-opus-5-5' });
    expect((await defaultAgentProfile(deps, 'do', { organizationId: f.organization.id, projectId: f.project.id }, 'claude')).included).toBe(true);
  });
});
