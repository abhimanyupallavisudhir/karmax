import { describe, expect, it } from 'vitest';
import {
  GithubActionsApi,
  GithubActionsApiError,
  actionLogExcerpt,
  assessGithubActionsFailure,
  classifyGithubActionsFailure,
  classifyGithubActionsDiagnostic,
  githubActionsFailureEvidenceKey,
  githubCheckEvidenceKey,
  githubActionsRunIdFromUrl,
  renderGithubActionsFailure,
  type GithubActionsFailureInspection,
} from '../src/integrations/github-actions.js';

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 42, name: 'Deploy', display_title: 'Deploy main', workflow_id: 7,
  run_number: 11, run_attempt: 2, event: 'push', status: 'completed', conclusion: 'failure',
  head_branch: 'main', head_sha: 'abc123', html_url: 'https://github.test/acme/app/actions/runs/42',
  created_at: '2026-08-09T00:00:00Z', updated_at: '2026-08-09T00:01:00Z',
  actor: { login: 'alice' }, triggering_actor: { login: 'bob' }, ...overrides,
});

describe('GitHub Actions API', () => {
  const inspection = (log: string, overrides: Partial<GithubActionsFailureInspection['run']> = {}): GithubActionsFailureInspection => ({
    run: {
      id: 42, name: 'CI', workflowId: 7, runNumber: 11, attempt: 1, event: 'pull_request',
      status: 'completed', conclusion: 'failure', branch: 'karmax/task', headSha: 'abc123',
      url: 'https://github.test/acme/app/actions/runs/42', createdAt: '', updatedAt: '', ...overrides,
    },
    jobs: [],
    failedJobs: [{ id: 99, name: 'test', status: 'completed', conclusion: 'failure', url: 'https://github.test/jobs/99',
      steps: [{ number: 1, name: 'Run tests', status: 'completed', conclusion: 'failure' }],
      log: { excerpt: log, downloadedBytes: log.length, truncated: false } }],
    artifacts: [], notices: [],
  });

  it('classifies code, transient, account/configuration, and post-merge failures by owner', () => {
    expect(classifyGithubActionsFailure(inspection('AssertionError: expected 2 to equal 3')).disposition).toBe('revision');
    expect(classifyGithubActionsFailure(inspection('The hosted runner lost communication with the server')).disposition).toBe('retry');
    expect(classifyGithubActionsFailure(inspection('The job was not started because recent account payments have failed or your spending limit needs to be increased')).disposition).toBe('human');
    expect(classifyGithubActionsDiagnostic('Workflow did not start because your spending limit needs to be increased')).toBe('human');
    expect(classifyGithubActionsDiagnostic('AssertionError: expected 2 to equal 3')).toBeUndefined();
    const deployment = classifyGithubActionsFailure(inspection('backup contains a symbolic link', {
      name: 'Deploy', event: 'workflow_run', branch: 'master',
    }), { postMerge: true });
    expect(deployment.disposition).toBe('deployment');
    expect(renderGithubActionsFailure(deployment)).toContain('backup contains a symbolic link');
    expect(githubActionsRunIdFromUrl('https://github.com/acme/app/actions/runs/123/job/456')).toBe(123);
    expect(githubActionsRunIdFromUrl('https://github.com/acme/app/pull/1')).toBeUndefined();
  });

  it('requires affirmative job evidence before assigning a failure to the proposal', () => {
    const aggregateOnly = inspection('', { conclusion: 'failure' });
    aggregateOnly.failedJobs = [];
    aggregateOnly.jobs = [];
    expect(assessGithubActionsFailure(aggregateOnly)).toMatchObject({
      kind: 'unknown',
      reason: expect.stringMatching(/without enough job-level evidence/i),
    });

    expect(assessGithubActionsFailure(inspection('AssertionError: expected 2 to equal 3'))).toMatchObject({
      kind: 'proposal-defect',
      evidenceKey: expect.stringMatching(/^github-actions:/),
    });
    expect(assessGithubActionsFailure(inspection('cancelled before execution', {
      conclusion: 'cancelled',
    }))).toMatchObject({ kind: 'provider-interruption' });
  });

  it('fingerprints immutable evidence rather than permission-sensitive diagnostic enrichment', () => {
    const first = inspection('short output');
    const enriched = inspection('much more detailed output that arrived later');
    expect(githubActionsFailureEvidenceKey(first)).toBe(githubActionsFailureEvidenceKey(enriched));

    const summary = {
      slug: 'Acme/App', number: 42, headSha: 'abc123',
      checks: [{ name: 'test', state: 'CANCELLED', url: 'https://github.test/actions/runs/7/job/8' }],
    };
    const enrichedSummary = {
      ...summary,
      checks: [{ ...summary.checks[0]!, detail: 'new annotation' }],
    };
    expect(githubCheckEvidenceKey(summary)).toBe(githubCheckEvidenceKey(enrichedSummary));
  });

  it('lists normalized runs with bounded provider filters', async () => {
    let requested = '';
    const api = new GithubActionsApi('installation-token', { apiBase: 'https://api.github.test',
      fetch: (async (input, init) => {
        requested = String(input);
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer installation-token');
        return Response.json({ total_count: 1, workflow_runs: [run()] });
      }) as typeof fetch });

    await expect(api.listRuns('acme/app', {
      branch: 'main', status: 'failure', workflow: 'deploy.yml', page: 2, perPage: 10,
    })).resolves.toEqual({ total: 1, page: 2, perPage: 10, runs: [expect.objectContaining({
      id: 42, name: 'Deploy', displayTitle: 'Deploy main', attempt: 2, conclusion: 'failure',
      branch: 'main', actor: 'alice', triggeringActor: 'bob',
    })] });
    const url = new URL(requested);
    expect(url.pathname).toBe('/repos/acme/app/actions/workflows/deploy.yml/runs');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ branch: 'main', status: 'failure', page: '2', per_page: '10' });
    await expect(api.listRuns('acme/app', { status: 'made-up' as any })).rejects.toThrow('invalid GitHub Actions status');
  });

  it('inspects failed jobs, steps, bounded logs, and artifact metadata without leaking signed URLs or auth', async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const signed = 'https://results.example/log.txt?sig=super-secret';
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, auth: (init.headers as Record<string, string> | undefined)?.authorization });
      const pathname = new URL(url).pathname;
      if (pathname === '/repos/acme/app/actions/runs/42') return Response.json(run());
      if (pathname === '/repos/acme/app/actions/runs/42/jobs') return Response.json({ jobs: [{
        id: 99, name: 'deploy-production', status: 'completed', conclusion: 'failure',
        html_url: 'https://github.test/jobs/99', runner_name: 'hosted',
        steps: [{ number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' },
          { number: 2, name: 'Deploy', status: 'completed', conclusion: 'failure' }],
      }, { id: 100, name: 'lint', status: 'completed', conclusion: 'success', html_url: 'https://github.test/jobs/100' }] });
      if (pathname === '/repos/acme/app/actions/runs/42/artifacts') return Response.json({ artifacts: [{
        id: 5, name: 'deployment-report', size_in_bytes: 1234, expired: false,
        created_at: '2026-08-09T00:00:00Z', expires_at: '2026-08-16T00:00:00Z',
      }] });
      if (pathname === '/repos/acme/app/actions/jobs/99/logs')
        return new Response(null, { status: 302, headers: { location: signed } });
      if (url === signed) return new Response('setup\nDeploying\n##[error]permission denied\nError: process exited 1\n');
      return new Response('not found', { status: 404 });
    };
    const api = new GithubActionsApi('installation-token', { apiBase: 'https://api.github.test', fetch: fakeFetch as typeof fetch });

    const result = await api.inspectFailure('acme/app', 42);
    expect(result).toMatchObject({
      run: { id: 42, conclusion: 'failure' },
      jobs: [{ id: 99, steps: [{ name: 'Checkout' }, { name: 'Deploy', conclusion: 'failure' }] }, { id: 100 }],
      failedJobs: [{ id: 99, log: { downloadedBytes: expect.any(Number), truncated: false } }],
      artifacts: [{ id: 5, name: 'deployment-report', sizeBytes: 1234, expired: false }],
      notices: [],
    });
    expect(result.failedJobs[0]!.log!.excerpt).toContain('permission denied');
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(calls.find((call) => call.url === signed)?.auth).toBeUndefined();
    expect(calls.filter((call) => call.url.startsWith('https://api.github.test')).every((call) => call.auth === 'Bearer installation-token')).toBe(true);
  });

  it('bounds downloaded log bytes and returned diagnostics', async () => {
    const large = `${'ordinary output\n'.repeat(10_000)}##[error]late failure\n`;
    const api = new GithubActionsApi('token', { apiBase: 'https://api.github.test',
      maxLogDownloadBytes: 64 * 1024, maxLogExcerptChars: 4 * 1024, maxJobLogs: 1,
      fetch: (async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith('/runs/42')) return Response.json(run());
        if (pathname.endsWith('/runs/42/jobs')) return Response.json({ jobs: [{ id: 99, name: 'test', status: 'completed', conclusion: 'failure', steps: [] }] });
        if (pathname.endsWith('/runs/42/artifacts')) return Response.json({ artifacts: [] });
        if (pathname.endsWith('/jobs/99/logs')) return new Response(large);
        return new Response('not found', { status: 404 });
      }) as typeof fetch });
    const result = await api.inspectFailure('acme/app', 42);
    expect(result.failedJobs[0]!.log).toMatchObject({ downloadedBytes: 64 * 1024, truncated: true });
    expect(result.failedJobs[0]!.log!.excerpt.length).toBeLessThanOrEqual(4 * 1024 + 50);
  });

  it('refreshes one rejected installation token and supports only the explicit write primitives', async () => {
    const calls: Array<{ path: string; method: string; body?: string; auth?: string }> = [];
    let first = true;
    const api = new GithubActionsApi(async (options) => options?.forceRefresh ? 'fresh' : 'stale', {
      apiBase: 'https://api.github.test', fetch: (async (input, init = {}) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, method: init.method ?? 'GET', body: String(init.body ?? ''),
          auth: (init.headers as Record<string, string>).authorization });
        if (first) { first = false; return new Response('expired', { status: 401 }); }
        return new Response(null, { status: path.endsWith('/dispatches') ? 204 : path.endsWith('/cancel') ? 202 : 201 });
      }) as typeof fetch,
    });

    await expect(api.rerun('acme/app', 42, true)).resolves.toEqual({ accepted: true, action: 'rerun-failed' });
    await expect(api.rerun('acme/app', 42, false)).resolves.toEqual({ accepted: true, action: 'rerun' });
    await expect(api.cancel('acme/app', 42)).resolves.toEqual({ accepted: true, action: 'cancel' });
    await expect(api.dispatch('acme/app', 'deploy.yml', 'main', { environment: 'production', dry_run: false }))
      .resolves.toEqual({ accepted: true, workflow: 'deploy.yml', ref: 'main' });
    expect(calls[1]).toMatchObject({ path: '/repos/acme/app/actions/runs/42/rerun-failed-jobs', auth: 'Bearer fresh' });
    expect(calls.map((call) => call.path)).toEqual(expect.arrayContaining([
      '/repos/acme/app/actions/runs/42/rerun', '/repos/acme/app/actions/runs/42/cancel',
      '/repos/acme/app/actions/workflows/deploy.yml/dispatches',
    ]));
    expect(calls.at(-1)!.body).toBe(JSON.stringify({ ref: 'main', inputs: { environment: 'production', dry_run: 'false' } }));
    await expect(api.dispatch('acme/app', '../workflow', 'main')).rejects.toThrow('workflow must be');
  });

  it('preserves API status classification and extracts useful log context', async () => {
    const api = new GithubActionsApi('token', { fetch: (async () => new Response('forbidden', { status: 403 })) as typeof fetch });
    const error = await api.listRuns('acme/app').catch((value) => value);
    expect(error).toBeInstanceOf(GithubActionsApiError);
    expect(error.status).toBe(403);
    expect(actionLogExcerpt('noise\nbefore\nError: broken\nafter\n')).toContain('before\nError: broken\nafter');
  });

  it('rejects private signed-log redirects before making an unauthenticated SSRF request', async () => {
    const calls: string[] = [];
    const api = new GithubActionsApi('token', { apiBase: 'https://api.github.test', fetch: (async (input) => {
      const url = String(input); calls.push(url);
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/runs/42')) return Response.json(run());
      if (pathname.endsWith('/runs/42/jobs')) return Response.json({ jobs: [{ id: 99, name: 'test', status: 'completed', conclusion: 'failure', steps: [] }] });
      if (pathname.endsWith('/runs/42/artifacts')) return Response.json({ artifacts: [] });
      if (pathname.endsWith('/jobs/99/logs')) return new Response(null, { status: 302,
        headers: { location: 'https://127.0.0.1/private-log' } });
      return new Response('should not be reached');
    }) as typeof fetch });
    const inspected = await api.inspectFailure('acme/app', 42);
    expect(inspected.failedJobs[0]!.log).toBeUndefined();
    expect(inspected.notices[0]).toMatch(/private job-log location/);
    expect(calls).not.toContain('https://127.0.0.1/private-log');
  });
});
