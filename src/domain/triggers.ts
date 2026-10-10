/**
 * Task triggers (this feature). A **trigger** gates *when a task's workflow
 * starts* — it is orthogonal to what the workflow does, so it lives on the
 * generic task lifecycle (`TaskParams`, alongside `draft`), NOT in any single
 * workflow's manifest. A task with triggers is stored-not-started (like a draft)
 * and armed; a dispatcher starts it when its trigger expression is satisfied
 * (SPEC §3.3). Dependency triggers are prerequisites: they combine with a
 * schedule/event using AND, so reaching a scheduled time never bypasses
 * unfinished work. Multiple schedule/event activators remain alternatives.
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
import {
  eventSourceMatches, eventTypeMatches, filterMatches, validateFilter, validEventType,
  type EventFilter, type ProjectEvent,
} from './project-events.js';

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
  /** Event type to match, e.g. `github.issues.labeled`; `github.issues.*` matches a family. */
  type: string;
  /** Restrict to events from a specific source task (a task event, or one it emitted). */
  taskId?: string;
  /** Restrict project events to a source: `github`, `webhook:<id>`, `webhook` (any webhook), … */
  source?: string;
  /** Payload filter: dotted path → value or operator (`in`, `contains`, `matches`, `exists`). */
  where?: EventFilter;
  /** Re-arm after firing instead of disarming (default one-shot). */
  recurring?: boolean;
  /**
   * Project events only: at most one unfinished run per rendered key (`{{issue.number}}`;
   * empty = one per series). A further event is skipped, queued until that run
   * ends, or told to that run as a message (`tell`, for an agent's run).
   */
  concurrency?: { key?: string; mode?: 'skip' | 'queue' | 'tell' };
  /** Project events only: runs this trigger may start per hour (default 60); more wait. */
  maxPerHour?: number;
  /** Also fire on outside events that echo tavya's own actions (default: ignored). */
  includeSelf?: boolean;
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

/**
 * Optional graph context for `validateTriggers`.
 *
 * Dependency triggers describe a *graph*, and an unsatisfiable graph is invisible
 * at runtime: the dispatcher simply never fires, so the task sits `armed` forever
 * with no signal beyond the `is:blocked-on-deps` facet. The three unsatisfiable
 * shapes are self-reference, a cycle (A→B→A), and a dangling id (a dep that was
 * never created or has since been deleted). None of them is detectable from the
 * trigger list alone, so the caller supplies a resolver; when it does not, the
 * pure per-trigger checks still run exactly as before (back-compatible).
 */
export interface TriggerValidationContext {
  /** Id of the task these triggers belong to — needed to spot a self-dependency. */
  taskId?: string;
  /**
   * Resolve a task id to the ids IT depends on. Return `undefined` for a task
   * that does not exist (that is what makes a dangling dep detectable), and an
   * array (possibly empty) for one that does.
   */
  dependenciesOf?: (taskId: string) => string[] | undefined | Promise<string[] | undefined>;
}

/** Validate a trigger list, returning human-readable errors (empty ⇒ valid). */
export async function validateTriggers(triggers: TaskTrigger[], ctx: TriggerValidationContext = {}): Promise<string[]> {
  const errs: string[] = [];
  for (const t of triggers) {
    if (t.kind === 'dependency') {
      if (!t.tasks?.length) errs.push('dependency trigger needs at least one task id');
      errs.push(...(await validateDependencyGraph(t.tasks ?? [], ctx)));
    } else if (t.kind === 'schedule') {
      if (!t.cron && t.at === undefined) errs.push('schedule trigger needs a cron expression or an `at` time');
      // `cron` and `at` are alternatives, not a pair: `armSchedule` checks `at`
      // first and silently drops the cron, so the task fires once and then never
      // again despite showing a schedule. Reject the ambiguity instead.
      else if (t.cron && t.at !== undefined)
        errs.push('schedule trigger takes either a cron expression or an `at` time, not both');
      // A one-shot `at` cannot recur — there is no next occurrence to compute, so
      // `armSchedule` sets a single timer and `fireFor` (seeing `repeatable`) never
      // disarms: the task fires once and then stays armed forever with no timer.
      if (t.at !== undefined && !t.cron && t.recurring === true)
        errs.push('a one-shot `at` schedule cannot be recurring; use a cron expression');
      if (t.cron && !parseCron(t.cron)) errs.push(`invalid cron expression: "${t.cron}"`);
      // A parseable-but-impossible date (Feb 30) would otherwise be accepted and
      // then never fire, leaving a task permanently "armed" with no next run.
      // Reject it loudly at the point the user types it instead.
      else if (t.cron && nextCronFire(t.cron, 0) === undefined)
        errs.push(`cron expression never occurs: "${t.cron}"`);
    } else if (t.kind === 'event') {
      if (!t.type) errs.push('event trigger needs an event `type`');
      else if (t.type !== '*' && !validEventType(t.type.endsWith('.*') ? t.type.slice(0, -2) : t.type))
        errs.push(`invalid event type: "${t.type}"`);
      errs.push(...validateFilter(t.where));
      if (t.concurrency !== undefined && (typeof t.concurrency !== 'object' || t.concurrency === null
        || (t.concurrency.mode !== undefined && !['skip', 'queue', 'tell'].includes(t.concurrency.mode))
        || (t.concurrency.key !== undefined && typeof t.concurrency.key !== 'string')))
        errs.push('event trigger `concurrency` takes an optional `key` and a `mode` of skip, queue or tell');
      if (t.maxPerHour !== undefined && !(Number.isInteger(t.maxPerHour) && t.maxPerHour > 0))
        errs.push('event trigger `maxPerHour` must be a positive whole number');
    }
  }
  return errs;
}

/**
 * Reject self-reference, dangling ids, and cycles reachable from `deps`.
 *
 * The DFS follows `dependsOn` edges outward from each declared dependency. If it
 * ever reaches `ctx.taskId` the new trigger would close a cycle; if it reaches an
 * id the resolver does not know, the dependency can never be satisfied. Both are
 * reported once per offending id. Without a resolver only self-reference (which
 * needs no lookup) is checked.
 */
async function validateDependencyGraph(deps: string[], ctx: TriggerValidationContext): Promise<string[]> {
  const errs: string[] = [];
  const self = ctx.taskId;
  for (const dep of deps) {
    if (self && dep === self) { errs.push('a task cannot depend on itself'); continue; }
    if (!ctx.dependenciesOf) continue;
    if ((await ctx.dependenciesOf(dep)) === undefined) { errs.push(`dependency task ${dep} does not exist`); continue; }
    // Walk outward; `seen` also guards against pre-existing cycles elsewhere in
    // the graph so validation itself can never loop.
    const seen = new Set<string>([dep]);
    const stack = [dep];
    let cyclic = false;
    while (stack.length && !cyclic) {
      const next = (await ctx.dependenciesOf(stack.pop()!)) ?? [];
      for (const id of next) {
        if (self && id === self) { cyclic = true; break; }
        if (!seen.has(id)) { seen.add(id); stack.push(id); }
      }
    }
    if (cyclic) errs.push(`dependency on ${dep} would create a cycle`);
  }
  return errs;
}

// ─── Event matching (event + dependency triggers) ────────────────────────────

/** The lifecycle event dependency triggers listen on (the `view.updated` feed). */
export const LIFECYCLE_EVENT = 'view.updated';

/** Does a task event (the bus) satisfy an event trigger? A trigger bound to a
 *  project-event `source` never matches task events, nor does a bare `*`: the
 *  bus carries every agent's live output, and each candidate costs store reads. */
export function eventMatchesEventTrigger(t: EventTrigger, ev: KarmaxEvent): boolean {
  if (!t.type || t.type === '*' || t.source || !eventTypeMatches(t.type, ev.type)) return false;
  if (t.taskId && ev.taskId !== t.taskId) return false;
  return filterMatches(ev.payload, t.where);
}

/** Does a project event (the inbox) satisfy an event trigger? */
export function projectEventMatchesTrigger(t: EventTrigger, ev: ProjectEvent): boolean {
  if (!t.type || !eventTypeMatches(t.type, ev.type) || !eventSourceMatches(t.source, ev.source)) return false;
  if (t.taskId && ev.source !== `task:${t.taskId}`) return false;
  if (ev.origin === 'self' && !t.includeSelf) return false;
  return filterMatches(ev.payload, t.where);
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

/** Does this task start only once `taskId` has succeeded (and so landed)? */
export function awaitsSuccessOf(triggers: TaskTrigger[], taskId: string): boolean {
  return triggers.some((t) => t.kind === 'dependency' && t.tasks?.includes(taskId)
    && (t.on === undefined || t.on === 'success' || t.on === 'done')
    && ((t.mode ?? 'all') === 'all' || t.tasks.length === 1));
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
  const { triggers: _t, triggerState: _s, triggerLastFiredAt: _lf, triggerPending: _tp, draft: _d, repeatable: _r, runOf: _ro, trigger: _tc, ...rest } = params as Record<string, unknown>;
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
    // Day of week: 0 = Sunday. POSIX cron also accepts 7 for Sunday (`0 9 * * 7`
    // is what most crontabs in the wild write), so the field is parsed with 7 in
    // range and normalized to 0 below.
    [0, 7],
  ];
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(parts[i]!, spec[i]![0], spec[i]![1]);
    if (!s) return undefined;
    sets.push(s);
  }
  if (sets[4]!.delete(7)) sets[4]!.add(0); // 7 ≡ Sunday
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

/**
 * Parse one cron field into its allowed value set.
 *
 * Every numeric token is matched against `/^\d+$/` rather than being handed to
 * `Number()`. `Number('')` is 0 and `Number('+5')` is 5, both of which pass
 * `Number.isInteger` — so `'-5 * * * *'` used to parse as "minutes 0 through 5"
 * (the dash sits at index 0, making the low token empty) for every field whose
 * minimum is 0, and a task the user wrote as a typo silently ran six times an
 * hour. A strict digit test is the whole fix.
 */
function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const num = (token: string): number | undefined => (/^\d+$/.test(token) ? Number(token) : undefined);
  const out = new Set<number>();
  for (const piece of field.split(',')) {
    let range = piece;
    let step = 1;
    const slash = piece.indexOf('/');
    if (slash >= 0) {
      range = piece.slice(0, slash);
      const parsed = num(piece.slice(slash + 1));
      if (parsed === undefined || parsed <= 0) return undefined;
      step = parsed;
    }
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const dash = range.indexOf('-');
      if (dash >= 0) {
        const l = num(range.slice(0, dash));
        const h = num(range.slice(dash + 1));
        if (l === undefined || h === undefined) return undefined;
        lo = l;
        hi = h;
      } else {
        const l = num(range);
        if (l === undefined) return undefined;
        lo = l;
        // A bare number with a step (`5/15`) means "from 5 to the max, every
        // step" in standard cron — not just the single value 5.
        hi = slash >= 0 ? max : lo;
      }
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
  // Horizon must cover the largest legal gap between two cron fires, which is
  // Feb 29 across a century non-leap year (2096-02-29 → 2104-02-29, ~8 years).
  // A 366-day horizon silently returned undefined for every `* * 29 2 *`, and
  // the scheduler's undefined branch arms no timer at all — the task then sits
  // "armed" forever and never fires. The scan is cheap: the loop steps by
  // month/day/hour, so the worst case is a few thousand day-steps.
  const limit = fromMs + 8 * 366 * 24 * 3600 * 1000;
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
