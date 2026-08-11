import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, Harness } from './helpers/harness.js';
import { ProfileResolver } from '../src/agent/profiles.js';

describe('profile + account management settings backend', () => {
  let h: Harness;
  let base: string;
  let token: string;
  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const J = (r: Response) => r.json() as Promise<any>;

  beforeAll(async () => {
    h = await bootHarness('mock');
    const gw = await h.startGateway();
    base = gw.url;
    token = ((await (await fetch(`${base}/api/session`)).json()) as any).token;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('edits a role profile and reflects it back', async () => {
    const updated = await fetch(`${base}/api/profiles`, {
      method: 'PUT',
      headers: auth(),
      // Old clients/installations may still submit the retired label. The
      // manifest-owned role vocabulary canonicalizes it to "Agent".
      body: JSON.stringify({ id: 'do-default', name: 'Do agent', role: 'do', provider: 'codex', model: 'gpt-4.1', effort: 'high', capabilities: ['signal-completion'], maxTurns: 30 }),
    }).then(J);
    expect(updated.name).toBe('Agent');
    expect(updated.provider).toBe('codex');
    expect(updated.model).toBe('gpt-4.1');
    const list = await fetch(`${base}/api/profiles`, { headers: auth() }).then(J);
    const p = list.find((x: any) => x.id === 'do-default');
    expect(p.effort).toBe('high');
    expect(p.maxTurns).toBe(30);
  });

  it('registers an API key as a handle and lists it (no secret leaks)', async () => {
    const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'codex', account: 'work', apiKey: 'sk-super-secret' }) }).then(J);
    expect(r.handle).toBe('codex:work');
    const accounts = await fetch(`${base}/api/accounts`, { headers: auth() }).then(J);
    expect(accounts.handles).toContain('codex:work');
    expect(JSON.stringify(accounts)).not.toContain('sk-super-secret'); // secret never returned
  });

  it('does not list or reuse agent credentials across organizations', async () => {
    const acme = h.store.createOrganization({ name: 'Acme' });
    const beta = h.store.createOrganization({ name: 'Beta' });
    const acmeBase = `${base}/api/organizations/${acme.id}`;
    const betaBase = `${base}/api/organizations/${beta.id}`;

    const saved = await fetch(`${acmeBase}/accounts`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ provider: 'claude', account: 'work', apiKey: 'acme-secret' }),
    }).then(J);
    expect(saved.handle).toBe(`claude:${acme.id}:work`);

    const [acmeAccounts, betaAccounts] = await Promise.all([
      fetch(`${acmeBase}/accounts`, { headers: auth() }).then(J),
      fetch(`${betaBase}/accounts`, { headers: auth() }).then(J),
    ]);
    expect(acmeAccounts.handles).toEqual([saved.handle]);
    expect(betaAccounts.handles).toEqual([]);
    expect(JSON.stringify(betaAccounts)).not.toContain('acme');

    const injectedNamespace = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ provider: 'claude', account: `${beta.id}:stolen`, apiKey: 'bad-secret' }),
    });
    expect(injectedNamespace.status).toBe(400);

    const betaProject = await fetch(`${betaBase}/projects`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ name: 'Beta project' }),
    }).then(J);
    const crossScope = await fetch(`${acmeBase}/credentials/policy`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        scope: 'project',
        projectId: betaProject.id,
        policy: { on: [saved.handle] },
      }),
    });
    expect(crossScope.status).toBe(400);
    expect(h.store.kvGet(`credpolicy:project:${betaProject.id}`)).toBeUndefined();
  });

  it('rejects a profile without a role', async () => {
    const res = await fetch(`${base}/api/profiles`, { method: 'PUT', headers: auth(), body: JSON.stringify({ provider: 'claude' }) });
    expect(res.status).toBe(400);
  });

  it('ignores retired per-profile credential routing and capability-ceiling fields', async () => {
    const saved = await fetch(`${base}/api/profiles`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({
        id: 'do-default',
        role: 'do',
        name: 'Agent',
        provider: 'claude',
        // The ceiling belongs to the workflow role, not to this profile: a submitted
        // one must neither narrow the role nor escalate it.
        capabilities: ['*'],
        modelProvider: 'anthropic',
        allowedAccounts: ['login:claude:work'],
        auth: { kind: 'configHome', configHome: '/tmp/legacy' },
      }),
    }).then(J);
    expect(saved.modelProvider).toBeUndefined();
    expect(saved.allowedAccounts).toBeUndefined();
    expect(saved.auth).toBeUndefined();
    expect(saved.capabilities).toBeUndefined();
    expect(h.store.getProfile('do-default')!.capabilities).toBeUndefined();
    const list = await fetch(`${base}/api/profiles`, { headers: auth() }).then(J);
    expect(list.every((p: any) => p.capabilities === undefined)).toBe(true);
  });

  it('exposes one shared Agent profile and retires the Merge profile API', async () => {
    const list = await fetch(`${base}/api/profiles`, { headers: auth() }).then(J);
    const operational = list.filter((p: any) => p.role !== 'confirm' && p.role !== 'responder');
    expect(operational).toHaveLength(1);
    expect(operational[0]).toMatchObject({ role: 'do', name: 'Agent' });
    expect(operational[0].roleWorkflows).toEqual(expect.arrayContaining(['software-dev', 'goal', 'merge-only']));

    const retired = await fetch(`${base}/api/profiles`, {
      method: 'PUT', headers: auth(),
      body: JSON.stringify({ id: 'merge-default', role: 'merge', name: 'Merge agent', provider: 'claude' }),
    });
    expect(retired.status).toBe(400);
  });

  it('supports project-scoped profile overrides that fall back to global (1e)', async () => {
    const project = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(), body: JSON.stringify({ name: 'P' }) }).then(J);
    // by default the project view inherits global
    let view = await fetch(`${base}/api/profiles?projectId=${project.id}`, { headers: auth() }).then(J);
    const doRow = view.find((p: any) => p.role === 'do');
    expect(doRow.scope).toBe('inherited');
    expect(doRow.id).toBe(`${project.id}::do-default`);

    // create a project override
    await fetch(`${base}/api/profiles?projectId=${project.id}`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ projectId: project.id, role: 'do', name: 'Agent', provider: 'codex', capabilities: [], effort: 'low' }),
    });
    view = await fetch(`${base}/api/profiles?projectId=${project.id}`, { headers: auth() }).then(J);
    const overridden = view.find((p: any) => p.role === 'do');
    expect(overridden.scope).toBe('project');
    expect(overridden.effort).toBe('low');
    // global stays untouched
    const globals = await fetch(`${base}/api/profiles`, { headers: auth() }).then(J);
    expect(globals.every((p: any) => !p.id.includes('::'))).toBe(true);

    // reset the override → back to inherited
    await fetch(`${base}/api/profiles/${encodeURIComponent(`${project.id}::do-default`)}?projectId=${project.id}`, { method: 'DELETE', headers: auth() });
    view = await fetch(`${base}/api/profiles?projectId=${project.id}`, { headers: auth() }).then(J);
    expect(view.find((p: any) => p.role === 'do').scope).toBe('inherited');
  });

  it('isolates organization profile defaults and resolves projects through their organization', async () => {
    const acme = h.store.createOrganization({ name: 'Profiles Acme' });
    const beta = h.store.createOrganization({ name: 'Profiles Beta' });
    const acmeProject = h.store.createProject('Acme agents', {}, acme.id);
    const betaProject = h.store.createProject('Beta agents', {}, beta.id);

    await fetch(`${base}/api/profiles?organizationId=${acme.id}`, {
      method: 'PUT', headers: auth(),
      body: JSON.stringify({ organizationId: acme.id, role: 'do', name: 'Agent', provider: 'codex', model: 'gpt-acme' }),
    });
    await fetch(`${base}/api/profiles?organizationId=${beta.id}`, {
      method: 'PUT', headers: auth(),
      body: JSON.stringify({ organizationId: beta.id, role: 'do', name: 'Agent', provider: 'claude', model: 'claude-beta' }),
    });

    const [acmeProfiles, betaProfiles, acmeProjectProfiles, betaProjectProfiles] = await Promise.all([
      fetch(`${base}/api/profiles?organizationId=${acme.id}`, { headers: auth() }).then(J),
      fetch(`${base}/api/profiles?organizationId=${beta.id}`, { headers: auth() }).then(J),
      fetch(`${base}/api/profiles?projectId=${acmeProject.id}`, { headers: auth() }).then(J),
      fetch(`${base}/api/profiles?projectId=${betaProject.id}`, { headers: auth() }).then(J),
    ]);
    expect(acmeProfiles.find((p: any) => p.role === 'do')).toMatchObject({ model: 'gpt-acme', scope: 'organization' });
    expect(betaProfiles.find((p: any) => p.role === 'do')).toMatchObject({ model: 'claude-beta', scope: 'organization' });
    expect(acmeProjectProfiles.find((p: any) => p.role === 'do')).toMatchObject({ model: 'gpt-acme', scope: 'inherited' });
    expect(betaProjectProfiles.find((p: any) => p.role === 'do')).toMatchObject({ model: 'claude-beta', scope: 'inherited' });
    const resolver = new ProfileResolver(h.store, 'mock');
    expect(resolver.resolve('do', undefined, undefined, acmeProject.id)).toMatchObject({ model: 'gpt-acme' });
    expect(resolver.resolve('do', undefined, undefined, betaProject.id)).toMatchObject({ model: 'claude-beta' });
  });

  it('exposes payment providers + a connect flow (1g)', async () => {
    const r = await fetch(`${base}/api/organizations/org_personal/payments/providers`, { headers: auth() }).then(J);
    expect(r.active).toBe('mock');
    expect(r.providers.some((p: any) => p.name === 'mock' && p.connected)).toBe(true);
    expect(r.providers.some((p: any) => p.name === 'stripe' && p.kind === 'oauth' && !p.available && !p.connected)).toBe(true);
    const c = await fetch(`${base}/api/organizations/org_personal/payments/connect`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'mock' }) }).then(J);
    expect(c.status).toBe('connected');
  });

  it('deletes and renames a connected login via the API (1b)', async () => {
    // connect (fake login in the harness) then rename + delete
    await fetch(`${base}/api/accounts/connect`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'claude', account: 'temp' }) });
    let accts = await fetch(`${base}/api/accounts`, { headers: auth() }).then(J);
    expect(accts.logins.some((l: any) => l.account === 'temp')).toBe(true);
    await fetch(`${base}/api/accounts/logins/claude/temp`, { method: 'PATCH', headers: auth(), body: JSON.stringify({ account: 'renamed' }) });
    accts = await fetch(`${base}/api/accounts`, { headers: auth() }).then(J);
    expect(accts.logins.some((l: any) => l.account === 'renamed')).toBe(true);
    const del = await fetch(`${base}/api/accounts/logins/claude/renamed`, { method: 'DELETE', headers: auth() });
    expect(del.status).toBe(200);
    accts = await fetch(`${base}/api/accounts`, { headers: auth() }).then(J);
    expect(accts.logins.some((l: any) => l.account === 'renamed')).toBe(false);
  });
});
