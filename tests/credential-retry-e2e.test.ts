import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootHarness, type Harness } from './helpers/harness.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { MockAdapter } from '../src/agent/mock.js';
import { providerFailure, SandboxProviderFailure } from '../src/agent/limits.js';
import type { UsageResult } from '../src/agent/usage.js';
import { makeCoordinatorActivities } from '../src/activities/coordinator.js';
import { accountCoordinatorId } from '../src/coordinators/names.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { retryCredentials } from '../src/agent/credential-health.js';
import { credPolicyKey } from '../src/platform/credential-sources.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';

// Full HTTP -> API -> real Temporal workflow/coordinator -> credential lease ->
// real git world -> agent result -> Review. Only model inference is simulated.
describe('credential Retry end to end', () => {
  let h: Harness;
  let root: string;
  let homes: ConfigHomeManager;
  let home: string;
  let base: string;
  let headers: Record<string, string>;
  let healthy = false;
  let turns = 0;
  let expectedHome = '';
  let quotaFailures = 0;
  let sandboxQuotaFailures = 0;
  let hostUsage: UsageResult | undefined;
  const probed: string[] = [];
  const accountId = 'login:claude:personal';
  const mock = new MockAdapter();

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-retry-e2e-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'ambient-claude'));
    vi.stubEnv('CODEX_HOME', path.join(root, 'ambient-codex'));
    homes = new ConfigHomeManager(root);
    home = homes.ensure('claude', 'personal');
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}'); // stale native shell left beside a setup token
    fs.writeFileSync(path.join(home, 'karmax-oauth.json'), JSON.stringify({ token: 'test-setup-token' }));
    h = await bootHarness('claude', {
      provider: 'claude',
      async runTurn(input, ctx) {
        turns++;
        expect(input.resolvedAuth?.configHome).toBe(expectedHome || home);
        if (sandboxQuotaFailures > 0) {
          sandboxQuotaFailures--;
          // What the adapters throw for a limit the CLI reported inside a remote sandbox.
          throw new SandboxProviderFailure(providerFailure('Claude usage limit reached · resets in 2s', {
            kind: 'quota', permanence: 'transient', provider: 'claude', source: 'structured', window: '5h', resetHint: 'in 2s',
          }));
        }
        if (quotaFailures > 0) {
          quotaFailures--;
          throw providerFailure('Claude usage limit reached · resets in 1s', {
            kind: 'quota', permanence: 'transient', provider: 'claude', source: 'structured', window: '5h', resetHint: 'in 1s',
          });
        }
        if (!healthy) throw providerFailure('API Error: 401 OAuth access token has expired', {
          kind: 'credential', permanence: 'hard', provider: 'claude', source: 'structured',
        });
        return mock.runTurn(input, ctx);
      },
    }, { configHomes: homes, probeUsage: async ({ configHome }) => { probed.push(configHome); return hostUsage; } });
    base = (await h.startGateway()).url;
    const session: any = await fetch(`${base}/api/session`).then(r => r.json());
    headers = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };
    await makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE }).registerAccounts([
      { id: accountId, provider: 'claude', kind: 'login', configHome: home, maxConcurrent: 1 },
    ]);
  }, 60_000);
  afterAll(async () => { await h?.stop(); vi.unstubAllEnvs(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

  const accounts = async () => (await h.client.workflow.getHandle(accountCoordinatorId()).query('accounts')) as any;
  const status = async (id: string) => (await accounts()).accounts.find((a: any) => a.id === id)?.status;

  // A login needing a person is a wait, not an escalation: the task parks on
  // "Waiting for credential" and resumes by itself once a credential works.
  it('waits for a quarantined login, re-checks it on Retry, then reaches Review after recovery', async () => {
    const repo = await h.makeRepo('recovered');
    const project = (await h.store.createProject('Retry', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }));
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const task = await h.api.createTask(token, { projectId: project.id, title: 'Recovered task',
      prompt: '@write recovered.txt :: RECOVERED\n@run git add recovered.txt && git commit -m recovered\n@review Recovered credential',
      params: { 'agent:do': { provider: 'claude', model: 'claude-fable-5-1' } },
    });
    const view = () => h.client.workflow.getHandle(task.id).query('view') as Promise<any>;
    const credentialWait = {
      stage: 'do', status: 'waiting',
      waitingFor: { kind: 'account', provider: 'claude', detail: 'Every allowed credential needs attention — sign in again or add one' },
    };
    await expect.poll(async () => view(), { timeout: 30_000 }).toMatchObject(credentialWait);
    expect((await view()).error).toBeUndefined();
    expect(await status(accountId)).toBe('needs-attention');
    expect(turns).toBe(1);
    const stored = async () => (await h.store.getTask(task.id))?.lastView as any;
    await expect.poll(async () => (await stored())?.waitingFor?.kind, { timeout: 5000 }).toBe('account');
    const apiView: any = await fetch(`${base}/api/tasks/${task.id}`, { headers }).then(r => r.json());
    expect(apiView.actions.map((action: any) => action.name)).toContain('retry');

    const usage = await fetch(`${base}/api/organizations/org_personal/accounts/usage/recheck`, {
      method: 'POST', headers, body: JSON.stringify({ accountId }),
    });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ usage: { [accountId]: { ok: false, reason: 'setup-token' } } });
    expect(await status(accountId)).toBe('needs-attention');

    const retry = () => fetch(`${base}/api/tasks/${task.id}/signal`, {
      method: 'POST', headers, body: JSON.stringify({ signal: 'retry' }),
    });
    expect((await retry()).status).toBe(200);
    await expect.poll(() => turns, { timeout: 20_000 }).toBe(2);
    await expect.poll(async () => view(), { timeout: 20_000 }).toMatchObject(credentialWait);
    expect(await status(accountId)).toBe('needs-attention');

    await expect.poll(async () => (await stored())?.waitingFor?.kind, { timeout: 5000 }).toBe('account');
    healthy = true; // provider quota/login now works; usage remains unpollable
    expect((await retry()).status).toBe(200);
    await expect.poll(async () => (await view()).stage, { timeout: 30_000 }).toBe('review');
    expect(turns).toBe(3);
    expect(await status(accountId)).toBe('available');
    const world = (await h.store.currentWorld(task.id))!;
    expect(fs.readFileSync(path.join(world.workdir ?? world.root, 'recovered.txt'), 'utf8')).toContain('RECOVERED');
    await h.api.signalTask(token, task.id, 'cancel');
  }, 90_000);

  // Signing in with a new account while tasks wait must resume them on it: their
  // allow-lists predate the login, so the coordinator asks them to re-resolve.
  it('resumes a task waiting for a credential on a newly connected login', async () => {
    const coordinator = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    healthy = false;
    const before = turns;
    const repo = await h.makeRepo('new-login');
    const project = (await h.store.createProject('New login', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }));
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    await coordinator.setAccountAvailability({ accountId, status: 'needs-attention' });
    const task = await h.api.createTask(token, { projectId: project.id, title: 'New login task',
      prompt: '@write new-login.txt :: NEW LOGIN\n@run git add new-login.txt && git commit -m login\n@review New login',
      params: { 'agent:do': { provider: 'claude', model: 'claude-fable-5-1' } },
    });
    const view = () => h.client.workflow.getHandle(task.id).query('view') as Promise<any>;
    await expect.poll(async () => (await view()).waitingFor?.kind, { timeout: 30_000 }).toBe('account');
    expect(turns).toBe(before);

    const fresh = homes.ensure('claude', 'fresh');
    fs.writeFileSync(path.join(fresh, 'karmax-oauth.json'), JSON.stringify({ token: 'fresh-setup-token' }));
    expectedHome = fresh;
    healthy = true;
    await coordinator.registerAccounts([
      { id: accountId, provider: 'claude', kind: 'login', configHome: home, maxConcurrent: 1 },
      { id: 'login:claude:fresh', provider: 'claude', kind: 'login', configHome: fresh, maxConcurrent: 1 },
    ]);
    await expect.poll(async () => (await view()).stage, { timeout: 30_000 }).toBe('review');
    expect(turns).toBe(before + 1);
    await h.api.signalTask(token, task.id, 'cancel');
    expectedHome = home;
    homes.remove('claude', 'fresh');
    await coordinator.registerAccounts([{ id: accountId, provider: 'claude', kind: 'login', configHome: home, maxConcurrent: 1 }]);
  }, 90_000);

  // Task 385: parked on an exhausted login's quota window, it kept waiting for
  // the reset although a second subscription had been connected meanwhile.
  it('resumes a task waiting out a quota limit on a login connected meanwhile', async () => {
    const coordinator = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    await coordinator.setAccountAvailability({ accountId, status: 'available' });
    await coordinator.reportAccountExhausted({ accountId, window: '5h', resetHint: 'in 3h' });
    healthy = true;
    const before = turns;
    const repo = await h.makeRepo('quota-new-login');
    const project = (await h.store.createProject('Quota login', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }));
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const task = await h.api.createTask(token, { projectId: project.id, title: 'Quota login task',
      prompt: '@write quota-login.txt :: QUOTA LOGIN\n@run git add quota-login.txt && git commit -m login\n@review Quota login',
      params: { 'agent:do': { provider: 'claude', model: 'claude-fable-5-1' } },
    });
    const view = () => h.client.workflow.getHandle(task.id).query('view') as Promise<any>;
    await expect.poll(async () => (await view()).waitingFor, { timeout: 30_000 })
      .toMatchObject({ kind: 'account', provider: 'claude', earliestResetAt: expect.any(Number) });
    expect(turns).toBe(before);

    const fresh = homes.ensure('claude', 'second');
    fs.writeFileSync(path.join(fresh, 'karmax-oauth.json'), JSON.stringify({ token: 'second-setup-token' }));
    expectedHome = fresh;
    await coordinator.registerAccounts([
      { id: accountId, provider: 'claude', kind: 'login', configHome: home, maxConcurrent: 1 },
      { id: 'login:claude:second', provider: 'claude', kind: 'login', configHome: fresh, maxConcurrent: 1 },
    ]);
    await expect.poll(async () => (await view()).stage, { timeout: 30_000 }).toBe('review');
    expect(turns).toBe(before + 1);
    expect(await status(accountId)).toBe('exhausted');
    await h.api.signalTask(token, task.id, 'cancel');
    expectedHome = home;
    homes.remove('claude', 'second');
    await coordinator.registerAccounts([{ id: accountId, provider: 'claude', kind: 'login', configHome: home, maxConcurrent: 1 }]);
    await coordinator.setAccountAvailability({ accountId, status: 'available' });
  }, 90_000);

  // Task 381: each quota failure on a leased login parks until the reported
  // reset, so it is a wait, not a failed attempt to escalate after two retries.
  it('keeps waiting through repeated quota limits instead of escalating', async () => {
    const coordinator = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    await coordinator.setAccountAvailability({ accountId, status: 'available' });
    healthy = true;
    quotaFailures = 4; // more than the Resolve attempt budget
    const before = turns;
    const repo = await h.makeRepo('quota');
    const project = (await h.store.createProject('Quota', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }));
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const task = await h.api.createTask(token, { projectId: project.id, title: 'Quota task',
      prompt: '@write quota.txt :: QUOTA\n@run git add quota.txt && git commit -m quota\n@review Quota',
      params: { 'agent:do': { provider: 'claude', model: 'claude-fable-5-1' } },
    });
    const view = () => h.client.workflow.getHandle(task.id).query('view') as Promise<any>;
    await expect.poll(async () => (await view()).stage, { timeout: 60_000 }).toBe('review');
    expect(turns).toBe(before + 5);
    await h.api.signalTask(token, task.id, 'cancel');
  }, 90_000);

  // Audit R-4: a limit reported from inside a sandbox used to become an ordinary
  // agent error — three retries on the exhausted login, then needs-human.
  it('waits out a sandbox-reported limit the host cannot confirm, leaving the shared login alone', async () => {
    const coordinator = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    await coordinator.setAccountAvailability({ accountId, status: 'available' });
    healthy = true;
    hostUsage = { ok: false, at: Date.now(), reason: 'setup-token' };
    sandboxQuotaFailures = 4; // more than the Resolve attempt budget
    probed.length = 0;
    const before = turns;
    const repo = await h.makeRepo('sandbox-quota');
    const project = (await h.store.createProject('Sandbox quota', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }));
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const task = await h.api.createTask(token, { projectId: project.id, title: 'Sandbox quota task',
      prompt: '@write sq.txt :: SQ\n@run git add sq.txt && git commit -m sq\n@review Sandbox quota',
      params: { 'agent:do': { provider: 'claude', model: 'claude-fable-5-1' } },
    });
    const view = () => h.client.workflow.getHandle(task.id).query('view') as Promise<any>;
    await expect.poll(async () => (await view()).waitingFor?.kind, { timeout: 30_000, interval: 100 }).toBe('account');
    expect(await status(accountId)).toBe('available'); // unconfirmed: not parked
    await expect.poll(async () => (await view()).stage, { timeout: 60_000 }).toBe('review');
    expect(turns).toBe(before + 5);
    expect(probed).toEqual(Array(4).fill(home));
    expect(await status(accountId)).toBe('available');
    await h.api.signalTask(token, task.id, 'cancel');
  }, 90_000);

  it('parks the login when the host confirms a sandbox-reported limit', async () => {
    const coordinator = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    await coordinator.setAccountAvailability({ accountId, status: 'available' });
    healthy = true;
    hostUsage = { ok: true, at: Date.now(), session: { pct: 100, resetLabel: 'soon', resetAt: Date.now() + 3_000 } };
    sandboxQuotaFailures = 1;
    const before = turns;
    const repo = await h.makeRepo('confirmed-quota');
    const project = (await h.store.createProject('Confirmed quota', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }));
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const task = await h.api.createTask(token, { projectId: project.id, title: 'Confirmed quota task',
      prompt: '@write cq.txt :: CQ\n@run git add cq.txt && git commit -m cq\n@review Confirmed quota',
      params: { 'agent:do': { provider: 'claude', model: 'claude-fable-5-1' } },
    });
    await expect.poll(async () => status(accountId), { timeout: 30_000, interval: 100 }).toBe('exhausted');
    const view = () => h.client.workflow.getHandle(task.id).query('view') as Promise<any>;
    await expect.poll(async () => (await view()).stage, { timeout: 60_000 }).toBe('review');
    expect(turns).toBe(before + 2);
    hostUsage = undefined;
    await h.api.signalTask(token, task.id, 'cancel');
  }, 90_000);

  // A login the provider signed out used to vanish from Credentials: the list
  // held only runnable credentials, so there was nothing to click to sign in.
  it('keeps a signed-out login listed so it can be signed in again', async () => {
    const expired = homes.ensure('claude', 'expired');
    fs.writeFileSync(path.join(expired, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: '', refreshToken: '', expiresAt: 0,
    } }));
    const listed: any = await fetch(`${base}/api/organizations/org_personal/credentials`, { headers }).then(r => r.json());
    expect(listed.credentials.find((c: any) => c.key === 'login:claude:expired')).toEqual({
      key: 'login:claude:expired', label: 'claude:expired', provider: 'claude', kind: 'login', account: 'expired', signedOut: true,
    });
    expect(listed.global.enabled).not.toContain('login:claude:expired');
    expect(listed.credentials.find((c: any) => c.key === accountId)?.signedOut).toBeUndefined();
    homes.remove('claude', 'expired');

    // A healthy Claude sign-in reports when it lapses, so it can be renewed first.
    const lapsing = homes.ensure('claude', 'lapsing');
    const signInExpiresAt = Date.now() + 86_400_000;
    fs.writeFileSync(path.join(lapsing, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000, refreshTokenExpiresAt: signInExpiresAt,
    } }));
    const renewing: any = await fetch(`${base}/api/organizations/org_personal/credentials`, { headers }).then(r => r.json());
    expect(renewing.credentials.find((c: any) => c.key === 'login:claude:lapsing')).toMatchObject({ signInExpiresAt });
    homes.remove('claude', 'lapsing');
  });

  it('preserves manual disables, known quota waits, task policy, and other providers', async () => {
    const coordinator = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    const entries = [
      ['off', 'claude', 'manual-off'], ['quota', 'claude', 'exhausted'],
      ['policy-off', 'claude', 'needs-attention'], ['other', 'codex', 'needs-attention'],
    ] as const;
    const registered = [{ id: accountId, provider: 'claude' as const, kind: 'login' as const, configHome: home }];
    for (const [account, provider] of entries) {
      const dir = homes.ensure(provider, account);
      fs.writeFileSync(path.join(dir, 'karmax-oauth.json'), JSON.stringify({ token: 'test-token' }));
      registered.push({ id: `login:${provider}:${account}`, provider: provider as any, kind: 'login', configHome: dir });
    }
    await coordinator.registerAccounts(registered);
    for (const [account, provider, state] of entries) await coordinator.setAccountAvailability({
      accountId: `login:${provider}:${account}`, status: state, resetAt: Date.now() + 3600_000,
    });
    const project = (await h.store.createProject('Policy'));
    const task = (await h.store.createTask({ projectId: project.id, title: 'Policy', workflow: 'software-dev', workflowVersion: '1.26.0', params: { prompt: 'Policy', draft: true } }));
    (await h.store.kvSet(credPolicyKey.task(task.id), JSON.stringify({ off: ['login:claude:policy-off'] })));
    await retryCredentials({ store: h.store, client: h.client, taskQueue: TASK_QUEUE, configHomes: homes }, task, 'claude');
    for (const [account, provider, state] of entries) expect(await status(`login:${provider}:${account}`)).toBe(state);
  });
  it('rearms enabled API keys for every harness without requiring a usage endpoint', async () => {
    const providers = ['claude', 'codex', 'kimi', 'grok', 'opencode'] as const;
    const coordinator = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    const rows = await Promise.all(providers.map(async provider => {
      const handle = `${provider}:retry-test`;
      (await h.broker.registerHandle(handle, 'test-key', INSTALLATION_SCOPE));
      return { id: `key:handle:${handle}`, provider, kind: 'key' as const, configHome: '', apiKeyHandle: handle };
    }));
    await coordinator.registerAccounts(rows);
    for (const row of rows) await coordinator.setAccountAvailability({ accountId: row.id, status: 'needs-attention' });
    const project = (await h.store.createProject('Key retry'));
    const task = (await h.store.createTask({ projectId: project.id, title: 'Key retry', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'Key retry', draft: true } }));
    (await h.store.kvSet(credPolicyKey.task(task.id), JSON.stringify({ on: rows.map(row => row.id) })));
    for (const row of rows) {
      expect(await status(row.id)).toBe('needs-attention');
      await retryCredentials({ store: h.store, client: h.client, taskQueue: TASK_QUEUE,
        configHomes: homes, broker: h.broker }, task, row.provider);
      expect(await status(row.id)).toBe('available');
    }
  });

  // Task #515: an agent waiting for a credential nobody can provide must not
  // hold the task. Stopping it, like Ctrl+C, gives up its place in the
  // credential queue, and the task goes on where it was.
  it('stops an agent waiting for a credential, and the task goes on in Review', async () => {
    const coordinator = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
    await coordinator.registerAccounts([{ id: accountId, provider: 'claude', kind: 'login', configHome: home, maxConcurrent: 1 }]);
    await coordinator.setAccountAvailability({ accountId, status: 'available' });
    healthy = true;
    expectedHome = home;
    const repo = await h.makeRepo('stop-waiting');
    const project = (await h.store.createProject('Stop waiting', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }));
    const task = await h.api.createTask((await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token, { projectId: project.id,
      title: 'Stop waiting', prompt: '@write stop.txt :: STOP\n@run git add stop.txt && git commit -m stop\n@review Stop',
      params: { 'agent:do': { provider: 'claude', model: 'claude-fable-5-1' } },
    });
    const view = () => h.client.workflow.getHandle(task.id).query('view') as Promise<any>;
    const agent = async (key: string) => (await view()).participants?.find((p: any) => p.key === key);
    await expect.poll(async () => (await view()).stage, { timeout: 30_000 }).toBe('review');
    const post = (path: string, body?: unknown) => fetch(`${base}/api/tasks/${task.id}${path}`, {
      method: 'POST', headers, ...(body ? { body: JSON.stringify(body) } : {}) });

    // No credential works any more; an agent called in now waits for one.
    await coordinator.setAccountAvailability({ accountId, status: 'needs-attention' });
    // Agent 2's harness has no credential at all; it says so.
    expect((await post('/messages', { text: 'Check it.', to: ['agent:agent-1', 'agent:agent-2'], agents: {
      'agent-1': { provider: 'claude', model: 'claude-fable-5-1' }, 'agent-2': { provider: 'codex', model: 'gpt-5.5' } } })).status).toBe(200);
    await expect.poll(async () => (await view()).waitingFor?.kind, { timeout: 30_000 }).toBe('account');
    expect(await agent('agent-1')).toMatchObject({ state: 'waiting' });
    expect(await agent('agent-2')).toMatchObject({ state: 'queued' });
    expect((await accounts()).waiting).toBe(1);

    expect((await post('/agents/agent-1/stop')).status).toBe(200);
    await expect.poll(async () => (await agent('agent-1'))?.state, { timeout: 10_000 }).toBe('idle');
    // The next agent runs; with no codex credential it waits too, until stopped.
    await expect.poll(async () => (await view()).waitingFor?.detail, { timeout: 30_000 }).toBe('No codex credential — add one, or stop this agent');
    expect(await agent('agent-2')).toMatchObject({ state: 'waiting' });
    expect((await post('/agents/agent-2/stop')).status).toBe(200);
    await expect.poll(async () => (await agent('agent-2'))?.state, { timeout: 10_000 }).toBe('idle');
    await expect.poll(async () => (await view()).waitingFor?.kind, { timeout: 10_000 }).toBe('human');
    const v = await view();
    expect(v.stage).toBe('review');
    expect(v.messages.at(-1)).toMatchObject({ role: 'system', to: [] });
    expect(v.messages.filter((m: any) => m.role === 'system').map((m: any) => m.text.replace(/^.* stopped/, 'Stopped')))
      .toEqual(['Stopped Agent 1.', 'Stopped Agent 2.']);
    expect((await accounts()).waiting).toBe(0);
    // Nothing to stop now.
    const again = await post('/agents/agent-1/stop');
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toMatch(/Agent 1 is not working/);
    expect((await h.store.eventsOfType(task.id, ['task.agent-stopped'])).map((e: any) => e.payload.participant)).toEqual(['agent-1', 'agent-2']);
    await post('/signal', { signal: 'cancel' });
  }, 90_000);
});
