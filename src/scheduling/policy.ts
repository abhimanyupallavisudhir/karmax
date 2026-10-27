import { ArrivalForecast, seeded, type Random } from './forecast.js';
import { adjustRanks, type OrderConstraint } from './order.js';
import { SampledDemand } from './pricing.js';
import type { SizeModel } from './size-model.js';

/**
 * Which waiting agent turn gets which model login, and when (wiki
 * features/quota-scheduling).
 *
 * Objective: least priority-weighted waiting, Σ w_k(tree) · (finish − arrival).
 * A priority is a delay cost per hour; a task and its sub-tasks are one tree.
 *
 * - Whom: rank I = w_k · g(a), the Gittins rank of the tree after spending `a`
 *   (completions per dollar). Trees that spend a lot are ever less likely to be
 *   about to finish, so g falls and no tree hogs. Orders people set by dragging
 *   adjust ranks minimally (order.ts).
 * - When: a login's next unit of quota is worth E[V_(c)] if kept: the rank of the
 *   c-th unit of demand that would want it before it resets, over sampled
 *   futures (pricing.ts). A 5-hour window is priced at E[max(V_(c), weekly
 *   price)]: a unit left in it keeps its weekly unit. A turn starts only on a
 *   login whose price its rank meets; near a reset the price falls to zero and
 *   what is left gets used.
 * - Where: the login whose quota is cheapest (least needed), then the one that
 *   served the tree last (its prompt cache is warm there), then the soonest reset.
 *
 * Times are minutes since the epoch; quota is in API-equivalent dollars (each
 * window's capacity converted with the login's learned quota-per-dollar rate).
 * Pure: an activity and the simulator both run it.
 */

export type Priority = 'low' | 'medium' | 'high' | 'urgent';

export interface SchedulingParams {
  /** Delay cost per hour of waiting, by priority (unset tasks are medium). */
  weights: Record<Priority, number>;
  /** Turns a login may run at once: a safety bound, not the scheduler. */
  maxConcurrent: number;
  /** Sampled futures per 5-hour window price and per weekly price. */
  scenarios: number;
  weekScenarios: number;
  /** false: never keep quota back (rank order only). */
  holdBack?: boolean;
}

export const DEFAULT_SCHEDULING: SchedulingParams = {
  weights: { low: 1, medium: 3, high: 10, urgent: 30 },
  maxConcurrent: 10,
  scenarios: 24,
  weekScenarios: 12,
};

export interface QuotaWindow {
  kind: 'session' | 'week';
  /** Capacity in dollars. */
  capacity: number;
  used: number;
  /** When it resets (minutes); undefined for a session window that starts at its first use. */
  resetAt?: number;
  /** Its length (minutes). */
  length: number;
}

export interface LoginState {
  id: string;
  provider: string;
  /** No windows: quota is not limited (an API key), so it is never held back. */
  windows: QuotaWindow[];
  running: number;
  /** Expected remaining spend of the turns it runs now. */
  committed: number;
  /** Exhausted until (minutes), as reported by a turn that hit its limit. */
  blockedUntil?: number;
  /** A concurrency bound of its own (the login's setting), else `maxConcurrent`. */
  maxConcurrent?: number;
}

export interface TreeState {
  id: string;
  priority: Priority;
  /** What the tree (root and sub-tasks) has spent so far. */
  attained: number;
  /** Spend per minute of one running turn. */
  burnRate: number;
  /** Expected spend of its next turn. */
  turnCost: number;
  running: number;
  /** Expected remaining spend of its running turns (part of its logins' `committed`). */
  committed: number;
  /** Turns it can run at once (its sub-tasks). */
  lanes?: number;
  /** The login it last ran on. */
  lastLogin?: string;
  /** Someone said to run it now: its quota is never kept back for better work (it still waits for a slot and a limit). */
  runNow?: boolean;
}

export interface TurnRequest {
  id: string;
  treeId: string;
  /** The task asking (a root or a sub-task), for orders within a tree. */
  taskId?: string;
  requestedAt: number;
  /** Logins it may use, in its credential order. */
  logins: string[];
}

export interface Forecast {
  arrivals: Pick<ArrivalForecast, 'sample'>;
  size: SizeModel;
  /** Spend per minute of one turn of a new tree, and the turns a new tree runs at once. */
  burnRate: number;
  lanes: number;
}

export type QueueStatus =
  /** Starts now. */
  | 'admit'
  /** Its rank clears a login's price, but that login is running all it may. */
  | 'next'
  /** Kept back: its quota is worth more to work expected before the reset. */
  | 'held'
  /** Every login it may use has run out. */
  | 'quota';

export interface QueueEntry {
  requestId: string;
  treeId: string;
  rank: number;
  status: QueueStatus;
  loginId?: string;
  /** When it should start, at the latest (minutes): a price falling, or a reset. */
  until?: number;
  /** Its rank was moved by a person's order. */
  placed?: boolean;
}

export interface Admission { requestId: string; loginId: string }

export interface ScheduleInput {
  now: number;
  logins: LoginState[];
  trees: TreeState[];
  requests: TurnRequest[];
  forecast: Forecast;
  params?: SchedulingParams;
  /** Orders between trees (by tree id) and between a tree's tasks (by task id). */
  order?: OrderConstraint[];
  seed?: number;
}

export interface ScheduleResult {
  admissions: Admission[];
  /** Every waiting request, in the order it will be served. */
  queue: QueueEntry[];
  /** Each login's current price per dollar of its 5-hour window, and of its week. */
  prices: Record<string, { session: number; week: number }>;
  /** Every tree's rank, people's orders applied. */
  ranks: Record<string, number>;
}

/** Sampled demand for a login's windows, reusable across calls while fresh (the simulator). */
export interface DemandCache {
  entries: Map<string, { builtAt: number; demand: SampledDemand }>;
  /** Minutes a sample stays good for: 5-hour windows, and weeks. */
  sessionTtl: number;
  weekTtl: number;
}

export function treeRank(tree: Pick<TreeState, 'priority' | 'attained'>, size: SizeModel, params: SchedulingParams): number {
  return params.weights[tree.priority] * size.rank(tree.attained);
}

const left = (w: QuotaWindow) => Math.max(0, w.capacity - (w.resetAt === undefined ? 0 : w.used));
const expiry = (w: QuotaWindow, now: number) => w.resetAt ?? now + w.length;
const windowOf = (login: LoginState, kind: QuotaWindow['kind']) => login.windows.find((w) => w.kind === kind);

/** Quota left in every window, and not reported exhausted. */
export function hasQuota(login: LoginState, now: number): boolean {
  if (login.blockedUntil !== undefined && login.blockedUntil > now) return false;
  return login.windows.every((w) => left(w) > w.capacity * 1e-3);
}

/**
 * Adds a tree's demand before `horizon` to a scenario: its further size drawn
 * given what it has spent, cut into pieces at the lowest rank on the way, each
 * wanted when its turns would reach it at their burn rate.
 */
function treeDemand(piece: (rank: number, quota: number, at: number) => void, size: SizeModel, u: Random,
  spent: number, weight: number, rate: number, start: number, horizon: number): void {
  if (start >= horizon || rate <= 0) return;
  const total = size.sampleBeyond(spent, u());
  const amount = Math.min(total - spent, rate * (horizon - start));
  let cumulative = 0;
  size.pieces(spent, amount, weight, (rank, quota) => {
    cumulative += quota;
    piece(rank, quota, start + cumulative / rate);
  });
}

export function schedule(input: ScheduleInput, cache?: DemandCache): ScheduleResult {
  const { now, forecast } = input;
  const params = input.params ?? DEFAULT_SCHEDULING;
  const trees = new Map(input.trees.map((t) => [t.id, { ...t }]));
  const logins = input.logins.map((l) => ({ ...l, windows: l.windows.map((w) => ({ ...w })) }));
  const byLogin = new Map(logins.map((l) => [l.id, l]));
  const order = input.order ?? [];

  // Ranks, moved as little as possible to respect people's orders between trees.
  const base = new Map([...trees.values()].map((t) => [t.id, treeRank(t, forecast.size, params)]));
  const ranks = adjustRanks(base, order);
  const factor = (id: string) => ranks.get(id)! / base.get(id)!;

  // Sampled demand before each login's resets (the same for logins resetting together).
  const local = new Map<string, SampledDemand>();
  const demandFor = (login: LoginState, kind: QuotaWindow['kind']): SampledDemand | undefined => {
    const w = windowOf(login, kind);
    if (!w) return undefined;
    const horizon = expiry(w, now) - now;
    // A window not started yet always has its full length ahead: one key for all of them.
    const key = `${login.provider}:${kind}:${w.resetAt === undefined ? 'fresh' : Math.round(w.resetAt)}`;
    const memo = local.get(key);
    if (memo) return memo;
    const ttl = kind === 'session' ? cache?.sessionTtl : cache?.weekTtl;
    const hit = cache?.entries.get(key);
    if (hit && ttl !== undefined && now - hit.builtAt < ttl) { local.set(key, hit.demand); return hit.demand; }
    const demand = new SampledDemand(Math.max(1, horizon));
    const u = seeded(((input.seed ?? 0) * 1_000_003 + Math.round(now) * 31 + (kind === 'week' ? 7 : 0)) >>> 0);
    const runs = kind === 'session' ? params.scenarios : params.weekScenarios;
    for (let s = 0; s < runs; s++) demand.add((piece) => {
      for (const t of trees.values()) {
        const lanes = Math.max(1, t.running, t.lanes ?? 1);
        treeDemand(piece, forecast.size, u, t.attained + t.committed, params.weights[t.priority] * factor(t.id),
          lanes * t.burnRate, 0, horizon);
      }
      for (const arrival of forecast.arrivals.sample(now, now + horizon, u)) {
        treeDemand(piece, forecast.size, u, 0, params.weights[arrival.priority], forecast.lanes * forecast.burnRate,
          arrival.at - now, horizon);
      }
    });
    if (cache && ttl !== undefined) {
      for (const [k, v] of cache.entries) if (now - v.builtAt >= Math.max(cache.sessionTtl, cache.weekTtl)) cache.entries.delete(k);
      cache.entries.set(key, { builtAt: now, demand });
    }
    local.set(key, demand);
    return demand;
  };

  // c for a login: the quota of its provider's logins that comes before its own runs out.
  /**
   * The c in E[V^{>r}_(c)] for a login's window: every unit of the provider's
   * logins that work wanting quota before that window resets could use instead
   * (demand past one login spills to the next, and waits only past all of them),
   * less what running turns will still spend. Only quota that exists by then
   * counts: before a 5-hour reset, the quota there is now; within a week, also
   * the 5-hour windows that open meanwhile, but not another login's next week.
   */
  const ahead = (login: LoginState, kind: QuotaWindow['kind']): number => {
    const horizon = expiry(windowOf(login, kind)!, now);
    let total = 0;
    for (const other of logins) {
      if (other.provider !== login.provider) continue;
      const session = windowOf(other, 'session'), week = windowOf(other, 'week');
      const open = hasQuota(other, now);
      const sessionTotal = session ? (open ? left(session) : 0)
        + (kind === 'week' ? Math.max(0, Math.ceil((horizon - expiry(session, now)) / session.length)) * session.capacity : 0) : Infinity;
      const usable = Math.min(sessionTotal, week ? (open ? left(week) : 0) : Infinity);
      if (Number.isFinite(usable)) total += usable - other.committed;
    }
    return Math.max(0, total);
  };

  // What a login's next unit is worth, kept, to work ranked above `rank`; memoised until a grant changes the quota ahead.
  let granted = 0;
  const memo = new Map<string, { session: number; week: number }>();
  const priceOf = (login: LoginState, rank: number): { session: number; week: number } => {
    if (params.holdBack === false) return { session: 0, week: 0 };
    const key = `${login.id}|${rank}|${granted}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const week = windowOf(login, 'week') ? demandFor(login, 'week')!.price(ahead(login, 'week'), 0, 0, rank) : 0;
    const session = windowOf(login, 'session') ? demandFor(login, 'session')!.price(ahead(login, 'session'), week, 0, rank) : week;
    const price = { session, week };
    memo.set(key, price);
    return price;
  };

  // Within a tree, people's orders between its tasks, else first asked first.
  const within = new Map<string, number>();
  for (const [treeId] of trees) {
    const own = input.requests.filter((r) => r.treeId === treeId).sort((a, b) => a.requestedAt - b.requestedAt);
    const local = new Map(own.map((r, i) => [r.taskId ?? r.id, Math.exp(-i * 1e-3)]));
    const adjusted = adjustRanks(local, order);
    for (const r of own) within.set(r.id, adjusted.get(r.taskId ?? r.id) ?? 1);
  }
  const requests = input.requests.filter((r) => trees.has(r.treeId)).sort((a, b) =>
    ranks.get(b.treeId)! - ranks.get(a.treeId)! || (a.treeId === b.treeId ? within.get(b.id)! - within.get(a.id)! : 0)
    || a.requestedAt - b.requestedAt);

  const admissions: Admission[] = [];
  const queue: QueueEntry[] = [];
  const placed = new Set(order.flatMap((c) => [c.above, c.below]));
  for (const request of requests) {
    const tree = trees.get(request.treeId)!;
    const rank = ranks.get(tree.id)!;
    const allowed = request.logins.map((id) => byLogin.get(id)).filter((l): l is LoginState => !!l);
    const withQuota = allowed.filter((l) => hasQuota(l, now));
    const entry: QueueEntry = { requestId: request.id, treeId: tree.id, rank, status: 'quota',
      ...(placed.has(tree.id) || placed.has(request.taskId ?? '') ? { placed: true } : {}) };
    if (!withQuota.length) {
      const resets = allowed.map((l) => Math.max(l.blockedUntil ?? 0,
        ...l.windows.filter((w) => left(w) <= w.capacity * 1e-3).map((w) => expiry(w, now))));
      if (resets.length) entry.until = Math.min(...resets);
      queue.push(entry);
      continue;
    }
    const affordable = tree.runNow ? withQuota : withQuota.filter((l) => rank >= priceOf(l, rank).session);
    const open = affordable.filter((l) => l.running < (l.maxConcurrent ?? params.maxConcurrent));
    if (open.length) {
      const sessionEnd = (l: LoginState) => { const w = windowOf(l, 'session'); return w ? expiry(w, now) : Infinity; };
      // The quota least needed by better work first (rounded: tiny differences are noise), then a warm cache, then the soonest reset.
      const cost = (l: LoginState) => Math.round(priceOf(l, rank).session / Math.max(rank, 1e-12) * 100);
      open.sort((a, b) => cost(a) - cost(b)
        || Number(b.id === tree.lastLogin) - Number(a.id === tree.lastLogin)
        || sessionEnd(a) - sessionEnd(b));
      const login = open[0]!;
      admissions.push({ requestId: request.id, loginId: login.id });
      queue.push({ ...entry, status: 'admit', loginId: login.id });
      login.running += 1;
      login.committed += tree.turnCost;
      for (const w of login.windows) if (w.resetAt === undefined && w.kind === 'session') w.resetAt = now + w.length;
      tree.running += 1;
      tree.committed += tree.turnCost;
      tree.lastLogin = login.id;
      granted++;
      continue;
    }
    if (affordable.length) { queue.push({ ...entry, status: 'next' }); continue; }
    // Held: when will some login's price have fallen to its rank?
    let until = Infinity;
    for (const login of withQuota) {
      const { week } = priceOf(login, rank);
      // Held by the week: until the weekly price falls; else until the window's does.
      const release = week > rank
        ? demandFor(login, 'week')!.releaseIn(rank, ahead(login, 'week'))
        : demandFor(login, 'session')?.releaseIn(rank, ahead(login, 'session'), week) ?? 0;
      until = Math.min(until, now + release);
    }
    queue.push({ ...entry, status: 'held', ...(Number.isFinite(until) ? { until } : {}) });
  }
  // For people: what each login's next unit is worth to the lowest-ranked work.
  const prices: ScheduleResult['prices'] = Object.fromEntries(logins.map((l) => [l.id, priceOf(l, 0)]));
  return { admissions, queue, prices, ranks: Object.fromEntries(ranks) };
}
