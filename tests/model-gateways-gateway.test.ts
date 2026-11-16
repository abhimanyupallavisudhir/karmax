import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Gateway } from '../src/gateway/server.js';
import { ORGANIZATION_GRANT_CEILING } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { issueGatewayToken } from '../src/agent/model-gateways.js';
import { resetModelPrices } from '../src/agent/model-prices.js';

/**
 * Model gateways through the gateway (wiki features/model-gateways): only an
 * installation operator (or an agent with that authority) adds, changes or
 * removes one; a new one is off; the key never comes back; and the proxy the
 * agents' harnesses call answers without a session, to a turn's token only.
 */
describe('model gateways through the gateway', () => {
  let home: string;
  let store: Store;
  let base: string;
  let close: () => Promise<void>;
  let upstream: http.Server;
  let upstreamUrl: string;
  let catalogue: http.Server;
  const seen: Array<{ url: string; auth?: string }> = [];
  const tokens = new TokenAuthority();
  const tokenFor: Record<string, string> = {};
  let tenantId: string;
  const call = (token: string, method: string, route: string, body?: unknown) =>
    fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-model-gateways-gw-'));
    fs.copyFileSync(new URL('../web/index.html', import.meta.url), path.join(home, 'index.html'));
    upstream = http.createServer((req, res) => {
      seen.push({ url: req.url!, auth: req.headers.authorization });
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 2 } })); });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    catalogue = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000004', completion: '0.00002' } }] })); });
    await new Promise<void>((resolve) => catalogue.listen(0, '127.0.0.1', () => resolve()));
    process.env.KARMAX_OPENROUTER_API_URL = `http://127.0.0.1:${(catalogue.address() as AddressInfo).port}`;
    resetModelPrices();
    store = await Store.create(':memory:');
    const gateway = await Gateway.create({
      store, bus: new KarmaxBus(), tokens, contributions: new ContributionRegistry(), overlays: new Overlays(),
      client: {} as any, api: {} as any, taskQueue: 'test', staticDir: home, broker: new CredentialBroker(new Vault(path.join(home, 'vault'))),
      agentInfo: { provider: 'mock', reason: 'model gateways test' }, worlds: new WorldRegistry(),
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_700));
    base = running.url;
    close = running.close;
    const tenant = await store.createOrganization({ name: 'Tenant', ownerUserId: 'owner' });
    tenantId = tenant.id;
    tokenFor.operator = (await tokens.mintPrincipal('user:op', ['*'])).token;
    tokenFor.reader = (await tokens.mintPrincipal('user:reader', ['settings:read'])).token;
    tokenFor.tenantOwner = (await tokens.mintPrincipal('user:owner', ORGANIZATION_GRANT_CEILING, undefined, undefined, tenant.id)).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    delete process.env.KARMAX_OPENROUTER_API_URL;
    resetModelPrices();
    await Promise.all([upstream, catalogue].map((server) => new Promise((resolve) => server.close(resolve))));
    await store?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('lets only an operator add, switch and remove one, off by default, never showing its key', async () => {
    const input = { name: 'Company LiteLLM', harnesses: ['claude'], baseUrl: upstreamUrl, models: ['claude-opus-5-5'], priceMultiplier: 0.5, apiKey: 'litellm-key' };
    for (const who of ['reader', 'tenantOwner']) expect((await call(tokenFor[who]!, 'POST', '/api/settings/model-gateways', input)).status).toBe(403);
    expect((await call(tokenFor.tenantOwner!, 'GET', '/api/settings/model-gateways')).status).toBe(403);
    const created = await call(tokenFor.operator!, 'POST', '/api/settings/model-gateways', input);
    expect(created.status).toBe(201);
    const { gateway } = await created.json() as any;
    expect(gateway).toMatchObject({ name: 'Company LiteLLM', enabled: false, priceMultiplier: 0.5 });
    const listed = await (await call(tokenFor.reader!, 'GET', '/api/settings/model-gateways')).text();
    expect(JSON.parse(listed).gateways).toEqual([expect.objectContaining({ id: gateway.id, enabled: false, keyConfigured: true })]);
    expect(listed).not.toContain('litellm-key');
    expect((await call(tokenFor.operator!, 'POST', '/api/settings/model-gateways', { ...input, baseUrl: 'nope' })).status).toBe(400);
    const on = await call(tokenFor.operator!, 'PUT', `/api/settings/model-gateways/${gateway.id}`, { enabled: true });
    expect((await on.json() as any).gateway).toMatchObject({ enabled: true });
    expect((await call(tokenFor.operator!, 'PUT', '/api/settings/model-gateways/gw_missing', { enabled: true })).status).toBe(404);

    // The proxy: no session, only a turn's token.
    const proxy = (auth: string) => fetch(`${base}/api/model-gateway/v1/messages`, { method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }) });
    expect((await proxy(tokenFor.operator!)).status).toBe(401);
    const turn = await issueGatewayToken(store, { gatewayId: gateway.id, harness: 'claude', organizationId: tenantId });
    const answered = await proxy(turn);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ usage: { input_tokens: 10 } });
    expect(seen).toEqual([{ url: '/v1/messages', auth: 'Bearer litellm-key' }]);

    expect((await call(tokenFor.operator!, 'DELETE', `/api/settings/model-gateways/${gateway.id}`)).status).toBe(200);
    expect((await (await call(tokenFor.operator!, 'GET', '/api/settings/model-gateways')).json() as any).gateways).toEqual([]);
    expect((await proxy(turn)).status).toBe(403);
  });
});
