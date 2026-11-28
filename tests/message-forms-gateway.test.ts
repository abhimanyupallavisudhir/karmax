// Message forms through the gateway (wiki features/message-forms): an agent's
// tool call carrying a form nobody would be shown is refused with the reason,
// and a person's save is checked on the server against the same list of
// settings — the browser's check is no longer the only guard — then made with
// their own authority.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService, DEFAULT_AUTHORIZATION_PROFILES } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import { turnPlatformRequest } from '../src/agent/platform-request.js';
import { FORM_SAVE_TARGETS } from '../src/domain/message-forms.js';

const caps = (id: string) => DEFAULT_AUTHORIZATION_PROFILES.find((profile) => profile.id === id)!.capabilities;
const fence = (spec: unknown) => `\`\`\`form\n${JSON.stringify(spec)}\n\`\`\``;
const outside = { fields: [{ name: 'who', label: 'Who' }], save: { method: 'POST', path: '/api/organizations/o/members', body: { userId: '{{who}}', role: 'owner' } } };

describe('message forms through the gateway', () => {
  let home: string;
  let store: Store;
  let close: () => Promise<void>;
  let base: string;
  let site: string;
  let agentToken: string;
  let maintainer: string;
  let developer: string;
  const previousGateway = process.env.KARMAX_GATEWAY_URL;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-message-forms-'));
    store = (await Store.create(':memory:', { hosted: true }));
    const tokens = new TokenAuthority();
    const acme = (await store.createOrganization({ name: 'Acme', ownerUserId: 'a' }));
    site = (await store.createProject('Site', {}, acme.id)).id;
    const client = { workflow: { getHandle: () => ({ signal: async () => {}, query: async () => undefined }) } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, contentDir: home, worlds: new WorldRegistry() });
    const running = await (await Gateway.create({
      api, store, tokens, client,
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      authorization: (await AuthorizationService.create(store)),
      taskQueue: 'test', staticDir: home, agentInfo: { provider: 'mock', reason: 'message forms test' },
      worlds: new WorldRegistry(),
    } as any)).listen(await findFreePortFrom(48_900));
    base = running.url;
    close = running.close;
    process.env.KARMAX_GATEWAY_URL = base;
    const task = await store.createTask({ projectId: site, title: 'Ask', workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'x', _authorization: { level: 'maintainer', scope: 'projects', projectIds: [site], organizationId: acme.id, capabilities: caps('maintainer') } } as any });
    agentToken = (await tokens.mint({ taskId: task.id, profileId: 'claude', role: 'do', principal: 'user:a', projectIds: [site],
      organizationId: acme.id, ceiling: ['*'], grantorCaps: [...caps('maintainer'), 'task:escalate'] })).token;
    maintainer = (await tokens.mintPrincipal('user:a', caps('maintainer'), site, 60_000, acme.id)).token;
    developer = (await tokens.mintPrincipal('user:d', caps('developer'), site, 60_000, acme.id)).token;
  }, 30_000);

  afterAll(async () => {
    if (previousGateway === undefined) delete process.env.KARMAX_GATEWAY_URL; else process.env.KARMAX_GATEWAY_URL = previousGateway;
    await close?.();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const save = (token: string, form: unknown, values: Record<string, unknown>) => fetch(`${base}/api/message-forms/save`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ form: typeof form === 'string' ? form : JSON.stringify(form), values }) })
    .then(async (res) => ({ status: res.status, body: await res.json() as any }));

  it('refuses an agent\'s tool call whose form nobody would be shown, saying why', async () => {
    const tools = platformToolHandlers({} as any, { platformRequest: (method: string, p: string, body?: unknown) =>
      turnPlatformRequest({ token: agentToken, method, path: p, body }) } as any);
    const message = `Who should own it?\n\n${fence(outside)}`;
    for (const call of [
      () => tools.escalate_to_human!({ audience: ['@creator'], message }),
      () => tools.notify!({ to: ['@creator'], message }),
    ]) await expect(call()).rejects.toThrow(new RegExp(
      "^the form: save POST /api/organizations/o/members isn't an allowed settings route; allowed: POST /api/projects/:project/secrets, .*PATCH /api/user/preferences\\. Nothing was sent: fix the form and try again\\.$"));
    // A secret that could be read back is refused too, saying where it would go.
    await expect(tools.escalate_to_human!({ audience: ['@creator'], message: fence({ fields: [{ name: 'key', type: 'secret' }],
      save: { method: 'POST', path: `/api/projects/${site}/secrets`, body: { name: '{{key}}', value: 'x' } } }) }))
      .rejects.toThrow(/secret field "key" is saved under "name", which can be read back; use a write-only key/);
    // Nothing reached anyone.
    expect((await store.eventsSince((await store.listTasks(site))[0]!.id, 0)).filter((e) => e.type === 'task.escalated')).toEqual([]);
  });

  it('serves the console the server\'s own list', async () => {
    const meta = await (await fetch(`${base}/api/meta`)).json() as any;
    expect(meta.messageForms.targets).toEqual(FORM_SAVE_TARGETS);
    expect(meta.messageForms.secretKeys).toContain('managementKey');
  });

  it('refuses to save to a route outside the list, whatever the browser said', async () => {
    const refused = await save(maintainer, outside, { who: 'mallory' });
    expect(refused).toEqual({ status: 400, body: expect.objectContaining({
      error: "This form may not save: save POST /api/organizations/o/members isn't an allowed settings route." }) });
    // Nor a secret where it can be read back: a project's name is shown to everyone in it.
    const leak = await save(maintainer, { fields: [{ name: 'key', type: 'secret' }], save: { method: 'PATCH', path: `/api/projects/${site}`, body: { name: '{{key}}' } } }, { key: 'sk-1' });
    expect(leak.status).toBe(400);
    expect(leak.body.error).toMatch(/not a secret store/);
    expect((await store.getProject(site))?.name).toBe('Site');
    expect((await save(maintainer, '{nope', {})).status).toBe(400);
    expect((await save(maintainer, { fields: [{ name: 'a' }] }, { a: 'x' })).body.error).toBe('This form saves nothing.');
    expect((await fetch(`${base}/api/message-forms/save`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(401);
  });

  it('saves an allowed setting with the person\'s own authority, from the form\'s fields only', async () => {
    const rename = { fields: [{ name: 'name', label: 'Name' }], save: { method: 'PATCH', path: `/api/projects/${site}`, body: { name: '{{name}}', description: '{{extra}}' } } };
    // A developer may not change project settings in Settings, so not through a form either.
    const denied = await save(developer, rename, { name: 'Renamed' });
    expect(denied.status).toBe(403);
    expect((await store.getProject(site))?.name).toBe('Site');
    const saved = await save(maintainer, rename, { name: 'Renamed', extra: 'not a field of the form' });
    expect(saved.status).toBe(200);
    const project = await store.getProject(site);
    expect(project?.name).toBe('Renamed');
    expect((project as any)?.description ?? '').toBe('');
  });
});
