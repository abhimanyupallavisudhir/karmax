import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The one HTTP layer every GitHub REST client in tavya sends through
 * (GitHubAppService, GithubPrApi, GithubActionsApi).
 *
 * Each installation of the GitHub App, and each person's GitHub login, may make
 * 5,000 REST calls an hour (more for big organizations). tavya polled a waiting
 * pull request's state every 30 seconds, and one busy installation reached 82%
 * of its hour (2026-11-09). This layer keeps the calls that change nothing free
 * and makes the rest visible:
 *
 * - **Conditional requests.** A GET GitHub answered with an `ETag` (or
 *   `Last-Modified`) is asked again with `If-None-Match`; GitHub answers an
 *   unchanged resource with 304, which does not count against the limit, and
 *   the caller gets the remembered body as an ordinary 200. Remembered per
 *   token, since what a token may see differs (GitHub varies on
 *   `Authorization`); bounded in entries and bytes.
 * - **Rate-limit observation.** `observeGithubRateLimits(fn)` reports the
 *   tightest `x-ratelimit-*` budget any response inside `fn` carried, so a
 *   poller can wait for the hour to reset instead of spending its last calls.
 * - **Call counts.** Every authorized call is counted by account
 *   (`labelGithubToken`: the installation's login) and by route template
 *   (`GET /repos/:owner/:repo/pulls/:id`), never by anything a person typed,
 *   and `startGithubUsageFlush` adds them to the service-usage counters, so
 *   Installation → Service limits can say what is using an account's calls.
 */

export interface GithubRateLimit {
  /** `core` (REST), `graphql`, `search`, … as GitHub names the bucket. */
  resource: string;
  limit: number;
  remaining: number;
  /** Epoch ms at which the bucket refills. */
  resetAt: number;
}

/** Billable calls, by account and route template: `github.calls:<label>|<METHOD route>`. */
export const GITHUB_CALLS_METER = 'github.calls:';
/** Calls answered 304 from the cache (free), by account: `github.saved:<label>`. */
export const GITHUB_SAVED_METER = 'github.saved:';

const MAX_ENTRIES = 2000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_LABELS = 4000;

const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);

// ─── Token labels ──────────────────────────────────────────────────────────

const labels = new Map<string, string>();

/** How an account is named in the call meters. */
export function githubCallLabel(login: string): string {
  return login.replace(/[|\s]/g, '_').slice(0, 100);
}

/** Attribute calls made with `token` to `label` (an installation's account login). */
export function labelGithubToken(token: string, label: string): void {
  if (!token || !label) return;
  const key = sha(token);
  labels.delete(key);
  labels.set(key, githubCallLabel(label));
  while (labels.size > MAX_LABELS) labels.delete(labels.keys().next().value!);
}

function bearer(authorization: string | null): string | undefined {
  const match = /^(?:bearer|token)\s+(.+)$/i.exec(authorization?.trim() ?? '');
  return match?.[1];
}

// ─── Route templates ───────────────────────────────────────────────────────

/** Path words kept as they are; anything else (ids, names, SHAs) becomes `:id`. */
const NOUNS = new Set([
  'access_tokens', 'actions', 'annotations', 'app', 'artifacts', 'assignees', 'attempts', 'blobs', 'cancel', 'check-runs',
  'check-suites', 'collaborators', 'comments', 'commits', 'dispatches', 'deployments', 'emails', 'environments', 'events',
  'files', 'forks', 'git', 'graphql', 'hooks', 'installation', 'installations', 'invitations', 'issues', 'jobs', 'keys',
  'labels', 'logs', 'members', 'memberships', 'merge', 'merge-upstream', 'merges', 'meta', 'orgs', 'permission', 'protection',
  'pulls', 'rate_limit', 'readme', 'refs', 'releases', 'repos', 'repositories', 'repository_invitations', 'requested_reviewers',
  'rerun', 'rerun-failed-jobs', 'reviews', 'runs', 'secrets', 'status', 'statuses', 'tags', 'teams', 'timeline', 'trees',
  'update-branch', 'user', 'users', 'variables', 'workflows', 'pending_deployments', 'approve', 'required_status_checks',
]);
/** Everything after these is one name that may contain slashes. */
const TAILS: Record<string, string> = { heads: ':ref', ref: ':ref', refs: ':ref', compare: ':basehead', contents: ':path', branches: ':branch' };

/** `GET /repos/:owner/:repo/pulls/:id` for `GET /repos/acme/site/pulls/7?x=1`. */
export function githubRoute(method: string, url: string): string {
  let pathname: string;
  try { pathname = new URL(url, 'https://api.github.com').pathname; } catch { return `${method} ?`; }
  let segments = pathname.split('/').filter(Boolean);
  if (segments[0] === 'api' && segments[1] === 'v3') segments = segments.slice(2);
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (i === 0 && segment === 'repos' && segments.length >= 3) { out.push('repos', ':owner', ':repo'); i += 2; continue; }
    if (i === 0 && (segment === 'users' || segment === 'orgs') && segments.length >= 2) { out.push(segment, ':login'); i += 1; continue; }
    if (TAILS[segment] && i + 1 < segments.length && !(segment === 'refs' && segments[i + 1] === 'heads')) {
      out.push(segment, TAILS[segment]!);
      break;
    }
    const word = NOUNS.has(segment) || segment === 'heads' ? segment : ':id';
    if (word === ':id' && out.at(-1) === ':id') continue;
    out.push(word);
  }
  return `${method} /${out.join('/')}`;
}

// ─── Call counts ───────────────────────────────────────────────────────────

const counts = new Map<string, number>();

function count(meter: string): void { counts.set(meter, (counts.get(meter) ?? 0) + 1); }

/** The counts since the last drain (and forget them). */
export function drainGithubCallCounts(): Map<string, number> {
  const drained = new Map(counts);
  counts.clear();
  return drained;
}

/** Add this process's call counts to `sink` every `everyMs` (and once more on `stop`). */
export function startGithubUsageFlush(sink: (meter: string, n: number) => Promise<void>, everyMs = 60_000): { stop(): Promise<void> } {
  let running: Promise<void> = Promise.resolve();
  const flush = () => {
    running = running.then(async () => {
      for (const [meter, n] of drainGithubCallCounts()) {
        try { await sink(meter, n); }
        catch { counts.set(meter, (counts.get(meter) ?? 0) + n); }
      }
    });
    return running;
  };
  const timer = setInterval(() => void flush(), everyMs);
  timer.unref?.();
  return { stop: async () => { clearInterval(timer); await flush(); } };
}

// ─── Rate-limit observation ────────────────────────────────────────────────

const observers = new AsyncLocalStorage<GithubRateLimit[]>();

/** Run `operation` and report the tightest GitHub budget its responses carried. */
export async function observeGithubRateLimits<T>(operation: () => Promise<T>): Promise<{ value: T; tightest?: GithubRateLimit }> {
  const seen: GithubRateLimit[] = [];
  const value = await observers.run(seen, operation);
  const tightest = seen.reduce<GithubRateLimit | undefined>((a, b) =>
    !a || b.remaining / b.limit < a.remaining / a.limit ? b : a, undefined);
  return { value, ...(tightest ? { tightest } : {}) };
}

function rateLimitOf(headers: Headers): GithubRateLimit | undefined {
  const limit = Number(headers.get('x-ratelimit-limit'));
  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (!headers.get('x-ratelimit-limit') || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return undefined;
  return { resource: headers.get('x-ratelimit-resource') || 'core', limit, remaining,
    resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0 };
}

// ─── Conditional-request cache ─────────────────────────────────────────────

interface Remembered { etag?: string; lastModified?: string; body: string; headers: Array<[string, string]>; bytes: number }

const remembered = new Map<string, Remembered>();
let rememberedBytes = 0;

function forget(key: string): void {
  const entry = remembered.get(key);
  if (!entry) return;
  remembered.delete(key);
  rememberedBytes -= entry.bytes;
}

function remember(key: string, entry: Remembered): void {
  forget(key);
  if (entry.bytes > MAX_BODY_BYTES) return;
  remembered.set(key, entry);
  rememberedBytes += entry.bytes;
  while (remembered.size > MAX_ENTRIES || rememberedBytes > MAX_TOTAL_BYTES) forget(remembered.keys().next().value!);
}

/** Forget every remembered response (tests). */
export function resetGithubHttpCache(): void {
  remembered.clear();
  rememberedBytes = 0;
}

/** Headers that describe the call just made rather than the remembered resource. */
const LIVE = /^(x-ratelimit-|date$|x-github-request-id$)/i;

/**
 * A `fetch` for GitHub's REST API with conditional requests, rate-limit
 * observation and call counts. Requests without an `Authorization` header
 * (log downloads from blob storage) pass through untouched.
 */
export function githubFetch(base?: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const send = base ?? globalThis.fetch;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const token = bearer(headers.get('authorization'));
    if (!token) return send(input, init);
    const tokenKey = sha(token);
    const label = labels.get(tokenKey) ?? 'other';
    const conditional = method === 'GET' && !headers.has('if-none-match') && !headers.has('if-modified-since') && !headers.has('range');
    const key = conditional ? `${tokenKey} ${headers.get('accept') ?? ''} ${url}` : '';
    const prior = conditional ? remembered.get(key) : undefined;
    if (prior?.etag) headers.set('if-none-match', prior.etag);
    else if (prior?.lastModified) headers.set('if-modified-since', prior.lastModified);
    // A plain object, as every client here passes: stubs read it as one.
    const response = await send(input, prior ? { ...init, headers: Object.fromEntries(headers) } : init);
    const rate = rateLimitOf(response.headers);
    if (rate) observers.getStore()?.push(rate);
    if (response.status === 304 && prior) {
      count(`${GITHUB_SAVED_METER}${label}`);
      remembered.delete(key);
      remembered.set(key, prior);
      const merged = new Headers(prior.headers.filter(([name]) => !LIVE.test(name)));
      response.headers.forEach((value, name) => { if (LIVE.test(name)) merged.set(name, value); });
      return new Response(prior.body, { status: 200, statusText: 'OK', headers: merged });
    }
    count(`${GITHUB_CALLS_METER}${label}|${githubRoute(method, url)}`);
    if (!conditional) return response;
    const etag = response.headers.get('etag') ?? undefined;
    const lastModified = response.headers.get('last-modified') ?? undefined;
    const length = Number(response.headers.get('content-length'));
    if (response.status !== 200 || (!etag && !lastModified) || !/json/i.test(response.headers.get('content-type') ?? '')
      || (Number.isFinite(length) && length > MAX_BODY_BYTES)) {
      if (prior) forget(key);
      return response;
    }
    const body = await response.text();
    const kept: Array<[string, string]> = [];
    response.headers.forEach((value, name) => { kept.push([name, value]); });
    remember(key, { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}), body, headers: kept,
      bytes: Buffer.byteLength(body) + key.length });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}
