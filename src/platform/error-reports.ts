import crypto from 'node:crypto';
import os from 'node:os';
import type { ProjectEvent, ProjectEventRecord } from '../domain/project-events.js';
import { buildHistory, buildRevision } from '../util/build-revision.js';

/**
 * Error reports — every unexpected error is one counted event per bug in the
 * project the installation's operators chose (Installation → Error reports),
 * where a repeatable task keeps one task per bug (wiki features/error-reports).
 *
 * What counts as unexpected: a task stopped for a person by a failure its
 * workflow could not recover from, a console/API request answered 500, a
 * rejection nothing caught, a lifecycle sweep step that failed, and an error a
 * person reported from the console. Expected outcomes — a refusal (4xx), a
 * quota or credential the organization must fix, waiting for a machine — are
 * not errors here.
 *
 * One bug is one event: its key is the error's fingerprint, so every further
 * occurrence is counted on it (how often, when last, in which organizations
 * and revisions, its latest occurrences) instead of starting anything. The
 * fingerprint is where the error was thrown (its frames in tavya's own code)
 * when that is known, else its message with what varies taken out. Nothing is
 * thrown away to bound volume: a process counts repeats in memory and writes
 * them every few seconds, so an outage of ten thousand occurrences is a
 * handful of writes to one row.
 *
 * Events come from source `tavya`, which no caller of the events API can
 * claim (an emitted event's source is the caller: `user:…`, `task:…`), so only
 * the platform can start the task that fixes them.
 */

export const ERROR_EVENT_TYPE = 'tavya.error';
export const DEPLOY_EVENT_TYPE = 'tavya.deployed';
export const ERROR_EVENT_SOURCE = 'tavya';
/** kv: `{"projectId": …}` — where reports go; absent = off. */
export const ERROR_REPORTS_KEY = 'installation:error-reports';
/** kv: the fingerprint a task's current error was reported under, so a person's report of it counts on the same bug. */
export const taskErrorKey = (taskId: string) => `error-reports:task:${taskId}`;

export type ErrorReportKind = 'escalation' | 'request' | 'rejection' | 'sweep' | 'reported';

export interface ErrorReportInput {
  kind: ErrorReportKind;
  error: unknown;
  /** Where it happened: a route, a sweep step, a task stage. */
  where?: string;
  taskId?: string;
  projectId?: string;
  organizationId?: string;
  /** Anything else worth knowing, small (it is stored with the event). */
  detail?: Record<string, unknown>;
  /** Count it on this bug (a person reporting an error already reported). */
  fingerprint?: string;
}

interface ReportsStore {
  kvGet(key: string): Promise<string | undefined>;
  kvSet?(key: string, value: string): Promise<void> | void;
  getProject(id: string): Promise<{ id: string; organizationId?: string } | undefined>;
  recordProjectEvent(input: ProjectEventRecord): Promise<{ event: ProjectEvent; created: boolean }>;
}

/** How long a process counts repeats of a bug in memory before writing them. */
const FLUSH_MS = 5_000;
/** Bugs a process may hold repeats of between writes; beyond it, repeats of further bugs are written at once. */
const MAX_BUFFERED = 500;
const SETTING_CACHE_MS = 30_000;
/** Own frames that say where an error came from; deeper ones say who asked. */
const FINGERPRINT_FRAMES = 3;
/** Payload paths tallied across a bug's occurrences. */
const TALLIED = ['organizationId', 'revision', 'kind'];

/** The error's message with what varies between occurrences of one bug taken out. */
export function normalizeErrorMessage(message: string): string {
  return scrubSecrets(message)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[a-z]{2,12}_[a-z0-9]{10,}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** The frames of tavya's own code in a stack, innermost first, without line
 *  numbers (they move with every edit): `src/world/vm/ssh.ts SshTransport.exec`. */
export function ownFrames(stack: string | undefined, limit = FINGERPRINT_FRAMES): string[] {
  const frames: string[] = [];
  for (const line of (stack ?? '').split('\n')) {
    const match = /\/(src\/[^\s:()]+\.[cm]?[jt]s)/.exec(line);
    if (!match || match[1]!.endsWith('platform/error-reports.ts')) continue;
    const fn = /at (?:async )?([\w.$<>]+) \(/.exec(line)?.[1];
    frames.push(fn ? `${match[1]} ${fn}` : match[1]!);
    if (frames.length >= limit) break;
  }
  return frames;
}

/** The first frame of tavya's own code. */
export function ownFrame(stack: string | undefined): string | undefined { return ownFrames(stack, 1)[0]; }

/**
 * One bug, one fingerprint. Where the error was thrown says which bug it is
 * better than what it said: one throw site words its message per case ("the
 * api-key …", "the ssh-key …"), and one bug surfaces as a failed request here
 * and a stopped task there. So an error whose stack names tavya's own code is
 * its name and those frames; only one without is its kind, name and message.
 */
export function errorFingerprint(kind: string, name: string, message: string, stack?: string): string {
  const frames = ownFrames(stack);
  return crypto.createHash('sha256').update((frames.length ? [name, ...frames] : [kind, name, normalizeErrorMessage(message)]).join('\n'))
    .digest('hex').slice(0, 16);
}

/** Credentials that error text sometimes carries (a URL with its token, a header). */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:ant-|proj-|or-)?|xox[abpr]-|tv[aprs]_|AKIA)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1[redacted]@')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]');
}

function described(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    // An activity failure wraps the real error: name the innermost one, and
    // keep its stack (the wrapper's says only who caught it).
    let inner: unknown = error;
    for (let depth = 0; depth < 5 && inner instanceof Error && inner.cause instanceof Error; depth++) inner = inner.cause;
    const root = inner as Error;
    const stack = ownFrames(root.stack).length ? root.stack : error.stack ?? root.stack;
    return { name: root.name || error.name || 'Error', message: error.message || root.message || String(error), ...(stack ? { stack } : {}) };
  }
  return { name: 'Error', message: typeof error === 'string' ? error : JSON.stringify(error) ?? String(error) };
}

// ─── Where a task's failure came from ────────────────────────────────────────

interface Failure { name: string; message: string; stack: string; at: number }
const FAILURE_MEMORY_MS = 30 * 60_000;
const failures = new Map<string, Failure[]>();

/**
 * Remember an activity's failure for its task (the worker's activity
 * interceptor). A task that stops for a person says only what failed, in its
 * workflow's words; the stack of the activity that failed says where, which
 * is what tells one bug from another.
 */
export function rememberTaskFailure(taskId: string, error: unknown, now = Date.now()): void {
  const { name, message, stack } = described(error);
  if (!stack || !ownFrames(stack).length) return;
  const kept = (failures.get(taskId) ?? []).filter((failure) => now - failure.at < FAILURE_MEMORY_MS).slice(-4);
  kept.push({ name, message, stack, at: now });
  failures.delete(taskId);
  failures.set(taskId, kept);
  if (failures.size > 2_000) failures.delete(failures.keys().next().value!);
}

/** The remembered failure a task's error text came from: the latest whose message it carries, else none. */
export function taskFailure(taskId: string, errorText: string, now = Date.now()): Failure | undefined {
  const text = errorText.replace(/\s+/g, ' ');
  return [...(failures.get(taskId) ?? [])].reverse().find((failure) => now - failure.at < FAILURE_MEMORY_MS
    && text.includes(failure.message.replace(/\s+/g, ' ').slice(0, 200)));
}

// ─── The reporter ────────────────────────────────────────────────────────────

interface Buffered { input: ErrorReportInput; described: { name: string; message: string; stack?: string }; occurrences: number; at: number;
  /** What the occurrences counted here differed in (who, which kind): only the latest is written out in full. */
  tally: Record<string, string[]> }

/** Add an occurrence's tallied values (its organization, its kind) to what a buffer has seen. */
function tallied(tally: Record<string, string[]>, input: ErrorReportInput): Record<string, string[]> {
  for (const [path, value] of [['organizationId', input.organizationId], ['kind', input.kind]] as const) {
    if (!value) continue;
    const values = (tally[path] ??= []);
    if (values.length < 20 && !values.includes(value)) values.push(value);
  }
  return tally;
}

export class ErrorReporter {
  /** Bugs this process has written: a further occurrence waits for the next flush. */
  private known = new Set<string>();
  private buffered = new Map<string, Buffered>();
  private timer?: ReturnType<typeof setTimeout>;
  private setting?: { at: number; projectId?: string };
  private lookup?: Promise<string | undefined>;

  constructor(private store: ReportsStore, private options: { now?: () => number; revision?: string; role?: string; flushMs?: number } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** The project reports go to, if they are on. One lookup at a time, however
   *  many errors ask at once (a storm must not queue a read per error), and a
   *  lookup that fails keeps the last answer instead of turning reports off. */
  async destination(): Promise<string | undefined> {
    if (this.setting && this.now() - this.setting.at < SETTING_CACHE_MS) return this.setting.projectId;
    this.lookup ??= (async () => {
      try {
        const projectId = (JSON.parse((await this.store.kvGet(ERROR_REPORTS_KEY)) ?? '{}') as { projectId?: unknown }).projectId;
        this.setting = { at: this.now(), ...(typeof projectId === 'string' && projectId ? { projectId } : {}) };
      } catch {
        this.setting = { at: this.now(), ...(this.setting?.projectId ? { projectId: this.setting.projectId } : {}) };
      } finally { this.lookup = undefined; }
      return this.setting!.projectId;
    })();
    return this.lookup;
  }

  /** Forget the cached destination (the setting just changed in this process). */
  invalidate(): void { this.setting = undefined; this.lookup = undefined; }

  /**
   * Count one occurrence. The first of a bug in this process is written at
   * once (the event it returns); a repeat is counted in memory and written
   * with the next flush (undefined), as is everything when reports are off.
   */
  async report(input: ErrorReportInput): Promise<ProjectEvent | undefined> {
    const projectId = await this.destination();
    if (!projectId) return undefined;
    const error = described(input.error);
    const fingerprint = input.fingerprint ?? errorFingerprint(input.kind, error.name, error.message, error.stack);
    const held = this.buffered.get(fingerprint);
    if (held) { held.occurrences++; held.input = input; held.described = error; held.at = this.now(); tallied(held.tally, input); return undefined; }
    if (this.known.has(fingerprint) && this.buffered.size < MAX_BUFFERED) {
      this.buffered.set(fingerprint, { input, described: error, occurrences: 1, at: this.now(), tally: tallied({}, input) });
      this.schedule();
      return undefined;
    }
    this.known.add(fingerprint);
    if (this.known.size > 20_000) this.known.clear();
    return this.write(projectId, fingerprint, input, error, 1, this.now());
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch((error) =>
      console.warn(`[error-reports] could not write counted errors: ${error instanceof Error ? error.message : String(error)}`)); }, this.options.flushMs ?? FLUSH_MS);
    this.timer.unref?.();
  }

  /** Write the repeats counted since the last flush (also at shutdown, and by tests). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const pending = [...this.buffered];
    this.buffered.clear();
    const projectId = pending.length ? await this.destination() : undefined;
    if (!projectId) return;
    for (const [fingerprint, held] of pending)
      await this.write(projectId, fingerprint, held.input, held.described, held.occurrences, held.at, held.tally);
  }

  private async write(projectId: string, fingerprint: string, input: ErrorReportInput, error: { name: string; message: string; stack?: string },
    occurrences: number, at: number, tally?: Record<string, string[]>): Promise<ProjectEvent | undefined> {
    const project = await this.store.getProject(projectId);
    if (!project) return undefined;
    const text = scrubSecrets(error.message);
    const summary = `${error.name === 'Error' ? '' : `${error.name}: `}${text.split('\n')[0]!}`.replace(/\s+/g, ' ').trim().slice(0, 120);
    const payload: Record<string, unknown> = {
      fingerprint, kind: input.kind, summary, name: error.name, message: text.slice(0, 4_000),
      ...(error.stack ? { stack: scrubSecrets(error.stack).slice(0, 8_000) } : {}),
      ...(input.where ? { where: input.where } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(this.options.revision ? { revision: this.options.revision } : {}),
      host: os.hostname(), ...(this.options.role ? { process: this.options.role } : {}),
      occurredAt: new Date(at).toISOString(),
    };
    const { event, created } = await this.store.recordProjectEvent({
      organizationId: project.organizationId ?? 'org_personal', projectId, source: ERROR_EVENT_SOURCE, type: ERROR_EVENT_TYPE,
      key: fingerprint, subject: `tavya-error:${fingerprint}`, occurredAt: at, receivedAt: at, payload, origin: 'external', hops: 0,
      occurrences, distinct: TALLIED, ...(tally ? { tally } : {}),
    });
    // A person's report of this task's error counts on the same bug.
    if (input.taskId && input.kind === 'escalation')
      await Promise.resolve(this.store.kvSet?.(taskErrorKey(input.taskId), JSON.stringify({ fingerprint, error: text.slice(0, 500) }))).catch(() => undefined);
    return created ? event : undefined;
  }
}

let reporter: ErrorReporter | undefined;

/** This process reports through `store` from now on (execution-services.ts). */
export function configureErrorReports(store: ReportsStore, options: { revision?: string; role?: string } = {}): ErrorReporter {
  reporter = new ErrorReporter(store, { revision: options.revision ?? buildRevision(), ...(options.role ? { role: options.role } : {}) });
  return reporter;
}

export function errorReporter(): ErrorReporter | undefined { return reporter; }

/** Report an unexpected error. Never throws, never waits: a failure to report is logged, not reported. */
export function reportError(input: ErrorReportInput): void {
  const current = reporter;
  if (!current) return;
  void current.report(input).catch((error) => {
    console.warn(`[error-reports] could not report ${input.kind}${input.where ? ` at ${input.where}` : ''}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

// ─── A person's report ───────────────────────────────────────────────────────

/**
 * An error a person saw and reported from the console. A task's error is
 * read from the task (never from the caller) and counts on the bug the
 * platform reported it under, if it did; anything else is the caller's own
 * words, marked as such. False when reports are off.
 */
export async function reportFromPerson(store: ReportsStore, input: { by: string; task?: { id: string; projectId: string; error?: string; stage?: string };
  message?: string; where?: string; note?: string; organizationId?: string }): Promise<boolean> {
  const current = reporter;
  if (!current || !(await current.destination())) return false;
  const text = (input.task?.error ?? input.message ?? '').trim().slice(0, 4_000);
  if (!text) return false;
  let fingerprint: string | undefined;
  if (input.task?.error) {
    try {
      const known = JSON.parse((await store.kvGet(taskErrorKey(input.task.id))) ?? '{}') as { fingerprint?: string; error?: string };
      if (known.fingerprint && known.error && scrubSecrets(text).startsWith(known.error.slice(0, 200))) fingerprint = known.fingerprint;
    } catch { fingerprint = undefined; }
  }
  await current.report({ kind: 'reported', error: Object.assign(new Error(text), { name: input.task?.error ? 'Escalation' : 'Reported', stack: undefined }),
    where: (input.task?.stage ? `stage ${input.task.stage}` : input.where?.slice(0, 200)) || undefined,
    ...(input.task ? { taskId: input.task.id, projectId: input.task.projectId } : {}),
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    detail: { reportedBy: input.by, ...(input.note?.trim() ? { note: input.note.trim().slice(0, 1_000) } : {}), ...(input.task?.error ? {} : { inTheirWords: true }) },
    ...(fingerprint ? { fingerprint } : {}) });
  await current.flush();
  return true;
}

// ─── Deploys ─────────────────────────────────────────────────────────────────

/** kv: the revision that last booted here. */
export const DEPLOYED_REVISION_KEY = 'deploy:revision';
const DEPLOY_COMMITS = 500;

/**
 * At boot: if this revision is not the one that ran before, say so in the
 * error-report project (`tavya.deployed`, source `tavya`) with the commits it
 * shipped. That is what tells the task that fixed a bug when its fix went
 * live, so that the bug coming again means the fix did not hold rather than
 * was not out yet.
 */
export async function recordDeploy(store: ReportsStore & { kvSet(key: string, value: string): Promise<void> | void }, options: { history?: string[]; now?: number } = {}):
  Promise<ProjectEvent | undefined> {
  const history = options.history ?? buildHistory();
  const revision = history[0];
  if (!revision) return undefined;
  const previous = await store.kvGet(DEPLOYED_REVISION_KEY);
  if (previous === revision) return undefined;
  let projectId: string | undefined;
  try { projectId = (JSON.parse((await store.kvGet(ERROR_REPORTS_KEY)) ?? '{}') as { projectId?: string }).projectId; } catch { projectId = undefined; }
  const project = projectId ? await store.getProject(projectId) : undefined;
  let recorded: ProjectEvent | undefined;
  if (project) {
    const until = previous ? history.indexOf(previous) : -1;
    const now = options.now ?? Date.now();
    recorded = (await store.recordProjectEvent({ organizationId: project.organizationId ?? 'org_personal', projectId: project.id,
      source: ERROR_EVENT_SOURCE, type: DEPLOY_EVENT_TYPE, key: `deploy:${revision}:${now}`, subject: `tavya-revision:${revision}`,
      occurredAt: now, origin: 'external', hops: 0,
      payload: { revision, ...(previous ? { previous } : {}), commits: (until >= 0 ? history.slice(0, until) : history).slice(0, DEPLOY_COMMITS), host: os.hostname() } })).event;
  }
  await store.kvSet(DEPLOYED_REVISION_KEY, revision);
  return recorded;
}
