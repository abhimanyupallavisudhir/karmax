import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { bootHarness, Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { newId } from '../src/util/id.js';
import { ConfigHomeManager, scrubbedEnv } from '../src/autonomy/config-homes.js';
import { remoteAccessPlan } from '../src/remote/access.js';

describe('config homes + scrubbed env (SPEC §7.3)', () => {
  it('mints one home per (account × provider) and scrubs inherited keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-ch-'));
    const mgr = new ConfigHomeManager(dir);
    const home = mgr.ensure('claude', 'work');
    expect(fs.existsSync(home)).toBe(true);
    expect(mgr.list().map((h) => h.account)).toContain('work');

    process.env.ANTHROPIC_API_KEY = 'leak-me';
    const env = scrubbedEnv({ provider: 'claude', configHome: home });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // never leaks across profiles
    expect(env.CLAUDE_CONFIG_DIR).toBe(home);
    delete process.env.ANTHROPIC_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('remote access plan (SPEC §12)', () => {
  it('recommends tailscale when present, with an auth warning when no password', async () => {
    const plan = await remoteAccessPlan(4173, { hasPassword: false, detect: async (b) => b === 'tailscale' });
    expect(plan.method).toBe('tailscale');
    expect(plan.command).toContain('tailscale serve');
    expect(plan.guidance).toMatch(/KARMAX_PASSWORD/);
  });
  it('falls back to guidance when no tunnel tool is installed', async () => {
    const plan = await remoteAccessPlan(4173, { hasPassword: true, detect: async () => false });
    expect(plan.method).toBe('none');
  });
});

describe('budget coordinator (virtual-card lease, SPEC §7.6)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness('mock');
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('grants under threshold, holds over threshold for approval, declines over cap', async () => {
    const grantee = newId('task');
    const ping = await h.client.workflow.start('pingWorkflow', { taskQueue: TASK_QUEUE, workflowId: grantee, args: ['x'] });
    const coord = await h.client.workflow.start('budgetCoordinator', {
      taskQueue: TASK_QUEUE,
      workflowId: 'budget-coordinator-test',
      args: [{ state: { scopes: {}, defaultCap: 1000, threshold: 300, pending: [], processed: 0 } }],
    });
    const budget = () => coord.query('budget') as Promise<any>;

    await coord.signal('requestSpend', { reqId: 'r1', taskId: grantee, scope: 'profA', amount: 100 });
    await expect.poll(async () => (await budget()).scopes.profA?.spent, { timeout: 8000 }).toBe(100);

    // above threshold → held as pending, not spent
    await coord.signal('requestSpend', { reqId: 'r2', taskId: grantee, scope: 'profA', amount: 500 });
    await expect.poll(async () => (await budget()).pending.length, { timeout: 8000 }).toBe(1);
    expect((await budget()).scopes.profA.spent).toBe(100);

    // approve at the review gate → now spent
    await coord.signal('approveSpend', { reqId: 'r2' });
    await expect.poll(async () => (await budget()).scopes.profA.spent, { timeout: 8000 }).toBe(600);

    // over cap → declined (spent unchanged)
    await coord.signal('requestSpend', { reqId: 'r3', taskId: grantee, scope: 'profA', amount: 9999 });
    await new Promise((r) => setTimeout(r, 800));
    expect((await budget()).scopes.profA.spent).toBe(600);

    await ping.signal('finish');
    await ping.result();
    await coord.terminate('done');
  });
});

describe('PTY terminal check-in (SPEC §5.5)', () => {
  let h: Harness;
  let base: string;
  let token: string;
  beforeAll(async () => {
    h = await bootHarness('mock');
    const gw = await h.startGateway();
    base = gw.url;
    token = ((await (await fetch(`${base}/api/session`)).json()) as any).token;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('streams a real shell over /ws/terminal against the task world', async () => {
    const repo = await h.makeRepo('term');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const project: any = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'T', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main' } }) })).json();
    const task: any = await (await fetch(`${base}/api/projects/${project.id}/tasks`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'term', prompt: '@write x.txt :: hi\n@incomplete', workflow: 'software-dev' }) })).json();
    // wait until the world exists (review stage)
    for (let i = 0; i < 60; i++) {
      const v: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth })).json();
      if (v?.worldPath) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const wsUrl = base.replace('http', 'ws') + `/ws/terminal?taskId=${task.id}`;
    const got = await new Promise<string>((resolve) => {
      const ws = new WebSocket(wsUrl);
      let buf = '';
      let sent = false;
      const timer = setTimeout(() => { ws.close(); resolve(buf); }, 9000);
      ws.on('message', (m) => {
        try { const msg = JSON.parse(m.toString()); if (msg.type === 'data') buf += msg.data; } catch {}
        // send the command once the shell prompt has appeared
        if (!sent && buf.includes('karmax:')) { sent = true; ws.send(JSON.stringify({ type: 'input', data: 'echo TERM_OK_123\n' })); }
        if (buf.includes('TERM_OK_123\r') || /TERM_OK_123\b[\s\S]*\$/.test(buf)) { clearTimeout(timer); ws.close(); resolve(buf); }
      });
      ws.on('error', () => { clearTimeout(timer); resolve(buf); });
    });
    expect(String(got)).toContain('TERM_OK_123');
  }, 60_000);
});
