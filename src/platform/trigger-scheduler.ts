import type { Store } from '../store/db.js';
import type { KarmaxBus } from '../contrib/bus.js';
import type { KarmaxEvent, TaskRecord, TaskTrigger } from '../domain/types.js';
import {
  normalizeTriggers,
  eventMatchesEventTrigger,
  statusSatisfiesDependency,
  dependencyMet,
  nextCronFire,
  validateTriggers,
  LIFECYCLE_EVENT,
  type DependencyTrigger,
  type ScheduleTrigger,
} from '../domain/triggers.js';

/**
 * The trigger dispatcher (SPEC §3.3). Triggers gate *when* a task's workflow
 * starts; the task is stored-not-started and *armed*, and this service starts it
 * when a trigger is satisfied. It is the reactive transport layer that sits
 * *underneath* control flow — it never becomes the control flow — exactly the
 * role the spec reserves for the dispatcher.
 *
 * It watches three signals, unified through one code path:
 *  - the event bus (`bus.onAny`) — for `event` triggers and `dependency`
 *    triggers (which listen on the `view.updated` lifecycle feed);
 *  - wall-clock timers — for `schedule` (cron / one-shot `at`) triggers.
 *
 * Durable source of truth is the **store**: armed tasks carry `triggerState:
 * 'armed'` in their params, so on boot `start()` re-arms every one — a cron that
 * should have fired while karmax was down fires on the next boot, and dependency
 * state is re-derived from each dep's last recorded status. Runs in-process off
 * the same bus the self-heal loop uses (main.ts), so no new durable machinery.
 *
 * **Cron catch-up is real, not aspirational.** `nextCronFire` is strictly after
 * the instant it is given, so nothing in the expression itself can express "the
 * 09:00 run you missed". The mark that makes it representable is
 * `params.triggerLastFiredAt`: it is seeded when a cron task is armed and moved
 * forward to the *scheduled* instant of every fire, so on boot `arm()` can ask
 * "did an occurrence fall between the mark and now?" and, if so, fire exactly
 * once before arming the next timer. Exactly once, not once per missed
 * occurrence: a nightly report that slept through a week's downtime wants today's
 * run, not seven simultaneous ones.
 */

export interface TriggerSchedulerDeps {
  store: Store;
  bus: KarmaxBus;
  /**
   * Start an armed task because a trigger fired. `self` starts the armed task
   * itself (one-shot); `clone` spawns a fresh copy that runs now and leaves the
   * armed template in place (recurring — cron, or a re-arming event trigger).
   */
  fire: (taskId: string, mode: 'self' | 'clone') => Promise<unknown>;
  /** Injectable clock/timers (tests drive them; prod uses wall-clock). */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  log?: (msg: string) => void;
}

interface ArmedEntry {
  task: TaskRecord;
  triggers: TaskTrigger[];
  /** Dependency task ids observed satisfied so far. */
  satisfiedDeps: Set<string>;
  timers: unknown[];
  /** Guards a one-shot entry from double-firing across overlapping events. */
  fired: boolean;
}

// Node's setTimeout caps at ~24.8 days; re-arm long waits in chunks below this.
const MAX_TIMER_MS = 20 * 24 * 3600 * 1000;

/** How far back a boot looks for a missed cron occurrence. Long enough to cover a
 *  weekly schedule and a realistic outage; short enough that a per-minute cron
 *  costs ~10k cheap `nextCronFire` steps rather than an unbounded replay. */
const MAX_CATCHUP_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Hard stop on the catch-up walk, so no expression can make boot pathological. */
const MAX_CATCHUP_STEPS = 20_000;

export class TriggerScheduler {
  private armed = new Map<string, ArmedEntry>();
  private unsub?: () => void;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (h: unknown) => void;
  private log: (msg: string) => void;

  constructor(private deps: TriggerSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = deps.log ?? (() => {});
  }

  /** Subscribe to the bus and re-arm every stored armed task (call once on boot). */
  start(): void {
    for (const task of this.deps.store.listArmedTasks()) {
      // A stored task can have become invalid since it was armed — most often a
      // dependency task that has since been deleted. Boot must never die on one
      // bad row, so the refusal is logged per task and the rest still arm.
      try {
        this.arm(task);
      } catch (e) {
        this.log(`refusing to arm ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.unsub = this.deps.bus.onAny((ev) => this.onEvent(ev));
    const n = this.armed.size;
    if (n) this.log(`trigger dispatcher armed ${n} task(s)`);
  }

  /**
   * Validate a task's trigger graph against the live store.
   *
   * `validateTriggers` is pure, so the *graph* half of validation (self-reference,
   * cycles, dangling dependency ids) can only run where a store is in reach —
   * here. Dependency ids are matched the way `arm()` matches them: by declared id,
   * with `attemptGroup` folding alternate attempts onto one logical task.
   */
  validationErrors(task: TaskRecord): string[] {
    const dependenciesOf = (id: string): string[] | undefined => {
      const t = this.deps.store.getTask(id);
      if (!t) return undefined;
      const out: string[] = [];
      for (const trig of normalizeTriggers(t.params)) if (trig.kind === 'dependency') out.push(...(trig.tasks ?? []));
      return out;
    };
    return validateTriggers(normalizeTriggers(task.params), { taskId: task.id, dependenciesOf });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = undefined;
    for (const e of this.armed.values()) for (const t of e.timers) this.clearTimer(t);
    this.armed.clear();
  }

  /** Number of tasks currently armed (used by tests / diagnostics). */
  get size(): number {
    return this.armed.size;
  }

  /**
   * Arm (or re-arm) a task: register its triggers, seed dependency state, set timers.
   *
   * Throws on an unsatisfiable dependency graph rather than arming it. An armed
   * task with a self-dependency, a cycle, or a deleted dep is indistinguishable
   * from one that is simply still waiting — it would sit `armed` forever with no
   * signal — so the loud failure at the moment someone tries to arm it is the only
   * place a human can act on it. `start()` catches this per task so boot is safe.
   */
  arm(task: TaskRecord): void {
    const triggers = normalizeTriggers(task.params);
    if (!triggers.length) return;
    const errs = this.validationErrors(task);
    if (errs.length) throw new Error(`invalid trigger(s): ${errs.join('; ')}`);
    this.disarm(task.id); // idempotent re-arm
    const entry: ArmedEntry = { task, triggers, satisfiedDeps: new Set(), timers: [], fired: false };
    this.armed.set(task.id, entry);

    // Seed dependency satisfaction from already-recorded statuses (a dep may have
    // completed before this task was armed, or while karmax was down).
    for (const trig of triggers) {
      if (trig.kind !== 'dependency') continue;
      for (const dep of trig.tasks ?? []) {
        const group = this.deps.store.attemptGroup(dep);
        const status = group
          ? group.attempts.find((a) => a.id === group.principalAttemptId)?.lastView?.status
          : this.deps.store.getTask(dep)?.lastView?.status;
        if (status && statusSatisfiesDependency(trig.on, status)) entry.satisfiedDeps.add(dep);
      }
    }

    // Arm time-based triggers.
    for (const trig of triggers) {
      if (trig.kind === 'schedule') this.armSchedule(entry, trig);
    }

    // A dependency/event trigger may already be satisfied at arm time.
    this.evaluate(entry);
  }

  disarm(taskId: string): void {
    const e = this.armed.get(taskId);
    if (!e) return;
    for (const t of e.timers) this.clearTimer(t);
    this.armed.delete(taskId);
  }

  // ─── Event routing ─────────────────────────────────────────────────────────

  private onEvent(ev: KarmaxEvent): void {
    // Copy: firing mutates the map (one-shot disarm).
    for (const entry of [...this.armed.values()]) {
      if (entry.fired) continue;
      // `event` triggers: a direct type/scope/payload match fires immediately.
      // `firedNow` is load-bearing for a REPEATABLE series: `entry.fired` is only
      // ever set for one-shots, so without it a single event that matched two of
      // the entry's triggers spawned two runs of the same series.
      let firedNow = false;
      for (const trig of entry.triggers) {
        if (entry.fired || firedNow) break;
        if (trig.kind === 'event' && eventMatchesEventTrigger(trig, ev)) firedNow = this.fireFor(entry, trig);
      }
      if (entry.fired || firedNow || !this.armed.has(entry.task.id)) continue;
      // `dependency` triggers: fold the event into satisfaction, then re-evaluate.
      let advanced = false;
      for (const trig of entry.triggers) {
        if (trig.kind === 'dependency') advanced = this.applyDependencyEvent(entry, trig, ev) || advanced;
      }
      if (advanced) this.evaluate(entry);
    }
  }

  /**
   * Update dependency satisfaction from a lifecycle event; returns true if it
   * advanced (i.e. a dep just became satisfied that was not before).
   *
   * `satisfiedDeps` is a LEVEL, re-derived from each dep's current status, and the
   * entry fires on the rising edge. That single rule serves both masters:
   *  - duplicate terminal `view.updated` events (a finishing task emits several)
   *    leave the level unchanged, so a repeatable series — which never sets
   *    `fired` — does not re-spawn a run per event; and
   *  - a dep that genuinely RUNS AGAIN first reports a non-terminal status, which
   *    drops it back out of the set, so the series fires again when it next
   *    completes. While the set was append-only, a repeatable dependency series
   *    fired at most once in its whole life and then sat armed doing nothing.
   */
  private applyDependencyEvent(entry: ArmedEntry, trig: DependencyTrigger, ev: KarmaxEvent): boolean {
    if (ev.type !== LIFECYCLE_EVENT) return false;
    const eventTask = this.deps.store.getTask(ev.taskId);
    const eventIntent = eventTask?.intentId ?? ev.taskId;
    let advanced = false;
    for (const dep of trig.tasks ?? []) {
      const declared = this.deps.store.getTask(dep);
      if ((declared?.intentId ?? dep) !== eventIntent) continue;
      // Read the logical task's CURRENT principal after Store.saveView has run.
      // Cancelling one attempt therefore cannot satisfy `settled` while another
      // eligible attempt remains; the eventual winner's outcome can.
      const group = this.deps.store.attemptGroup(eventIntent);
      const principal = group?.attempts.find((a) => a.id === group.principalAttemptId);
      const status = group
        ? principal?.lastView?.status ?? (principal?.id === ev.taskId ? (ev.payload as { status?: string })?.status : undefined)
        : (ev.payload as { status?: string })?.status;
      if (!status) continue;
      if (statusSatisfiesDependency(trig.on, status)) {
        if (!entry.satisfiedDeps.has(dep)) {
          entry.satisfiedDeps.add(dep); // dependencyMet keys by the declared id
          advanced = true;
        }
      } else {
        // The dep left the satisfying state — it is running again. Arm the edge.
        entry.satisfiedDeps.delete(dep);
      }
    }
    return advanced;
  }

  // ─── Firing ────────────────────────────────────────────────────────────────

  /** Evaluate all of an entry's non-time triggers; fire if any is satisfied. */
  private evaluate(entry: ArmedEntry): void {
    if (entry.fired) return;
    for (const trig of entry.triggers) {
      if (trig.kind === 'dependency' && dependencyMet(trig, entry.satisfiedDeps)) {
        this.fireFor(entry, trig);
        return;
      }
    }
  }

  /**
   * Fire an entry for a specific trigger. A repeatable series spawns a run
   * (`clone`) and stays armed; a one-off starts itself (`self`), disarming first
   * (prevents double fire) and re-arming on a start failure so a fire is never
   * silently lost. Returns true if a fire was initiated.
   */
  private fireFor(entry: ArmedEntry, trig: TaskTrigger): boolean {
    if (entry.fired) return false;
    const repeatable = !!entry.task.params?.repeatable;
    const taskId = entry.task.id;
    if (!repeatable) {
      entry.fired = true;
      this.disarm(taskId);
    }
    void this.deps
      .fire(taskId, repeatable ? 'clone' : 'self')
      .then(() => this.log(`trigger fired for ${taskId} (${trig.kind}, ${repeatable ? 'run' : 'self'})`))
      .catch((e) => {
        this.log(`trigger fire failed for ${taskId}: ${e instanceof Error ? e.message : String(e)}`);
        if (!repeatable) {
          // api re-arms the task row on failure; re-arm the in-memory entry too.
          // `arm()` THROWS on an invalid graph (e.g. a dependency deleted since
          // this task was armed), and this is a `.catch()` on a `void`ed chain —
          // so an unguarded throw becomes an unhandled rejection and leaves the
          // task armed in the store but absent from the scheduler: it never
          // fires again, and nothing says so. Guard it exactly as `start()` does.
          try {
            const t = this.deps.store.getTask(taskId);
            if (t?.params?.triggerState === 'armed') this.arm(t);
          } catch (err) {
            this.log(`refusing to re-arm ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });
    return true;
  }

  // ─── Schedule (cron / at) ────────────────────────────────────────────────────

  private armSchedule(entry: ArmedEntry, trig: ScheduleTrigger): void {
    if (trig.at !== undefined) {
      this.armAt(entry, trig.at, () => this.fireFor(entry, trig));
      return;
    }
    if (trig.cron) {
      // Catch up on a window missed while karmax was down, then arm the next one.
      // The catch-up can itself disarm a (non-repeatable) entry, so re-check.
      const mark = this.catchUpCron(entry, trig);
      if (this.armed.get(entry.task.id) === entry) this.armCron(entry, trig, mark);
    }
  }

  /**
   * Fire once now if a cron occurrence elapsed since this task's recorded mark,
   * and return the instant subsequent scheduling should measure from.
   *
   * The mark (`params.triggerLastFiredAt`) is seeded on first arm so a task that
   * has never fired does not retroactively fire for occurrences that predate it.
   *
   * The catch-up run is for the *most recent* missed occurrence, not the oldest:
   * a nightly report that slept through a week of downtime wants today's run.
   * Firing the oldest would also mean the mark only advanced one occurrence per
   * boot, so a restart loop would replay history one step at a time.
   */
  private catchUpCron(entry: ArmedEntry, trig: ScheduleTrigger): number {
    const now = this.now();
    const mark = entry.task.params?.triggerLastFiredAt;
    if (typeof mark !== 'number') {
      this.recordCronFire(entry, now);
      return now;
    }
    // Only look back a bounded window: an install that was off for a year should
    // not walk a per-minute cron through half a million occurrences at boot.
    let cursor = Math.max(mark, now - MAX_CATCHUP_WINDOW_MS);
    let last: number | undefined;
    for (let i = 0; i < MAX_CATCHUP_STEPS; i++) {
      const next = nextCronFire(trig.cron!, cursor);
      if (next === undefined || next > now) break;
      last = next;
      cursor = next;
    }
    if (last === undefined) return mark;
    this.log(`cron catch-up for ${entry.task.id}: occurrence at ${new Date(last).toISOString()} was missed`);
    this.recordCronFire(entry, last);
    this.fireFor(entry, trig);
    return last;
  }

  /** Persist the cron mark so catch-up survives a restart. */
  private recordCronFire(entry: ArmedEntry, whenMs: number): void {
    const params = { ...entry.task.params, triggerLastFiredAt: whenMs };
    entry.task = { ...entry.task, params };
    try {
      this.deps.store.updateTaskParams(entry.task.id, params);
    } catch (e) {
      // A vanished row must not kill the timer chain; the in-memory mark still
      // dedupes for this process's lifetime.
      this.log(`could not record cron fire for ${entry.task.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Arm the next cron occurrence strictly after `fromMs`.
   *
   * `fromMs` is threaded through deliberately instead of being re-read from the
   * clock. The timer callback used to call `nextCronFire(cron, this.now())`, and
   * `nextCronFire` floors to the whole minute — so if `now()` read even 1 ms
   * before the instant that had just fired (a backward NTP step, a VM resume, an
   * early libuv timer), it returned that same instant, `armAt` clamped the delay
   * to 0, and the occurrence fired a second time. Nothing downstream dedupes it:
   * `fireFor` sets no `fired` flag for a repeatable entry.
   */
  private armCron(entry: ArmedEntry, trig: ScheduleTrigger, fromMs: number): void {
    const next = nextCronFire(trig.cron!, fromMs);
    if (next === undefined) {
      this.log(`cron trigger for ${entry.task.id} has no upcoming fire ("${trig.cron}")`);
      return;
    }
    this.armAt(entry, next, () => {
      // Cron is recurring: fire a clone, then re-arm for the next occurrence,
      // measured from the SCHEDULED instant (never from the wall clock).
      this.recordCronFire(entry, next);
      this.fireFor(entry, trig);
      if (this.armed.get(entry.task.id) === entry) this.armCron(entry, trig, next);
    });
  }

  /** Set a (possibly very long) timer that fires `onDue` at absolute time `whenMs`. */
  private armAt(entry: ArmedEntry, whenMs: number, onDue: () => void): void {
    const delay = Math.max(0, whenMs - this.now());
    if (delay > MAX_TIMER_MS) {
      const h = this.setTimer(() => {
        entry.timers = entry.timers.filter((t) => t !== h);
        if (this.armed.get(entry.task.id) === entry) this.armAt(entry, whenMs, onDue);
      }, MAX_TIMER_MS);
      entry.timers.push(h);
      return;
    }
    const h = this.setTimer(() => {
      entry.timers = entry.timers.filter((t) => t !== h);
      onDue();
    }, delay);
    entry.timers.push(h);
  }
}
