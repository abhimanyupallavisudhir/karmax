import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootHarness, type Harness } from './helpers/harness.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { LoginSandboxes } from '../src/agent/login-sandbox.js';
import { credPolicyKey } from '../src/platform/credential-sources.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';
import { newId } from '../src/util/id.js';
import { makeCoordinatorActivities } from '../src/activities/coordinator.js';
import { TASK_QUEUE } from '../src/temporal/config.js';

/**
 * Start latency of a task without a computer on a subscription login, for real
 * (wiki features/computerless-tasks § Start latency): real Temporal, workflow,
 * account coordinator and activities; Claude Code in a real login sandbox on
 * E2B or Daytona; timed from creating the task as the Ask box does to the
 * first streamed agent token, cold (a new sandbox), warm (a follow-up while it
 * runs) and resumed (a follow-up after it parked), against the API-key path.
 *
 *   KARMAX_RUN_LIVE=1 E2B_API_KEY=… KARMAX_LIVE_CLAUDE_HOME=<a config home with .credentials.json>
 *   [KARMAX_LIVE_SANDBOX_PROVIDER=e2b|daytona DAYTONA_API_KEY=…] [KARMAX_LIVE_ANTHROPIC_KEY=…] [KARMAX_LIVE_RUNS=3]
 *   npx vitest run tests/login-sandbox-live.test.ts
 *
 * Copy a login whose refresh token is withheld (a sandbox projection) or replaced
 * with junk: the CLI never refreshes it here (wiki ops/providers § Model logins).
 */
const live = process.env.KARMAX_RUN_LIVE === '1' && !!process.env.KARMAX_LIVE_CLAUDE_HOME;
const PROVIDER = process.env.KARMAX_LIVE_SANDBOX_PROVIDER ?? 'e2b';
const RUNS = Number(process.env.KARMAX_LIVE_RUNS ?? 3);
const MODEL = { provider: 'claude', model: process.env.KARMAX_LIVE_MODEL ?? 'claude-opus-5-5', effort: 'low' };

/** Progress, as it happens (vitest prints a test's console only at its end). */
const log = (line: string) => { console.log(line); if (process.env.KARMAX_LIVE_LOG) fs.appendFileSync(process.env.KARMAX_LIVE_LOG, `${new Date().toISOString()} ${line}\n`); };

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
};

describe.skipIf(!live)(`login sandbox start latency on ${PROVIDER} (live)`, () => {
  let h: Harness;
  let pool: LoginSandboxes;
  let configHomes: ConfigHomeManager;
  let home = '';
  const results: Record<string, number[]> = {};
  const note = (kind: string, ms: number) => { (results[kind] ??= []).push(ms); log(`[latency] ${PROVIDER} ${kind}: ${ms} ms`); };
  const firstToken = new Map<string, (at: number) => void>();
  const opened: Array<{ taskId: string; ms: number; reused: boolean; pooled?: boolean }> = [];
  /** Per task, when each phase of its current turn was first seen. */
  const phases = new Map<string, Record<string, number>>();
  const breakdown = (kind: string, taskId: string, from: number, to: number) => {
    const marks = phases.get(taskId) ?? {};
    log(`[latency] ${PROVIDER} ${kind} breakdown (ms from start): ${JSON.stringify(Object.fromEntries(
      [...Object.entries(marks).map(([name, at]) => [name, at - from] as const), ['first-token', to - from] as const].sort((a, b) => a[1] - b[1])))}`);
    phases.set(taskId, {});
  };

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-sandbox-live-'));
    configHomes = new ConfigHomeManager(path.join(dir, 'homes'));
    home = configHomes.ensure('claude', 'live', 'org_personal');
    fs.copyFileSync(path.join(process.env.KARMAX_LIVE_CLAUDE_HOME!, '.credentials.json'), path.join(home, '.credentials.json'));
    h = await bootHarness('claude', undefined, { configHomes, loginSandboxes: (store, worlds) => {
      pool = new LoginSandboxes({ store, worlds, route: async () => ({ candidates: [{ provider: PROVIDER, funding: 'own' }] }) });
      const open = pool.open.bind(pool);
      pool.open = async (input) => {
        const started = Date.now();
        const sandbox = await open(input);
        opened.push({ taskId: input.taskId, ms: Date.now() - started, reused: sandbox.reused,
          ...(sandbox.world.handle.id.startsWith('login-pool-') ? { pooled: true } : {}) } as never);
        const marks = phases.get(input.taskId);
        if (marks) marks['sandbox-ready'] ??= Date.now();
        return sandbox;
      };
      return pool;
    } });
    (h.store as { hosted: boolean }).hosted = true;
    // As production: the account coordinator leases the organization's login to each turn.
    await makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE }).registerAccounts([
      { id: 'login:claude:live', provider: 'claude', kind: 'login', configHome: home, maxConcurrent: 4 },
    ]);
    h.bus.onAny((event) => {
      const payload = event.payload as { source?: string; text?: string; id?: string; phase?: string; title?: string; detail?: string } | undefined;
      // Where the time goes: the turn starting, the CLI's start-up steps, its first token.
      const marks = phases.get(event.taskId);
      if (marks) {
        if (event.type === 'agent.activity' && payload?.id === 'turn' && payload.phase === 'started') marks.turn ??= Date.now();
        if (event.type === 'agent.activity' && payload?.id === 'claude-startup') {
          const step = (() => { try { return JSON.parse(payload.detail ?? '{}').step; } catch { return undefined; } })();
          if (step) marks[step] ??= Date.now();
          if (payload.phase === 'completed') marks.connected ??= Date.now();
        }
      }
      if (event.type === 'agent.output' && payload?.source === 'assistant' && payload.text) firstToken.get(event.taskId)?.(Date.now());
    });
  }, 120_000);
  afterAll(async () => {
    if (h) (h.store as { hosted: boolean }).hosted = false;
    log(`[latency] ${PROVIDER} medians (ms): ${JSON.stringify(Object.fromEntries(Object.entries(results).map(([kind, values]) => [kind, { median: median(values), runs: values }])))}`);
    log(`[latency] ${PROVIDER} sandbox opens: ${JSON.stringify(opened)}`);
    await h?.stop();
  });

  const view = (taskId: string) => h.client.workflow.getHandle(taskId).query<any>('view');
  /** The task's first agent token from now; what it is doing is logged while it takes long. */
  const tokenAfter = (taskId: string) => {
    const token = new Promise<number>((resolve) => firstToken.set(taskId, (at) => { firstToken.delete(taskId); resolve(at); }));
    const stall = setInterval(async () => {
      const current = await Promise.race([view(taskId), new Promise((resolve) => setTimeout(() => resolve({ error: 'query timed out' }), 5_000))])
        .catch((error) => ({ error: String(error) })) as any;
      log(`[latency] waiting: ${JSON.stringify({ stage: current.stage, status: current.status, waitingFor: current.waitingFor,
        error: current.error, agentTurn: current.agentTurn }).slice(0, 800)}`);
      const events = (await h.store.eventsSince(taskId, 0)).slice(-5).map((event) => `${event.type} ${JSON.stringify(event.payload).slice(0, 250)}`);
      log(`[latency] events: ${events.join(' | ')}`);
    }, 20_000);
    return token.finally(() => clearInterval(stall));
  };
  const reviewed = (taskId: string) => expect.poll(async () => (await view(taskId)).stage, { timeout: 180_000, interval: 250 }).toBe('review');

  async function ask(projectId: string, token: string, agent: Record<string, unknown>) {
    // What POST /api/organizations/:id/ask does: a computerless task with the person's message.
    const started = Date.now();
    let taskId = '';
    const first = new Promise<number>((resolve) => { firstToken.set('*pending*', resolve); });
    const task = await h.api.createTask(token, { projectId, workflow: 'software-dev', params: {
      computer: { provider: 'none' }, prompt: 'Reply with one short sentence: what can you do here?', 'agent:do': agent,
    } });
    taskId = task.id;
    phases.set(taskId, {});
    const pending = firstToken.get('*pending*')!;
    firstToken.delete('*pending*');
    firstToken.set(taskId, pending);
    return { taskId, started, first };
  }

  it('cold, warm and resumed, measured to the first agent token', async () => {
    const project = await h.store.createProject(newId('Ask'), { defaultBase: 'main' });
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const login = `login:claude:live`;
    await h.store.kvSet(credPolicyKey.organization('org_personal'), JSON.stringify({ order: [login], on: [login] }));
    for (let run = 0; run < RUNS; run++) {
      // A new conversation finds the organization's pooled sandbox once the first has made one
      // (KARMAX_LOGIN_SANDBOX_POOL=0 measures without the pool).
      if (run > 0 && (process.env.KARMAX_LOGIN_SANDBOX_POOL ?? '1') !== '0' && PROVIDER === 'e2b')
        await expect.poll(async () => (await h.store.kvEntries('login-sandbox-pool:')).length, { timeout: 120_000, interval: 1_000 }).toBeGreaterThan(0);
      // Cold: a new conversation (its sandbox new, or from the pool).
      const cold = await ask(project.id, token, MODEL);
      const stall = setInterval(async () => {
        const current = await view(cold.taskId).catch((error) => ({ error: String(error) }));
        log(`[latency] waiting: ${JSON.stringify({ stage: current.stage, status: current.status, waitingFor: current.waitingFor,
          error: current.error, agentTurn: current.agentTurn, last: current.messages?.slice(-2) }).slice(0, 1500)}`);
        const events = (await h.store.eventsSince(cold.taskId, 0)).slice(-6).map((event) => `${event.type} ${JSON.stringify(event.payload).slice(0, 300)}`);
        log(`[latency] events: ${events.join('\n')}`);
      }, 20_000);
      try { const at = await cold.first; note(opened.at(-1)?.pooled ? 'cold (pooled)' : 'cold', at - cold.started); breakdown('cold', cold.taskId, cold.started, at); } finally { clearInterval(stall); }
      await reviewed(cold.taskId);
      // Warm: a follow-up while its sandbox still runs.
      const warmAt = Date.now();
      const warm = tokenAfter(cold.taskId);
      await h.client.workflow.getHandle(cold.taskId).signal('followUp', { id: `w${run}`, role: 'user', ts: Date.now(), text: 'And in one word?' });
      const warmToken = await warm; note('warm', warmToken - warmAt); breakdown('warm', cold.taskId, warmAt, warmToken);
      await reviewed(cold.taskId);
      // Resumed: a follow-up after its sandbox parked (the sweep's idle park, done now).
      const entry = (await pool.entry(cold.taskId))!;
      expect(entry.state).toBe('running');
      process.env.KARMAX_LOGIN_SANDBOX_IDLE_MS = '1';
      try { await pool.housekeep(); } finally { delete process.env.KARMAX_LOGIN_SANDBOX_IDLE_MS; }
      expect((await pool.entry(cold.taskId))?.state).toBe('parked');
      const resumedAt = Date.now();
      const resumed = tokenAfter(cold.taskId);
      await h.client.workflow.getHandle(cold.taskId).signal('followUp', { id: `r${run}`, role: 'user', ts: Date.now(), text: 'Thanks. Anything else?' });
      const resumedToken = await resumed; note('resumed', resumedToken - resumedAt); breakdown('resumed', cold.taskId, resumedAt, resumedToken);
      await reviewed(cold.taskId);
      // Done: the task's sandbox goes with it.
      await h.client.workflow.getHandle(cold.taskId).signal('confirm');
      await h.client.workflow.getHandle(cold.taskId).result();
      await pool.housekeep();
      expect(await pool.entry(cold.taskId)).toBeUndefined();
    }
  }, 30 * 60_000);

  it.skipIf(!process.env.KARMAX_LIVE_ANTHROPIC_KEY)('the API-key path, for comparison', async () => {
    const project = await h.store.createProject(newId('Ask key'), { defaultBase: 'main' });
    const token = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const handle = 'claude:org_personal:live-key';
    await h.broker.registerHandle(handle, process.env.KARMAX_LIVE_ANTHROPIC_KEY!, INSTALLATION_SCOPE);
    const key = `key:handle:${handle}`;
    await makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE }).registerAccounts([
      { id: 'login:claude:live', provider: 'claude', kind: 'login', configHome: home, maxConcurrent: 4 },
      { id: key, provider: 'claude', kind: 'key', configHome: '', apiKeyHandle: handle, maxConcurrent: 4 },
    ]);
    // Only the key: the login is switched off for this comparison.
    await h.store.kvSet(credPolicyKey.organization('org_personal'), JSON.stringify({ order: [key], on: [key], off: ['login:claude:live'] }));
    for (let run = 0; run < RUNS; run++) {
      const cold = await ask(project.id, token, MODEL);
      const keyToken = await cold.first;
      // The host-side Messages API loop: no sandbox at all.
      expect(await pool.entry(cold.taskId)).toBeUndefined(); note('api-key first', keyToken - cold.started); breakdown('api-key first', cold.taskId, cold.started, keyToken);
      await reviewed(cold.taskId);
      const at = Date.now();
      const next = tokenAfter(cold.taskId);
      await h.client.workflow.getHandle(cold.taskId).signal('followUp', { id: `k${run}`, role: 'user', ts: Date.now(), text: 'And in one word?' });
      note('api-key follow-up', (await next) - at);
      await reviewed(cold.taskId);
      await h.client.workflow.getHandle(cold.taskId).cancel().catch(() => undefined);
    }
  }, 15 * 60_000);
});
