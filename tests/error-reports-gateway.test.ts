import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { ORGANIZATION_GRANT_CEILING } from '../src/platform/authorization.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { configureErrorReports, ERROR_EVENT_TYPE } from '../src/platform/error-reports.js';
import { ERROR_FIXER_TRIGGER } from '../src/platform/error-fixer.js';

/**
 * Error reports through the gateway (wiki features/error-reports): only an
 * installation operator (or an agent with that authority) chooses where they
 * go, choosing makes the fixer with the caller's token, and a request that
 * fails unexpectedly (500) becomes a report; a refusal (4xx) does not.
 */
describe('error reports through the gateway', () => {
  let home: string;
  let store: Store;
  let base: string;
  let close: () => Promise<void>;
  let ops: { id: string };
  const tokens = new TokenAuthority();
  const made: Array<{ token: string; input: any }> = [];
  const tokenFor: Record<string, string> = {};
  const call = (token: string, method: string, route: string, body?: unknown) =>
    fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-error-reports-'));
    fs.copyFileSync(new URL('../web/index.html', import.meta.url), path.join(home, 'index.html'));
    store = await Store.create(':memory:');
    configureErrorReports(store, { role: 'gateway' });
    ops = await store.createProject('tavya');
    // Every other API call fails as an unexpected bug would.
    const api = new Proxy({
      createTask: async (token: string, input: any) => {
        made.push({ token, input });
        return store.createTask({ projectId: input.projectId, title: input.title, workflow: 'software-dev', workflowVersion: '1.30.0',
          params: { prompt: input.prompt, ...input.params } });
      },
    }, { get: (target, key) => key in target ? (target as any)[key] : async () => { throw new TypeError('Cannot read properties of undefined (reading \'id\')'); } });
    const gateway = await Gateway.create({
      store, bus: new KarmaxBus(), tokens, contributions: new ContributionRegistry(), overlays: new Overlays(),
      client: {} as any, api, taskQueue: 'test', staticDir: home,
      agentInfo: { provider: 'mock', reason: 'error reports test' }, worlds: new WorldRegistry(),
    } as any);
    const running = await gateway.listen(await findFreePortFrom(48_600));
    base = running.url;
    close = running.close;
    const tenant = await store.createOrganization({ name: 'Tenant', ownerUserId: 'owner' });
    tokenFor.operator = (await tokens.mintPrincipal('user:op', ['*'])).token;
    tokenFor.reader = (await tokens.mintPrincipal('user:reader', ['settings:read'])).token;
    tokenFor.tenantOwner = (await tokens.mintPrincipal('user:owner', ORGANIZATION_GRANT_CEILING, undefined, undefined, tenant.id)).token;
  }, 30_000);

  afterAll(async () => {
    await close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is installation authority, listed for agents', async () => {
    expect(routeCapability('GET', '/api/settings/error-reports')).toBe('settings:read');
    expect(routeCapability('PUT', '/api/settings/error-reports')).toBe('settings:write');
    expect(PLATFORM_API_CATALOG.installation.some((entry: string) => entry.startsWith('GET|PUT /api/settings/error-reports '))).toBe(true);
    expect((await call(tokenFor.reader!, 'GET', '/api/settings/error-reports')).status).toBe(200);
    for (const who of ['reader', 'tenantOwner'])
      expect((await call(tokenFor[who]!, 'PUT', '/api/settings/error-reports', { projectId: ops.id })).status).toBe(403);
    expect(made).toEqual([]);
  });

  it('sends reports to a project and makes its fixer with the operator\'s token; a 500 becomes a report, a 404 does not', async () => {
    expect((await call(tokenFor.operator!, 'PUT', '/api/settings/error-reports', { projectId: 'proj_missing' })).status).toBe(404);
    const saved = await call(tokenFor.operator!, 'PUT', '/api/settings/error-reports', { projectId: ops.id });
    expect(saved.status).toBe(200);
    const { settings } = await saved.json() as { settings: { projectId: string; fixerTaskId: string } };
    expect(settings).toEqual({ projectId: ops.id, fixerTaskId: expect.stringMatching(/^task_/) });
    expect(made).toEqual([{ token: tokenFor.operator, input: expect.objectContaining({ params: expect.objectContaining({ triggers: [ERROR_FIXER_TRIGGER] }) }) }]);
    expect(await (await call(tokenFor.reader!, 'GET', '/api/settings/error-reports')).json()).toEqual({ settings });

    expect((await call(tokenFor.operator!, 'GET', '/api/no-such-route')).status).toBe(404);
    const failed = await call(tokenFor.operator!, 'GET', `/api/tasks/${settings.fixerTaskId}/follows`);
    expect(failed.status).toBe(500);
    const reports = async () => (await store.listProjectEvents(ops.id)).filter((event) => event.type === ERROR_EVENT_TYPE);
    await expect.poll(reports).toHaveLength(1);
    const [report] = await reports();
    expect(report).toMatchObject({ source: 'tavya', payload: { kind: 'request', name: 'TypeError', process: 'gateway',
      where: 'GET /api/tasks/:id/follows', message: "Cannot read properties of undefined (reading 'id')" } });

    expect((await call(tokenFor.operator!, 'PUT', '/api/settings/error-reports', { projectId: null })).status).toBe(200);
    expect(await (await call(tokenFor.operator!, 'GET', '/api/settings/error-reports')).json()).toEqual({ settings: {} });
  });
});
