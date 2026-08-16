import { describe, expect, it } from 'vitest';
import {
  GithubActionsApi,
  GithubActionsApiError,
  actionLogExcerpt,
  classifyGithubActionsFailure,
  classifyGithubActionsDiagnostic,
  githubActionsRunIdFromUrl,
  githubRequiredCheckKey,
  reconcileGithubActionsRuns,
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
    expect(classifyGithubActionsFailure(inspection(
      'Canceling since a higher priority waiting request for CI-refs/pull/106/merge exists',
      { conclusion: 'cancelled' },
    )).disposition).toBe('superseded');
    expect(classifyGithubActionsFailure(inspection('The job never started'), {
      providerContext: 'GitHub annotation: Recent account payments failed and the spending limit must be increased',
    })).toMatchObject({ disposition: 'human', waitReason: 'GitHub Actions billing action required' });
    expect(classifyGithubActionsDiagnostic('Workflow did not start because your spending limit needs to be increased')).toBe('human');
    expect(classifyGithubActionsDiagnostic(
      'Canceling since a higher priority waiting request for CI-refs/pull/106/merge exists',
    )).toBe('superseded');
    expect(classifyGithubActionsDiagnostic('AssertionError: expected 2 to equal 3')).toBeUndefined();
    const deployment = classifyGithubActionsFailure(inspection('backup contains a symbolic link', {
      name: 'Deploy', event: 'workflow_run', branch: 'master',
    }), { postMerge: true });
    expect(deployment.disposition).toBe('deployment');
    expect(renderGithubActionsFailure(deployment)).toContain('backup contains a symbolic link');
    expect(githubActionsRunIdFromUrl('https://github.com/acme/app/actions/runs/123/job/456')).toBe(123);
    expect(githubActionsRunIdFromUrl('https://github.com/acme/app/pull/1')).toBeUndefined();
  });

  it('routes CI #410 source-diff keywords to revision because a job log is not provider evidence', () => {
    const vitestDiff = [
      'FAIL tests/web-console-ux.test.ts > reconnects after a dropped socket',
      'AssertionError: expected app.js to contain if (wsHadDropped) { refreshTasks()',
      '- Expected',
      '+ Received',
      '+ const fixtures = {',
      '+ billing: "Payment failed; increase the spending limit or budget",',
      '+ quota: "Quota for Actions minutes exhausted; no included minutes",',
      '+ permissions: "Resource not accessible by integration; not permitted to use this action",',
      '+ approval: "Action required: requires approval; approve and run",',
      '+ runners: "Actions is disabled; workflows are disabled; no hosted runners",',
      '+ prepaid: "Your prepaid balance has been fully consumed"',
      '+ };',
    ].join('\n');

    const decision = classifyGithubActionsFailure(inspection(vitestDiff));
    expect(decision.disposition).toBe('revision');
    expect(renderGithubActionsFailure(decision)).toContain('tests/web-console-ux.test.ts');
  });

  it('routes only direct provider evidence and action_required to a human', () => {
    const annotation = classifyGithubActionsFailure(inspection('AssertionError: ordinary test failure'), {
      providerContext: 'GitHub check annotation: Actions is disabled for this repository',
    });
    expect(annotation).toMatchObject({
      disposition: 'human',
      waitReason: 'GitHub Actions is disabled',
      providerEvidence: expect.stringContaining('Actions is disabled'),
    });
    expect(renderGithubActionsFailure(annotation)).toContain('Provider evidence:');

    expect(classifyGithubActionsFailure(inspection('', {
      conclusion: 'action_required',
    }))).toMatchObject({
      disposition: 'human',
      waitReason: 'GitHub Actions approval required',
    });
  });

  it('classifies GitHub concurrency preemption as superseded in inspected and fallback diagnostics', () => {
    const message = 'Canceling since a higher priority waiting request for CI-refs/pull/113/merge exists.';
    const decision = classifyGithubActionsFailure(inspection(message, { conclusion: 'cancelled' }));
    expect(decision).toMatchObject({
      disposition: 'superseded',
      reason: expect.stringMatching(/newer or higher-priority run.*wait/i),
    });
    expect(classifyGithubActionsDiagnostic(message)).toBe('superseded');
    expect(classifyGithubActionsDiagnostic('Pull request check\n- CI: CANCELLED')).toBe('retry');
  });

  it('does not route a cancelled run from billing/quota fixture text printed by tests', () => {
    const fixture = [
      "expected classification fixture: You're out of usage credits",
      'Your prepaid balance has now been fully consumed.',
      'all negative-path classifier assertions passed',
      'The operation was canceled.',
    ].join('\n');
    expect(classifyGithubActionsFailure(inspection(fixture, {
      conclusion: 'cancelled', status: 'completed',
    })).disposition).toBe('retry');
    // Direct GitHub check evidence still routes a genuine provider/account
    // block accurately even when the execution itself was cancelled.
    expect(classifyGithubActionsFailure(inspection('The operation was canceled.', {
      conclusion: 'cancelled', status: 'completed',
    }), { providerContext: 'GitHub annotation: Actions is disabled for this repository' }).disposition).toBe('human');
  });

  it('reconciles duplicate run observations by canonical exact-head validation identity', () => {
    const identity = { repository: 'Acme/App', pullRequest: 118, headSha: 'c19ce3c', workflowId: 7, check: 'CI' };
    const cancelled = inspection('The operation was canceled.', {
      id: 365, workflowId: 7, runNumber: 365, attempt: 1, conclusion: 'cancelled',
      headSha: 'synthetic-merge-1',
      pullRequests: [{ number: 118, headSha: 'c19ce3c' }],
    }).run;
    const active = { ...cancelled, id: 366, runNumber: 366, status: 'in_progress', conclusion: undefined,
      headSha: 'synthetic-merge-2' };
    const key = githubRequiredCheckKey(identity);
    expect(key).toBe('acme/app#118:c19ce3c:workflow:7:check:ci');
    expect(reconcileGithubActionsRuns(identity, cancelled, [cancelled, active])).toMatchObject({
      key, current: { id: 366, attempt: 1 }, replacement: { id: 366 },
    });
    expect(reconcileGithubActionsRuns(identity, cancelled, [cancelled, active]).successful).toBeUndefined();

    const successful = { ...active, status: 'completed', conclusion: 'success' };
    expect(reconcileGithubActionsRuns(identity, cancelled, [cancelled, successful])).toMatchObject({
      current: { id: 366 }, replacement: { id: 366 }, successful: { id: 366 },
    });
    const laterFailure = { ...successful, id: 368, runNumber: 368, conclusion: 'failure' };
    const failedCurrent = reconcileGithubActionsRuns(identity, cancelled, [successful, laterFailure]);
    expect(failedCurrent).toMatchObject({ current: { id: 368 }, replacement: { id: 368 } });
    expect(failedCurrent.successful).toBeUndefined();
    const duplicateCancelled = { ...cancelled, id: 366, runNumber: 366,
      updatedAt: '2026-08-14T00:03:00Z' };
    const survivingRerun = { ...cancelled, id: 365, runNumber: 365, attempt: 2,
      status: 'completed', conclusion: 'success', updatedAt: '2026-08-14T00:15:00Z' };
    expect(reconcileGithubActionsRuns(identity, duplicateCancelled,
      [duplicateCancelled, survivingRerun])).toMatchObject({
      current: { id: 365, attempt: 2 }, successful: { id: 365, attempt: 2 },
    });
    // A run for another revision or workflow never becomes a replacement.
    const foreign = { ...active, id: 367, workflowId: 8,
      pullRequests: [{ number: 118, headSha: 'different-head' }] };
    expect(reconcileGithubActionsRuns(identity, cancelled, [foreign]).current.id).toBe(365);
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
