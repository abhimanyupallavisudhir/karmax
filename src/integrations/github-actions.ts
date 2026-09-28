/**
 * GitHub Actions inspection and narrowly-scoped mutations.
 *
 * The API object receives a short-lived token provider from GitHubAppService;
 * callers never receive the token itself. Log downloads follow GitHub's signed
 * redirect without forwarding Authorization and are size/output bounded before
 * they can enter an agent conversation.
 */
import net from 'node:net';
import { BRAND } from '../domain/brand.js';

export type GithubActionsStatus =
  | 'completed' | 'action_required' | 'cancelled' | 'failure' | 'neutral'
  | 'skipped' | 'stale' | 'success' | 'timed_out' | 'in_progress' | 'queued'
  | 'requested' | 'waiting' | 'pending';

export interface GithubActionsRun {
  id: number;
  name: string;
  path?: string;
  checkSuiteId?: number;
  referencedWorkflows?: Array<{ path: string; sha: string; ref?: string }>;
  displayTitle?: string;
  workflowId: number;
  runNumber: number;
  attempt: number;
  event: string;
  status: string;
  conclusion?: string;
  branch?: string;
  headSha: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  actor?: string;
  triggeringActor?: string;
  /** Pull-request heads attached by GitHub to this run. `headSha` is the
   * workflow execution SHA (often a synthetic merge ref for pull_request), so
   * this is the authoritative exact proposal revision when it is present. */
  pullRequests?: Array<{ number: number; headSha: string; headRef?: string }>;
}

/** Durable identity of one required-check validation. Runs and attempts are
 * observations of this identity, not part of it: GitHub may create or rerun
 * several equivalent executions for one exact proposal revision. */
export interface GithubRequiredCheckIdentity {
  repository: string;
  pullRequest: number;
  headSha: string;
  workflowId: number;
  check: string;
}

export interface GithubActionsRunReconciliation {
  identity: GithubRequiredCheckIdentity;
  key: string;
  runs: GithubActionsRun[];
  current: GithubActionsRun;
  replacement?: GithubActionsRun;
  successful?: GithubActionsRun;
}

export interface GithubActionsStep {
  number: number;
  name: string;
  status: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface GithubActionsJob {
  id: number;
  runId?: number;
  attempt?: number;
  headSha?: string;
  checkRunId?: number;
  name: string;
  status: string;
  conclusion?: string;
  runner?: string;
  url: string;
  startedAt?: string;
  completedAt?: string;
  steps: GithubActionsStep[];
}

export interface GithubActionsArtifact {
  id: number;
  name: string;
  sizeBytes: number;
  expired: boolean;
  digest?: string;
  workflowRun?: { id: number; headSha: string; headBranch?: string };
  expiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GithubActionsFailureInspection {
  run: GithubActionsRun;
  jobs: GithubActionsJob[];
  failedJobs: Array<GithubActionsJob & {
    log?: { excerpt: string; downloadedBytes: number; truncated: boolean };
  }>;
  artifacts: GithubActionsArtifact[];
  notices: string[];
}

export type GithubActionsFailureDisposition = 'revision' | 'retry' | 'superseded' | 'human' | 'deployment';

export interface GithubActionsFailureDecision {
  disposition: GithubActionsFailureDisposition;
  reason: string;
  /** Bounded UI copy for a direct provider-owned hold. Full evidence remains in
   * the rendered inspection and must not be squeezed into this label. */
  waitReason?: string;
  /** Check output retained for diagnosis, never used as ownership evidence. */
  checkDiagnostics?: string;
  inspection: GithubActionsFailureInspection;
}

export type GithubActionsTokenProvider =
  (options?: { forceRefresh?: boolean }) => Promise<string>;

export interface GithubActionsApiOptions {
  apiBase?: string;
  fetch?: typeof fetch;
  /** Maximum bytes fetched from any one job log. */
  maxLogDownloadBytes?: number;
  /** Maximum characters returned from any one job log. */
  maxLogExcerptChars?: number;
  /** Maximum failing job logs fetched for one inspection. */
  maxJobLogs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Views keep large evidence opt-in. Default retains legacy failure diagnostics. */
export interface GithubActionsInspectOptions {
  view?: 'failure' | 'jobs' | 'log' | 'artifacts' | 'annotations' | 'pending-deployments';
  attempt?: number;
  jobId?: number;
  page?: number;
  perPage?: number;
  tailLines?: number;
  offsetLines?: number;
  maxChars?: number;
}

export class GithubActionsApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GithubActionsApiError';
  }
}

const FAILURE_CONCLUSIONS = new Set([
  'action_required', 'cancelled', 'failure', 'stale', 'startup_failure', 'timed_out',
]);
const ACTIONS_STATUSES = new Set<GithubActionsStatus>([
  'completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success',
  'timed_out', 'in_progress', 'queued', 'requested', 'waiting', 'pending',
]);
const DEFAULT_MAX_LOG_DOWNLOAD = 8 * 1024 * 1024;
const DEFAULT_MAX_LOG_EXCERPT = 64 * 1024;
const DEFAULT_MAX_JOB_LOGS = 8;
const MAX_JOB_PAGES = 10;
export class GithubActionsApi {
  private fetcher: typeof fetch;
  private apiBase: string;
  private maxLogDownloadBytes: number;
  private maxLogExcerptChars: number;
  private maxJobLogs: number;
  private seenTokens = new Set<string>();
  private sleep: (ms: number) => Promise<void>;

  constructor(private token: string | GithubActionsTokenProvider, options: GithubActionsApiOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.maxLogDownloadBytes = positiveBound(options.maxLogDownloadBytes, DEFAULT_MAX_LOG_DOWNLOAD, 64 * 1024, 64 * 1024 * 1024);
    this.maxLogExcerptChars = positiveBound(options.maxLogExcerptChars, DEFAULT_MAX_LOG_EXCERPT, 4 * 1024, 256 * 1024);
    this.maxJobLogs = positiveBound(options.maxJobLogs, DEFAULT_MAX_JOB_LOGS, 1, 20);
  }

  async listRuns(slug: string, options: {
    branch?: string;
    event?: string;
    status?: GithubActionsStatus;
    workflow?: string | number;
    page?: number;
    perPage?: number;
  } = {}): Promise<{ total: number; page: number; perPage: number; runs: GithubActionsRun[] }> {
    validateSlug(slug);
    const page = positiveBound(options.page, 1, 1, 1_000);
    const perPage = positiveBound(options.perPage, 30, 1, 100);
    const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (options.branch?.trim()) query.set('branch', boundedFilter(options.branch, 'branch'));
    if (options.event?.trim()) query.set('event', boundedFilter(options.event, 'event'));
    if (options.status) {
      if (!ACTIONS_STATUSES.has(options.status)) throw new Error(`invalid GitHub Actions status: ${options.status}`);
      query.set('status', options.status);
    }
    const endpoint = options.workflow === undefined
      ? `/repos/${slug}/actions/runs`
      : `/repos/${slug}/actions/workflows/${workflowId(options.workflow)}/runs`;
    const value = await this.request<any>(`${endpoint}?${query}`);
    const runs = Array.isArray(value?.workflow_runs) ? value.workflow_runs.map(normalizeRun) : [];
    return { total: Number(value?.total_count ?? runs.length), page, perPage, runs };
  }

  async listWorkflows(slug: string, options: { page?: number; perPage?: number } = {}) {
    validateSlug(slug);
    const page = positiveBound(options.page, 1, 1, 1000);
    const perPage = positiveBound(options.perPage, 30, 1, 100);
    const raw = await this.request<any>(`/repos/${slug}/actions/workflows?per_page=${perPage}&page=${page}`);
    const workflows = (raw.workflows ?? []).map((w: any) => ({
      id: w.id, name: w.name, path: w.path, state: w.state, url: w.html_url,
      createdAt: w.created_at, updatedAt: w.updated_at,
    }));
    return { ...pagination(raw.total_count, page, perPage), workflows };
  }

  async inspectRun(slug: string, runId: number, options: GithubActionsInspectOptions = {}) {
    validateSlug(slug);
    const id = positiveId(runId, 'run id');
    const view = options.view ?? 'failure';
    if (!['failure', 'jobs', 'log', 'artifacts', 'annotations', 'pending-deployments'].includes(view))
      throw new Error('invalid GitHub Actions inspection view');
    if (view === 'failure' && Object.values(options).every((v) => v === undefined || v === 'failure'))
      return this.inspectFailure(slug, id);
    if (view === 'failure') throw new Error('Use view jobs or log for attempt and pagination selection');
    const attempt = options.attempt === undefined ? undefined : positiveId(options.attempt, 'attempt');
    const page = positiveBound(options.page, 1, 1, 1000);
    const perPage = positiveBound(options.perPage, 30, 1, 100);
    const base = `/repos/${slug}/actions/runs/${id}`;
    const rawRun = await this.request<any>(`${base}${attempt ? `/attempts/${attempt}` : ''}`);
    if (Number(rawRun.id) !== id || (rawRun.repository?.full_name
      && String(rawRun.repository.full_name).toLowerCase() !== slug.toLowerCase()))
      throw new GithubActionsApiError(404, 'Run does not belong to the selected repository');
    const run = normalizeRun(rawRun);
    if (attempt !== undefined && run.attempt !== attempt)
      throw new GithubActionsApiError(404, 'Run attempt does not match the selection');
    const notices = [
      'headSha is GitHub run metadata, not proof of deployed code. For workflow_run, correlate triggering revision with explicit checkout/target and completion logs. Success or skipped status alone does not prove readiness, completion, or absence of rollback.',
    ];
    const common = { run, notices };
    if (view === 'jobs') {
      const raw = await this.request<any>(`${base}/attempts/${run.attempt}/jobs?per_page=${perPage}&page=${page}`);
      const jobs: GithubActionsJob[] = (raw.jobs ?? []).map(normalizeJob);
      if (jobs.some((job) => job.runId !== id || job.attempt !== run.attempt))
        throw new GithubActionsApiError(404, 'Job listing does not match the selected run and attempt');
      return { ...common, ...pagination(raw.total_count, page, perPage), jobs };
    }
    if (view === 'artifacts') {
      const raw = await this.request<any>(`${base}/artifacts?per_page=${perPage}&page=${page}`);
      return { ...common, scope: 'run (artifacts are not attempt-scoped)',
        ...pagination(raw.total_count, page, perPage), artifacts: (raw.artifacts ?? []).map(normalizeArtifact) };
    }
    if (view === 'pending-deployments') {
      const raw = await this.request<any[]>(`${base}/pending_deployments`);
      return { ...common, scope: 'current run state (not historical attempt)', pendingDeployments: raw.map((d) => ({
        environment: { id: d.environment?.id, name: d.environment?.name },
        waitTimer: d.wait_timer, waitTimerStartedAt: d.wait_timer_started_at,
        currentUserCanApprove: d.current_user_can_approve,
        reviewers: (d.reviewers ?? []).map((r: any) => ({ type: r.type,
          name: r.reviewer?.login ?? r.reviewer?.name, id: r.reviewer?.id })),
      })) };
    }
    const jobId = positiveId(options.jobId!, 'job id');
    const rawJob = await this.request<any>(`/repos/${slug}/actions/jobs/${jobId}`);
    if (Number(rawJob.id) !== jobId || Number(rawJob.run_id) !== id || Number(rawJob.run_attempt) !== run.attempt)
      throw new GithubActionsApiError(404, 'Job does not belong to the selected run and attempt');
    const job = normalizeJob(rawJob);
    if (view === 'annotations') {
      if (!job.checkRunId) throw new GithubActionsApiError(404, 'Job has no check run');
      const check = await this.request<any>(`/repos/${slug}/check-runs/${job.checkRunId}`);
      if (Number(check.id) !== job.checkRunId || Number(check.check_suite?.id) !== run.checkSuiteId)
        throw new GithubActionsApiError(404, 'Check does not belong to the selected run');
      const raw = await this.request<any[]>(`/repos/${slug}/check-runs/${job.checkRunId}/annotations?per_page=${perPage}&page=${page}`);
      let textBudget = 24000;
      let textTruncated = false;
      const bounded = (v: unknown) => {
        const clean = redactActionsText(String(v ?? ''));
        const result = clean.slice(0, Math.min(2000, textBudget));
        textBudget -= result.length;
        textTruncated ||= result.length < clean.length;
        return result;
      };
      const diagnostics = { ...common, job, ...pagination(check.output?.annotations_count, page, perPage),
        check: { id: check.id, status: check.status, conclusion: check.conclusion,
          title: bounded(check.output?.title), summary: bounded(check.output?.summary) },
        annotations: raw.map((a) => ({ path: bounded(a.path), startLine: a.start_line, endLine: a.end_line,
          level: a.annotation_level, title: bounded(a.title), message: bounded(a.message) })) };
      return { ...diagnostics, textTruncated, textLimit: 24000, fieldTextLimit: 2000 };
    }
    const tailLines = positiveBound(options.tailLines, 100, 1, 500);
    const maxChars = positiveBound(options.maxChars, 16000, 256, 32000);
    const offsetLines = positiveBound(options.offsetLines, 0, 0, 1000000);
    const log = await this.jobLog(slug, jobId, { tailLines, maxChars, offsetLines });
    return { ...common, job, log };
  }

  async inspectFailure(slug: string, runId: number): Promise<GithubActionsFailureInspection> {
    validateSlug(slug);
    const id = positiveId(runId, 'run id');
    const [rawRun, jobs, rawArtifacts] = await Promise.all([
      this.request<any>(`/repos/${slug}/actions/runs/${id}`),
      this.listJobs(slug, id),
      this.request<any>(`/repos/${slug}/actions/runs/${id}/artifacts?per_page=100`),
    ]);
    const run = normalizeRun(rawRun);
    if (run.id !== id || (rawRun.repository?.full_name && String(rawRun.repository.full_name).toLowerCase() !== slug.toLowerCase()))
      throw new GithubActionsApiError(404, 'Run does not belong to the selected repository');
    if (jobs.some((job) => job.runId !== undefined && job.runId !== id))
      throw new GithubActionsApiError(404, 'Job does not belong to the selected run');
    const artifacts = Array.isArray(rawArtifacts?.artifacts)
      ? rawArtifacts.artifacts.map(normalizeArtifact)
      : [];
    const failures = jobs.filter((job) => FAILURE_CONCLUSIONS.has(String(job.conclusion ?? '').toLowerCase()));
    const failedJobs: GithubActionsFailureInspection['failedJobs'] = [];
    const notices: string[] = [];
    if (jobs.length >= MAX_JOB_PAGES * 100) notices.push('Job listing capped at 1,000; use view jobs with page/perPage for more.');
    if (Number(rawArtifacts?.total_count) > artifacts.length) notices.push('Artifact listing truncated; use view artifacts with page/perPage for more.');
    for (const job of failures.slice(0, this.maxJobLogs)) {
      try {
        const log = await this.jobLog(slug, job.id);
        failedJobs.push({ ...job, ...(log.excerpt ? { log } : {}) });
      } catch (error) {
        failedJobs.push(job);
        notices.push(`Could not read logs for ${job.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > this.maxJobLogs)
      notices.push(`Logs were fetched for ${this.maxJobLogs} of ${failures.length} failing jobs; narrow the run or inspect the remaining jobs on GitHub.`);
    if (!failures.length && run.conclusion && FAILURE_CONCLUSIONS.has(run.conclusion.toLowerCase()))
      notices.push('The workflow run failed, but GitHub exposed no terminally failing job in the first 1,000 jobs.');
    return { run, jobs, failedJobs, artifacts, notices };
  }

  async rerun(slug: string, runId: number, failedOnly: boolean): Promise<{ accepted: true; action: 'rerun' | 'rerun-failed' }> {
    validateSlug(slug);
    const id = positiveId(runId, 'run id');
    const action = failedOnly ? 'rerun-failed' : 'rerun';
    await this.request(`/repos/${slug}/actions/runs/${id}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, { method: 'POST' });
    return { accepted: true, action };
  }

  async cancel(slug: string, runId: number): Promise<{ accepted: true; action: 'cancel' }> {
    validateSlug(slug);
    await this.request(`/repos/${slug}/actions/runs/${positiveId(runId, 'run id')}/cancel`, { method: 'POST' });
    return { accepted: true, action: 'cancel' };
  }

  async dispatch(slug: string, workflow: string | number, ref: string,
    inputs: Record<string, string | number | boolean> = {}): Promise<{ accepted: true; workflow: string; ref: string }> {
    validateSlug(slug);
    const branch = ref.trim();
    if (!branch || branch.length > 255 || /[\0\r\n]/.test(branch)) throw new Error('invalid GitHub workflow ref');
    if (Object.keys(inputs).length > 25) throw new Error('GitHub workflow dispatch accepts at most 25 inputs');
    const normalizedInputs = Object.fromEntries(Object.entries(inputs).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key)) throw new Error(`invalid workflow input name: ${key}`);
      const rendered = String(value);
      if (rendered.length > 10_000) throw new Error(`workflow input ${key} is too long`);
      return [key, rendered];
    }));
    const selected = workflowId(workflow);
    await this.request(`/repos/${slug}/actions/workflows/${selected}/dispatches`, {
      method: 'POST', body: JSON.stringify({ ref: branch, inputs: normalizedInputs }),
    });
    return { accepted: true, workflow: selected, ref: branch };
  }

  private async listJobs(slug: string, runId: number): Promise<GithubActionsJob[]> {
    const jobs: GithubActionsJob[] = [];
    for (let page = 1; page <= MAX_JOB_PAGES; page++) {
      const value = await this.request<any>(`/repos/${slug}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
      const batch = Array.isArray(value?.jobs) ? value.jobs : [];
      jobs.push(...batch.map(normalizeJob));
      if (batch.length < 100) break;
    }
    return jobs;
  }

  private async jobLog(slug: string, jobId: number, selection?: { tailLines: number; maxChars: number; offsetLines: number }) {
    const response = await this.send(`/repos/${slug}/actions/jobs/${positiveId(jobId, 'job id')}/logs`, {
      redirect: 'manual',
    });
    let download = response;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new GithubActionsApiError(502, 'GitHub returned a job-log redirect without a location');
      const target = safeDownloadTarget(parseDownloadLocation(location, this.apiBase));
      // Signed log URLs are bearer credentials in their own right. Never send
      // the installation token to the storage host and never return the URL.
      download = await this.downloadWithoutAuth(target);
    }
    if (!download.ok) throw new GithubActionsApiError(download.status, `GitHub job log download failed (${download.status})`);
    const body = await boundedTailText(download, selection ? 64 * 1024 * 1024 : this.maxLogDownloadBytes)
      .catch(() => { throw new GithubActionsApiError(502, 'GitHub job log stream failed'); });
    let safeText = body.text;
    for (const token of this.seenTokens) if (token) safeText = safeText.split(token).join('[REDACTED]');
    const clean = redactActionsText(safeText).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    const lines = clean.replace(/\n$/, '').split('\n');
    const end = selection ? Math.max(0, lines.length - selection.offsetLines) : lines.length;
    const start = selection ? Math.max(0, end - selection.tailLines) : 0;
    const selected = selection ? lines.slice(start, end).join('\n') : actionLogExcerpt(clean, this.maxLogExcerptChars);
    const excerpt = selection ? selected.slice(-selection.maxChars) : selected;
    return {
      excerpt, downloadedBytes: body.bytes,
      truncated: body.truncated || body.omittedPrefix || excerpt.length < clean.trim().length,
      downloadTruncated: body.truncated, omittedPrefix: body.omittedPrefix,
      tailComplete: !body.truncated, retainedBytes: body.retainedBytes,
      ...(selection ? { tailLines: selection.tailLines, maxChars: selection.maxChars, offsetLines: selection.offsetLines,
        nextOffsetLines: start > 0 ? selection.offsetLines + (end - start) : null,
        retainedLines: lines.length, outputTruncated: excerpt.length < selected.length } : {}),
    };
  }

  private async request<T = unknown>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(pathname, init);
    if (!response.ok) {
      let detail = '';
      try {
        const body = await boundedTailText(response, 8192);
        const message = JSON.parse(body.text).message;
        if (typeof message === 'string') detail = message;
      } catch { /* Retain the status when GitHub returns a non-JSON error. */ }
      for (const token of this.seenTokens) if (token) detail = detail.split(token).join('[REDACTED]');
      detail = redactActionsText(detail).slice(0, 1000);
      throw new GithubActionsApiError(response.status,
        `GitHub Actions API request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    if (response.status === 204) return undefined as T;
    try {
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch { throw new GithubActionsApiError(502, 'GitHub Actions returned an invalid response'); }
  }

  private async downloadWithoutAuth(initial: URL): Promise<Response> {
    let target = initial;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await this.fetcher(target, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
        .catch(() => { throw new GithubActionsApiError(502, 'GitHub log storage request failed'); });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) throw new GithubActionsApiError(502, 'GitHub log storage redirected without a location');
      if (redirects === 3) throw new GithubActionsApiError(502, 'GitHub job log download redirected too many times');
      target = safeDownloadTarget(parseDownloadLocation(location, target));
    }
    throw new GithubActionsApiError(502, 'GitHub job log download failed');
  }

  private async send(pathname: string, init: RequestInit): Promise<Response> {
    const once = async (forceRefresh = false) => {
      const token = typeof this.token === 'function'
        ? await this.token(forceRefresh ? { forceRefresh: true } : undefined)
        : this.token;
      this.seenTokens.add(token);
      return this.fetcher(`${this.apiBase}${pathname}`, { ...init, redirect: 'manual', headers: {
        accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28', 'user-agent': BRAND, ...(init.headers ?? {}),
      }, signal: AbortSignal.timeout(30000) }).catch(() => { throw new GithubActionsApiError(502, 'GitHub Actions request failed'); });
    };
    let response = await once();
    if (response.status === 401 && typeof this.token === 'function') response = await once(true);
    for (let attempt = 0; attempt < 3 && (response.status === 403 || response.status === 429); attempt++) {
      const retryAfter = response.headers.get('retry-after');
      const reset = response.headers.get('x-ratelimit-reset');
      const wait = retryAfter !== null ? Number(retryAfter) * 1000
        : response.headers.get('x-ratelimit-remaining') === '0' && reset ? Number(reset) * 1000 - Date.now()
        : response.status === 429 ? 1000 * 2 ** attempt : undefined;
      if (wait === undefined || !Number.isFinite(wait)) break;
      await response.body?.cancel();
      await this.sleep(Math.min(60_000, Math.max(0, wait)));
      response = await once();
    }
    return response;
  }
}

/** Only structured conclusions determine ownership. Names, logs, annotations,
 * summaries and inspection notices can all contain repository-controlled text.
 * GitHub does not expose a structured billing reason here: never invent one. */
export function classifyGithubActionsFailure(
  inspection: GithubActionsFailureInspection,
  options: { postMerge?: boolean; checkContext?: string } = {},
): GithubActionsFailureDecision {
  const diagnostic = options.checkContext?.trim().slice(0, 32_000);
  const common = { inspection, ...(diagnostic ? { checkDiagnostics: diagnostic } : {}) };
  if (options.postMerge) return {
    ...common, disposition: 'deployment',
    reason: 'The failing workflow ran after the revision was merged; repairing it must not reopen or mutate the completed proposal.',
  };
  // failedJobs is log-capped; jobs contains all the inspected job metadata.
  const jobs = [...inspection.jobs, ...inspection.failedJobs];
  const conclusions = [inspection.run.conclusion, ...jobs.map(job => job.conclusion)];
  const structured = classifyGithubCheckStates(conclusions);
  if (structured?.disposition === 'human') return { ...common, ...structured };
  // A real failed step needs repair even when another job was interrupted.
  // The run's cancellation/timeout alone must not convert assertion text into
  // account evidence, nor can a quoted runner error request an automatic rerun.
  if (jobs.some(job => job.conclusion?.toLowerCase() === 'failure'
    && job.steps.some(step => step.conclusion?.toLowerCase() === 'failure'))) return {
    ...common, disposition: 'revision',
    reason: 'GitHub reports a failed execution step; repair the proposal using the attached diagnostics.',
  };
  if (structured) return { ...common, ...structured };
  return {
    ...common, disposition: 'human',
    waitReason: 'GitHub Actions failure needs inspection',
    reason: 'GitHub exposed no failed execution step. Inspect the startup and check diagnostics before deciding whether to repair workflow code or resolve an external restriction.',
  };
}

/** Fallback for permission-limited PR checks and speculative merge-group checks.
 * Inputs must be API conclusion/state fields, never formatted check output.
 * Unknown states carry no ownership evidence. Preserve diagnostics for repair. */
export function classifyGithubCheckStates(states: ReadonlyArray<string | undefined>):
  { disposition: 'human' | 'retry'; reason: string; waitReason?: string } | undefined {
  const normalized = new Set(states.map(state => state?.toLowerCase()));
  if (normalized.has('action_required')) return {
    disposition: 'human', waitReason: 'GitHub Actions action required',
    reason: 'GitHub reports that action is required. Inspect the check on GitHub for the required action.',
  };
  if (normalized.has('startup_failure')) return {
    disposition: 'human', waitReason: 'GitHub Actions failure needs inspection',
    reason: 'GitHub reports a startup failure. Inspect the workflow configuration and startup diagnostics.',
  };
  if (['cancelled', 'stale', 'timed_out'].some(state => normalized.has(state))) return {
    disposition: 'retry',
    reason: 'GitHub reports an interrupted or timed-out execution; reconcile equivalent runs before a bounded retry.',
  };
  return undefined;
}

/** Render bounded but otherwise complete diagnostics for every failed job that
 * GitHub exposed. The inspection API already strips signed log URLs and caps
 * each downloaded log; this adds a total event/prompt boundary. */
export function renderGithubActionsFailure(
  decision: GithubActionsFailureDecision,
  maxChars = 96 * 1024,
): string {
  const { run, failedJobs, notices } = decision.inspection;
  const lines = [
    `GitHub Actions run ${run.name} #${run.runNumber} (attempt ${run.attempt}) concluded ${run.conclusion ?? run.status}.`,
    `Revision: ${run.headSha || 'unknown'}`,
    ...(run.url ? [`Run: ${run.url}`] : []),
    `Classification: ${decision.disposition} — ${decision.reason}`,
    ...(decision.checkDiagnostics ? [`Check diagnostics (may include repository output):\n${decision.checkDiagnostics}`] : []),
  ];
  if (!failedJobs.length) lines.push('GitHub exposed no terminally failing job output.');
  for (const job of failedJobs) {
    lines.push('', `Job: ${job.name} (${job.conclusion ?? job.status})${job.url ? ` — ${job.url}` : ''}`);
    const failedSteps = job.steps.filter((step) => FAILURE_CONCLUSIONS.has(String(step.conclusion ?? '').toLowerCase()));
    if (failedSteps.length) lines.push(`Failed steps: ${failedSteps.map((step) => step.name).join(', ')}`);
    if (job.log?.excerpt) lines.push(job.log.excerpt, ...(job.log.truncated ? ['[GitHub log output was truncated; use the targeted log view to inspect tail completeness and limits.]'] : []));
    else lines.push('[No job log was available.]');
  }
  if (notices.length) lines.push('', 'Inspection notices:', ...notices.map((notice) => `- ${notice}`));
  const rendered = lines.join('\n').trim();
  return rendered.length <= maxChars ? rendered : `${rendered.slice(0, maxChars)}\n[Additional diagnostics omitted at the task-event safety limit.]`;
}

/** A person-sized account of the same failure: which run and job failed and
 * where to look. Logs belong in the repair prompt and on GitHub, not in a
 * request for human input. */
export function summarizeGithubActionsFailure(decision: GithubActionsFailureDecision): string {
  const { run, failedJobs, notices } = decision.inspection;
  const failed = failedJobs.slice(0, 6).map((job) => {
    const steps = job.steps.filter((step) => FAILURE_CONCLUSIONS.has(String(step.conclusion ?? '').toLowerCase()));
    return `- ${job.name}${steps.length ? `: ${steps.map((step) => step.name).join(', ')}` : ''}`;
  });
  return [
    `GitHub Actions run ${run.name} #${run.runNumber} (attempt ${run.attempt}) concluded ${run.conclusion ?? run.status}.`,
    ...(run.url ? [`Run: ${run.url}`] : []),
    ...(failed.length ? ['Failed:', ...failed] : []),
    ...notices.slice(0, 3).map((notice) => `Note: ${notice.slice(0, 200)}`),
  ].join('\n');
}

export function githubActionsRunIdFromUrl(value: string | undefined): number | undefined {
  const match = value?.match(/\/actions\/runs\/(\d+)(?:\/|$)/);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** Stable, restart-safe key for one repository/PR/revision/check validation. */
export function githubRequiredCheckKey(identity: GithubRequiredCheckIdentity): string {
  const repository = identity.repository.trim().toLowerCase();
  const headSha = identity.headSha.trim().toLowerCase();
  const check = identity.check.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${repository}#${identity.pullRequest}:${headSha}:workflow:${identity.workflowId}:check:${check}`;
}

/** Reconcile every same-workflow run GitHub exposes for one exact PR head.
 * A successful equivalent satisfies the validation. Otherwise an active
 * equivalent becomes current, so an older cancellation cannot trigger a rerun
 * that would cancel its healthy replacement. */
export function reconcileGithubActionsRuns(
  identity: GithubRequiredCheckIdentity,
  observed: GithubActionsRun,
  listed: GithubActionsRun[],
): GithubActionsRunReconciliation {
  const equivalent = new Map<number, GithubActionsRun>();
  const add = (run: GithubActionsRun) => {
    if (identity.workflowId > 0 && run.workflowId !== identity.workflowId) return;
    if (run.id !== observed.id && !githubActionsRunMatchesRevision(run, identity)) return;
    const previous = equivalent.get(run.id);
    if (!previous || compareGithubActionsRuns(run, previous) > 0) equivalent.set(run.id, run);
  };
  add(observed);
  for (const run of listed) add(run);
  const runs = [...equivalent.values()].sort((a, b) => compareGithubActionsRuns(b, a));
  const successful = runs.find((run) => githubActionsRunState(run) === 'success');
  const active = runs.find((run) => ACTIVE_RUN_STATES.has(githubActionsRunState(run)));
  const terminalFailure = runs.find((run) => {
    const state = githubActionsRunState(run);
    return state !== 'success' && state !== 'cancelled' && !ACTIVE_RUN_STATES.has(state);
  });
  let current = terminalFailure && (!successful || compareGithubActionsRuns(terminalFailure, successful) > 0)
    ? terminalFailure
    : successful ?? runs[0] ?? observed;
  if (active && compareGithubActionsRuns(active, current) > 0) current = active;
  const satisfied = githubActionsRunState(current) === 'success' ? current : undefined;
  return {
    identity,
    key: githubRequiredCheckKey(identity),
    runs,
    current,
    ...(current.id !== observed.id || current.attempt !== observed.attempt ? { replacement: current } : {}),
    ...(satisfied ? { successful: satisfied } : {}),
  };
}

function githubActionsRunMatchesRevision(run: GithubActionsRun, identity: GithubRequiredCheckIdentity): boolean {
  if (run.headSha.toLowerCase() === identity.headSha.toLowerCase()) return true;
  return Boolean(run.pullRequests?.some((pr) => pr.number === identity.pullRequest
    && pr.headSha.toLowerCase() === identity.headSha.toLowerCase()));
}

const ACTIVE_RUN_STATES = new Set(['requested', 'queued', 'pending', 'waiting', 'in_progress']);

function githubActionsRunState(run: GithubActionsRun): string {
  return String(run.conclusion ?? run.status).toLowerCase();
}

function compareGithubActionsRuns(a: GithubActionsRun, b: GithubActionsRun): number {
  const aTime = Date.parse(a.updatedAt || a.createdAt);
  const bTime = Date.parse(b.updatedAt || b.createdAt);
  return (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0)
    || a.runNumber - b.runNumber || a.attempt - b.attempt
    || a.id - b.id;
}

function normalizeRun(raw: any): GithubActionsRun {
  const id = positiveId(Number(raw?.id), 'GitHub Actions run id');
  return {
    id,
    name: String(raw?.name ?? 'GitHub Actions'),
    ...(raw?.path ? { path: String(raw.path) } : {}),
    ...(raw?.check_suite_id ? { checkSuiteId: Number(raw.check_suite_id) } : {}),
    ...(Array.isArray(raw?.referenced_workflows) ? { referencedWorkflows: raw.referenced_workflows.map((w: any) => ({
      path: String(w.path ?? ''), sha: String(w.sha ?? ''), ...(w.ref ? { ref: String(w.ref) } : {}),
    })) } : {}),
    ...(raw?.display_title ? { displayTitle: String(raw.display_title) } : {}),
    workflowId: Number(raw?.workflow_id ?? 0),
    runNumber: Number(raw?.run_number ?? 0),
    attempt: Number(raw?.run_attempt ?? 1),
    event: String(raw?.event ?? ''),
    status: String(raw?.status ?? 'unknown'),
    ...(raw?.conclusion ? { conclusion: String(raw.conclusion) } : {}),
    ...(raw?.head_branch ? { branch: String(raw.head_branch) } : {}),
    headSha: String(raw?.head_sha ?? ''),
    url: String(raw?.html_url ?? raw?.url ?? ''),
    createdAt: String(raw?.created_at ?? ''),
    updatedAt: String(raw?.updated_at ?? ''),
    ...(raw?.actor?.login ? { actor: String(raw.actor.login) } : {}),
    ...(raw?.triggering_actor?.login ? { triggeringActor: String(raw.triggering_actor.login) } : {}),
    ...(Array.isArray(raw?.pull_requests) ? { pullRequests: raw.pull_requests.flatMap((pr: any) => {
      const number = Number(pr?.number);
      const headSha = String(pr?.head?.sha ?? '');
      if (!Number.isSafeInteger(number) || number <= 0 || !headSha) return [];
      return [{ number, headSha, ...(pr?.head?.ref ? { headRef: String(pr.head.ref) } : {}) }];
    }) } : {}),
  };
}

function normalizeJob(raw: any): GithubActionsJob {
  return {
    id: positiveId(Number(raw?.id), 'GitHub Actions job id'),
    ...(raw?.run_id ? { runId: Number(raw.run_id) } : {}),
    ...(raw?.run_attempt ? { attempt: Number(raw.run_attempt) } : {}),
    ...(raw?.head_sha ? { headSha: String(raw.head_sha) } : {}),
    ...(typeof raw?.check_run_url === 'string' && /\/check-runs\/(\d+)$/.test(raw.check_run_url)
      ? { checkRunId: Number(raw.check_run_url.match(/\/check-runs\/(\d+)$/)[1]) } : {}),
    name: String(raw?.name ?? 'GitHub Actions job'),
    status: String(raw?.status ?? 'unknown'),
    ...(raw?.conclusion ? { conclusion: String(raw.conclusion) } : {}),
    ...(raw?.runner_name ? { runner: String(raw.runner_name) } : {}),
    url: String(raw?.html_url ?? raw?.url ?? ''),
    ...(raw?.started_at ? { startedAt: String(raw.started_at) } : {}),
    ...(raw?.completed_at ? { completedAt: String(raw.completed_at) } : {}),
    steps: Array.isArray(raw?.steps) ? raw.steps.map((step: any) => ({
      number: Number(step?.number ?? 0), name: String(step?.name ?? 'step'),
      status: String(step?.status ?? 'unknown'),
      ...(step?.conclusion ? { conclusion: String(step.conclusion) } : {}),
      ...(step?.started_at ? { startedAt: String(step.started_at) } : {}),
      ...(step?.completed_at ? { completedAt: String(step.completed_at) } : {}),
    })) : [],
  };
}

function normalizeArtifact(raw: any): GithubActionsArtifact {
  return {
    id: positiveId(Number(raw?.id), 'GitHub Actions artifact id'),
    name: String(raw?.name ?? 'artifact'),
    sizeBytes: Math.max(0, Number(raw?.size_in_bytes ?? 0)),
    expired: Boolean(raw?.expired),
    ...(raw?.digest ? { digest: String(raw.digest) } : {}),
    ...(raw?.workflow_run ? { workflowRun: { id: Number(raw.workflow_run.id),
      headSha: String(raw.workflow_run.head_sha ?? ''),
      ...(raw.workflow_run.head_branch ? { headBranch: String(raw.workflow_run.head_branch) } : {}) } } : {}),
    ...(raw?.expires_at ? { expiresAt: String(raw.expires_at) } : {}),
    ...(raw?.created_at ? { createdAt: String(raw.created_at) } : {}),
    ...(raw?.updated_at ? { updatedAt: String(raw.updated_at) } : {}),
  };
}

/** Scan with a hard network cap and a small rolling buffer, retaining actual
 * completion output when logs exceed the retained window. Never claim a tail
 * when the scan cap was hit. No full transcript enters persistence. */
async function boundedTailText(response: Response, maxBytes: number) {
  const retain = 1024 * 1024;
  let tail = Buffer.alloc(0);
  let bytes = 0;
  let truncated = false;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxBytes - bytes;
        const chunk = value.subarray(0, Math.max(0, remaining));
        bytes += chunk.length;
        tail = chunk.length >= retain ? Buffer.from(chunk.subarray(-retain))
          : Buffer.concat([tail.subarray(Math.max(0, tail.length + chunk.length - retain)), chunk]);
        if (value.length > remaining) { truncated = true; break; }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return { text: tail.toString('utf8'), bytes, retainedBytes: tail.length,
    omittedPrefix: bytes > tail.length, truncated };
}

function pagination(total: unknown, page: number, perPage: number) {
  const count = Number(total ?? 0);
  return { total: count, page, perPage, hasMore: page * perPage < count,
    nextPage: page * perPage < count && page < 1000 ? page + 1 : null,
    pageLimitReached: page === 1000 && page * perPage < count };
}

/** Defense in depth for credentials printed by workflows. GitHub masks secrets
 * upstream; do not return recognizable tokens or bearer query strings either. */
export function redactActionsText(input: string): string {
  return input.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/g, (url) => {
      try { const parsed = new URL(url); return parsed.search || parsed.username || parsed.password
        ? `${parsed.origin}${parsed.pathname}?[REDACTED]` : url; } catch { return '[REDACTED URL]'; }
    });
}

/** Prefer explicit runner error markers with context, then retain the tail that
 * usually contains the command's exit and job summary. */
export function actionLogExcerpt(input: string, maxChars = DEFAULT_MAX_LOG_EXCERPT): string {
  const clean = input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  const lines = clean.split('\n');
  const selected = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    if (!/(?:##\[error\]|\b(?:fatal|error|failed|failure|exception|timed out)\b)/i.test(lines[index]!)) continue;
    for (let context = Math.max(0, index - 2); context <= Math.min(lines.length - 1, index + 3); context++) selected.add(context);
  }
  for (let index = Math.max(0, lines.length - 100); index < lines.length; index++) selected.add(index);
  let rendered = [...selected].sort((a, b) => a - b).map((index) => lines[index]).join('\n').trim();
  if (rendered.length > maxChars) rendered = `…(earlier diagnostic lines omitted)\n${rendered.slice(-maxChars)}`;
  return rendered;
}

function workflowId(value: string | number): string {
  const rendered = String(value).trim();
  if (!rendered || !/^(?:\d+|[A-Za-z0-9_.-]+)$/.test(rendered))
    throw new Error('workflow must be a numeric id or workflow file name such as deploy.yml');
  return encodeURIComponent(rendered);
}

function validateSlug(slug: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug) || slug.split('/').some((part) => part === '.' || part === '..')) throw new Error('invalid GitHub repository');
}

/** Only known GitHub log storage domains may receive signed redirects. Reject
 * arbitrary hosts (including DNS rebinding targets) and never forward auth. */
function safeDownloadTarget(target: URL): URL {
  if (target.protocol !== 'https:' || target.username || target.password)
    throw new GithubActionsApiError(502, 'GitHub returned an unsafe job-log location');
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal'))
    throw new GithubActionsApiError(502, 'GitHub returned a private job-log location');
  if (net.isIP(hostname) === 4) {
    const [a = 0, b = 0] = hostname.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))
      throw new GithubActionsApiError(502, 'GitHub returned a private job-log location');
  }
  if (net.isIP(hostname) === 6 && (hostname === '::' || hostname === '::1'
    || hostname.startsWith('fc') || hostname.startsWith('fd')
    || /^fe[89ab]/.test(hostname)))
    throw new GithubActionsApiError(502, 'GitHub returned a private job-log location');
  if (target.port && target.port !== '443') throw new GithubActionsApiError(502, 'GitHub returned an unsafe job-log port');
  if (!['.blob.core.windows.net', '.githubusercontent.com'].some((suffix) => hostname.endsWith(suffix)))
    throw new GithubActionsApiError(502, 'GitHub returned an unsupported job-log storage host');
  return target;
}

function parseDownloadLocation(location: string, base: string | URL): URL {
  try { return new URL(location, base); }
  catch { throw new GithubActionsApiError(502, 'GitHub returned an invalid job-log location'); }
}

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function boundedFilter(value: string, label: string): string {
  const rendered = value.trim();
  if (rendered.length > 255 || /[\0\r\n]/.test(rendered)) throw new Error(`invalid GitHub Actions ${label}`);
  return rendered;
}

function positiveBound(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`value must be an integer from ${min} to ${max}`);
  return value;
}
