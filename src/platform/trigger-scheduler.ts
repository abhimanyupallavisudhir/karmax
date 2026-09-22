import type { Store } from '../store/db.js';
import type { KarmaxBus } from '../contrib/bus.js';
import type { KarmaxEvent, TaskRecord, TaskTrigger } from '../domain/types.js';
import type { KarmaxApi } from './api.js';
import type { TokenAuthority } from './tokens.js';
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
 * when its trigger expression is satisfied. Dependencies are prerequisites:
 * every dependency trigger must be met AND a schedule/event activator must have
 * occurred (or dependency completion itself activates a dependency-only task).
 * It is the reactive transport layer that sits
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

/** The dispatcher outlives principal-token TTLs. Give each start its own bounded
 * credential and release it once the API operation completes. */
export function createTriggerFire(api: Pick<KarmaxApi, 'fireTriggeredTask'>, tokens: TokenAuthority): TriggerSchedulerDeps['fire'] {
  return async (taskId, mode) => {
    const { token } = (await tokens.mintPrincipal('system:triggers', ['*'], undefined, 10 * 60_000));
    try {
      return await api.fireTriggeredTask(token, taskId, mode);
    } finally {
      (await tokens.revoke(token));
    }
  };
}

interface ArmedEntry {
  task: TaskRecord;
  triggers: TaskTrigger[];
  /** Dependency task ids observed satisfied so far. */
  satisfiedDeps: Set<string>;
  /**
   * A non-dependency trigger has occurred and is waiting for its dependency
   * prerequisites. Persisted on the task so a restart cannot lose a due time or
   * matching event while the prerequisites are still running.
   */
  activationPending: boolean;
  /** A pending activation has been claimed by an asynchronous workflow/run start. */
  activationInFlight: boolean;
  timers: unknown[];
  /** Guards a one-shot entry from double-firing across overlapping events. */
  fired: boolean;
  retryTimer?: unknown;
  retryDelay: number;
}

// Node's setTimeout caps at ~24.8 days; re-arm long waits in chunks below this.
const MAX_TIMER_MS = 20 * 24 * 3600 * 1000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

/** How far back a boot looks for a missed cron occurrence. Long enough to cover a
 *  weekly schedule and a realistic outage; short enough that a per-minute cron
 *  costs ~10k cheap `nextCronFire` steps rather than an unbounded replay. */
const MAX_CATCHUP_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Hard stop on the catch-up walk, so no expression can make boot pathological. */
const MAX_CATCHUP_STEPS = 20_000;

export class TriggerScheduler {
  private armed = new Map<string, ArmedEntry>();
  private eventTail: Promise<void> = Promise.resolve();
  private pendingOperations = new Set<Promise<unknown>>();
  private epoch = 0;
  private versions = new Map<string, number>();
  private unsub?: () => void;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (h: unknown) => void;
  private log: (msg: string) => void;

  constructor(private deps: TriggerSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    const schedule = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.setTimer = (fn, ms) => schedule(() => this.track(Promise.resolve().then(fn)), ms);
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = deps.log ?? (() => {});
  }

  /** Subscribe to the bus and re-arm every stored armed task (call once on boot). */
  async start(): Promise<void> {
    const startEpoch = this.epoch;
    for (const task of (await this.deps.store.listArmedTasks())) {
      // A stored task can have become invalid since it was armed — most often a
      // dependency task that has since been deleted. Boot must never die on one
      // bad row, so the refusal is logged per task and the rest still arm.
      try {
        if (this.epoch !== startEpoch) return;
        (await this.arm(task));
      } catch (e) {
        this.log(`refusing to arm ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (this.epoch !== startEpoch) return;
    const epoch = this.epoch;
    this.unsub = this.deps.bus.onAny(ev => {
      // Do not retain high-volume output or perform attribution reads unless
      // an already-armed trigger could consume this event. Capture entry
      // identities now: an old queued event cannot activate a later re-arm.
      const candidates = [...this.armed.values()].filter(entry => !entry.fired && entry.triggers.some(trigger =>
        trigger.kind === 'event' ? eventMatchesEventTrigger(trigger, ev)
          : trigger.kind === 'dependency' && ev.type === LIFECYCLE_EVENT));
      if (!candidates.length) return;
      // Lifecycle edges must not overtake one another while attribution reads
      // yield. A stopped/restarted scheduler must not consume its old backlog.
      const next = this.eventTail.then(() => this.epoch === epoch ? this.onEvent(ev, candidates) : undefined);
      this.eventTail = next.catch(error => this.log(`trigger event failed: ${String(error)}`));
      return next;
    });
    const n = this.armed.size;
    if (n) this.log(`trigger dispatcher armed ${n} task(s)`);
  }

  private async organizationOfTask(taskId: string, task?: TaskRecord): Promise<string | undefined> {
    task ??= await this.deps.store.taskMetadata(taskId);
    const projectId = task?.projectId;
    return projectId ? (await this.deps.store.getProject(projectId))?.organizationId ?? 'org_personal' : undefined;
  }

  /**
   * Validate a task's trigger graph against the live store.
   *
   * `validateTriggers` is pure, so the *graph* half of validation (self-reference,
   * cycles, dangling dependency ids) can only run where a store is in reach —
   * here. Dependency ids are matched the way `arm()` matches them: by declared id,
   * with the principal lookup folding alternate attempts onto one logical task.
   */
  async validationErrors(task: TaskRecord): Promise<string[]> {
    const dependenciesOf = async (id: string): Promise<string[] | undefined> => {
      const t = (await this.deps.store.taskMetadata(id));
      if (!t) return undefined;
      const out: string[] = [];
      for (const trig of normalizeTriggers(t.params)) if (trig.kind === 'dependency') out.push(...(trig.tasks ?? []));
      return out;
    };
    return (await validateTriggers(normalizeTriggers(task.params), { taskId: task.id, dependenciesOf }));
  }

  async stop(): Promise<void> {
    this.epoch++;
    this.unsub?.();
    this.unsub = undefined;
    for (const e of this.armed.values()) for (const t of e.timers) this.clearTimer(t);
    this.armed.clear();
    await this.eventTail;
    while (this.pendingOperations.size) await Promise.allSettled([...this.pendingOperations]);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pendingOperations.add(operation);
    void operation.then(() => this.pendingOperations.delete(operation), () => this.pendingOperations.delete(operation));
    return operation;
  }

  /** Number of tasks currently armed (used by tests / diagnostics). */
  get size(): number {
    return [...this.armed.values()].filter((entry) => !entry.fired).length;
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
  async arm(task: TaskRecord): Promise<void> {
    const triggers = normalizeTriggers(task.params);
    if (!triggers.length) return;
    const epoch = this.epoch;
    const version = (this.versions.get(task.id) ?? 0) + 1;
    this.versions.set(task.id, version);
    const errs = (await this.validationErrors(task));
    if (this.epoch !== epoch || this.versions.get(task.id) !== version) return;
    if (errs.length) throw new Error(`invalid trigger(s): ${errs.join('; ')}`);
    this.disarm(task.id); // idempotent re-arm
    const entry: ArmedEntry = {
      task,
      triggers,
      satisfiedDeps: new Set(),
      activationPending: task.params?.triggerPending === true,
      activationInFlight: false,
      timers: [],
      fired: false,
      retryDelay: INITIAL_RETRY_MS,
    };
    this.armed.set(task.id, entry);

    // Seed dependency satisfaction from already-recorded statuses (a dep may have
    // completed before this task was armed, or while karmax was down).
    (await this.refreshDependencies(entry));
    if (this.armed.get(task.id) !== entry) return;

    // Arm time-based triggers.
    for (const trig of triggers) {
      if (trig.kind === 'schedule') (await this.armSchedule(entry, trig));
    }

    // Dependencies may already be satisfied at arm time, and a durable pending
    // activation may have been recorded before a restart.
    this.evaluate(entry);
  }

  private async refreshDependencies(entry: ArmedEntry): Promise<void> {
    entry.satisfiedDeps.clear();
    for (const trig of entry.triggers) {
      if (trig.kind !== 'dependency') continue;
      for (const dep of trig.tasks ?? []) {
        const group = (await this.deps.store.attemptPrincipalState(dep));
        const status = group
          ? group.status
          : (await this.deps.store.taskMetadata(dep))?.lastView?.status;
        if (status && statusSatisfiesDependency(trig.on, status)) entry.satisfiedDeps.add(dep);
      }
    }
  }

  disarm(taskId: string): void {
    this.versions.set(taskId, (this.versions.get(taskId) ?? 0) + 1);
    const e = this.armed.get(taskId);
    if (!e) return;
    for (const t of e.timers) this.clearTimer(t);
    this.armed.delete(taskId);
  }

  // ─── Event routing ─────────────────────────────────────────────────────────

  private async onEvent(ev: KarmaxEvent, candidates: ArmedEntry[]): Promise<void> {
    if (!this.armed.size) return;
    // Events are tenant data: an armed task only ever sees events from tasks in
    // its own organization. Without this, `{kind:'event', where:{repo:…}}` in one
    // organization fired on (and probed the payloads of) another's tasks.
    const sourceOrganization = (await this.organizationOfTask(ev.taskId));
    if (!sourceOrganization) return;
    for (const entry of candidates) {
      if (this.armed.get(entry.task.id) !== entry || entry.fired) continue;
      if ((await this.organizationOfTask(entry.task.id, entry.task)) !== sourceOrganization) continue;
      if (this.armed.get(entry.task.id) !== entry) continue;
      // `event` triggers are activators. They become runnable only once every
      // dependency prerequisite is also satisfied.
      // `firedNow` is load-bearing for a REPEATABLE series: `entry.fired` is only
      // ever set for one-shots, so without it a single event that matched two of
      // the entry's triggers spawned two runs of the same series.
      let firedNow = false;
      for (const trig of entry.triggers) {
        if (entry.fired || firedNow) break;
        if (trig.kind === 'event' && eventMatchesEventTrigger(trig, ev)) {
          (await this.markActivationPending(entry));
          firedNow = this.evaluate(entry, trig);
        }
      }
      if (entry.fired || firedNow || !this.armed.has(entry.task.id)) continue;
      // `dependency` triggers: fold the event into satisfaction, then re-evaluate.
      let advanced = false;
      for (const trig of entry.triggers) {
        if (trig.kind === 'dependency') advanced = (await this.applyDependencyEvent(entry, trig, ev)) || advanced;
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
  private async applyDependencyEvent(entry: ArmedEntry, trig: DependencyTrigger, ev: KarmaxEvent): Promise<boolean> {
    if (ev.type !== LIFECYCLE_EVENT) return false;
    const eventTask = (await this.deps.store.taskMetadata(ev.taskId));
    const eventIntent = eventTask?.intentId ?? ev.taskId;
    let advanced = false;
    for (const dep of trig.tasks ?? []) {
      const declared = (await this.deps.store.taskMetadata(dep));
      if ((declared?.intentId ?? dep) !== eventIntent) continue;
      // Read the logical task's CURRENT principal after Store.saveView has run.
      // Cancelling one attempt therefore cannot satisfy `settled` while another
      // eligible attempt remains; the eventual winner's outcome can.
      const group = (await this.deps.store.attemptPrincipalState(eventIntent));
      const status = group
        ? group.status ?? (group.principalAttemptId === ev.taskId ? (ev.payload as { status?: string })?.status : undefined)
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

  /**
   * Fire only when every dependency prerequisite is met AND an activator has
   * occurred. A dependency-only task needs no separate activator: completion of
   * its dependencies is itself the activation.
   */
  private evaluate(entry: ArmedEntry, cause?: TaskTrigger): boolean {
    if (this.armed.get(entry.task.id) !== entry || entry.fired) return false;
    const dependencies = entry.triggers.filter((t): t is DependencyTrigger => t.kind === 'dependency');
    if (!dependencies.every((t) => dependencyMet(t, entry.satisfiedDeps))) return false;

    const activators = entry.triggers.filter((t) => t.kind !== 'dependency');
    if (activators.length && !entry.activationPending) return false;

    const firingTrigger = cause && cause.kind !== 'dependency'
      ? cause
      : activators[0] ?? cause ?? dependencies[0];
    return firingTrigger ? this.fireFor(entry, firingTrigger) : false;
  }

  /** Durably remember (or consume) an activation that is gated on dependencies. */
  private async setActivationPending(entry: ArmedEntry, pending: boolean): Promise<void> {
    try {
      await this.deps.store.transaction(async () => {
        const current = await this.deps.store.taskMetadata(entry.task.id);
        if (!current || this.armed.get(entry.task.id) !== entry) return;
        const persisted = current.params?.triggerPending === true;
        if (entry.activationPending === pending && persisted === pending) return;
        const params = { ...(current.params as Record<string, unknown>) };
        if (pending) params.triggerPending = true;
        else delete params.triggerPending;
        await this.deps.store.updateTaskParams(entry.task.id, params as TaskRecord['params']);
        if (this.armed.get(entry.task.id) !== entry) return;
        entry.activationPending = pending;
        entry.task = { ...current, params: params as TaskRecord['params'] };
      });
    } catch (error) {
      this.log(`could not record pending trigger for ${entry.task.id}: ${String(error)}`);
      throw error;
    }
  }

  private async markActivationPending(entry: ArmedEntry): Promise<void> {
    (await this.setActivationPending(entry, true));
  }

  /**
   * Fire an entry for a specific trigger. A repeatable series spawns a run
   * (`clone`) and stays armed; a one-off starts itself (`self`), suppressing
   * further events while it starts. Failures retry on a bounded timer so a
   * rejected start cannot starve HTTP, health checks, or shutdown signals.
   */
  private fireFor(entry: ArmedEntry, trig: TaskTrigger): boolean {
    if (this.armed.get(entry.task.id) !== entry || entry.fired || entry.retryTimer !== undefined) return false;
    const consumesActivation = entry.triggers.some((t) => t.kind !== 'dependency');
    if (consumesActivation && entry.activationInFlight) return false;
    if (consumesActivation) {
      // Claim it in memory, but keep the durable `triggerPending` marker until
      // the workflow/run has actually started. If the process dies between here
      // and the API call, boot safely retries the claimed occurrence.
      entry.activationPending = false;
      entry.activationInFlight = true;
    }
    const repeatable = !!entry.task.params?.repeatable;
    const taskId = entry.task.id;
    if (!repeatable) {
      entry.fired = true;
      for (const timer of entry.timers) this.clearTimer(timer);
      entry.timers = [];
    }
    this.track(this.deps
      .fire(taskId, repeatable ? 'clone' : 'self')
      .then(async () => {
        if (this.armed.get(taskId) !== entry) return;
        entry.retryDelay = INITIAL_RETRY_MS;
        if (consumesActivation) {
          entry.activationInFlight = false;
          // A second occurrence may have arrived while this run was starting.
          // Preserve it and start one more coalesced run; otherwise the claimed
          // durable marker can now be cleared.
          if (repeatable && entry.activationPending) this.evaluate(entry);
          else (await this.setActivationPending(entry, false));
        }
        if (!repeatable) this.disarm(taskId);
        this.log(`trigger fired for ${taskId} (${trig.kind}, ${repeatable ? 'run' : 'self'})`);
      })
      .catch((e) => {
        // A stop, cancel, or edit supersedes this in-flight attempt. Its late
        // completion must never resurrect an old trigger or schedule a retry.
        if (this.armed.get(taskId) !== entry) return;
        if (consumesActivation) {
          entry.activationInFlight = false;
          entry.activationPending = true; // durable marker was deliberately retained
        }
        this.log(`trigger fire failed for ${taskId}: ${e instanceof Error ? e.message : String(e)}`);
        entry.fired = false;
        this.retry(entry);
      }));
    return true;
  }

  private retry(entry: ArmedEntry): void {
    if (entry.retryTimer !== undefined) return;
    const taskId = entry.task.id;
    const timer = this.setTimer(async () => {
      entry.timers = entry.timers.filter((t) => t !== timer);
      entry.retryTimer = undefined;
      if (this.armed.get(taskId) !== entry) return;
      try {
        const task = await this.deps.store.taskMetadata(taskId);
        if (this.armed.get(taskId) !== entry) return;
        if (task?.params?.triggerState !== 'armed') return this.disarm(taskId);
        const errors = (await this.validationErrors(task));
        if (errors.length) throw new Error(`invalid trigger(s): ${errors.join('; ')}`);
        if (this.armed.get(taskId) !== entry) return;
        entry.task = task;
        (await this.refreshDependencies(entry));
        this.evaluate(entry);
      } catch (error) {
        if (this.armed.get(taskId) !== entry) return;
        this.disarm(taskId);
        this.log(`refusing to retry ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, entry.retryDelay);
    entry.retryTimer = timer;
    entry.timers.push(timer);
    entry.retryDelay = Math.min(entry.retryDelay * 2, MAX_RETRY_MS);
  }

  // ─── Schedule (cron / at) ────────────────────────────────────────────────────

  private async armSchedule(entry: ArmedEntry, trig: ScheduleTrigger): Promise<void> {
    if (trig.at !== undefined) {
      this.armAt(entry, trig.at, async () => {
        (await this.markActivationPending(entry));
        this.evaluate(entry, trig);
      });
      return;
    }
    if (trig.cron) {
      // Catch up on a window missed while karmax was down, then arm the next one.
      // The catch-up can itself disarm a (non-repeatable) entry, so re-check.
      const mark = (await this.catchUpCron(entry, trig));
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
  private async catchUpCron(entry: ArmedEntry, trig: ScheduleTrigger): Promise<number> {
    const now = this.now();
    const mark = entry.task.params?.triggerLastFiredAt;
    if (typeof mark !== 'number') {
      (await this.recordCronFire(entry, now));
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
    // Nothing fell inside the window: subsequent scheduling measures from the
    // window's edge, not the raw mark. Returning a mark older than the window
    // made `armCron` compute a next occurrence in the past and fire once per
    // historical occurrence, back to back — the replay the window exists to stop.
    if (last === undefined) return Math.max(mark, now - MAX_CATCHUP_WINDOW_MS);
    this.log(`cron catch-up for ${entry.task.id}: occurrence at ${new Date(last).toISOString()} was missed`);
    (await this.recordCronFire(entry, last));
    (await this.markActivationPending(entry));
    this.evaluate(entry, trig);
    return last;
  }

  /** Persist the cron mark so catch-up survives a restart. */
  private async recordCronFire(entry: ArmedEntry, whenMs: number): Promise<void> {
    if (this.armed.get(entry.task.id) !== entry) return;
    const params = { ...entry.task.params, triggerLastFiredAt: whenMs };
    entry.task = { ...entry.task, params };
    try {
      (await this.deps.store.patchTaskParams(entry.task.id, { triggerLastFiredAt: whenMs }));
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
    this.armAt(entry, next, async () => {
      // Cron is recurring: fire a clone, then re-arm for the next occurrence,
      // measured from the SCHEDULED instant (never from the wall clock).
      (await this.recordCronFire(entry, next));
      (await this.markActivationPending(entry));
      this.evaluate(entry, trig);
      if (this.armed.get(entry.task.id) === entry) this.armCron(entry, trig, next);
    });
  }

  /** Set a (possibly very long) timer that fires `onDue` at absolute time `whenMs`. */
  private armAt(entry: ArmedEntry, whenMs: number, onDue: () => unknown): void {
    const delay = Math.max(0, whenMs - this.now());
    if (delay > MAX_TIMER_MS) {
      const h = this.setTimer(() => {
        entry.timers = entry.timers.filter((t) => t !== h);
        if (this.armed.get(entry.task.id) === entry) this.armAt(entry, whenMs, onDue);
      }, MAX_TIMER_MS);
      entry.timers.push(h);
      return;
    }
    const h = this.setTimer(async () => {
      entry.timers = entry.timers.filter((t) => t !== h);
      if (this.armed.get(entry.task.id) !== entry) return;
      try { await onDue(); } catch (error) { this.log(`trigger timer failed: ${String(error)}`); }
    }, delay);
    entry.timers.push(h);
  }
}
