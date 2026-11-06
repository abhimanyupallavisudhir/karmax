import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runSmoke, formatSmokeReport, type SmokeOptions } from '../src/ops/smoke.js';

/**
 * The production smoke test (wiki ops/release-and-deploy, "Smoke test"): what a
 * visitor and a signed-in client need from a live tavya, checked from outside
 * it. These run it against a stand-in that answers like the gateway.
 */

interface Behaviour {
  ready?: number;
  missingAsset?: string;
  /** Serve this asset as the SPA's HTML fallback, as the gateway does for a file it lacks. */
  htmlAsset?: string;
  me?: { status?: number; projectIds?: string[]; expiresAt?: number | null };
  /** What successive task reads answer, after the task is created. */
  task?: Array<{ status: string; stage?: string; waitingFor?: Record<string, unknown>; output?: string; error?: string }>;
}

const DAY = 86_400_000;
const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

async function standIn(behaviour: Behaviour = {}) {
  const requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: string }> = [];
  let command = '';
  let reads = 0;
  const html = '<!doctype html><link rel="stylesheet" href="/styles.css"><link rel="icon" href="/brand/icon.svg">'
    + '<script src="/markdown.js"></script><script type="module" src="/app.js"></script>'
    + '<script src="https://cdn.example/elsewhere.js"></script>';
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? '/', 'http://stand-in');
    requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body });
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const signedIn = req.headers.authorization === 'Bearer tvp_good';
    if (url.pathname === '/api/health/ready') return json(behaviour.ready ?? 200, { ok: (behaviour.ready ?? 200) === 200 });
    if (url.pathname === '/api/meta') return json(200, { brand: 'tavya' });
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html); }
    if (['/styles.css', '/markdown.js', '/app.js'].includes(url.pathname)) {
      if (behaviour.missingAsset === url.pathname) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
      if (behaviour.htmlAsset === url.pathname) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html); }
      res.writeHead(200, { 'content-type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
      return res.end('/* asset */');
    }
    if (url.pathname === '/api/user/me') {
      const me = behaviour.me ?? {};
      if (!signedIn || me.status === 401) return json(401, { error: 'unauthorized' });
      if (me.status === 403) return json(403, { error: 'a verified human subject is required' });
      return json(200, { id: 'user_1', name: 'Owner', email: 'owner@example.test',
        via: { grantId: 'grant_1', kind: 'token', scope: { projectIds: me.projectIds ?? ['proj_smoke'] },
          expiresAt: me.expiresAt === undefined ? Date.now() + 200 * DAY : me.expiresAt } });
    }
    if (url.pathname === '/api/projects/proj_smoke' && req.method === 'GET') return json(signedIn ? 200 : 401, signedIn ? { id: 'proj_smoke' } : { error: 'unauthorized' });
    if (url.pathname === '/api/projects/proj_smoke/tasks' && req.method === 'POST') {
      if (!signedIn) return json(401, { error: 'unauthorized' });
      command = JSON.parse(body).params.command;
      return json(201, { id: 'task_smoke', num: 7 });
    }
    if (url.pathname === '/api/tasks/task_smoke' && req.method === 'GET') {
      const script = behaviour.task ?? [{ status: 'running', stage: 'do' }, { status: 'done', output: 'run' }];
      const state = script[Math.min(reads++, script.length - 1)]!;
      // The command ran: its output is what a shell would have printed.
      const printed = state.output === 'run' ? shell(command) : state.output;
      return json(200, { id: 'task_smoke', status: state.status, stage: state.stage ?? 'do', waitingFor: state.waitingFor,
        error: state.error, params: { command },
        messages: [{ role: 'system', text: `Running \`${command}\`` }, ...(printed !== undefined ? [{ role: 'system', text: `The command exited 0.\n${printed}` }] : [])] });
    }
    if (url.pathname === '/api/tasks/task_smoke/signal' && req.method === 'POST') return json(200, { ok: true });
    json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const via = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  servers.push({ close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) });
  return { via, requests, command: () => command };
}

/** Evaluate the `$((a*b))` the smoke command prints, as the sandbox's shell would. */
function shell(command: string): string {
  const product = command.match(/\$\(\((\d+)\*(\d+)\)\)/);
  return command.includes('tavya-smoke') && product ? `tavya-smoke ${BigInt(product[1]!) * BigInt(product[2]!)}` : '';
}

const fast = (overrides: Partial<SmokeOptions>): SmokeOptions => ({
  url: 'https://tavya.example', pollMs: 1, journeyTimeoutMs: 2_000, ...overrides,
});
const step = (report: Awaited<ReturnType<typeof runSmoke>>, name: string) => report.steps.find((entry) => entry.name === name);

describe('production smoke test', () => {
  it('checks what a visitor loads, and skips the signed-in journey without a token', async () => {
    const tavya = await standIn();
    const report = await runSmoke(fast({ via: tavya.via }));
    expect(report.outcome).toBe('ok');
    expect(report.steps.map((entry) => [entry.name, entry.outcome])).toEqual([
      ['ready', 'ok'], ['console', 'ok'], ['meta', 'ok'], ['sign-in', 'skipped'], ['task', 'skipped'],
    ]);
    // Every same-origin script and stylesheet the console names, nothing elsewhere.
    expect(tavya.requests.map((request) => request.path)).toEqual(expect.arrayContaining(['/styles.css', '/markdown.js', '/app.js']));
    expect(tavya.requests.some((request) => request.path.includes('elsewhere'))).toBe(false);
  });

  it('reaches the app directly the way the edge would, for a deploy that checks itself before its edge', async () => {
    const tavya = await standIn();
    await runSmoke(fast({ via: tavya.via }));
    for (const request of tavya.requests) {
      expect(request.headers.host).toBe('tavya.example');
      expect(request.headers['x-forwarded-proto']).toBe('https');
    }
  });

  it('fails, naming the asset, when the console references a file that is not served', async () => {
    const tavya = await standIn({ missingAsset: '/app.js' });
    const report = await runSmoke(fast({ via: tavya.via }));
    expect(report.outcome).toBe('failed');
    expect(step(report, 'console')).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('/app.js answered 404') });
  });

  it('fails when a script comes back as the console page, which is what a file the gateway lacks looks like', async () => {
    const tavya = await standIn({ htmlAsset: '/markdown.js' });
    const report = await runSmoke(fast({ via: tavya.via }));
    expect(report.outcome).toBe('failed');
    expect(step(report, 'console')?.detail).toContain('/markdown.js is text/html; charset=utf-8, not JavaScript');
  });

  it('fails when the control plane is not ready', async () => {
    const tavya = await standIn({ ready: 503 });
    const report = await runSmoke(fast({ via: tavya.via }));
    expect(report.outcome).toBe('failed');
    expect(step(report, 'ready')).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('503') });
  });

  it('runs a command task on a fresh computer and checks what the command printed', async () => {
    const tavya = await standIn();
    const report = await runSmoke(fast({ via: tavya.via, token: 'tvp_good' }));
    expect(report.outcome).toBe('ok');
    expect(step(report, 'sign-in')).toMatchObject({ outcome: 'ok', detail: expect.stringMatching(/expires in (199|200) days/) });
    expect(step(report, 'task')).toMatchObject({ outcome: 'ok', detail: expect.stringContaining('task_smoke') });
    // The command reaches tavya from inside its computer, and prints a value
    // that appears nowhere in its own text, so an echo of the command cannot pass.
    const command = tavya.command();
    expect(command).toContain('$KARMAX_GATEWAY_URL/api/health/ready');
    expect(command).not.toContain(shell(command).split(' ')[1]);
    const create = tavya.requests.find((request) => request.method === 'POST' && request.path.endsWith('/tasks'))!;
    expect(create.headers.authorization).toBe('Bearer tvp_good');
  });

  it('fails when the command never printed its answer, even though the task finished', async () => {
    const tavya = await standIn({ task: [{ status: 'done', output: 'tavya-smoke 1' }] });
    const report = await runSmoke(fast({ via: tavya.via, token: 'tvp_good' }));
    expect(report.outcome).toBe('failed');
    expect(step(report, 'task')?.detail).toContain('did not print');
  });

  it('fails with the task\'s own error when the task fails', async () => {
    const tavya = await standIn({ task: [{ status: 'failed', error: 'could not provision the world: E2B 500' }] });
    const report = await runSmoke(fast({ via: tavya.via, token: 'tvp_good' }));
    expect(report.outcome).toBe('failed');
    expect(step(report, 'task')?.detail).toContain('could not provision the world: E2B 500');
  });

  it('is inconclusive, not failed, when no computer was free in time, and cancels the task', async () => {
    const tavya = await standIn({ task: [{ status: 'waiting', waitingFor: { kind: 'retry', summary: 'Waiting for a machine', detail: 'All 20 of tavya\'s E2B computers are in use' } }] });
    const report = await runSmoke(fast({ via: tavya.via, token: 'tvp_good', journeyTimeoutMs: 50 }));
    expect(report.outcome).toBe('inconclusive');
    expect(step(report, 'task')?.detail).toContain('All 20 of tavya\'s E2B computers are in use');
    expect(tavya.requests.find((request) => request.path.endsWith('/signal'))?.body).toBe(JSON.stringify({ signal: 'cancel' }));
  });

  it('fails when the task is stuck for any other reason, saying where, and cancels it', async () => {
    const tavya = await standIn({ task: [{ status: 'waiting', stage: 'do', waitingFor: { kind: 'retry', detail: 'Retry 2 of 5' } }] });
    const report = await runSmoke(fast({ via: tavya.via, token: 'tvp_good', journeyTimeoutMs: 50 }));
    expect(report.outcome).toBe('failed');
    expect(step(report, 'task')?.detail).toMatch(/do · waiting · Retry 2 of 5/);
    expect(tavya.requests.some((request) => request.path.endsWith('/signal'))).toBe(true);
  });

  it('fails when the token is refused', async () => {
    const tavya = await standIn();
    const report = await runSmoke(fast({ via: tavya.via, token: 'tvp_revoked' }));
    expect(report.outcome).toBe('failed');
    expect(step(report, 'sign-in')).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('401') });
    expect(step(report, 'task')?.outcome).toBe('skipped');
  });

  it('asks for a project when the token is not limited to exactly one', async () => {
    const tavya = await standIn({ me: { projectIds: [] } });
    const report = await runSmoke(fast({ via: tavya.via, token: 'tvp_good' }));
    expect(report.outcome).toBe('failed');
    expect(step(report, 'sign-in')?.detail).toContain('limit the token to one project');
    const chosen = await runSmoke(fast({ via: tavya.via, token: 'tvp_good', projectId: 'proj_smoke' }));
    expect(chosen.outcome).toBe('ok');
  });

  it('takes an agent\'s or a task\'s token, which has no person behind it, when it names its project', async () => {
    const tavya = await standIn({ me: { status: 403 } });
    const unnamed = await runSmoke(fast({ via: tavya.via, token: 'tvp_good' }));
    expect(step(unnamed, 'sign-in')?.detail).toContain('limit the token to one project');
    const named = await runSmoke(fast({ via: tavya.via, token: 'tvp_good', projectId: 'proj_smoke' }));
    expect(named.outcome).toBe('ok');
    expect(step(named, 'sign-in')?.detail).toBe('token valid, not a person\'s token');
  });

  it('warns of a token about to expire only when asked to', async () => {
    const tavya = await standIn({ me: { expiresAt: Date.now() + 5 * DAY } });
    expect((await runSmoke(fast({ via: tavya.via, token: 'tvp_good' }))).outcome).toBe('ok');
    const strict = await runSmoke(fast({ via: tavya.via, token: 'tvp_good', expiringWithinDays: 14 }));
    expect(strict.outcome).toBe('failed');
    expect(step(strict, 'sign-in')?.detail).toMatch(/expires in [45] days/);
  });

  it('never prints the account\'s email or the token', async () => {
    const tavya = await standIn();
    const report = await runSmoke(fast({ via: tavya.via, token: 'tvp_good' }));
    const printed = formatSmokeReport(report);
    expect(printed).not.toContain('owner@example.test');
    expect(printed).not.toContain('tvp_good');
    expect(printed).toMatch(/✓ task/);
  });

  it('fails a step that does not answer in time instead of hanging', async () => {
    const server = createServer(() => { /* never answers */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push({ close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) });
    const report = await runSmoke(fast({ via: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requestTimeoutMs: 100 }));
    expect(report.outcome).toBe('failed');
    expect(step(report, 'ready')?.detail).toMatch(/timed out/);
  });
});
