import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootHarness, type Harness } from './helpers/harness.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { MockAdapter } from '../src/agent/mock.js';
import { providerFailure } from '../src/agent/limits.js';
import { makeCoordinatorActivities } from '../src/activities/coordinator.js';
import { accountCoordinatorId } from '../src/coordinators/names.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { retryCredentials } from '../src/agent/credential-health.js';
import { credPolicyKey } from '../src/platform/credential-sources.js';

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
        expect(input.resolvedAuth?.configHome).toBe(home);
        if (!healthy) throw providerFailure('API Error: 401 OAuth access token has expired', {
          kind: 'credential', permanence: 'hard', provider: 'claude', source: 'structured',
        });
        return mock.runTurn(input, ctx);
      },
    }, { configHomes: homes });
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

  it('retries an unpollable login, quarantines a persistent failure, then reaches Review after recovery', async () => {
    const repo = await h.makeRepo('recovered');
    const project = (await h.store.createProject('Retry', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }));
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const task = await h.api.createTask(token, { projectId: project.id, title: 'Recovered task',
      prompt: '@write recovered.txt :: RECOVERED\n@run git add recovered.txt && git commit -m recovered\n@review Recovered credential',
      params: { 'agent:do': { provider: 'claude', model: 'claude-fable-5-1' } },
    });
    const view = () => h.client.workflow.getHandle(task.id).query('view') as Promise<any>;
    await expect.poll(async () => (await view()).error, { timeout: 30_000 }).toMatch(/No usable claude credential/);
    expect(await status(accountId)).toBe('needs-attention');
    expect(turns).toBe(1);

    const usage = await fetch(`${base}/api/organizations/org_personal/accounts/usage/recheck`, {
      method: 'POST', headers, body: JSON.stringify({ accountId }),
    });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ usage: { [accountId]: { ok: false, reason: 'setup-token' } } });
    expect(await status(accountId)).toBe('needs-attention');

    await expect.poll(async () => (await h.store.getTask(task.id))?.lastView?.status, { timeout: 5000 }).toBe('blocked');
    expect((await h.store.getTask(task.id))?.lastView?.error).toMatch(/No usable claude credential/);
    const retry = () => fetch(`${base}/api/tasks/${task.id}/signal`, {
      method: 'POST', headers, body: JSON.stringify({ signal: 'retry' }),
    });
    expect((await retry()).status).toBe(200);
    await expect.poll(() => turns, { timeout: 20_000 }).toBe(2);
    await expect.poll(async () => (await view()).error, { timeout: 20_000 }).toMatch(/No usable claude credential/);
    expect(await status(accountId)).toBe('needs-attention');

    await expect.poll(async () => (await h.store.getTask(task.id))?.lastView?.status, { timeout: 5000 }).toBe('blocked');
    healthy = true; // provider quota/login now works; usage remains unpollable
    expect((await retry()).status).toBe(200);
    await expect.poll(async () => (await view()).stage, { timeout: 30_000 }).toBe('review');
    expect(turns).toBe(3);
    expect(await status(accountId)).toBe('available');
    const world = (await h.store.currentWorld(task.id))!;
    expect(fs.readFileSync(path.join(world.workdir ?? world.root, 'recovered.txt'), 'utf8')).toContain('RECOVERED');
    await h.api.signalTask(token, task.id, 'cancel');
  }, 90_000);

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
    const rows = providers.map(provider => {
      const handle = `${provider}:retry-test`;
      h.broker.registerHandle(handle, 'test-key');
      return { id: `key:handle:${handle}`, provider, kind: 'key' as const, configHome: '', apiKeyHandle: handle };
    });
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

});
