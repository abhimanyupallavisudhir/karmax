import { afterEach, describe, expect, it } from 'vitest';
import {
  drainGithubCallCounts, githubFetch, githubRoute, labelGithubToken, observeGithubRateLimits, resetGithubHttpCache,
  startGithubUsageFlush,
} from '../src/integrations/github-http.js';

const API = 'https://api.github.com';

/** A GitHub stand-in that answers If-None-Match like GitHub: 304 while the ETag matches. */
function github(options: { remaining?: () => number } = {}) {
  const calls: Array<{ url: string; method: string; ifNoneMatch?: string; authorization?: string }> = [];
  let version = 1;
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', ...(headers.get('if-none-match') ? { ifNoneMatch: headers.get('if-none-match')! } : {}),
      ...(headers.get('authorization') ? { authorization: headers.get('authorization')! } : {}) });
    const rate = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(options.remaining?.() ?? 4000),
      'x-ratelimit-reset': '1800000000', 'x-ratelimit-resource': 'core' };
    if (url.endsWith('/log')) return new Response('plain log', { status: 200, headers: { 'content-type': 'text/plain', etag: '"log"' } });
    if ((init.method ?? 'GET') !== 'GET') return Response.json({ ok: true }, { status: 201, headers: rate });
    const etag = `W/"v${version}"`;
    if (headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ...rate, etag } });
    return Response.json({ version }, { headers: { ...rate, etag } });
  }) as typeof fetch;
  return { fetcher, calls, change: () => { version++; } };
}

afterEach(() => { resetGithubHttpCache(); drainGithubCallCounts(); });

describe('githubFetch conditional requests', () => {
  it('asks again with If-None-Match and answers a 304 with the remembered body as a 200', async () => {
    const server = github();
    const send = githubFetch(server.fetcher);
    const auth = { authorization: 'Bearer token-a' };
    expect(await (await send(`${API}/repos/acme/site/pulls/7`, { headers: auth })).json()).toEqual({ version: 1 });
    const again = await send(`${API}/repos/acme/site/pulls/7`, { headers: auth });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ version: 1 });
    expect(again.headers.get('x-ratelimit-remaining')).toBe('4000');
    expect(server.calls.map((call) => call.ifNoneMatch)).toEqual([undefined, 'W/"v1"']);
    server.change();
    expect(await (await send(`${API}/repos/acme/site/pulls/7`, { headers: auth })).json()).toEqual({ version: 2 });
  });

  it('keeps what one token saw from another token, and never makes writes or non-JSON conditional', async () => {
    const server = github();
    const send = githubFetch(server.fetcher);
    await send(`${API}/repos/acme/site`, { headers: { authorization: 'Bearer token-a' } });
    await send(`${API}/repos/acme/site`, { headers: { authorization: 'Bearer token-b' } });
    await send(`${API}/repos/acme/site/pulls`, { method: 'POST', headers: { authorization: 'Bearer token-a' }, body: '{}' });
    await send(`${API}/repos/acme/site/pulls`, { method: 'POST', headers: { authorization: 'Bearer token-a' }, body: '{}' });
    await send(`${API}/repos/acme/site/actions/jobs/1/log`, { headers: { authorization: 'Bearer token-a' } });
    const log = await send(`${API}/repos/acme/site/actions/jobs/1/log`, { headers: { authorization: 'Bearer token-a' } });
    expect(await log.text()).toBe('plain log');
    expect(server.calls.every((call) => call.ifNoneMatch === undefined)).toBe(true);
  });

  it('passes requests without a token through untouched and uncounted', async () => {
    const server = github();
    const send = githubFetch(server.fetcher);
    await send('https://blob.example/log.zip');
    await send('https://blob.example/log.zip');
    expect(server.calls.every((call) => !call.ifNoneMatch && !call.authorization)).toBe(true);
    expect(drainGithubCallCounts().size).toBe(0);
  });
});

describe('githubFetch call counts', () => {
  it('counts billable calls by account and route, and 304s as saved', async () => {
    const server = github();
    const send = githubFetch(server.fetcher);
    labelGithubToken('installation-token', 'acme');
    for (let i = 0; i < 3; i++) await send(`${API}/repos/acme/site/collaborators?per_page=100`, { headers: { authorization: 'Bearer installation-token' } });
    await send(`${API}/repos/acme/site/pulls/7`, { headers: { authorization: 'token someone-else' } });
    expect(Object.fromEntries(drainGithubCallCounts())).toEqual({
      'github.calls:acme|GET /repos/:owner/:repo/collaborators': 1,
      'github.saved:acme': 2,
      'github.calls:other|GET /repos/:owner/:repo/pulls/:id': 1,
    });
    expect(drainGithubCallCounts().size).toBe(0);
  });

  it('flushes counts to the store, keeping what a failed write could not add', async () => {
    const server = github();
    const send = githubFetch(server.fetcher);
    labelGithubToken('t', 'acme');
    const added: Record<string, number> = {};
    let fail = true;
    const flush = startGithubUsageFlush(async (meter, n) => {
      if (fail) throw new Error('database is busy');
      added[meter] = (added[meter] ?? 0) + n;
    }, 60_000);
    await send(`${API}/rate_limit`, { headers: { authorization: 'Bearer t' } });
    await flush.stop();
    fail = false;
    await startGithubUsageFlush(async (meter, n) => { added[meter] = (added[meter] ?? 0) + n; }).stop();
    expect(added).toEqual({ 'github.calls:acme|GET /rate_limit': 1 });
  });

  it('names routes without ids, names, SHAs or branches', () => {
    expect(githubRoute('GET', `${API}/repos/acme/site/pulls/12/reviews`)).toBe('GET /repos/:owner/:repo/pulls/:id/reviews');
    expect(githubRoute('GET', `${API}/repos/acme/site/commits/0123456789abcdef0123456789abcdef01234567/check-runs?filter=latest`))
      .toBe('GET /repos/:owner/:repo/commits/:id/check-runs');
    expect(githubRoute('GET', `${API}/repos/acme/site/compare/main...tavya/task_x`)).toBe('GET /repos/:owner/:repo/compare/:basehead');
    expect(githubRoute('PATCH', `${API}/repos/acme/site/git/refs/heads/feature/x`)).toBe('PATCH /repos/:owner/:repo/git/refs/heads/:ref');
    expect(githubRoute('GET', `${API}/repos/acme/site/branches/feature/x/protection`)).toBe('GET /repos/:owner/:repo/branches/:branch');
    expect(githubRoute('POST', `${API}/app/installations/123/access_tokens`)).toBe('POST /app/installations/:id/access_tokens');
    expect(githubRoute('GET', `${API}/users/octocat/installation`)).toBe('GET /users/:login/installation');
    expect(githubRoute('POST', `${API}/graphql`)).toBe('POST /graphql');
    expect(githubRoute('GET', 'https://ghe.example/api/v3/repos/a/b/pulls')).toBe('GET /repos/:owner/:repo/pulls');
  });
});

describe('observeGithubRateLimits', () => {
  it('reports the tightest budget the operation saw', async () => {
    let remaining = 4000;
    const server = github({ remaining: () => remaining });
    const send = githubFetch(server.fetcher);
    const { value, tightest } = await observeGithubRateLimits(async () => {
      await send(`${API}/repos/acme/site`, { headers: { authorization: 'Bearer t' } });
      remaining = 120;
      await send(`${API}/repos/acme/site/pulls/1`, { headers: { authorization: 'Bearer t' } });
      remaining = 3000;
      await send(`${API}/repos/acme/site/pulls/2`, { headers: { authorization: 'Bearer t' } });
      return 'done';
    });
    expect(value).toBe('done');
    expect(tightest).toEqual({ resource: 'core', limit: 5000, remaining: 120, resetAt: 1_800_000_000_000 });
    expect((await observeGithubRateLimits(async () => 1)).tightest).toBeUndefined();
  });
});
