import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

/**
 * The production smoke test (wiki ops/release-and-deploy, "Smoke test"): what a
 * visitor and a signed-in client need from a live tavya, checked from outside it
 * through its public API only.
 *
 * 1. ready    — the control plane answers readiness (database, Temporal).
 * 2. console  — the console page and every same-origin script and stylesheet it
 *               names are served as what they are (a missing file falls back to
 *               the SPA's HTML, so a 200 alone proves nothing).
 * 3. meta     — the console's first API call answers.
 * 4. sign-in  — a personal token signs in; it should be limited to one project.
 * 5. task     — a command task in that project runs on a fresh computer, reaches
 *               tavya back from inside it, and prints a product that appears
 *               nowhere in its own text. No model tokens are spent.
 *
 * `deploy/karmax update` runs it against a candidate release before declaring the
 * update complete (and rolls back when it fails); `.github/workflows/monitor.yml`
 * runs it against tavya.io from GitHub on a schedule and after every deploy.
 *
 * The outcome is `inconclusive` only when the task waited the whole time for a
 * computer (capacity, not a defect), so a full provider never rolls a release
 * back. Output never includes the token or the account's email: the monitor's
 * logs are public.
 */

export type SmokeOutcome = 'ok' | 'failed' | 'inconclusive';
export interface SmokeStep { name: 'ready' | 'console' | 'meta' | 'sign-in' | 'task'; outcome: SmokeOutcome | 'skipped'; ms: number; detail: string }
export interface SmokeReport { outcome: SmokeOutcome; url: string; steps: SmokeStep[] }

export interface SmokeOptions {
  /** The public origin, e.g. https://tavya.io. */
  url: string;
  /** Connect here instead (e.g. http://127.0.0.1:4505), sending `url`'s host and
   *  protocol as the edge would: a deploy checks its candidate this way. */
  via?: string;
  /** A personal token (tvp_…); without one only the visitor's steps run. */
  token?: string;
  /** The project to run the task in; else the one project the token is limited to. */
  projectId?: string;
  /** Fail sign-in when the token expires within this many days (the monitor's reminder). */
  expiringWithinDays?: number;
  journeyTimeoutMs?: number;
  pollMs?: number;
  requestTimeoutMs?: number;
}

interface Answer { status: number; type: string; body: string }
class StepFailure extends Error {}
class Inconclusive extends Error {}

const DAY = 86_400_000;
const CAPACITY_WAITS = /^(Out of compute|Waiting for a machine)$/;
const clip = (text: string, length = 400) => (text.length > length ? `${text.slice(0, length)}…` : text).replace(/\s+/g, ' ').trim();

export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const origin = new URL(options.url);
  const target = new URL(options.via ?? options.url);
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;

  const request = (method: string, path: string, body?: unknown, auth = false): Promise<Answer> => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      'user-agent': 'tavya-smoke', accept: '*/*',
      ...(auth && options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
      // Through the edge these are Caddy's; straight to the app, ours.
      ...(options.via ? { host: origin.host, 'x-forwarded-proto': origin.protocol.replace(':', ''), 'x-forwarded-host': origin.host } : {}),
    };
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
      method, path, headers, servername: target.protocol === 'https:' ? target.hostname : undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(requestTimeoutMs, () => req.destroy(new StepFailure(`${method} ${path} timed out after ${requestTimeoutMs / 1000} s`)));
    req.on('error', (error) => reject(error instanceof StepFailure ? error : new StepFailure(`${method} ${path}: ${error.message}`)));
    req.end(payload);
  });
  const expect = (answer: Answer, path: string, status = 200) => {
    if (answer.status !== status) throw new StepFailure(`${path} answered ${answer.status}${answer.body ? `: ${clip(answer.body, 200)}` : ''}`);
    return answer;
  };
  const json = <T>(answer: Answer, path: string): T => {
    try { return JSON.parse(answer.body) as T; } catch { throw new StepFailure(`${path} did not answer JSON`); }
  };

  const steps: SmokeStep[] = [];
  const run = async (name: SmokeStep['name'], check: () => Promise<string>) => {
    const started = Date.now();
    try {
      steps.push({ name, outcome: 'ok', detail: await check(), ms: Date.now() - started });
    } catch (error) {
      const outcome = error instanceof Inconclusive ? 'inconclusive' : 'failed';
      steps.push({ name, outcome, detail: clip(error instanceof Error ? error.message : String(error), 600), ms: Date.now() - started });
    }
    return steps.at(-1)!.outcome === 'ok';
  };
  const skip = (name: SmokeStep['name'], detail: string) => steps.push({ name, outcome: 'skipped', ms: 0, detail });

  await run('ready', async () => {
    const answer = expect(await request('GET', '/api/health/ready'), '/api/health/ready');
    const body = json<{ ok?: boolean; database?: string; temporal?: string }>(answer, '/api/health/ready');
    if (body.ok !== true) throw new StepFailure(`/api/health/ready answered ${clip(answer.body, 200)}`);
    return 'database and Temporal ready';
  });

  await run('console', async () => {
    const page = expect(await request('GET', '/'), '/');
    if (!page.type.includes('text/html')) throw new StepFailure(`/ is ${page.type || 'untyped'}, not HTML`);
    const assets = consoleAssets(page.body, origin);
    if (!assets.some((asset) => asset.kind === 'script')) throw new StepFailure('the console page names no script');
    for (const asset of assets) {
      const answer = expect(await request('GET', asset.path), asset.path);
      const wanted = asset.kind === 'script' ? /javascript/ : /text\/css/;
      if (!wanted.test(answer.type)) throw new StepFailure(`${asset.path} is ${answer.type || 'untyped'}, not ${asset.kind === 'script' ? 'JavaScript' : 'CSS'}`);
      if (!answer.body.trim()) throw new StepFailure(`${asset.path} is empty`);
    }
    return `the page and its ${assets.length} scripts and stylesheets`;
  });

  await run('meta', async () => {
    json(expect(await request('GET', '/api/meta'), '/api/meta'), '/api/meta');
    return 'answered';
  });

  if (!options.token) {
    skip('sign-in', 'no token');
    skip('task', 'no token');
  } else {
    let projectId = options.projectId;
    const signedIn = await run('sign-in', async () => {
      // A person's token says which projects it is limited to and when it
      // expires; an agent's or a task's token has no person behind it (403)
      // and must name its project.
      const meAnswer = await request('GET', '/api/user/me', undefined, true);
      if (meAnswer.status !== 403) expect(meAnswer, '/api/user/me');
      const me = meAnswer.status === 200
        ? json<{ via?: { expiresAt?: number | null; scope?: { projectIds?: string[] } } }>(meAnswer, '/api/user/me') : undefined;
      const limited = me?.via?.scope?.projectIds ?? [];
      projectId ??= limited.length === 1 ? limited[0] : undefined;
      if (!projectId) throw new StepFailure('limit the token to one project (Profile → Apps and tokens), or name the project with --project');
      const projectPath = `/api/projects/${encodeURIComponent(projectId)}`;
      expect(await request('GET', projectPath, undefined, true), projectPath);
      const expiresAt = me?.via?.expiresAt;
      const days = typeof expiresAt === 'number' ? Math.floor((expiresAt - Date.now()) / DAY) : undefined;
      const expiry = !me ? 'not a person\'s token' : days === undefined ? 'does not expire' : `expires in ${days} days`;
      if (days !== undefined && options.expiringWithinDays !== undefined && days < options.expiringWithinDays)
        throw new StepFailure(`the token ${expiry}: make a new one in Profile → Apps and tokens and replace the TAVYA_SMOKE_TOKEN secret`);
      return `token valid, ${expiry}`;
    });
    if (!signedIn) skip('task', 'not signed in');
    else await run('task', () => commandJourney(projectId!));
  }

  async function commandJourney(projectId: string): Promise<string> {
    // Two random factors: their product is printed only by a shell that ran the
    // command, and appears nowhere in the command itself.
    const [a, b] = [crypto.randomInt(10_000, 99_999), crypto.randomInt(10_000, 99_999)];
    const answer = `tavya-smoke ${a * b}`;
    const command = `curl -fsS --max-time 20 -o /dev/null "$KARMAX_GATEWAY_URL/api/health/ready" && echo "tavya-smoke $((${a}*${b}))"`;
    const path = `/api/projects/${encodeURIComponent(projectId)}/tasks`;
    const created = await request('POST', path, {
      title: `Smoke test ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      prompt: 'Smoke test: run a command on a fresh computer and reach tavya from it.',
      params: { command },
    }, true);
    if (created.status !== 200 && created.status !== 201) expect(created, path, 201);
    const { id } = json<{ id: string }>(created, path);
    const deadline = Date.now() + (options.journeyTimeoutMs ?? 10 * 60_000);
    let last: TaskView | undefined;
    while (Date.now() < deadline) {
      const view = json<TaskView>(expect(await request('GET', `/api/tasks/${encodeURIComponent(id)}`, undefined, true), `/api/tasks/${id}`), `/api/tasks/${id}`);
      last = view.lastView ?? view;
      if (last.status === 'done') {
        if (!JSON.stringify(last.messages ?? []).includes(answer)) throw new StepFailure(`task ${id} finished, but its command did not print "${answer}"`);
        return `task ${id} ran its command on a fresh computer`;
      }
      if (last.status === 'failed' || last.status === 'cancelled')
        throw new StepFailure(`task ${id} ${last.status}: ${last.error ?? lastMessage(last) ?? 'no reason given'}`);
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 3_000));
    }
    // Don't leave it running; it was only ever a probe.
    await request('POST', `/api/tasks/${encodeURIComponent(id)}/signal`, { signal: 'cancel' }, true).catch(() => undefined);
    const minutes = Math.round((options.journeyTimeoutMs ?? 10 * 60_000) / 60_000);
    const wait = last?.waitingFor;
    const where = [last?.stage, last?.status, wait?.summary, wait?.detail ?? (wait?.summary ? undefined : wait?.kind)].filter(Boolean).join(' · ');
    if (last?.waitingFor?.kind === 'retry' && CAPACITY_WAITS.test(last.waitingFor.summary ?? ''))
      throw new Inconclusive(`no computer was free within ${minutes || '<1'} min (task ${id}: ${where})`);
    throw new StepFailure(`task ${id} was still ${where || 'unfinished'} after ${minutes || '<1'} min`);
  }

  const outcomes = steps.map((entry) => entry.outcome);
  return { url: options.url, steps,
    outcome: outcomes.includes('failed') ? 'failed' : outcomes.includes('inconclusive') ? 'inconclusive' : 'ok' };
}

interface TaskView { status?: string; stage?: string; error?: string; lastView?: TaskView;
  waitingFor?: { kind?: string; summary?: string; detail?: string }; messages?: Array<{ role?: string; text?: string }> }
const lastMessage = (view: TaskView) => view.messages?.filter((message) => message.text).at(-1)?.text;

/** Same-origin scripts and stylesheets a page names. */
export function consoleAssets(html: string, origin: URL): Array<{ kind: 'script' | 'stylesheet'; path: string }> {
  const found: Array<{ kind: 'script' | 'stylesheet'; path: string }> = [];
  const local = (reference: string) => {
    try {
      const url = new URL(reference, origin);
      return url.origin === origin.origin ? url.pathname + url.search : undefined;
    } catch { return undefined; }
  };
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    const src = tag.match(/\ssrc\s*=\s*["']([^"']+)["']/i)?.[1];
    const path = src && local(src);
    if (path) found.push({ kind: 'script', path });
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\srel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = tag.match(/\shref\s*=\s*["']([^"']+)["']/i)?.[1];
    const path = href && local(href);
    if (path) found.push({ kind: 'stylesheet', path });
  }
  return found.filter((asset, index) => found.findIndex((other) => other.path === asset.path) === index);
}

const MARK: Record<SmokeStep['outcome'], string> = { ok: '✓', failed: '✗', inconclusive: '?', skipped: '–' };

export function formatSmokeReport(report: SmokeReport): string {
  const lines = report.steps.map((entry) => `${MARK[entry.outcome]} ${entry.name.padEnd(8)} ${entry.outcome === 'skipped' ? '' : `${(entry.ms / 1000).toFixed(1)} s  `}${entry.detail}`);
  return [`Smoke test of ${report.url}: ${report.outcome}`, ...lines].join('\n');
}

/** The report as a GitHub job summary. */
export function smokeSummaryMarkdown(report: SmokeReport): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  return [`### Smoke test of ${report.url}: ${report.outcome}`, '', '| | Step | Time | Detail |', '|---|---|---|---|',
    ...report.steps.map((entry) => `| ${MARK[entry.outcome]} | ${entry.name} | ${entry.outcome === 'skipped' ? '' : `${(entry.ms / 1000).toFixed(1)} s`} | ${cell(entry.detail)} |`), ''].join('\n');
}
