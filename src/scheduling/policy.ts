import { normalCdf, normalQuantile, type SizeModel } from './size-model.js';

/**
 * Which waiting agent turn gets which model login, and when (wiki
 * planned/quota-scheduling). Two decisions:
 *
 * - Whom: the highest rank `w_k · g(a)`, where `w_k` is the priority's delay
 *   cost (an hour of waiting at High costs as much as `w_high / w_low` hours at
 *   Low) and `g(a)` the Gittins rank of the task tree after spending `a`
 *   (sub-tasks count in their root's tree). Ranking by it minimises the total
 *   priority-weighted waiting; since `g` falls as a tree spends, no tree can hog.
 * - When: quota is perishable (a window's remainder is lost at its reset) and
 *   better work may still arrive before then. Admitting a turn of rank `I` must
 *   leave the quota that higher-ranked demand is expected to need until the
 *   window resets: the Littlewood protection level `y` with
 *   `P(D_{>I}(τ) > y) = I / Ī_{>I}` (both lose the same wait, until the next
 *   capacity, if the unit is missing, so the ranks are the fares). As the reset
 *   nears, `D(τ) → 0` and everything left is used.
 *
 * Units are the caller's (production: API-equivalent dollars, each login's
 * window capacity converted with its learned quota-per-dollar rate). Pure and
 * deterministic, so a workflow activity or the simulator can run it.
 */

export type Priority = 'low' | 'medium' | 'high' | 'urgent';

export interface SchedulingParams {
  /** Delay cost per hour of waiting, by priority. Urgent is also never held back. */
  weights: Record<Priority, number>;
  /** Turns a login may run at once: a safety bound, not the scheduler. */
  maxConcurrent: number;
  /**
   * Scale of the protection levels: 1 is Littlewood's rule, 0 never holds quota back.
   * Littlewood assumes demand turned away is lost; here it only waits and later
   * takes what higher-ranked work left, so less than 1 is better. The best value
   * depends on load (simulated: 0.75 at 0.7× capacity, 0.5 at 1–1.3×, 1 under a
   * 20-sub-task burst); 0.75 has the least worst-case regret. Tune per
   * organization with benchmarks/scheduling.ts on its fitted model.
   */
  reserve: number;
}

export const DEFAULT_SCHEDULING: SchedulingParams = {
  weights: { low: 1, medium: 3, high: 10, urgent: 100 },
  maxConcurrent: 10,
  reserve: 0.75,
};

export interface QuotaWindow {
  kind: 'session' | 'week';
  capacity: number;
  used: number;
  /** When it resets; undefined for a session window that starts at its first use. */
  resetAt?: number;
  length: number;
}

export interface LoginState {
  id: string;
  provider: string;
  windows: QuotaWindow[];
  running: number;
  /** Expected remaining spend of the turns it runs now. */
  committed: number;
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
}

export interface TurnRequest {
  id: string;
  treeId: string;
  requestedAt: number;
  /** Logins it may use, in its credential order. */
  logins: string[];
}

export interface DemandForecast {
  /** Expected new task trees in [from, to) (minutes; time-of-week profile in production). */
  arrivals(from: number, to: number): number;
  /** Negative-binomial dispersion of those counts (Infinity: Poisson). */
  dispersion: number;
  mix: Record<Priority, number>;
  size: SizeModel;
  /** Typical spend per minute of a new tree's turn. */
  burnRate: number;
}

export interface Admission { requestId: string; loginId: string }

export function treeRank(tree: Pick<TreeState, 'priority' | 'attained'>, size: SizeModel, params: SchedulingParams): number {
  return params.weights[tree.priority] * size.rank(tree.attained);
}

const remaining = (w: QuotaWindow) => Math.max(0, w.capacity - (w.resetAt === undefined ? 0 : w.used));

/** Room for another turn, and quota left in every window (a sliver would only cut the turn short). */
export function usable(login: LoginState, params: SchedulingParams): boolean {
  return login.running < params.maxConcurrent && login.windows.every((w) => remaining(w) > w.capacity * 1e-3);
}

interface Spend { mean: number; variance: number; rank: number }

/**
 * Spend expected from work ranked above a given rank before a horizon `tau`
 * (minutes): trees not here yet (a negative-binomial number of arrivals, each
 * spending min(S, burn × time left)) and the further spend of trees already
 * working. Memoised per horizon within one scheduling pass.
 */
class Demand {
  private readonly fresh = new Map<number, { priority: Priority; rank: number; mean: number; variance: number }[]>();
  private readonly working = new Map<number, { rank: number; mean: number; variance: number }[]>();

  constructor(private readonly now: number, private readonly trees: TreeState[],
    private readonly forecast: DemandForecast, private readonly params: SchedulingParams) {}

  /** Trees changed (a turn was admitted): their further spend must be recomputed. */
  invalidate(): void { this.working.clear(); }

  above(tau: number, rank: number): Spend {
    let mean = 0, variance = 0, weighted = 0;
    for (const x of this.freshAt(tau)) if (x.rank > rank) { mean += x.mean; variance += x.variance; weighted += x.rank * x.mean; }
    for (const x of this.workingAt(tau)) if (x.rank > rank) { mean += x.mean; variance += x.variance; weighted += x.rank * x.mean; }
    return { mean, variance, rank: mean > 0 ? weighted / mean : 0 };
  }

  private freshAt(tau: number) {
    const key = Math.round(tau);
    let rows = this.fresh.get(key);
    if (rows) return rows;
    const { forecast, params } = this;
    const expected = forecast.arrivals(this.now, this.now + tau);
    const nodes = [1, 3, 5, 7].map((i) => tau * i / 8); // time left after a uniform arrival
    const m1 = nodes.reduce((s, t) => s + forecast.size.expectedMin(forecast.burnRate * t), 0) / nodes.length;
    const m2 = nodes.reduce((s, t) => s + forecast.size.expectedMinSquared(forecast.burnRate * t), 0) / nodes.length;
    rows = (Object.keys(forecast.mix) as Priority[]).map((priority) => {
      const n = expected * forecast.mix[priority];
      const dispersion = Number.isFinite(forecast.dispersion) ? n * n * m1 * m1 / forecast.dispersion : 0;
      return { priority, rank: treeRank({ priority, attained: 0 }, forecast.size, params), mean: n * m1, variance: n * m2 + dispersion };
    });
    this.fresh.set(key, rows);
    return rows;
  }

  private workingAt(tau: number) {
    const key = Math.round(tau);
    let rows = this.working.get(key);
    if (rows) return rows;
    rows = this.trees.filter((t) => t.running > 0).map((tree) => {
      const next = this.forecast.size.residual(tree.attained, tree.burnRate * tree.running * tau);
      return { rank: treeRank(tree, this.forecast.size, this.params), mean: Math.max(0, next.mean - tree.committed), variance: next.variance };
    });
    this.working.set(key, rows);
    return rows;
  }
}

const until = (now: number, window: QuotaWindow) => (window.resetAt ?? now + window.length) - now;

/**
 * Quota that work ranked above `rank` is expected to need before `window`
 * resets: Littlewood's protection level y with P(D > y) = rank / Ī, for D the
 * higher-ranked demand and Ī its demand-weighted mean rank.
 */
function protectionLevel(now: number, window: QuotaWindow, rank: number, demand: Demand, params: SchedulingParams): number {
  const tau = until(now, window);
  if (params.reserve <= 0 || tau <= 0) return 0;
  const d = demand.above(tau, rank);
  if (d.mean <= 0 || rank >= d.rank) return 0;
  return params.reserve * Math.max(0, d.mean + normalQuantile(1 - rank / d.rank) * Math.sqrt(d.variance));
}

/** Quota of this provider's logins available before `window` of `login` resets (refills included). */
function poolQuota(now: number, login: LoginState, window: QuotaWindow, logins: LoginState[]): number {
  const horizon = now + until(now, window);
  let total = 0;
  for (const other of logins) {
    if (other.provider !== login.provider) continue;
    const w = other.windows.find((x) => x.kind === window.kind);
    if (!w) continue;
    total += remaining(w) - other.committed;
    if (w.resetAt !== undefined && w.resetAt < horizon) total += w.capacity;
  }
  return total;
}

/**
 * How likely the quota a turn would spend on `login` is to be missed before it
 * comes back: the chance, per window, that all expected work outruns the pool's
 * quota before that window resets. A login whose week resets soon costs almost
 * nothing to drain; spreading work over every login would instead run all their
 * weeks out together, and nothing could run for days.
 */
function scarcity(now: number, login: LoginState, logins: LoginState[], demand: Demand): number {
  let worst = 0;
  for (const w of login.windows) {
    const d = demand.above(until(now, w), -Infinity);
    if (d.mean <= 0) continue;
    const z = (d.mean - poolQuota(now, login, w, logins)) / Math.max(1e-9, Math.sqrt(d.variance));
    worst = Math.max(worst, normalCdf(z));
  }
  return worst;
}

/** Earliest-resetting session first among equally scarce logins: its remainder is the first to be lost. */
const sessionReset = (login: LoginState) => login.windows.find((w) => w.kind === 'session')?.resetAt ?? Infinity;

export function schedule(now: number, logins: LoginState[], trees: TreeState[], requests: TurnRequest[],
  forecast: DemandForecast, params: SchedulingParams = DEFAULT_SCHEDULING): Admission[] {
  const working = trees.map((t) => ({ ...t }));
  const byId = new Map(working.map((t) => [t.id, t]));
  const state = logins.map((l) => ({ ...l, windows: l.windows.map((w) => ({ ...w })) }));
  const loginById = new Map(state.map((l) => [l.id, l]));
  const demand = new Demand(now, working, forecast, params);
  const ranked = requests
    .map((request) => ({ request, tree: byId.get(request.treeId)! }))
    .filter((x) => x.tree)
    .map((x) => ({ ...x, rank: treeRank(x.tree, forecast.size, params) }))
    .sort((a, b) => b.rank - a.rank || a.request.requestedAt - b.request.requestedAt);
  const admitted: Admission[] = [];
  for (const { request, tree, rank } of ranked) {
    const candidates = request.logins.map((id) => loginById.get(id)).filter((l): l is LoginState => !!l && usable(l, params))
      .map((l) => ({ l, scarce: Math.round(100 * scarcity(now, l, state, demand)) })) // within 1%: equally scarce
      .sort((a, b) => a.scarce - b.scarce || sessionReset(a.l) - sessionReset(b.l)).map((x) => x.l);
    // Littlewood: protection binds only when higher-ranked demand is expected; otherwise any quota left is used.
    const login = candidates.find((l) => tree.priority === 'urgent' || l.windows.every((w) => {
      const protect = protectionLevel(now, w, rank, demand, params);
      return protect <= 0 || poolQuota(now, l, w, state) - tree.turnCost >= protect;
    }));
    if (!login) continue;
    admitted.push({ requestId: request.id, loginId: login.id });
    login.running += 1;
    login.committed += tree.turnCost;
    tree.running += 1;
    tree.committed += tree.turnCost;
    demand.invalidate();
    for (const w of login.windows) if (w.resetAt === undefined && w.kind === 'session') w.resetAt = now + w.length;
  }
  return admitted;
}
