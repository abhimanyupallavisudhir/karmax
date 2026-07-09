/**
 * Task triggers (this feature). A **trigger** gates *when a task's workflow
 * starts* — it is orthogonal to what the workflow does, so it lives on the
 * generic task lifecycle (`TaskParams`, alongside `draft`), NOT in any single
 * workflow's manifest. A task with triggers is stored-not-started (like a draft)
 * and armed; a dispatcher starts it when a trigger is satisfied (SPEC §3.3).
 *
 * This module is PURE (no Node/Temporal imports) so it is safe to import from
 * the deterministic workflow sandbox, the platform API, and the dispatcher, and
 * so its cron/matching logic is cheaply unit-testable without a Temporal server.
 *
 * Three trigger kinds, deliberately unified:
 *  - `event`      — the general form: fire when any karmax event (SPEC §5) whose
 *                   `type` matches occurs (optionally scoped to a source task and
 *                   filtered by payload). This is what "support all general karmax
 *                   event triggers" means — one mechanism for GitHub webhooks,
 *                   world lifecycle, quota refills, etc.
 *  - `dependency` — ergonomic sugar over `event`: fire when other task(s) reach a
 *                   terminal state. Modelled explicitly because "run B after A" is
 *                   the overwhelmingly common case and deserves a first-class shape.
 *  - `schedule`   — time-based: a cron expression (recurring) or a one-shot `at`.
 */

import type { KarmaxEvent } from './types.js';

// ─── Trigger shapes ──────────────────────────────────────────────────────────

/** Which lifecycle outcome of a dependency task satisfies the trigger. */
export type DependencyOn = 'done' | 'success' | 'failed' | 'settled';

export interface DependencyTrigger {
  kind: 'dependency';
  /** Source task ids this task waits on. */
  tasks: string[];
  /** Outcome that counts as satisfied (default `success` — the "run B after A succeeds" case). */
  on?: DependencyOn;
  /** `all` = wait for every dep (default); `any` = fire on the first. */
  mode?: 'all' | 'any';
}

export interface ScheduleTrigger {
  kind: 'schedule';
  /** Standard 5-field cron (min hour dom month dow), evaluated in UTC. Recurring. */
  cron?: string;
  /** One-shot absolute epoch-ms fire time (alternative to `cron`). */
  at?: number;
  /**
   * `true` (cron default): each fire spawns a fresh clone that runs immediately;
   * the armed template stays armed. `false` (the default for `at`): fire once,
   * then the armed task itself starts and is disarmed.
   */
  recurring?: boolean;
}

export interface EventTrigger {
  kind: 'event';
  /** Event type to match, e.g. `software-dev.stage-changed` or `github.pr-merged`. */
  type: string;
  /** Restrict to events from a specific source task (optional). */
  taskId?: string;
  /** Shallow payload equality filter — every key must match the event payload. */
  where?: Record<string, unknown>;
  /** Re-arm after firing instead of disarming (default one-shot). */
  recurring?: boolean;
}

export type TaskTrigger = DependencyTrigger | ScheduleTrigger | EventTrigger;

/** Lifecycle marker stored on a triggered task's params. */
export type TriggerState = 'armed' | 'fired';

// ─── Normalization ───────────────────────────────────────────────────────────

/** Terminal statuses a task workflow settles into (mirrors reconcile.ts). */
export const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'] as const;

/** Read the trigger list off arbitrary task params, tolerating a single object. */
export function normalizeTriggers(params: unknown): TaskTrigger[] {
  const raw = (params as { triggers?: unknown } | undefined)?.triggers;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.filter(isTrigger);
}

export function isTrigger(t: unknown): t is TaskTrigger {
  if (!t || typeof t !== 'object') return false;
  const k = (t as TaskTrigger).kind;
  return k === 'dependency' || k === 'schedule' || k === 'event';
}

/** Does this task want to be gated behind a trigger (vs starting immediately)? */
export function hasActiveTriggers(params: unknown): boolean {
  return normalizeTriggers(params).length > 0;
}

/** Validate a trigger list, returning human-readable errors (empty ⇒ valid). */
export function validateTriggers(triggers: TaskTrigger[]): string[] {
  const errs: string[] = [];
  for (const t of triggers) {
    if (t.kind === 'dependency') {
      if (!t.tasks?.length) errs.push('dependency trigger needs at least one task id');
    } else if (t.kind === 'schedule') {
      if (!t.cron && t.at === undefined) errs.push('schedule trigger needs a cron expression or an `at` time');
      if (t.cron && !parseCron(t.cron)) errs.push(`invalid cron expression: "${t.cron}"`);
    } else if (t.kind === 'event') {
      if (!t.type) errs.push('event trigger needs an event `type`');
    }
  }
  return errs;
}

// ─── Event matching (event + dependency triggers) ────────────────────────────

/** The lifecycle event dependency triggers listen on (the `view.updated` feed). */
export const LIFECYCLE_EVENT = 'view.updated';

/** Does a karmax event satisfy a single event/dependency trigger for one dep? */
export function eventMatchesEventTrigger(t: EventTrigger, ev: KarmaxEvent): boolean {
  if (ev.type !== t.type) return false;
  if (t.taskId && ev.taskId !== t.taskId) return false;
  if (t.where) {
    for (const [k, v] of Object.entries(t.where)) {
      if ((ev.payload as Record<string, unknown>)?.[k] !== v) return false;
    }
  }
  return true;
}

/** Does a status count as satisfying a dependency `on` condition? */
export function statusSatisfiesDependency(on: DependencyOn | undefined, status: string): boolean {
  const cond = on ?? 'success';
  switch (cond) {
    case 'done':
      return status === 'done';
    case 'success':
      return status === 'done';
    case 'failed':
      return status === 'failed';
    case 'settled':
      return (TERMINAL_STATUSES as readonly string[]).includes(status);
  }
}

/**
 * Given which dependency tasks are currently satisfied, is the dependency
 * trigger as a whole met? (`all` ⇒ every dep; `any` ⇒ at least one.)
 */
export function dependencyMet(t: DependencyTrigger, satisfied: ReadonlySet<string>): boolean {
  const deps = t.tasks ?? [];
  if (!deps.length) return false;
  return (t.mode ?? 'all') === 'any' ? deps.some((d) => satisfied.has(d)) : deps.every((d) => satisfied.has(d));
}

// ─── Recurrence ──────────────────────────────────────────────────────────────

/** A recurring trigger spawns a fresh clone each fire; a one-shot starts the task itself. */
export function isRecurring(t: TaskTrigger): boolean {
  if (t.kind === 'schedule') return t.at === undefined ? t.recurring !== false : t.recurring === true;
  if (t.kind === 'event') return t.recurring === true;
  return false; // dependency triggers are one-shot
}

/**
 * Does this trigger set force the task to be a repeatable series? A cron (or any
 * other recurring) trigger fires forever, so its task can't be a one-off.
 */
export function forcesRepeatable(triggers: TaskTrigger[]): boolean {
  return triggers.some((t) => t.kind === 'schedule' && !!t.cron) || triggers.some(isRecurring);
}

/** Params for a run spawned from a series: the original minus trigger + series metadata. */
export function cloneParamsWithoutTriggers<T extends Record<string, unknown>>(params: T): T {
  const { triggers: _t, triggerState: _s, draft: _d, repeatable: _r, runOf: _ro, ...rest } = params as Record<string, unknown>;
  return rest as T;
}

// ─── Cron (pure, UTC) ────────────────────────────────────────────────────────

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

/** Parse a standard 5-field cron expression into per-field allowed sets (UTC). */
export function parseCron(expr: string): CronFields | undefined {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const spec: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 6], // day of week (0 = Sunday)
  ];
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(parts[i]!, spec[i]![0], spec[i]![1]);
    if (!s) return undefined;
    sets.push(s);
  }
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dom: sets[2]!,
    month: sets[3]!,
    dow: sets[4]!,
    domStar: parts[2] === '*',
    dowStar: parts[4] === '*',
  };
}

function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const out = new Set<number>();
  for (const piece of field.split(',')) {
    let range = piece;
    let step = 1;
    const slash = piece.indexOf('/');
    if (slash >= 0) {
      range = piece.slice(0, slash);
      step = Number(piece.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return undefined;
    }
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const dash = range.indexOf('-');
      if (dash >= 0) {
        lo = Number(range.slice(0, dash));
        hi = Number(range.slice(dash + 1));
      } else {
        lo = hi = Number(range);
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return undefined;
      if (lo < min || hi > max || lo > hi) return undefined;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : undefined;
}

/**
 * Next fire time strictly after `fromMs` for a cron expression, in UTC epoch-ms,
 * or undefined if it can't be parsed / nothing matches within a year. Day-of-month
 * and day-of-week combine with OR when both are restricted (standard cron rule).
 */
export function nextCronFire(expr: string, fromMs: number): number | undefined {
  const f = parseCron(expr);
  if (!f) return undefined;
  // Start at the next whole minute after `fromMs`.
  const d = new Date(Math.floor(fromMs / 60000) * 60000 + 60000);
  const limit = fromMs + 366 * 24 * 3600 * 1000;
  while (d.getTime() <= limit) {
    const month = d.getUTCMonth() + 1;
    if (!f.month.has(month)) {
      // Jump to the first of next month, midnight UTC.
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(f, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hour.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!f.minute.has(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return undefined;
}

function dayMatches(f: CronFields, d: Date): boolean {
  const domOk = f.dom.has(d.getUTCDate());
  const dowOk = f.dow.has(d.getUTCDay());
  // Standard cron: if both DOM and DOW are restricted, either matching fires.
  if (!f.domStar && !f.dowStar) return domOk || dowOk;
  if (!f.domStar) return domOk;
  if (!f.dowStar) return dowOk;
  return true; // both `*`
}
