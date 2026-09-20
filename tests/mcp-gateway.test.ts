import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

describe('MCP HTTP authorization boundary', () => {
  let dir: string, store: Store, tokens: TokenAuthority, base: string, close: () => Promise<void>;
  let org: string, project: string, otherOrg: string, otherProject: string;
  const token = (caps: string[], pid: string | undefined = project, oid = org) => tokens.mintPrincipal('user:test', caps, pid, 60_000, oid).token;
  const request = (method: string, route: string, bearer: string, body?: unknown) => fetch(base + route, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gateway-')); store = new Store(':memory:', { hosted: true }); tokens = new TokenAuthority();
    org = store.createOrganization({ name: 'Acme' }).id; project = store.createProject('Mine', {}, org).id;
    otherOrg = store.createOrganization({ name: 'Other' }).id; otherProject = store.createProject('Theirs', {}, otherOrg).id;
    const gateway = new Gateway({ store, tokens, broker: new CredentialBroker(new Vault(path.join(dir, 'vault'))), bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(), client: {} as any, api: {} as any, taskQueue: 'test', staticDir: dir, agentInfo: { provider: 'mock', reason: 'test' }, worlds: new WorldRegistry() });
    const server = await gateway.listen(await findFreePortFrom(48_500)); base = server.url; close = server.close;
  });
  afterAll(async () => { await close?.(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  it('serves a public client identity without reflecting request origins or requiring Composio', async () => {
    vi.stubEnv('KARMAX_PUBLIC_URL', 'https://tavya.example');
    try {
      const response = await fetch(base + '/api/mcp-client-metadata', { headers: { host: 'attacker.example', origin: 'https://attacker.example' } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ client_id: 'https://tavya.example/api/mcp-client-metadata', redirect_uris: ['https://tavya.example/mcp-callback'] });
      expect(JSON.stringify(body)).not.toContain('attacker');
      vi.stubEnv('KARMAX_PUBLIC_URL', '');
      expect((await fetch(base + '/api/mcp-client-metadata')).status).toBe(404);
    } finally { vi.unstubAllEnvs(); }
  });
  it('accepts preregistered OAuth clients only for administrators and excludes client secrets from responses', async () => {
    const route = `/api/mcp?projectId=${project}`;
    const body = { label: 'Manual OAuth', auth: 'oauth', transport: { type: 'http', url: 'https://example.com/oauth' }, oauthClient: { clientId: 'client', clientSecret: 'private-secret', tokenEndpointAuthMethod: 'client_secret_basic' } };
    expect((await request('POST', route, token(['profile:read']), body)).status).toBe(403);
    const response = await request('POST', route, token(['project:settings:write']), body);
    expect(response.status).toBe(200);
    const saved = await response.json() as any;
    expect(saved.oauthClient).toEqual({ clientId: 'client', tokenEndpointAuthMethod: 'client_secret_basic', hasSecret: true });
    expect(JSON.stringify(saved)).not.toContain('private-secret');
    expect(await (await request('GET', route, token(['profile:read']))).text()).not.toContain('private-secret');
    expect((await request('DELETE', `/api/mcp/${saved.id}?projectId=${project}`, token(['project:settings:write']))).status).toBe(200);
  });
  it('separates discovery from administration and never returns raw credentials', async () => {
    const route = `/api/mcp?projectId=${project}`;
    const definition = { label: 'Work', transport: { type: 'http', url: 'https://example.com/mcp' }, auth: 'secrets', secrets: { Authorization: 'Bearer do-not-return' } };
    expect((await request('POST', route, token(['profile:read']), definition)).status).toBe(403);
    const saved = await request('POST', route, token(['project:settings:write']), definition);
    expect(saved.status).toBe(200); const c = await saved.json() as any;
    expect(JSON.stringify(c)).not.toContain('do-not-return');
    const list = await request('GET', route, token(['profile:read'])); expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject([{ id: c.id, connected: true }]);
    expect((await request('DELETE', `/api/mcp/${c.id}?projectId=${otherProject}`, token(['project:settings:write']))).status).toBe(403);
    expect((await request('GET', `/api/mcp?projectId=${project}&organizationId=${otherOrg}`, token(['profile:read']))).status).not.toBe(200);
    expect((await request('GET', '/api/mcp', token(['profile:read']))).status).not.toBe(200);
  });
  it('does not let a project administrator change an organization connection', async () => {
    const bearer = tokens.mintPrincipal('user:owner', ['organization:edit'], undefined, 60_000, org).token;
    const saved = await request('POST', `/api/mcp?organizationId=${org}`, bearer, { label: 'Shared', transport: { type: 'http', url: 'https://example.com/shared' } });
    expect(saved.status).toBe(200); const c = await saved.json() as any;
    expect((await request('POST', `/api/mcp?projectId=${project}`, token(['project:settings:write']), { ...c, label: 'Hijacked' })).status).toBe(400);
    expect((await request('DELETE', `/api/mcp/${c.id}?projectId=${project}`, token(['project:settings:write']))).status).toBe(403);
  });
  it.each(['test', 'authorize', 'callback'])('requires administration authority for %s, before making outbound requests', async (operation) => {
    const created = await request('POST', `/api/mcp?projectId=${project}`, token(['project:settings:write']), { label: 'Restricted', transport: { type: 'http', url: 'https://example.com/mcp' } });
    const c = await created.json() as any;
    expect((await request('POST', `/api/mcp/${c.id}/${operation}?projectId=${project}`, token(['profile:read']), { state: 'bad', code: 'bad' })).status).toBe(403);
  });
  it('round-trips editing and disabling, rejects invalid updates, and deletes connections', async () => {
    const route = `/api/mcp?projectId=${project}`, admin = token(['project:settings:write']);
    const created = await request('POST', route, admin, { label: 'Lifecycle', transport: { type: 'http', url: 'https://example.com/lifecycle' }, auth: 'secrets', secrets: { Authorization: 'Bearer original' } });
    const c = await created.json() as any;
    expect((await request('POST', route, admin, { ...c, transport: { type: 'http', url: 'https://127.0.0.1' } })).status).toBe(400);
    const edited = await request('POST', route, admin, { ...c, label: 'Disabled', enabled: false });
    expect(edited.status).toBe(200);
    const list = await (await request('GET', route, token(['profile:read']))).json() as any[];
    expect(list.find((v) => v.id === c.id)).toMatchObject({ label: 'Disabled', enabled: false, connected: true });
    expect(JSON.stringify(list)).not.toContain('Bearer original');
    expect((await request('POST', `/api/mcp/${c.id}/test?projectId=${project}`, admin, {})).status).toBe(400);
    expect((await request('DELETE', `/api/mcp/${c.id}?projectId=${project}`, admin)).status).toBe(200);
    const after = await (await request('GET', route, token(['profile:read']))).json() as any[];
    expect(after.some((v) => v.id === c.id)).toBe(false);
  });

});
