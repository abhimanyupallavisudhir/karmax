import { describe, expect, it } from 'vitest';
import { GithubActionsApi, redactActionsText } from '../src/integrations/github-actions.js';

const run = { id: 42, run_attempt: 1, event: 'workflow_run', head_sha: 'workflow-sha',
  repository: { full_name: 'acme/app' }, check_suite_id: 9, conclusion: 'success',
  referenced_workflows: [{ path: 'acme/app/.github/workflows/helper.yml@main', sha: 'helper-sha' }] };
const job = { id: 99, run_id: 42, run_attempt: 1, head_sha: 'workflow-sha', status: 'completed',
  conclusion: 'success', check_run_url: 'https://api.github.com/repos/acme/app/check-runs/77',
  steps: [{ number: 1, name: 'Deploy', status: 'completed', conclusion: 'success',
    started_at: '2026-09-11T00:00:00Z', completed_at: '2026-09-11T00:02:00Z' }] };
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const routes: Record<string, unknown> = {
    '/repos/acme/app/actions/runs/42': run,
    '/repos/acme/app/actions/runs/42/attempts/1': run,
    '/repos/acme/app/actions/jobs/99': job,
    '/repos/acme/app/actions/jobs/99/logs': 'Ready at target-sha\nUpdate complete at target-sha\n',
    ...overrides,
  };
  const api = new GithubActionsApi('installation-secret', { fetch: (async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    const value = routes[url.href] ?? routes[url.pathname];
    if (typeof value === 'function') return value();
    if (value instanceof Response) return value;
    if (typeof value === 'string') return new Response(value);
    if (value !== undefined) return Response.json(value);
    return new Response('not found secret', { status: 404 });
  }) as typeof fetch });
  return { api, calls };
}

describe('targeted Actions inspection', () => {
  it.each(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral'])('reads %s job evidence with explicit attempt ownership', async (conclusion) => {
    const { api, calls } = fixture({ '/repos/acme/app/actions/jobs/99': { ...job, conclusion } });
    const result: any = await api.inspectRun('acme/app', 42, { view: 'log', jobId: 99, attempt: 1 });
    expect(result).toMatchObject({ run: { headSha: 'workflow-sha', event: 'workflow_run' },
      job: { attempt: 1, runId: 42, conclusion, steps: [{ number: 1, startedAt: '2026-09-11T00:00:00Z' }] },
      log: { excerpt: expect.stringContaining('Update complete at target-sha'), tailComplete: true } });
    expect(result.notices.join(' ')).toContain('not proof of deployed code');
    expect(result.run.referencedWorkflows[0].sha).toBe('helper-sha');
    expect(calls[0]!.url.pathname).toContain('/attempts/1');
  });

  it.each([{ run_id: 43 }, { run_attempt: 2 }, { id: 100 }])('rejects foreign job selection %j before log access', async (change) => {
    const { api, calls } = fixture({ '/repos/acme/app/actions/jobs/99': { ...job, ...change } });
    await expect(api.inspectRun('acme/app', 42, { view: 'log', jobId: 99, attempt: 1 })).rejects.toThrow('Job does not belong');
    expect(calls.some(({ url }) => url.pathname.endsWith('/logs'))).toBe(false);
  });

  it.each([{ id: 43 }, { repository: { full_name: 'acme/other' } }, { run_attempt: 2 }])('rejects mismatched run selection %j', async (change) => {
    const { api } = fixture({ '/repos/acme/app/actions/runs/42/attempts/1': { ...run, ...change } });
    await expect(api.inspectRun('acme/app', 42, { view: 'jobs', attempt: 1 })).rejects.toThrow(/Run/);
  });

  it('paginates attempt jobs, artifacts and workflows without implicit extra pages', async () => {
    const { api, calls } = fixture({
      '/repos/acme/app/actions/runs/42/attempts/1/jobs': { total_count: 5, jobs: [job] },
      '/repos/acme/app/actions/runs/42/artifacts': { total_count: 5, artifacts: [{ id: 4, name: 'report', size_in_bytes: 10,
        expired: true, archive_download_url: 'https://secret?sig=credential' }] },
      '/repos/acme/app/actions/workflows': { total_count: 5, workflows: [{ id: 7, path: '.github/workflows/deploy.yml', state: 'active' }] },
    });
    for (const view of ['jobs', 'artifacts'] as const) {
      const result: any = await api.inspectRun('acme/app', 42, { view, page: 2, perPage: 2 });
      expect(result).toMatchObject({ total: 5, page: 2, perPage: 2, hasMore: true, nextPage: 3 });
      expect(JSON.stringify(result)).not.toContain('credential');
    }
    expect(await api.listWorkflows('acme/app', { page: 3, perPage: 2 })).toMatchObject({ nextPage: null, hasMore: false });
    expect(calls.filter(({ url }) => url.pathname.endsWith('/jobs'))).toHaveLength(1);
    expect(calls.find(({ url }) => url.pathname.endsWith('/jobs'))!.url.searchParams.get('page')).toBe('2');
  });

  it('retains completion after more than 8 MiB, caps prompt output, and pages backward', async () => {
    const { api } = fixture({ '/repos/acme/app/actions/jobs/99/logs':
      'noise\n'.repeat(1500000) + 'target=abc\nreadiness succeeded\nUpdate complete at abc\n' });
    const result: any = await api.inspectRun('acme/app', 42, { view: 'log', jobId: 99, tailLines: 2, maxChars: 256 });
    expect(result.log).toMatchObject({ excerpt: 'readiness succeeded\nUpdate complete at abc', truncated: true,
      tailComplete: true, omittedPrefix: true, nextOffsetLines: 2 });
    expect(result.log.retainedBytes).toBeLessThanOrEqual(1024 * 1024);
    const earlier: any = await api.inspectRun('acme/app', 42, { view: 'log', jobId: 99, tailLines: 1, offsetLines: 2 });
    expect(earlier.log.excerpt).toBe('target=abc');
  });

  it('reports incomplete tail and cancels a stream at the scan cap', async () => {
    let cancelled = false;
    const { api } = fixture({ '/repos/acme/app/actions/jobs/99/logs': () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(120)); },
      cancel() { cancelled = true; },
    })) });
    const result: any = await api.inspectRun('acme/app', 42, { view: 'log', jobId: 99, maxChars: 256 });
    expect(result.log).toMatchObject({ downloadTruncated: true, tailComplete: false, downloadedBytes: 64 * 1024 * 1024 });
    expect(result.log.excerpt).toHaveLength(256);
    expect(cancelled).toBe(true);
  });

  it('reads scoped check diagnostics with pagination and bounded annotation text', async () => {
    const { api } = fixture({
      '/repos/acme/app/check-runs/77': { id: 77, check_suite: { id: 9 }, output: { annotations_count: 3, summary: 's'.repeat(5000) } },
      '/repos/acme/app/check-runs/77/annotations': [{ path: 'test.ts', start_line: 3, annotation_level: 'failure', message: 'ghp_secret123' }],
    });
    const result: any = await api.inspectRun('acme/app', 42, { view: 'annotations', jobId: 99, perPage: 1 });
    expect(result.nextPage).toBe(2);
    expect(result.check.summary).toHaveLength(2000);
    expect(result.annotations[0]).toMatchObject({ startLine: 3, message: '[REDACTED]' });
    const bad = fixture({ '/repos/acme/app/check-runs/77': { check_suite: { id: 10 } } });
    await expect(bad.api.inspectRun('acme/app', 42, { view: 'annotations', jobId: 99 })).rejects.toThrow('Check does not belong');
  });

  it('reads current pending protections without invoking any mutation', async () => {
    const { api, calls } = fixture({ '/repos/acme/app/actions/runs/42/pending_deployments': [{
      environment: { id: 1, name: 'production' }, wait_timer: 10, current_user_can_approve: true,
      reviewers: [{ type: 'Team', reviewer: { id: 8, name: 'operations' } }],
    }] });
    expect(await api.inspectRun('acme/app', 42, { view: 'pending-deployments' })).toMatchObject({
      scope: 'current run state (not historical attempt)', pendingDeployments: [{ environment: { name: 'production' }, waitTimer: 10 }],
    });
    expect(calls.every(({ init }) => !init.method || init.method === 'GET')).toBe(true);
  });

  it('keeps auth off every storage redirect and redacts printed secrets', async () => {
    const first = 'https://results.blob.core.windows.net/log?sig=secret1';
    const second = 'https://results.blob.core.windows.net/final?sig=secret2';
    const { api, calls } = fixture({
      '/repos/acme/app/actions/jobs/99/logs': new Response(null, { status: 302, headers: { location: first } }),
      [first]: new Response(null, { status: 302, headers: { location: second } }),
      [second]: `installation-secret\nghp_secret\n${second}\nUpdate complete at abc`,
    });
    const result = await api.inspectRun('acme/app', 42, { view: 'log', jobId: 99 });
    expect(JSON.stringify(result)).not.toMatch(/installation-secret|ghp_secret|secret2/);
    for (const call of calls.filter(({ url }) => url.hostname.endsWith('.windows.net'))) {
      expect(call.init.headers).toBeUndefined();
      expect(call.init.redirect).toBe('manual');
    }
    expect(redactActionsText('Authorization: Bearer secret')).toBe('Authorization: Bearer [REDACTED]');
  });

  it.each(['https://127.0.0.1/a', 'http://results.blob.core.windows.net/a', 'https://evil.test/a',
    'https://user:secret@results.blob.core.windows.net/a', 'https://results.blob.core.windows.net:444/a'])('refuses unsafe redirect %s', async (location) => {
    const { api, calls } = fixture({ '/repos/acme/app/actions/jobs/99/logs': new Response(null, { status: 302, headers: { location } }) });
    await expect(api.inspectRun('acme/app', 42, { view: 'log', jobId: 99 })).rejects.toThrow(/GitHub returned/);
    expect(calls).toHaveLength(3);
  });

  it('sanitizes malformed locations, network errors, invalid JSON and redirect loops', async () => {
    for (const response of [
      new Response(null, { status: 302 }),
      new Response(null, { status: 302, headers: { location: 'https://[invalid?sig=secret' } }),
    ]) {
      const { api } = fixture({ '/repos/acme/app/actions/jobs/99/logs': response });
      const error = await api.inspectRun('acme/app', 42, { view: 'log', jobId: 99 }).catch((e) => e);
      expect(error.status).toBe(502);
      expect(error.message).not.toContain('secret');
    }
    const storage = 'https://results.blob.core.windows.net/log?sig=secret';
    const loop = fixture({
      '/repos/acme/app/actions/jobs/99/logs': new Response(null, { status: 302, headers: { location: storage } }),
      [storage]: () => new Response(null, { status: 302, headers: { location: storage } }),
    });
    await expect(loop.api.inspectRun('acme/app', 42, { view: 'log', jobId: 99 })).rejects.toThrow('too many times');
    expect(loop.calls.filter(({ url }) => url.href === storage)).toHaveLength(4);
    const network = fixture({
      '/repos/acme/app/actions/jobs/99/logs': new Response(null, { status: 302, headers: { location: storage } }),
      [storage]: () => { throw new Error(storage); },
    });
    await expect(network.api.inspectRun('acme/app', 42, { view: 'log', jobId: 99 })).rejects.toThrow('GitHub log storage request failed');
    const invalid = fixture({ '/repos/acme/app/actions/runs/42': 'invalid JSON secret' });
    await expect(invalid.api.inspectRun('acme/app', 42, { view: 'jobs' })).rejects.toThrow('GitHub Actions returned an invalid response');
  });

  it.each(['Skipped superseded update', 'Rolling back to previous-sha'])('preserves %s evidence without declaring deployed code', async (evidence) => {
    const { api } = fixture({ '/repos/acme/app/actions/jobs/99/logs': evidence });
    const result: any = await api.inspectRun('acme/app', 42, { view: 'log', jobId: 99 });
    expect(result.log.excerpt).toBe(evidence);
    expect(result).not.toHaveProperty('deployedSha');
    expect(result.run).not.toHaveProperty('deployedSha');
  });

  it.each([403, 404, 410, 429, 500])('returns sanitized provider status %s for unavailable logs', async (status) => {
    const { api } = fixture({ '/repos/acme/app/actions/jobs/99/logs': new Response('https://private?sig=secret', { status }) });
    await expect(api.inspectRun('acme/app', 42, { view: 'log', jobId: 99 })).rejects.toMatchObject({ status,
      message: `GitHub job log download failed (${status})` });
  });

  it('does not follow authenticated API redirects or reveal response bodies', async () => {
    const { api, calls } = fixture({ '/repos/acme/app/actions/runs/42': new Response('credential', {
      status: 302, headers: { location: 'https://evil.test?sig=secret' },
    }) });
    await expect(api.inspectRun('acme/app', 42, { view: 'jobs' })).rejects.toMatchObject({ status: 302,
      message: 'GitHub Actions API request failed (302)' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it.each([{ attempt: 0 }, { jobId: -1, view: 'log' }, { page: 0 }, { perPage: 101 }, { view: 'unknown' },
    { view: 'log', jobId: 99, maxChars: 32001 }, { view: 'log', jobId: 99, tailLines: 501 }])('rejects invalid selection %j', async (options) => {
    const { api } = fixture();
    await expect(api.inspectRun('acme/app', 42, { view: 'jobs', ...options } as any)).rejects.toThrow();
  });
});
