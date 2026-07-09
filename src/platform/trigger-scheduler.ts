import type { Store } from '../store/db.js';
import type { KarmaxBus } from '../contrib/bus.js';
import type { KarmaxEvent, TaskRecord, TaskTrigger } from '../domain/types.js';
import {
  normalizeTriggers,
  eventMatchesEventTrigger,
  statusSatisfiesDependency,
  dependencyMet,
  nextCronFire,
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
    for (const task of this.deps.store.listArmedTasks()) this.arm(task);
    this.unsub = this.deps.bus.onAny((ev) => this.onEvent(ev));
    const n = this.armed.size;
    if (n) this.log(`trigger dispatcher armed ${n} task(s)`);
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

  /** Arm (or re-arm) a task: register its triggers, seed dependency state, set timers. */
  arm(task: TaskRecord): void {
    const triggers = normalizeTriggers(task.params);
    if (!triggers.length) return;
    this.disarm(task.id); // idempotent re-arm
    const entry: ArmedEntry = { task, triggers, satisfiedDeps: new Set(), timers: [], fired: false };
    this.armed.set(task.id, entry);

    // Seed dependency satisfaction from already-recorded statuses (a dep may have
    // completed before this task was armed, or while karmax was down).
    for (const trig of triggers) {
      if (trig.kind !== 'dependency') continue;
      for (const dep of trig.tasks ?? []) {
        const status = this.deps.store.getTask(dep)?.lastView?.status;
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
      for (const trig of entry.triggers) {
        if (entry.fired) break;
        if (trig.kind === 'event' && eventMatchesEventTrigger(trig, ev)) this.fireFor(entry, trig);
      }
      if (entry.fired || !this.armed.has(entry.task.id)) continue;
      // `dependency` triggers: fold the event into satisfaction, then re-evaluate.
      let advanced = false;
      for (const trig of entry.triggers) {
        if (trig.kind === 'dependency') advanced = this.applyDependencyEvent(entry, trig, ev) || advanced;
      }
      if (advanced) this.evaluate(entry);
    }
  }

  /** Update dependency satisfaction from a lifecycle event; returns true if it advanced. */
  private applyDependencyEvent(entry: ArmedEntry, trig: DependencyTrigger, ev: KarmaxEvent): boolean {
    if (ev.type !== LIFECYCLE_EVENT) return false;
    if (!(trig.tasks ?? []).includes(ev.taskId)) return false;
    const status = (ev.payload as { status?: string })?.status;
    if (status && statusSatisfiesDependency(trig.on, status)) {
      entry.satisfiedDeps.add(ev.taskId);
      return true;
    }
    return false;
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
          const t = this.deps.store.getTask(taskId);
          if (t?.params?.triggerState === 'armed') this.arm(t);
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
    if (trig.cron) this.armCron(entry, trig);
  }

  private armCron(entry: ArmedEntry, trig: ScheduleTrigger): void {
    const next = nextCronFire(trig.cron!, this.now());
    if (next === undefined) {
      this.log(`cron trigger for ${entry.task.id} has no upcoming fire ("${trig.cron}")`);
      return;
    }
    this.armAt(entry, next, () => {
      // Cron is recurring: fire a clone, then re-arm for the next occurrence.
      this.fireFor(entry, trig);
      if (this.armed.get(entry.task.id) === entry) this.armCron(entry, trig);
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
