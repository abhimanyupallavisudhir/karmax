import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Gateway, routeCapability } from '../src/gateway/server.js';
import { clientWentAway } from '../src/gateway/error-status.js';
import { ORGANIZATION_GRANT_CEILING } from '../src/platform/authorization.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { WorldRegistry } from '../src/world/registry.js';
import { configureErrorReports, ERROR_EVENT_TYPE, errorReporter } from '../src/platform/error-reports.js';
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
    const failed = await call(tokenFor.operator!, 'GET', `/api/tasks/${settings.fixerTaskId}/follow-up-triggers`);
    expect(failed.status).toBe(500);
    const reports = async () => (await store.listProjectEvents(ops.id)).filter((event) => event.type === ERROR_EVENT_TYPE);
    await expect.poll(reports).toHaveLength(1);
    const [report] = await reports();
    expect(report).toMatchObject({ source: 'tavya', payload: { kind: 'request', name: 'TypeError', process: 'gateway',
      where: 'GET /api/tasks/:id/follow-up-triggers', message: "Cannot read properties of undefined (reading 'id')" } });

    expect((await call(tokenFor.operator!, 'PUT', '/api/settings/error-reports', { projectId: null })).status).toBe(200);
    expect(await (await call(tokenFor.operator!, 'GET', '/api/settings/error-reports')).json()).toEqual({ settings: {} });
  });

  // tavya-error 9a1cd9333f3c057a (2026-11-15): a person closed the page while
  // POST /review-action's body was on its way; Node failed the body with
  // ECONNRESET "aborted", which was answered as a 500 and filed as a bug.
  it('files no report when the client goes away before its request is read', async () => {
    expect((await call(tokenFor.operator!, 'PUT', '/api/settings/error-reports', { projectId: ops.id })).status).toBe(200);
    const reported = vi.spyOn(errorReporter()!, 'report');
    const failed = vi.spyOn(Gateway.prototype as any, 'fail');
    const { port } = new URL(base);
    // Headers promise a body; part of it arrives, then the connection closes.
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(Number(port), '127.0.0.1', () => {
        socket.write(`POST /api/tasks/task_gone/review-action HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${tokenFor.operator}\r\n`
          + 'content-type: application/json\r\ncontent-length: 200\r\n\r\n{"index":');
        setTimeout(() => { socket.destroy(); resolve(); }, 100);
      });
      socket.on('error', reject);
    });
    // The gateway meets the aborted body, and whatever it reports is recorded.
    await expect.poll(() => failed.mock.calls.some(([, error]) => (error as Error)?.message === 'aborted')).toBe(true);
    await Promise.all(reported.mock.results.map((result) => result.value));
    expect(reported).not.toHaveBeenCalled();
    failed.mockRestore();
    reported.mockRestore();
    const events = (await store.listProjectEvents(ops.id)).filter((event) => event.type === ERROR_EVENT_TYPE);
    expect(events.map((event) => (event.payload as { message: string }).message)).not.toContain('aborted');
    expect((await call(tokenFor.operator!, 'PUT', '/api/settings/error-reports', { projectId: null })).status).toBe(200);
  });
});

describe('clientWentAway', () => {
  const gone = { socket: { destroyed: true } } as unknown as http.IncomingMessage;
  const here = { socket: { destroyed: false } } as unknown as http.IncomingMessage;
  const reset = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
  it('is a dropped connection failing the request, never the same code while the client still waits', () => {
    expect(clientWentAway(reset, gone)).toBe(true);
    expect(clientWentAway(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }), gone)).toBe(true);
    // An upstream tavya called reset its connection: the client is still there to be told.
    expect(clientWentAway(reset, here)).toBe(false);
    // A bug that happens to run after the client left is still a bug.
    expect(clientWentAway(new TypeError("Cannot read properties of undefined (reading 'id')"), gone)).toBe(false);
    expect(clientWentAway(reset, undefined)).toBe(false);
  });
});
