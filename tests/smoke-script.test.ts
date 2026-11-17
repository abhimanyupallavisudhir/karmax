import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { checkSyntax, pageAssets, runSmoke } from '../scripts/smoke.mjs';

const REVISION = 'a'.repeat(40);
const html = `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><script src="/markdown.js"></script>
<script type="module" src="/app.js"></script><script src="https://cdn.example/x.js"></script></head></html>`;

/** A deployed tavya, answering what the suite asks; `override` breaks one route. */
function fakeTavya(override: Record<string, () => Response> = {},
  task: { answers?: boolean | 'wrong'; stage?: string } = {}) {
  const calls: Array<{ method: string; route: string; auth?: string; body?: any }> = [];
  let prompt = '';
  const fetchImpl = async (url: string, init: RequestInit) => {
    const route = new URL(url).pathname + new URL(url).search;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, route, auth: (init.headers as Record<string, string>).authorization, body });
    const key = `${method} ${new URL(url).pathname}`;
    if (override[key]) return override[key]!();
    const json = (value: unknown) => Response.json(value);
    if (key === 'GET /api/health/ready') return json({ ok: true, database: 'ready', temporal: 'ready', revision: REVISION });
    if (key === 'GET /') return new Response(html, { headers: { 'content-type': 'text/html' } });
    if (key === 'GET /app.js') return new Response('export const app = () => 1;\n', { headers: { 'content-type': 'text/javascript' } });
    if (key === 'GET /markdown.js') return new Response('window.md = 1;\n');
    if (key === 'GET /styles.css') return new Response('body{}');
    if (key === 'GET /docs' || key === 'GET /pricing') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    if (key === 'GET /api/meta') return json({ version: '1.0.0' });
    if (key === 'GET /api/session') return json({ authenticated: false });
    if (key === 'GET /api/projects/proj_smoke') return json({ id: 'proj_smoke' });
    if (key === 'POST /api/projects/proj_smoke/tasks') { prompt = body.prompt; return json({ id: 'task_smoke' }); }
    if (key === 'GET /api/tasks/task_smoke/conversation') {
      const [, a, b] = prompt.match(/value of (\d+) \+ (\d+)/) ?? [];
      const sum = Number(a) + Number(b);
      const reply = task.answers === false ? 'I cannot.' : task.answers === 'wrong' ? String(sum * 100 + 7) : String(sum);
      return json({ role: 'do', messages: [{ role: 'user', text: prompt }, { role: 'agent', text: reply }] });
    }
    if (key === 'GET /api/tasks/task_smoke') return json({ stage: task.stage ?? 'do', status: task.stage === 'review' ? 'waiting' : 'active' });
    return json({ ok: true });
  };
  return { fetchImpl, calls };
}

const quiet = () => undefined;
const failures = (results: Array<{ name: string; ok: boolean; error?: string }>) =>
  results.filter((result) => !result.ok).map((result) => `${result.name}: ${result.error}`);

describe('smoke suite', () => {
  it('passes against a healthy instance at the expected commit', async () => {
    const { fetchImpl, calls } = fakeTavya();
    const results = await runSmoke({ url: 'https://staging.example/', revision: REVISION, fetch: fetchImpl }, {}, quiet);
    expect(failures(results)).toEqual([]);
    // Every same-origin asset of the console page, nothing from elsewhere.
    expect(calls.map((call) => call.route)).toEqual(expect.arrayContaining(['/app.js', '/markdown.js', '/styles.css']));
    expect(calls.some((call) => call.route.includes('cdn.example'))).toBe(false);
    expect(calls.some((call) => call.auth)).toBe(false);
  });

  it('fails when another commit serves, readiness fails, or an asset is missing', async () => {
    const other = await runSmoke({ url: 'https://s.example', revision: 'b'.repeat(40), fetch: fakeTavya().fetchImpl }, {}, quiet);
    expect(failures(other)).toEqual([`ready: serving ${REVISION}, not ${'b'.repeat(40)}`]);
    const down = fakeTavya({ 'GET /api/health/ready': () => Response.json({ ok: false }, { status: 503 }) });
    expect(failures(await runSmoke({ url: 'https://s.example', fetch: down.fetchImpl }, {}, quiet))[0]).toMatch(/^ready: readiness answered 503/);
    const missing = fakeTavya({ 'GET /markdown.js': () => new Response('nope', { status: 404 }) });
    expect(failures(await runSmoke({ url: 'https://s.example', fetch: missing.fetchImpl }, {}, quiet))[0]).toMatch(/^console: \/markdown\.js answered 404/);
  });

  it('catches a console script that does not parse', async () => {
    const broken = fakeTavya({ 'GET /app.js': () => new Response('export const app = () => {;\n') });
    expect(failures(await runSmoke({ url: 'https://s.example', fetch: broken.fetchImpl }, {}, quiet))[0]).toMatch(/^console: \/app\.js does not parse/);
    expect(() => checkSyntax('import x from "./y.js"; export default x;', 'ok.js')).not.toThrow();
  });

  it('runs a real task with the smoke token, checks the answer, then cancels and archives it', async () => {
    const { fetchImpl, calls } = fakeTavya();
    const env = { SMOKE_TOKEN: 'tvp_smoke', SMOKE_PROJECT_ID: 'proj_smoke' };
    const results = await runSmoke({ url: 'https://s.example', task: true, fetch: fetchImpl }, env, quiet);
    expect(failures(results)).toEqual([]);
    const authed = calls.filter((call) => call.auth);
    expect(authed.every((call) => call.auth === 'Bearer tvp_smoke')).toBe(true);
    expect(authed.map((call) => `${call.method} ${call.route}`)).toEqual(expect.arrayContaining([
      'POST /api/projects/proj_smoke/tasks', 'POST /api/tasks/task_smoke/signal', 'POST /api/tasks/task_smoke/archive']));
    expect(calls.find((call) => call.route === '/api/tasks/task_smoke/signal')?.body).toEqual({ signal: 'cancel' });
    const params = { 'agent:do': { provider: 'claude', model: 'claude-haiku-5-5', mcpConnections: [] } };
    const named = fakeTavya();
    expect(failures(await runSmoke({ url: 'https://s.example', task: true, fetch: named.fetchImpl },
      { ...env, SMOKE_TASK_PARAMS: JSON.stringify(params) }, quiet))).toEqual([]);
    expect(named.calls.find((call) => call.route === '/api/projects/proj_smoke/tasks')?.body.params).toEqual(params);
    expect(calls.find((call) => call.route === '/api/projects/proj_smoke/tasks')?.body.params).toBeUndefined();
  });

  it('fails a task that never answers, and one asked for without credentials', async () => {
    const silent = fakeTavya({}, { answers: false });
    const env = { SMOKE_TOKEN: 'tvp_smoke', SMOKE_PROJECT_ID: 'proj_smoke' };
    const timedOut = await runSmoke({ url: 'https://s.example', task: true, taskTimeoutMs: 1, fetch: silent.fetchImpl }, env, quiet);
    expect(failures(timedOut)[0]).toMatch(/^task: task task_smoke did not answer/);
    expect(silent.calls.some((call) => call.route === '/api/tasks/task_smoke/archive')).toBe(true);
    const anonymous = await runSmoke({ url: 'https://s.example', task: true, fetch: fakeTavya().fetchImpl }, {}, quiet);
    expect(failures(anonymous)).toEqual(['task: a task check needs SMOKE_TOKEN and SMOKE_PROJECT_ID']);
  });

  it('asks a sum no model gets wrong, whose answer is not in the prompt', async () => {
    // Production's smoke agent (Claude Haiku, low effort, no tools) answered 8393 + 5514 with 17907
    // and 8267 + 8997 with 16915 (Promote runs 44083589841 and 44087210378): four-digit sums
    // test the model's arithmetic, not tavya.
    for (let i = 0; i < 30; i++) {
      const { fetchImpl, calls } = fakeTavya();
      const env = { SMOKE_TOKEN: 'tvp_smoke', SMOKE_PROJECT_ID: 'proj_smoke' };
      expect(failures(await runSmoke({ url: 'https://s.example', task: true, fetch: fetchImpl }, env, quiet))).toEqual([]);
      const prompt: string = calls.find((call) => call.route === '/api/projects/proj_smoke/tasks')?.body.prompt;
      const [, a, b] = prompt.match(/value of (\d+) \+ (\d+)/)!;
      expect(Number(a)).toBeGreaterThanOrEqual(2);
      expect(Number(b)).toBeLessThanOrEqual(9);
      // An echo of the prompt cannot pass: the answer is nowhere in it.
      expect(prompt).not.toMatch(new RegExp(`(?<!\\d)${Number(a) + Number(b)}(?!\\d)`));
    }
  });

  it('fails at once, quoting the reply, when the turn ends with a wrong answer', async () => {
    const wrong = fakeTavya({}, { answers: 'wrong', stage: 'review' });
    const env = { SMOKE_TOKEN: 'tvp_smoke', SMOKE_PROJECT_ID: 'proj_smoke' };
    const started = Date.now();
    const results = await runSmoke({ url: 'https://s.example', task: true, taskTimeoutMs: 60_000, fetch: wrong.fetchImpl }, env, quiet);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(failures(results)[0]).toMatch(/^task: task task_smoke answered "\d+07", not \d+ \(\d \+ \d\)/);
    expect(wrong.calls.some((call) => call.route === '/api/tasks/task_smoke/archive')).toBe(true);
    // Still working: no verdict before the turn ends (the reply may yet come), only the timeout.
    const working = fakeTavya({}, { answers: 'wrong' });
    const timedOut = await runSmoke({ url: 'https://s.example', task: true, taskTimeoutMs: 1, fetch: working.fetchImpl }, env, quiet);
    expect(failures(timedOut)[0]).toMatch(/^task: task task_smoke did not answer/);
  });

  it('a reply containing the answer only inside a longer number is not the answer', async () => {
    const env = { SMOKE_TOKEN: 'tvp_smoke', SMOKE_PROJECT_ID: 'proj_smoke' };
    const padded = fakeTavya({ 'GET /api/tasks/task_smoke/conversation': () => Response.json({ messages: [] }) }, { stage: 'review' });
    let prompt = '';
    const fetchImpl = async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === '/api/projects/proj_smoke/tasks') prompt = JSON.parse(String(init.body)).prompt;
      if (new URL(url).pathname === '/api/tasks/task_smoke/conversation') {
        const [, a, b] = prompt.match(/value of (\d+) \+ (\d+)/)!;
        return Response.json({ messages: [{ role: 'agent', text: `1${Number(a) + Number(b)}1` }] });
      }
      return padded.fetchImpl(url, init);
    };
    const results = await runSmoke({ url: 'https://s.example', task: true, taskTimeoutMs: 60_000, fetch: fetchImpl }, env, quiet);
    expect(failures(results)[0]).toMatch(/^task: task task_smoke answered "1\d+1", not/);
  });

  it('lists the page assets from its own origin', () => {
    expect(pageAssets(html).sort()).toEqual(['/app.js', '/markdown.js', '/styles.css']);
  });
});
