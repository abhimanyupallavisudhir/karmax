/**
 * GitHub Actions inspection and narrowly-scoped mutations.
 *
 * The API object receives a short-lived token provider from GitHubAppService;
 * callers never receive the token itself. Log downloads follow GitHub's signed
 * redirect without forwarding Authorization and are size/output bounded before
 * they can enter an agent conversation.
 */
import net from 'node:net';

export type GithubActionsStatus =
  | 'completed' | 'action_required' | 'cancelled' | 'failure' | 'neutral'
  | 'skipped' | 'stale' | 'success' | 'timed_out' | 'in_progress' | 'queued'
  | 'requested' | 'waiting' | 'pending';

export interface GithubActionsRun {
  id: number;
  name: string;
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

  constructor(private token: string | GithubActionsTokenProvider, options: GithubActionsApiOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
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

  async inspectFailure(slug: string, runId: number): Promise<GithubActionsFailureInspection> {
    validateSlug(slug);
    const id = positiveId(runId, 'run id');
    const [rawRun, jobs, rawArtifacts] = await Promise.all([
      this.request<any>(`/repos/${slug}/actions/runs/${id}`),
      this.listJobs(slug, id),
      this.request<any>(`/repos/${slug}/actions/runs/${id}/artifacts?per_page=100`),
    ]);
    const run = normalizeRun(rawRun);
    const artifacts = Array.isArray(rawArtifacts?.artifacts)
      ? rawArtifacts.artifacts.map(normalizeArtifact)
      : [];
    const failures = jobs.filter((job) => FAILURE_CONCLUSIONS.has(String(job.conclusion ?? '').toLowerCase()));
    const failedJobs: GithubActionsFailureInspection['failedJobs'] = [];
    const notices: string[] = [];
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

  private async jobLog(slug: string, jobId: number): Promise<{ excerpt: string; downloadedBytes: number; truncated: boolean }> {
    const response = await this.send(`/repos/${slug}/actions/jobs/${positiveId(jobId, 'job id')}/logs`, {
      redirect: 'manual',
    });
    let download = response;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new GithubActionsApiError(502, 'GitHub returned a job-log redirect without a location');
      const target = safeDownloadTarget(new URL(location, this.apiBase));
      // Signed log URLs are bearer credentials in their own right. Never send
      // the installation token to the storage host and never return the URL.
      download = await this.downloadWithoutAuth(target);
    }
    if (!download.ok) throw new GithubActionsApiError(download.status, `GitHub job log download failed (${download.status})`);
    const body = await boundedText(download, this.maxLogDownloadBytes);
    return {
      excerpt: actionLogExcerpt(body.text, this.maxLogExcerptChars),
      downloadedBytes: body.bytes,
      truncated: body.truncated,
    };
  }

  private async request<T = unknown>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(pathname, init);
    if (!response.ok)
      throw new GithubActionsApiError(response.status, `GitHub Actions API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async downloadWithoutAuth(initial: URL): Promise<Response> {
    let target = initial;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await this.fetcher(target, { redirect: 'manual' });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      if (!location) throw new GithubActionsApiError(502, 'GitHub log storage redirected without a location');
      if (redirects === 3) throw new GithubActionsApiError(502, 'GitHub job log download redirected too many times');
      target = safeDownloadTarget(new URL(location, target));
    }
    throw new GithubActionsApiError(502, 'GitHub job log download failed');
  }

  private async send(pathname: string, init: RequestInit): Promise<Response> {
    const once = async (forceRefresh = false) => {
      const token = typeof this.token === 'function'
        ? await this.token(forceRefresh ? { forceRefresh: true } : undefined)
        : this.token;
      return this.fetcher(`${this.apiBase}${pathname}`, { ...init, headers: {
        accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28', 'user-agent': 'karmax', ...(init.headers ?? {}),
      } });
    };
    let response = await once();
    if (response.status === 401 && typeof this.token === 'function') response = await once(true);
    return response;
  }
}

function normalizeRun(raw: any): GithubActionsRun {
  const id = positiveId(Number(raw?.id), 'GitHub Actions run id');
  return {
    id,
    name: String(raw?.name ?? 'GitHub Actions'),
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
  };
}

function normalizeJob(raw: any): GithubActionsJob {
  return {
    id: positiveId(Number(raw?.id), 'GitHub Actions job id'),
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
    ...(raw?.expires_at ? { expiresAt: String(raw.expires_at) } : {}),
    ...(raw?.created_at ? { createdAt: String(raw.created_at) } : {}),
    ...(raw?.updated_at ? { updatedAt: String(raw.updated_at) } : {}),
  };
}

async function boundedText(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!response.body) return { text: '', bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      if (remaining <= 0) { truncated = true; break; }
      if (value.length > remaining) {
        chunks.push(value.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        break;
      }
      chunks.push(value); bytes += value.length;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(joined), bytes, truncated };
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
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) throw new Error('invalid GitHub repository');
}

/** Reject credential-bearing/private redirect targets. GitHub may use several
 * public storage providers, so a fixed hostname allow-list would be brittle;
 * the invariant is public HTTPS and no forwarded installation credential. */
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
  return target;
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
