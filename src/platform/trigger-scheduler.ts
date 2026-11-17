import type { Store } from '../store/db.js';
import type { KarmaxBus } from '../contrib/bus.js';
import type { KarmaxEvent, TaskRecord, TaskTrigger } from '../domain/types.js';
import type { KarmaxApi } from './api.js';
import type { TokenAuthority } from './tokens.js';
import {
  normalizeTriggers,
  eventMatchesEventTrigger,
  projectEventMatchesTrigger,
  statusSatisfiesDependency,
  dependencyMet,
  nextCronFire,
  validateTriggers,
  normalizeFollowUpTriggers,
  isRecurring,
  isSeries,
  LIFECYCLE_EVENT,
  type DependencyTrigger,
  type EventTrigger,
  type FollowUpTrigger,
  type ScheduleTrigger,
} from '../domain/triggers.js';
import {
  DEFAULT_MAX_RUNS_PER_HOUR, EventRunRefused, MAX_EVENT_HOPS, countCrossedThreshold, lastHappenedAt, recurrenceMessage, renderTemplate, templateData, triggerContext, triggerMessage,
  type KeyedRun, type ProjectEvent, type ProjectEventClaim, type ProjectEventClaimState, type TriggerContext,
} from '../domain/project-events.js';

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
 * **Dependencies are level-triggered, not only edge-triggered.** The lifecycle
 * feed is the fast path, but a dependency must never hinge on one event being
 * delivered: a manual Done that wrote its view without one left #367's
 * dependents armed until the next reboot happened to re-derive them. So every
 * `reconcileMs` the armed dependency triggers are re-derived from the store and
 * fire on any rising edge the feed missed (a crash between commit and delivery,
 * a writer in a process with no relay, a future writer that forgets).
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
 *
 * **Project events are delivered one by one, never coalesced.** An outside
 * occurrence (a GitHub delivery, an incoming webhook, an event a task emitted)
 * is a row in the store's inbox before anyone is told about it. Each matching
 * armed task gets at most one run per event — the `(event, task)` claim is
 * unique in the database, so a redelivery, a second process or a retry after a
 * crash cannot start another — and that run receives the event. A claim that
 * cannot start yet (dependencies, a queued concurrency slot, the hourly limit,
 * a failed start) is `deferred` and retried by the inbox sweep, oldest event
 * first; the sweep also offers events another process recorded.
 *
 * **A repeat of an event's key is counted, not dropped**, and offered again:
 * nothing new starts for it, but a trigger that keeps one task per key
 * (`concurrency.mode: 'continue'`) routes it to that task — said once per
 * tenfold growth while the task works, and carrying the task on once it has
 * finished and its change is live. Such a trigger may also wait before
 * starting (`settleMinutes`), keep only so many runs at work (`maxRunning`,
 * the most-seen event first) and ask a model whether to start at all (`gate`).
 *
 * **Follow-up triggers are the same machine pointed at a started task** (wiki
 * features/follow-up-triggers): an entry with `followUp` set listens for what
 * `params.followUpTriggers` names, and firing it says something to the task
 * (`fire(…, 'followUp', …)`) rather than starting one. Dependencies keep their
 * meaning as prerequisites, schedules and claims work unchanged; what differs
 * is that each trigger, not the whole task, is one-shot or recurring. Entries
 * stay armed through Done, which is when firing forks; only cancellation ends them.
 */

export interface TriggerSchedulerDeps {
  store: Store;
  bus: KarmaxBus;
  /**
   * Start an armed task because a trigger fired. `self` starts the armed task
   * itself (one-shot); `clone` spawns a fresh copy that runs now and leaves the
   * armed template in place (recurring — cron, or a re-arming event trigger).
   * `followUp` says it to a started task instead; `cause` is the trigger that fired.
   */
  fire: (taskId: string, mode: 'self' | 'clone' | 'followUp', trigger?: TriggerContext, cause?: TaskTrigger, text?: string) => Promise<unknown>;
  /** Ask a trigger's gate whether an event should start a run (`EventTrigger.gate`).
   *  Without it, or when it fails, the event starts its run. */
  gate?: (ask: GateRequest) => Promise<GateVerdict>;
  /** Give an unfinished run a further event of its concurrency key (`tell`). */
  tell?: (runId: string, trigger: TriggerContext, text?: string) => Promise<unknown>;
  /** An event started a run or was told to one (a chat bot answers in its thread). */
  announce?: (event: ProjectEvent, runId: string, how: 'started' | 'told') => Promise<unknown>;
  /** Injectable clock/timers (tests drive them; prod uses wall-clock). */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  log?: (msg: string) => void;
  /** How often armed dependency triggers are re-derived from the store
   *  (default one minute; `0` disables — tests that count store reads). */
  reconcileMs?: number;
  /** How often the project-event inbox is swept (default 15 s; `0` disables —
   *  tests call `sweepProjectEvents()` themselves). */
  inboxSweepMs?: number;
}

/** What a gate is asked: the event, and, for a trigger that keeps one task
 *  per key, the keys that have a task it could join. */
export interface GateRequest {
  series: TaskRecord;
  trigger: EventTrigger;
  event: ProjectEvent;
  keys: Array<{ key: string; taskId: string; title: string; status: string }>;
}

export interface GateVerdict {
  decision: 'start' | 'skip' | 'merge';
  reason?: string;
  /** `merge`: the key whose task takes this event's key too. */
  into?: string;
}

/** `tell`: the event reaches the run's agent as a message, with a bounded
 *  credential like a start. */
export function createTriggerTell(api: Pick<KarmaxApi, 'postTaskMessage'>, tokens: TokenAuthority): NonNullable<TriggerSchedulerDeps['tell']> {
  return async (runId, trigger, text) => {
    const { token } = (await tokens.mintPrincipal('system:triggers', ['*'], undefined, 10 * 60_000));
    try {
      // A linked chat sender's reply is theirs (wiki planned/assistant §3); the context comes from the stored event.
      return await api.postTaskMessage(token, runId, { text: text ?? triggerMessage(trigger), ...(trigger.actsAs ? { onBehalfOf: trigger.actsAs } : {}) });
    } finally {
      (await tokens.revoke(token));
    }
  };
}

/** The dispatcher outlives principal-token TTLs. Give each start its own bounded
 * credential and release it once the API operation completes. */
export function createTriggerFire(api: Pick<KarmaxApi, 'fireTriggeredTask'>, tokens: TokenAuthority): TriggerSchedulerDeps['fire'] {
  return async (taskId, mode, trigger, cause, text) => {
    const { token } = (await tokens.mintPrincipal('system:triggers', ['*'], undefined, 10 * 60_000));
    try {
      return await api.fireTriggeredTask(token, taskId, mode, trigger, cause, text);
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
  /** A started task's follow-up triggers, not a task waiting to start. */
  followUp?: boolean;
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
/** The dependency safety net's period: the longest a missed lifecycle event can
 *  delay a dependent. Each pass costs one indexed read per armed dependency. */
const DEPENDENCY_RECONCILE_MS = 60_000;
const INBOX_SWEEP_MS = 15_000;
/** A claim still `pending` this long belongs to a start that never finished. */
const STALE_PENDING_MS = 10 * 60_000;
/** A failed start is retried no sooner than this. */
const FAILED_START_RETRY_MS = 60_000;
const FAILED_START = 'could not start';
const GATE_ASKED = 'being considered';
const SETTLING = 'letting what comes with it arrive';
/** How long after a change landed it counts as live when no event said so. */
const LIVE_WITHOUT_WORD_MS = 24 * 3600 * 1000;

type Verdict = { state: ProjectEventClaimState; reason?: string; tell?: string;
  /** The key's task takes it: a message while it works, a continuation once it has finished. */
  carryOn?: { taskId: string; text?: string };
  /** The trigger's gate decides. */
  ask?: true };

export class TriggerScheduler {
  /** Claims whose gate is being asked right now, `<event>:<task>`. */
  private gating = new Set<string>();
  private armed = new Map<string, ArmedEntry>();
  private eventTail: Promise<void> = Promise.resolve();
  private pendingOperations = new Set<Promise<unknown>>();
  private epoch = 0;
  private versions = new Map<string, number>();
  private unsub?: () => void;
  private reconcileTimer?: unknown;
  private inboxTimer?: unknown;
  /** Project events are offered only once every armed task is registered:
   *  one offered earlier would be marked dispatched without reaching them. */
  private started = false;
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
    const epoch = this.epoch;
    // Subscribe BEFORE re-arming. Arming reads each dependency's status and
    // registers the entry; a dependency that finished between that read and a
    // later subscription reached nobody, so its dependent waited for the next
    // boot. Subscribed first, the event finds the entry arm() just registered.
    this.unsub = this.deps.bus.onAny(ev => {
      // Do not retain high-volume output or perform attribution reads unless
      // an already-armed trigger could consume this event. Capture entry
      // identities now: an old queued event cannot activate a later re-arm.
      if (ev.type === LIFECYCLE_EVENT && this.armed.get(ev.taskId)?.followUp) this.enqueue(() => this.settleFollowUps(ev.taskId), 'follow-up triggers');
      const candidates = [...this.armed.values()].filter(entry => !entry.fired && entry.triggers.some(trigger =>
        trigger.kind === 'event' ? this.heardOnBus(entry, trigger, ev)
          : trigger.kind === 'dependency' && ev.type === LIFECYCLE_EVENT));
      if (!candidates.length) return;
      // Lifecycle edges must not overtake one another while attribution reads
      // yield. A stopped/restarted scheduler must not consume its old backlog.
      const next = this.eventTail.then(() => this.epoch === epoch ? this.onEvent(ev, candidates) : undefined);
      this.eventTail = next.catch(error => this.log(`trigger event failed: ${String(error)}`));
      return next;
    });
    // Before the follow-up triggers are read: a follow is one, once drained.
    const drained = await this.deps.store.drainLegacyTaskFollows();
    if (drained) this.log(`moved ${drained} legacy follow(s) into follow-up triggers`);
    if (this.epoch !== epoch) return;
    for (const task of (await this.deps.store.listArmedTasks())) {
      // A stored task can have become invalid since it was armed — most often a
      // dependency task that has since been deleted. Boot must never die on one
      // bad row, so the refusal is logged per task and the rest still arm.
      try {
        if (this.epoch !== epoch) return;
        (await this.arm(task));
      } catch (e) {
        this.log(`refusing to arm ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (this.epoch !== epoch) return;
    for (const task of (await this.deps.store.listFollowUpTasks())) {
      try {
        if (this.epoch !== epoch) return;
        (await this.armFollowUps(task));
      } catch (e) {
        this.log(`refusing to arm follow-ups of ${task.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (this.epoch !== epoch) return;
    this.scheduleDependencyReconcile(epoch);
    this.started = true;
    await this.sweepProjectEvents();
    if (this.epoch !== epoch) return;
    this.scheduleInboxSweep(epoch);
    const n = this.armed.size;
    if (n) this.log(`trigger dispatcher armed ${n} task(s)`);
  }

  /** Re-derive dependency triggers from the store periodically (see the class
   *  comment). Serialized with event routing so the two never interleave. */
  private scheduleDependencyReconcile(epoch: number): void {
    const every = this.deps.reconcileMs ?? DEPENDENCY_RECONCILE_MS;
    if (!(every > 0)) return;
    this.reconcileTimer = this.setTimer(async () => {
      if (this.epoch !== epoch) return;
      const pass = this.eventTail.then(() => this.epoch === epoch ? this.reconcileDependencies() : undefined);
      this.eventTail = pass.catch(error => this.log(`dependency reconciliation failed: ${String(error)}`));
      await this.eventTail;
      if (this.epoch === epoch) this.scheduleDependencyReconcile(epoch);
    }, every);
  }

  /** Fire every armed entry whose dependencies became satisfied without the
   *  lifecycle feed saying so. Rising edges only, exactly like an event: a
   *  repeatable series whose dependency simply stays done must not re-run. */
  private async reconcileDependencies(): Promise<void> {
    for (const entry of this.armed.values()) {
      if (entry.fired || !entry.triggers.some((t) => t.kind === 'dependency')) continue;
      const satisfied = (await this.satisfiedDependencies(entry));
      if (this.armed.get(entry.task.id) !== entry || entry.fired) continue;
      const missed = [...satisfied].filter((dep) => !entry.satisfiedDeps.has(dep));
      entry.satisfiedDeps = satisfied;
      if (!missed.length) continue;
      this.log(`dependency reconciliation: ${missed.join(', ')} finished without a lifecycle event reaching ${entry.task.id}`);
      this.evaluate(entry);
    }
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
   * A task in another organization does not exist for it: its outcome is that
   * tenant's data, so waiting on it would reveal when it finished.
   */
  async validationErrors(task: TaskRecord): Promise<string[]> {
    const organizationId = (await this.organizationOfTask(task.id, task));
    const dependenciesOf = async (id: string): Promise<string[] | undefined> => {
      const t = (await this.deps.store.taskMetadata(id));
      if (!t || (await this.organizationOfTask(id, t)) !== organizationId) return undefined;
      const out: string[] = [];
      for (const trig of normalizeTriggers(t.params)) if (trig.kind === 'dependency') out.push(...(trig.tasks ?? []));
      return out;
    };
    return (await validateTriggers(normalizeTriggers(task.params), { taskId: task.id, dependenciesOf }));
  }

  async stop(): Promise<void> {
    this.epoch++;
    this.started = false;
    this.unsub?.();
    this.unsub = undefined;
    if (this.reconcileTimer !== undefined) this.clearTimer(this.reconcileTimer);
    this.reconcileTimer = undefined;
    if (this.inboxTimer !== undefined) this.clearTimer(this.inboxTimer);
    this.inboxTimer = undefined;
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
    await this.register(task, triggers);
  }

  /**
   * Arm (or re-arm) a started task's follow-up triggers, or take it off the
   * dispatcher when it has none it can act on. Unlike `arm` this validates
   * nothing: they were validated when set, and one that became unsatisfiable
   * (its dependency was deleted) simply never fires.
   */
  async armFollowUps(task: TaskRecord): Promise<void> {
    const status = task.lastView?.status;
    const ended = ['done', 'failed', 'cancelled'].includes(status ?? '');
    const triggers = normalizeFollowUpTriggers(task.params).filter((trigger) => !(trigger.whileRunning && ended));
    // Not started yet, or it never runs itself: its runs listen for it.
    if (!triggers.length || task.params?.triggerState === 'armed' || task.params?.draft || isSeries(task.params) || status === 'cancelled') {
      if (this.armed.get(task.id)?.followUp) this.disarm(task.id);
      return;
    }
    this.disarm(task.id);
    // Kept in memory until it ends, or for ever if it never fires: only what matching needs.
    await this.register({ ...task, lastView: undefined }, triggers, true);
  }

  /** A task's lifecycle moved: cancellation ends its follow-ups, and an end
   *  ends those that were only for while it ran. */
  private async settleFollowUps(taskId: string): Promise<void> {
    if (!this.armed.get(taskId)?.followUp) return;
    const task = await this.deps.store.taskMetadata(taskId);
    const status = task?.lastView?.status;
    if (!task || status === 'cancelled') {
      if (task) await this.deps.store.updateFollowUpTriggers(taskId, () => [], { clearPending: true });
      this.disarm(taskId);
      return;
    }
    if (!['done', 'failed'].includes(status ?? '')) return;
    const held = normalizeFollowUpTriggers(task.params);
    if (!held.some((trigger) => trigger.whileRunning)) return;
    const params = await this.deps.store.updateFollowUpTriggers(taskId, (current) => current.filter((trigger) => !trigger.whileRunning));
    await this.armFollowUps({ ...task, params: { ...task.params, followUpTriggers: params } as TaskRecord['params'] });
  }

  private async register(task: TaskRecord, triggers: TaskTrigger[], followUp?: boolean): Promise<void> {
    const entry: ArmedEntry = {
      task,
      triggers,
      followUp,
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
    entry.satisfiedDeps = (await this.satisfiedDependencies(entry));
  }

  /** The declared dependency ids whose logical task is currently in the state
   *  its trigger waits for, read from the store (never from event history). */
  private async satisfiedDependencies(entry: ArmedEntry): Promise<Set<string>> {
    const satisfied = new Set<string>();
    for (const trig of entry.triggers) {
      if (trig.kind !== 'dependency') continue;
      for (const dep of trig.tasks ?? []) {
        const group = (await this.deps.store.attemptPrincipalState(dep));
        const status = group
          ? group.status
          : (await this.deps.store.taskMetadata(dep))?.lastView?.status;
        if (status && statusSatisfiesDependency(trig.on, status)) satisfied.add(dep);
      }
    }
    return satisfied;
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
        if (trig.kind === 'event' && this.heardOnBus(entry, trig, ev)) {
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

  // ─── Project events (the inbox) ────────────────────────────────────────────

  /** A project event was recorded in this process: offer it now. Events from
   *  other processes, and any this misses, arrive through the sweep. */
  projectEventRecorded(event: ProjectEvent): void {
    if (!this.started) return;
    this.enqueue(() => this.dispatchProjectEvent(event), 'project event');
  }

  /** Resolves once queued event work has run (tests, shutdown). */
  async drain(): Promise<void> {
    let tail: Promise<void>;
    do { tail = this.eventTail; await tail; } while (tail !== this.eventTail);
  }

  /** Offer undispatched events, recover interrupted starts and retry deferred
   *  claims. Serialized with event routing. */
  sweepProjectEvents(): Promise<void> {
    if (!this.started) return Promise.resolve();
    return this.enqueue(() => this.sweep(), 'project event sweep');
  }

  private enqueue(work: () => Promise<void>, what: string): Promise<void> {
    const epoch = this.epoch;
    const next = this.eventTail.then(() => (this.epoch === epoch ? work() : undefined));
    this.eventTail = next.catch((error) => this.log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`));
    return this.eventTail;
  }

  private scheduleInboxSweep(epoch: number): void {
    const every = this.deps.inboxSweepMs ?? INBOX_SWEEP_MS;
    if (!(every > 0)) return;
    this.inboxTimer = this.setTimer(async () => {
      if (this.epoch !== epoch) return;
      await this.sweepProjectEvents();
      if (this.epoch === epoch) this.scheduleInboxSweep(epoch);
    }, every);
  }

  private async dispatchProjectEvent(event: ProjectEvent): Promise<void> {
    // Those armed when it arrived: a run this event just started has already got it.
    for (const entry of Array.from(this.armed.values())) {
      if (entry.fired || entry.task.projectId !== event.projectId || this.armed.get(entry.task.id) !== entry) continue;
      const trigger = this.projectEventTrigger(entry, event);
      if (trigger && !(entry.followUp && await this.deps.store.projectEventReached(event.id, entry.task.id))) await this.offerProjectEvent(entry, trigger, event);
    }
    await this.deps.store.markProjectEventDispatched(event.id, this.now(), event.count);
  }

  private projectEventTrigger(entry: ArmedEntry, event: ProjectEvent): EventTrigger | undefined {
    return entry.triggers.find((t): t is EventTrigger => t.kind === 'event' && projectEventMatchesTrigger(t, event)
      && !(entry.followUp && this.emittedBy(entry.task, event)));
  }

  /** A task never hears what it, or the series it is a run of, emitted. */
  private emittedBy(task: TaskRecord, event: ProjectEvent): boolean {
    return event.source === `task:${task.id}` || event.source === `task:${String(task.params?.runOf ?? task.id)}`;
  }

  /** Does a task event match, leaving aside a follow-up on the task's own events? */
  private heardOnBus(entry: ArmedEntry, trigger: EventTrigger, ev: KarmaxEvent): boolean {
    return eventMatchesEventTrigger(trigger, ev) && !(entry.followUp && ev.taskId === entry.task.id);
  }

  /** Whether this firing leaves the trigger armed: a series' or a recurring follow-up's. */
  private repeats(entry: ArmedEntry, trigger: TaskTrigger): boolean {
    return entry.followUp ? isRecurring(trigger) : !!entry.task.params?.repeatable;
  }

  /** A one-shot start trigger has fired: the task is started, so its follow-up triggers begin. */
  private async hearFollowUpsAfterStart(taskId: string): Promise<void> {
    this.disarm(taskId);
    const task = await this.deps.store.taskMetadata(taskId);
    if (task) await this.armFollowUps(task);
  }

  /** A follow-up one-shot stops matching the moment it fires; the API uses it up. */
  private spendOneShot(entry: ArmedEntry, trigger: TaskTrigger): void {
    entry.triggers = entry.triggers.filter((candidate) => candidate !== trigger);
  }

  private async sweep(): Promise<void> {
    for (const event of await this.deps.store.undispatchedProjectEvents(100)) await this.dispatchProjectEvent(event);
    const now = this.now();
    for (const claim of await this.deps.store.projectEventClaimsInState('pending', { updatedBefore: now - STALE_PENDING_MS })) {
      const runId = await this.deps.store.projectEventRun(claim.taskId, claim.eventId);
      await this.deps.store.updateProjectEventClaim(claim.eventId, claim.taskId, ['pending'], runId
        ? { state: 'started', runId, reason: null, updatedAt: now }
        : { state: 'deferred', reason: 'its start was interrupted', updatedAt: now });
    }
    const waiting: Array<{ claim: ProjectEventClaim; entry: ArmedEntry; trigger: EventTrigger; event: ProjectEvent }> = [];
    for (const claim of await this.deps.store.projectEventClaimsInState('deferred')) {
      if (claim.reason?.startsWith(FAILED_START) && now - claim.updatedAt < FAILED_START_RETRY_MS) continue;
      const entry = this.armed.get(claim.taskId);
      if (!entry || entry.fired) {
        const task = await this.deps.store.taskMetadata(claim.taskId);
        if (task?.params?.triggerState !== 'armed')
          await this.settleClaim(claim, 'skipped', 'the task is no longer waiting for events');
        continue;
      }
      const event = await this.deps.store.getProjectEvent(claim.eventId);
      const trigger = event && this.projectEventTrigger(entry, event);
      if (!event || !trigger) { await this.settleClaim(claim, 'skipped', 'the task no longer reacts to this event'); continue; }
      waiting.push({ claim, entry, trigger, event });
    }
    // Oldest event first, except that what happened most goes first (a
    // stable sort: events seen once keep their order).
    waiting.sort((a, b) => b.event.count - a.event.count);
    for (const { claim, entry, trigger, event } of waiting) {
      if (this.armed.get(entry.task.id) === entry) await this.offerProjectEvent(entry, trigger, event, claim);
    }
  }

  private async settleClaim(claim: ProjectEventClaim, state: ProjectEventClaimState, reason: string): Promise<void> {
    await this.deps.store.updateProjectEventClaim(claim.eventId, claim.taskId, [claim.state], { state, reason, updatedAt: this.now() });
  }

  /**
   * Decide what one event does for one armed task and record it atomically
   * (both stores serialize transactions), then start the run if it may start.
   * `deferred` is the claim being retried; without it the pair is new, or the
   * event came again: then it goes to its key's task, if the trigger keeps one.
   */
  private async offerProjectEvent(entry: ArmedEntry, trigger: EventTrigger, event: ProjectEvent, deferred?: ProjectEventClaim): Promise<void> {
    const taskId = entry.task.id;
    const concurrencyKey = trigger.concurrency ? renderTemplate(trigger.concurrency.key ?? '', templateData(event), 300) : undefined;
    if (!deferred) {
      const existing = await this.deps.store.getProjectEventClaim(event.id, taskId);
      if (existing) {
        if (concurrencyKey !== undefined && trigger.concurrency?.mode === 'continue' && !entry.followUp) await this.eventCameAgain(entry, trigger, event, concurrencyKey, existing);
        return;
      }
    }
    const verdict = await this.deps.store.transaction(async () => {
      const decided = await this.projectEventVerdict(entry, trigger, event, concurrencyKey, deferred);
      const now = this.now();
      if (deferred) {
        if (decided.state === 'deferred' && decided.reason === deferred.reason) return decided.ask ? decided : undefined;
        const moved = await this.deps.store.updateProjectEventClaim(event.id, taskId, ['deferred'],
          { state: decided.state, reason: decided.reason ?? null, concurrencyKey: concurrencyKey ?? null, updatedAt: now });
        return moved ? decided : undefined;
      }
      const claimed = await this.deps.store.claimProjectEvent({ eventId: event.id, taskId, state: decided.state, reason: decided.reason,
        concurrencyKey, receivedAt: event.receivedAt, updatedAt: now });
      return claimed ? decided : undefined;
    });
    if (verdict?.ask) this.askGate(entry, trigger, event, concurrencyKey);
    else if (verdict?.state === 'pending' && verdict.carryOn) await this.carryOn(entry, trigger, event, concurrencyKey!, verdict.carryOn);
    else if (verdict?.state === 'pending' && verdict.tell) await this.tellEventRun(entry, event, verdict.tell, concurrencyKey);
    else if (verdict?.state === 'pending') await this.startEventRun(entry, trigger, event, concurrencyKey);
  }

  private async projectEventVerdict(entry: ArmedEntry, trigger: EventTrigger, event: ProjectEvent, concurrencyKey: string | undefined,
    claim?: ProjectEventClaim): Promise<Verdict> {
    if (event.hops > MAX_EVENT_HOPS) return { state: 'skipped', reason: `stopped a loop: more than ${MAX_EVENT_HOPS} event-to-run steps` };
    // A reply in a thread, a comment on an issue: the run already working on it
    // follows it and hears it there, so a second run would duplicate it.
    const following = event.subject && !entry.followUp ? [...this.armed.values()].find((candidate) => candidate.followUp
      && candidate.task.params?.runOf === entry.task.id && candidate.triggers.some((t) => t.kind === 'event' && !!(t as FollowUpTrigger).whileRunning && projectEventMatchesTrigger(t, event))) : undefined;
    if (following) return { state: 'skipped', reason: `its run ${following.task.id} follows this` };
    const dependencies = entry.triggers.filter((t): t is DependencyTrigger => t.kind === 'dependency');
    if (!dependencies.every((t) => dependencyMet(t, entry.satisfiedDeps))) return { state: 'deferred', reason: 'waiting for its dependencies' };
    const mode = trigger.concurrency?.mode ?? 'skip';
    const keeps = concurrencyKey !== undefined && mode === 'continue' && !entry.followUp;
    // One task per key, for good: a further event of the key is that task's.
    const kept = keeps ? await this.keyTask(entry.task.id, concurrencyKey!, event) : undefined;
    if (kept) {
      if (kept.task.lastView?.status === 'done') {
        // What came before its change was live says nothing about whether it held.
        const live = await this.finishedKeyReady(trigger, kept.run, kept.task, event, false);
        if (!live.ready) return live.liveAt !== undefined ? { state: 'skipped', reason: 'it came before what its task changed went live' }
          : { state: 'deferred', reason: 'waiting for what its task changed to go live' };
      }
      return { state: 'pending', carryOn: { taskId: kept.task.id } };
    }
    const slot = concurrencyKey !== undefined ? await this.deps.store.projectEventSlot(entry.task.id, concurrencyKey) : undefined;
    if (slot) {
      if (keeps) return slot.runId ? { state: 'pending', carryOn: { taskId: slot.runId } } : { state: 'deferred', reason: 'waiting for its run to start' };
      if (mode === 'tell' && this.deps.tell) {
        return slot.runId ? { state: 'pending', tell: slot.runId } : { state: 'deferred', reason: 'waiting for its run to start' };
      }
      return mode === 'queue' || mode === 'tell'
        ? { state: 'deferred', reason: 'queued behind an unfinished run' }
        : { state: 'skipped', reason: 'a run for it was already unfinished' };
    }
    if (!entry.followUp) {
      if (trigger.settleMinutes && this.now() < event.receivedAt + trigger.settleMinutes * 60_000) return { state: 'deferred', reason: SETTLING };
      if (trigger.gate && this.deps.gate && !claim?.gated) return { state: 'deferred', reason: GATE_ASKED, ask: true };
      if (trigger.maxRunning) {
        const running = await this.deps.store.unfinishedRunsOf(entry.task.id);
        if (running >= trigger.maxRunning) return { state: 'deferred', reason: `queued: ${running} of its runs are at work` };
      }
    }
    const limit = trigger.maxPerHour ?? DEFAULT_MAX_RUNS_PER_HOUR;
    const lately = entry.followUp ? this.deps.store.projectEventsToldSince(entry.task.id, this.now() - 3600_000)
      : this.deps.store.projectEventRunsSince(entry.task.id, this.now() - 3600_000);
    if (await lately >= limit)
      return { state: 'deferred', reason: `waiting for its limit of ${limit} runs an hour` };
    return { state: 'pending' };
  }

  // ─── One task per key (`concurrency.mode: 'continue'`) ─────────────────────

  /** The task that holds a key, if it still stands. A key whose task is gone
   *  is free again; one whose task was cancelled was turned down by a person,
   *  like one its gate skipped. */
  private async keyTask(seriesId: string, key: string, event: ProjectEvent): Promise<{ run: KeyedRun; task: TaskRecord } | undefined> {
    const run = await this.deps.store.keyedRun(seriesId, key);
    if (!run?.taskId) return undefined;
    const task = await this.deps.store.taskMetadataAsync(run.taskId);
    if (!task) { await this.deps.store.deleteKeyedRun(seriesId, key); return undefined; }
    if (task.lastView?.status === 'cancelled') {
      await this.deps.store.saveKeyedRun({ ...run, taskId: undefined, state: 'skipped', reason: 'its task was cancelled', seen: event.count, liveAt: undefined });
      return undefined;
    }
    return { run, task };
  }

  /**
   * Whether a finished task should carry on for a further event of its key.
   * One that landed a change does once the change is live: at once, or, when
   * the trigger names what makes it live (`concurrency.after`, a deploy), after
   * the event of that kind that names a commit it landed (or lists none), else
   * a day after it landed.
   * One that changed nothing found nothing to do: only a repeat that has grown
   * tenfold since, or a different event of the key, is worth another look.
   */
  private async finishedKeyReady(trigger: EventTrigger, run: KeyedRun, task: TaskRecord, event: ProjectEvent, repeat: boolean): Promise<{ ready: boolean; liveAt?: number }> {
    const landed = (task.lastView?.prs ?? []).filter((pr) => pr.merged && pr.headSha).map((pr) => pr.headSha!);
    if (!landed.length) return { ready: !repeat || countCrossedThreshold(run.seen, event.count) };
    const finishedAt = task.statusChangedAt ?? run.updatedAt;
    const after = trigger.concurrency?.after;
    let liveAt = run.liveAt ?? (after ? undefined : finishedAt);
    if (liveAt === undefined && after) {
      for (const candidate of await this.deps.store.projectEventsAfter(task.projectId, after.type, after.source, finishedAt)) {
        const commits = candidate.payload.commits;
        const names = !Array.isArray(commits) || landed.some((sha) => commits.some((commit) => typeof commit === 'string' && commit.length >= 7
          && (sha.startsWith(commit) || commit.startsWith(sha))));
        if (names) { liveAt = candidate.receivedAt; break; }
      }
      // No such event named it (none is sent, or it landed as another commit:
      // a squash): a change is taken to be out a day after it landed.
      if (liveAt === undefined && this.now() - finishedAt > LIVE_WITHOUT_WORD_MS) liveAt = finishedAt + LIVE_WITHOUT_WORD_MS;
      if (liveAt !== undefined) await this.deps.store.updateKeyedRun(run.seriesId, run.key, { liveAt });
    }
    // What happened before the change was out says nothing about it, however late it is heard of.
    return { ready: liveAt !== undefined && lastHappenedAt(event) > liveAt, ...(liveAt !== undefined ? { liveAt } : {}) };
  }

  /**
   * An event the series already answered came again (its count moved). Its
   * key's task hears of it: once per tenfold growth while it works; once it
   * has finished, when that means its change did not hold. A key that was
   * turned down is put to the gate again once it has grown tenfold.
   */
  private async eventCameAgain(entry: ArmedEntry, trigger: EventTrigger, event: ProjectEvent, key: string, claim: ProjectEventClaim): Promise<void> {
    if (claim.state === 'pending' || claim.state === 'deferred') return; // it starts knowing its count
    const seriesId = entry.task.id;
    const run = await this.deps.store.keyedRun(seriesId, key);
    const kept = run?.taskId ? await this.keyTask(seriesId, key, event) : undefined;
    if (!kept) {
      // Turned down (by its gate, or its task was cancelled): asked again once it has grown tenfold.
      // No key at all: it was split off its task, or its task is gone, so it starts over.
      const current = run?.taskId ? await this.deps.store.keyedRun(seriesId, key) : run;
      if (current && !countCrossedThreshold(current.seen, event.count)) return;
      const reason = current ? 'it keeps coming' : 'its key is free again';
      if (await this.deps.store.updateProjectEventClaim(event.id, seriesId, [claim.state], { state: 'deferred', reason, runId: null, gated: false, gateReason: null, updatedAt: this.now() }))
        await this.offerProjectEvent(entry, trigger, event, { ...claim, state: 'deferred', reason, runId: undefined, gated: false, gateReason: undefined });
      return;
    }
    const finished = kept.task.lastView?.status === 'done';
    let liveAt: number | undefined;
    if (finished) {
      const ready = await this.finishedKeyReady(trigger, kept.run, kept.task, event, true);
      if (!ready.ready) return;
      liveAt = ready.liveAt;
    } else if (!countCrossedThreshold(kept.run.seen, event.count)) return;
    if (!(await this.deps.store.updateProjectEventClaim(event.id, seriesId, [claim.state], { state: 'pending', updatedAt: this.now() }))) return;
    await this.carryOn(entry, trigger, event, key, { taskId: kept.task.id,
      text: recurrenceMessage(triggerContext(event, key), { seen: kept.run.seen, finished, ...(liveAt !== undefined ? { liveAt } : {}) }) });
  }

  /** Give an event to its key's task (`pending` claim): a message if it can
   *  take one, kept until it can, a continuation once it has finished. */
  private async carryOn(entry: ArmedEntry, trigger: EventTrigger, event: ProjectEvent, key: string, to: { taskId: string; text?: string }): Promise<void> {
    const seriesId = entry.task.id;
    try {
      await this.deps.fire(to.taskId, 'followUp', triggerContext(event, key), trigger, to.text);
      await this.deps.store.updateProjectEventClaim(event.id, seriesId, ['pending'], { state: 'told', runId: to.taskId, reason: null, updatedAt: this.now() });
      // Only what it has heard: a continuation made meanwhile already took the key along.
      if (!(await this.deps.store.updateKeyedRun(seriesId, key, { seen: event.count })))
        await this.keepKey(entry.task, key, { taskId: to.taskId, seen: event.count });
      this.announce(event, to.taskId, 'told');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.store.updateProjectEventClaim(event.id, seriesId, ['pending'],
        { state: 'deferred', reason: `${FAILED_START}: ${message}`.slice(0, 300), updatedAt: this.now() });
    }
  }

  private async keepKey(series: TaskRecord, key: string, value: { taskId?: string; seen: number; reason?: string }): Promise<void> {
    await this.deps.store.saveKeyedRun({ seriesId: series.id, key, projectId: series.projectId,
      organizationId: (await this.organizationOfTask(series.id, series)) ?? 'org_personal',
      state: value.taskId ? 'run' : 'skipped', seen: value.seen, ...(value.taskId ? { taskId: value.taskId } : {}), ...(value.reason ? { reason: value.reason } : {}) });
  }

  // ─── Gate ──────────────────────────────────────────────────────────────────

  /** Ask the trigger's gate about a `deferred` claim, off the dispatch queue
   *  (a model answers in seconds; events must not wait behind it). */
  private askGate(entry: ArmedEntry, trigger: EventTrigger, event: ProjectEvent, key: string | undefined): void {
    const id = `${event.id}:${entry.task.id}`;
    if (this.gating.has(id)) return;
    this.gating.add(id);
    const keeps = key !== undefined && trigger.concurrency?.mode === 'continue';
    this.track((async () => {
      let verdict: GateVerdict;
      try {
        const keys: GateRequest['keys'] = [];
        if (keeps) for (const run of (await this.deps.store.listKeyedRuns(entry.task.id)).filter((candidate) => candidate.taskId && candidate.key !== key).slice(0, 40)) {
          const task = await this.deps.store.taskMetadata(run.taskId!);
          if (task && task.lastView?.status !== 'cancelled') keys.push({ key: run.key, taskId: task.id, title: task.title, status: task.lastView?.status ?? 'active' });
        }
        verdict = await this.deps.gate!({ series: entry.task, trigger, event, keys });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`gate of ${entry.task.id} could not be asked about ${event.id}: ${message}`);
        verdict = { decision: 'start', reason: `its gate could not be asked (${message.slice(0, 120)})` };
      }
      // Still marked as being asked until its verdict is applied: a sweep in between must not ask twice.
      await this.enqueue(() => this.applyGate(entry, trigger, event.id, key, verdict), 'gate verdict');
    })().finally(() => this.gating.delete(id)));
  }

  private async applyGate(entry: ArmedEntry, trigger: EventTrigger, eventId: string, key: string | undefined, verdict: GateVerdict): Promise<void> {
    const seriesId = entry.task.id;
    if (this.armed.get(seriesId) !== entry) return;
    const claim = await this.deps.store.getProjectEventClaim(eventId, seriesId);
    const event = await this.deps.store.getProjectEvent(eventId);
    if (!event || claim?.state !== 'deferred') return;
    const keeps = key !== undefined && trigger.concurrency?.mode === 'continue';
    const why = (verdict.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (verdict.decision === 'skip') {
      const reason = `its gate: ${why || 'not worth a run'}`;
      if (!(await this.deps.store.updateProjectEventClaim(eventId, seriesId, ['deferred'], { state: 'skipped', reason, updatedAt: this.now() }))) return;
      if (keeps) await this.keepKey(entry.task, key!, { seen: event.count, reason });
      this.log(`gate skipped ${event.type} ${event.key} for ${seriesId}: ${why}`);
      return;
    }
    const into = verdict.decision === 'merge' && keeps && verdict.into && verdict.into !== key ? await this.keyTask(seriesId, verdict.into, event) : undefined;
    if (into) {
      if (!(await this.deps.store.updateProjectEventClaim(eventId, seriesId, ['deferred'], { state: 'pending', updatedAt: this.now() }))) return;
      await this.keepKey(entry.task, key!, { taskId: into.task.id, seen: event.count, reason: `its gate: the same as ${verdict.into}${why ? ` (${why})` : ''}` });
      await this.carryOn(entry, trigger, event, key!, { taskId: into.task.id });
      return;
    }
    const gateReason = why || undefined;
    const approved = { ...claim, gated: true, reason: 'its gate said to start it', ...(gateReason ? { gateReason } : {}) };
    if (await this.deps.store.updateProjectEventClaim(eventId, seriesId, ['deferred'],
      { state: 'deferred', reason: approved.reason, gated: true, gateReason: gateReason ?? null, updatedAt: this.now() })) {
      this.log(`gate started ${event.type} ${event.key} for ${seriesId}${why ? `: ${why}` : ''}`);
      await this.offerProjectEvent(entry, trigger, event, approved);
    }
  }

  private async tellEventRun(entry: ArmedEntry, event: ProjectEvent, runId: string, concurrencyKey: string | undefined): Promise<void> {
    const taskId = entry.task.id;
    try {
      await this.deps.tell!(runId, triggerContext(event, concurrencyKey));
      await this.deps.store.updateProjectEventClaim(event.id, taskId, ['pending'],
        { state: 'told', runId, reason: null, updatedAt: this.now() });
      this.announce(event, runId, 'told');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.store.updateProjectEventClaim(event.id, taskId, ['pending'],
        { state: 'deferred', reason: `${FAILED_START}: ${message}`.slice(0, 300), updatedAt: this.now() });
    }
  }

  /** Best effort and off the dispatch path: an answer never holds up an event. */
  private announce(event: ProjectEvent, runId: string, how: 'started' | 'told'): void {
    if (!this.deps.announce) return;
    this.track(Promise.resolve().then(() => this.deps.announce!(event, runId, how))
      .catch((error) => this.log(`announcing event ${event.id} failed: ${error instanceof Error ? error.message : String(error)}`)));
  }

  private async startEventRun(entry: ArmedEntry, trigger: EventTrigger, event: ProjectEvent, concurrencyKey: string | undefined): Promise<void> {
    const taskId = entry.task.id;
    const repeatable = this.repeats(entry, trigger);
    if (!repeatable) {
      if (entry.followUp) this.spendOneShot(entry, trigger);
      else {
        entry.fired = true;
        for (const timer of entry.timers) this.clearTimer(timer);
        entry.timers = [];
      }
    }
    try {
      const started = await this.deps.fire(taskId, entry.followUp ? 'followUp' : repeatable ? 'clone' : 'self', triggerContext(event, concurrencyKey), trigger);
      const { startedTaskId: runId, told } = (started ?? {}) as { startedTaskId?: string; told?: boolean };
      await this.deps.store.updateProjectEventClaim(event.id, taskId, ['pending'],
        { state: told ? 'told' : 'started', runId: runId ?? null, reason: null, updatedAt: this.now() });
      if (runId && concurrencyKey !== undefined && trigger.concurrency?.mode === 'continue' && !entry.followUp)
        await this.keepKey(entry.task, concurrencyKey, { taskId: runId, seen: event.count });
      if (!repeatable && !entry.followUp && this.armed.get(taskId) === entry) await this.hearFollowUpsAfterStart(taskId);
      this.log(`event ${event.type} ${entry.followUp ? 'followed up' : 'started'} ${repeatable && !entry.followUp ? `a run of ${taskId}` : taskId}`);
      if (runId) this.announce(event, runId, told ? 'told' : 'started');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!repeatable && this.armed.get(taskId) === entry) {
        if (entry.followUp) entry.triggers.push(trigger);
        else entry.fired = false;
      }
      // A start refused for good is skipped, not retried every minute.
      const refused = error instanceof EventRunRefused;
      await this.deps.store.updateProjectEventClaim(event.id, taskId, ['pending'],
        { state: refused ? 'skipped' : 'deferred', reason: (refused ? message : `${FAILED_START}: ${message}`).slice(0, 300), updatedAt: this.now() });
      this.log(`event ${event.type} could not start ${taskId}: ${message}`);
    }
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
        await this.deps.store.lockTask(entry.task.id);
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
    const repeatable = this.repeats(entry, trig);
    const taskId = entry.task.id;
    if (!repeatable) {
      if (entry.followUp) this.spendOneShot(entry, trig);
      else {
        entry.fired = true;
        for (const timer of entry.timers) this.clearTimer(timer);
        entry.timers = [];
      }
    }
    this.track((entry.followUp ? this.deps.fire(taskId, 'followUp', undefined, trig) : this.deps.fire(taskId, repeatable ? 'clone' : 'self'))
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
        if (!repeatable && !entry.followUp) await this.hearFollowUpsAfterStart(taskId);
        this.log(`trigger fired for ${taskId} (${trig.kind}, ${entry.followUp ? 'follow-up' : repeatable ? 'run' : 'self'})`);
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
        if (entry.followUp && !repeatable) entry.triggers.push(trig);
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
        if (entry.followUp) {
          if (!task) return this.disarm(taskId);
          entry.task = task;
          (await this.refreshDependencies(entry));
          this.evaluate(entry);
          return;
        }
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
