import crypto from 'node:crypto';
import os from 'node:os';
import type { ProjectEvent } from '../domain/project-events.js';

/**
 * Error reports — every unexpected error becomes one event in the project the
 * installation's operators chose (Installation → Error reports), where a
 * repeatable task fixes it (wiki features/error-reports).
 *
 * What counts as unexpected: a task stopped for a person by a failure its
 * workflow could not recover from, a console/API request answered 500, a
 * rejection nothing caught, and a lifecycle sweep step that failed. Expected
 * outcomes — a refusal (4xx), a quota or credential the organization must fix,
 * waiting for a machine — are not errors here.
 *
 * Events come from source `tavya`, which no caller of the events API can
 * claim (an emitted event's source is the caller: `user:…`, `task:…`), so only
 * the platform can start the fixer. Volume is bounded three times: one event
 * per error fingerprint per UTC day (the event key), one per fingerprint per
 * 10 minutes per process before touching the database, and 20 a minute per
 * process; the fixer's trigger then keeps one run at a time.
 */

export const ERROR_EVENT_TYPE = 'tavya.error';
export const ERROR_EVENT_SOURCE = 'tavya';
/** kv: `{"projectId": …}` — where reports go; absent = off. */
export const ERROR_REPORTS_KEY = 'installation:error-reports';

export type ErrorReportKind = 'escalation' | 'request' | 'rejection' | 'sweep';

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
}

interface ReportsStore {
  kvGet(key: string): Promise<string | undefined>;
  getProject(id: string): Promise<{ id: string; organizationId?: string } | undefined>;
  recordProjectEvent(input: Omit<ProjectEvent, 'id' | 'receivedAt'> & { receivedAt?: number }): Promise<{ event: ProjectEvent; created: boolean }>;
}

const PER_FINGERPRINT_MS = 10 * 60_000;
const PER_MINUTE = 20;
const SETTING_CACHE_MS = 30_000;

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

/** The first frame of tavya's own code, without line numbers (they move with every edit). */
export function ownFrame(stack: string | undefined): string | undefined {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const match = /\/(src\/[^\s:()]+\.[cm]?[jt]s)/.exec(line);
    if (match && !match[1]!.endsWith('platform/error-reports.ts')) {
      const fn = /at (?:async )?([\w.$<>]+) \(/.exec(line)?.[1];
      return fn ? `${match[1]} ${fn}` : match[1];
    }
  }
  return undefined;
}

/** One bug, one fingerprint: its kind, name, normalized message and own frame. */
export function errorFingerprint(kind: string, name: string, message: string, stack?: string): string {
  return crypto.createHash('sha256').update([kind, name, normalizeErrorMessage(message), ownFrame(stack) ?? ''].join('\n'))
    .digest('hex').slice(0, 16);
}

/** Credentials that error text sometimes carries (a URL with its token, a header). */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:ant-|proj-)?|xox[abpr]-|tv[aprs]_|AKIA)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]')
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1[redacted]@')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]');
}

function described(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    // An activity failure wraps the real error: name the innermost one.
    let inner: unknown = error;
    for (let depth = 0; depth < 5 && inner instanceof Error && inner.cause instanceof Error; depth++) inner = inner.cause;
    const root = inner as Error;
    return { name: root.name || error.name || 'Error', message: error.message || root.message || String(error),
      ...(error.stack ? { stack: error.stack } : {}) };
  }
  return { name: 'Error', message: typeof error === 'string' ? error : JSON.stringify(error) ?? String(error) };
}

export class ErrorReporter {
  private recent = new Map<string, number>();
  private minute = { start: 0, count: 0 };
  private setting?: { at: number; projectId?: string };

  constructor(private store: ReportsStore, private options: { now?: () => number; revision?: string; role?: string } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async destination(): Promise<string | undefined> {
    if (this.setting && this.now() - this.setting.at < SETTING_CACHE_MS) return this.setting.projectId;
    let projectId: string | undefined;
    try { projectId = (JSON.parse((await this.store.kvGet(ERROR_REPORTS_KEY)) ?? '{}') as { projectId?: unknown }).projectId as string | undefined; }
    catch { projectId = undefined; }
    this.setting = { at: this.now(), ...(typeof projectId === 'string' && projectId ? { projectId } : {}) };
    return this.setting.projectId;
  }

  /** Forget the cached destination (the setting just changed in this process). */
  invalidate(): void { this.setting = undefined; }

  /** The event recorded, or undefined when off, throttled or already reported today. */
  async report(input: ErrorReportInput): Promise<ProjectEvent | undefined> {
    const projectId = await this.destination();
    if (!projectId) return undefined;
    const { name, message, stack } = described(input.error);
    const fingerprint = errorFingerprint(input.kind, name, message, stack);
    const now = this.now();
    if (now - (this.recent.get(fingerprint) ?? -Infinity) < PER_FINGERPRINT_MS) return undefined;
    if (now - this.minute.start >= 60_000) this.minute = { start: now, count: 0 };
    if (this.minute.count >= PER_MINUTE) return undefined;
    this.minute.count++;
    this.recent.set(fingerprint, now);
    if (this.recent.size > 5_000) for (const [key, at] of this.recent) if (now - at >= PER_FINGERPRINT_MS) this.recent.delete(key);
    const project = await this.store.getProject(projectId);
    if (!project) return undefined;
    const text = scrubSecrets(message);
    const summary = `${name === 'Error' ? '' : `${name}: `}${text.split('\n')[0]!}`.replace(/\s+/g, ' ').trim().slice(0, 120);
    const payload: Record<string, unknown> = {
      fingerprint, kind: input.kind, summary, name, message: text.slice(0, 4_000),
      ...(stack ? { stack: scrubSecrets(stack).slice(0, 8_000) } : {}),
      ...(input.where ? { where: input.where } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(this.options.revision ? { revision: this.options.revision } : {}),
      host: os.hostname(), ...(this.options.role ? { process: this.options.role } : {}),
      occurredAt: new Date(now).toISOString(),
    };
    const { event, created } = await this.store.recordProjectEvent({
      organizationId: project.organizationId ?? 'org_personal', projectId, source: ERROR_EVENT_SOURCE, type: ERROR_EVENT_TYPE,
      key: `${fingerprint}:${new Date(now).toISOString().slice(0, 10)}`, subject: `tavya-error:${fingerprint}`,
      occurredAt: now, payload, origin: 'external', hops: 0,
    });
    return created ? event : undefined;
  }
}

let reporter: ErrorReporter | undefined;

/** This process reports through `store` from now on (execution-services.ts). */
export function configureErrorReports(store: ReportsStore, options: { revision?: string; role?: string } = {}): ErrorReporter {
  reporter = new ErrorReporter(store, {
    revision: options.revision ?? [process.env.KARMAX_BUILD_REVISION, process.env.GITHUB_SHA, process.env.SOURCE_VERSION].find(Boolean),
    ...(options.role ? { role: options.role } : {}),
  });
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
