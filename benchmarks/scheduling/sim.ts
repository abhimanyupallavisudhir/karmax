/**
 * Simulates quota scheduling policies on one workload (wiki planned/quota-scheduling).
 *
 *   npx tsx benchmarks/scheduling/sim.ts [--load 0.5,0.9,1.3] [--seeds 6] [--weeks 5]
 *
 * Calibrated to tavya.io's last 35 days (2026-09-22..10-27): root-task arrivals by
 * hour of day (UTC), clustered in batches of ~3 a person files at once (gaps have a
 * coefficient of variation ≈ 2), with day-to-day swings; tree sizes log-normal
 * (μ 3.07, σ 1.64 agent-minutes, median 21 min, p99 ≈ 26 h, top 10% of trees = 73% of
 * the work). Accounts are Claude Max 20x: a 5-hour window that starts on first use and
 * holds ≈ 250 agent-minutes (10 heavy agents emptied one in ~25 min), and a weekly
 * limit of ≈ 6 windows. Priorities are not yet used on tavya.io, so the mix is assumed.
 */
import { ArrivalForecast, PRIORITY_ORDER, SampledDemand, SizeTable, geometric, poisson, type Priority } from './policy.js';

const WEIGHT: Record<Priority, number> = { low: 1, normal: 3, high: 10, urgent: 30 };
const MIX: Record<Priority, number> = { low: 0.25, normal: 0.55, high: 0.15, urgent: 0.05 };
const SIZE = { mu: 3.07, sigma: 1.64, cap: 3600 };
const ACCOUNTS = 3, WINDOW = 300, WINDOW_QUOTA = 250, WEEKLY_QUOTA = 1500, MAX_AGENTS = 10, WEEK = 10_080;
/** Root tasks per UTC hour on tavya.io, 2026-09-22..10-27. */
const HOURS = [35, 27, 31, 31, 38, 19, 23, 18, 41, 21, 5, 7, 2, 1, 0, 2, 3, 5, 29, 34, 46, 49, 41, 34];
const BATCH = 3;

type Policy = 'fifo' | 'priority' | 'index' | 'priced';
interface Tree { arrive: number; priority: Priority; size: number; used: number; agents: number; start?: number; done?: number }
interface Account { end?: number; window: number; weekly: number; resetAt: number }

const option = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1]! : fallback;
};
const loads = option('load', '0.5,0.9,1.3').split(',').map(Number);
const seeds = Number(option('seeds', '6'));
const weeks = Number(option('weeks', '5'));
const policies = option('policies', 'fifo,priority,index,priced').split(',') as Policy[];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (u: number): Priority => {
  let acc = 0;
  for (const p of PRIORITY_ORDER) { acc += MIX[p]; if (u < acc) return p; }
  return 'normal';
};
/** Sub-tasks: bigger trees run more agents at once. */
const agentsFor = (size: number) => Math.max(1, Math.min(12, Math.round(Math.sqrt(size / 10))));

const table = new SizeTable(SIZE);
const meanSize = table.area.at(-1)!;

function workload(load: number, seed: number): Tree[] {
  const u = rng(seed);
  const perWeek = load * ACCOUNTS * WEEKLY_QUOTA / meanSize;
  const hourShare = HOURS.map((h) => h / HOURS.reduce((a, b) => a + b, 0));
  const trees: Tree[] = [];
  for (let day = 0; day < weeks * 7; day++) {
    const swing = -Math.log(u() * u()) / 2; // gamma(2), mean 1: some days are busier
    for (let hour = 0; hour < 24; hour++) {
      const batches = poisson(perWeek / 7 * hourShare[hour]! * swing / BATCH, u);
      for (let b = 0; b < batches; b++) {
        const at = (day * 24 + hour) * 60 + Math.floor(u() * 60);
        for (let i = geometric(BATCH, u); i > 0; i--) {
          const size = Math.max(1, Math.round(table.sampleBeyond(0, u())));
          trees.push({ arrive: at + Math.floor(u() * 10), priority: pick(u()), size, used: 0, agents: agentsFor(size) });
        }
      }
    }
  }
  return trees.sort((a, b) => a.arrive - b.arrive);
}

function simulate(source: Tree[], policy: Policy, seed: number) {
  const trees = source.map((t) => ({ ...t }));
  const u = rng(seed * 7919 + 1);
  const accounts: Account[] = Array.from({ length: ACCOUNTS }, (_, i) =>
    ({ window: 0, weekly: WEEKLY_QUOTA, resetAt: Math.round((i + 1) * WEEK / ACCOUNTS) }));
  const forecast = new ArrivalForecast(BATCH);
  const demand = new Map<Account, SampledDemand>();
  const floors = new Map<Account, number>();
  let next = 0, consumed = 0, expired = 0;
  const active: Tree[] = [];
  const end = weeks * WEEK;
  const expiry = (a: Account, t: number) => a.end ?? t + WINDOW;
  const left = (a: Account) => Math.min(a.end === undefined ? WINDOW_QUOTA : a.window, a.weekly);
  const index = (t: Tree) => WEIGHT[t.priority] * table.index(t.used);

  for (let t = 0; t < end; t++) {
    for (const a of accounts) {
      // Weekly quota left at the reset is the quota that was really lost.
      if (t >= a.resetAt) { expired += a.weekly; a.weekly = WEEKLY_QUOTA; a.resetAt += WEEK; }
      if (a.end !== undefined && t >= a.end) a.end = undefined;
    }
    while (next < trees.length && trees[next]!.arrive <= t) { active.push(trees[next]!); forecast.observe(t, trees[next]!.priority); next++; }
    if (policy === 'priced' && t % 10 === 0) {
      forecast.advanceTo(t);
      // What a quota will be asked for before it resets: the trees waiting now (their
      // sizes drawn given what they have used) and sampled arrivals, each capped by
      // what its agents can spend in the time left.
      const sample = (horizon: number, scenarios: number) => {
        const sampled = new SampledDemand();
        for (let s = 0; s < scenarios; s++) sampled.add((piece) => {
          for (const tr of active) {
            const size = table.sampleBeyond(tr.used, u());
            table.pieces(tr.used, Math.min(size - tr.used, tr.agents * horizon), WEIGHT[tr.priority], piece);
          }
          for (const { at, priority } of forecast.sample(t, t + horizon, u)) {
            const size = table.sampleBeyond(0, u());
            table.pieces(0, Math.min(size, agentsFor(size) * (t + horizon - at)), WEIGHT[priority], piece);
          }
        });
        return sampled;
      };
      // The weekly quota of each account, against its own reset: the quota of accounts
      // resetting no later is spent first, at most one window per 5 hours.
      if (t % 30 === 0) for (const a of accounts) {
        const horizon = a.resetAt - t;
        const spendable = (b: Account) => Math.min(b.weekly, MAX_AGENTS * horizon,
          left(b) + WINDOW_QUOTA * Math.max(0, Math.ceil((horizon - (expiry(b, t) - t)) / WINDOW)));
        const remaining = accounts.filter((b) => b.resetAt <= a.resetAt).reduce((s, b) => s + spendable(b), 0);
        floors.set(a, sample(horizon, 16).price(remaining, 0));
      }
      for (const a of accounts) demand.set(a, sample(expiry(a, t) - t, 32));
    }
    const order = [...active];
    if (policy === 'fifo') order.sort((a, b) => a.arrive - b.arrive);
    else if (policy === 'priority') order.sort((a, b) => WEIGHT[b.priority] - WEIGHT[a.priority] || a.arrive - b.arrive);
    else order.sort((a, b) => index(b) - index(a) || a.arrive - b.arrive);
    const busy = new Map<Account, number>();
    for (const tree of order) {
      for (let k = 0; k < tree.agents && tree.used < tree.size; k++) {
        const open = accounts.filter((a) => left(a) > 0 && (busy.get(a) ?? 0) < MAX_AGENTS);
        // The quota that perishes first goes first: the 5-hour window, then the week.
        if (policy === 'index' || policy === 'priced') open.sort((a, b) => expiry(a, t) - expiry(b, t) || a.resetAt - b.resetAt);
        let chosen = open[0];
        if (policy === 'priced') {
          const value = index(tree);
          chosen = open.find((a) => {
            const ahead = accounts.filter((b) => expiry(b, t) <= expiry(a, t)).reduce((s, b) => s + left(b), 0);
            const floor = floors.get(a) ?? 0;
            return value >= (demand.get(a)?.price(ahead, floor) ?? floor);
          });
        }
        if (!chosen) break;
        if (chosen.end === undefined) { chosen.end = t + WINDOW; chosen.window = WINDOW_QUOTA; }
        chosen.window--; chosen.weekly--; consumed++;
        busy.set(chosen, (busy.get(chosen) ?? 0) + 1);
        tree.used++;
        tree.start ??= t;
      }
      if (tree.used >= tree.size) { tree.done = t + 1; active.splice(active.indexOf(tree), 1); }
    }
  }
  // Trees arriving after the first week (warm-up), each counted until it finished
  // or the simulation ended (a lower bound for those still waiting).
  const measured = trees.filter((t) => t.arrive >= WEEK);
  const byPriority = Object.fromEntries(PRIORITY_ORDER.map((p) => {
    const group = measured.filter((t) => t.priority === p);
    const hours = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length) / 60;
    const starts = group.map((t) => (t.start ?? end) - t.arrive).sort((a, b) => a - b);
    return [p, { response: hours(group.map((t) => (t.done ?? end) - t.arrive)), start: hours(starts),
      startP90: (starts[Math.floor(0.9 * (starts.length - 1))] ?? 0) / 60, n: group.length }];
  }));
  const weighted = measured.reduce((s, t) => s + WEIGHT[t.priority] * ((t.done ?? end) - t.arrive), 0)
    / measured.reduce((s, t) => s + WEIGHT[t.priority], 0) / 60;
  return { byPriority, weighted, done: measured.filter((t) => t.done !== undefined).length / measured.length,
    // Of the weekly quota that reached its reset, the share spent and the share lost.
    utilization: consumed / (consumed + expired), expired: expired / (consumed + expired) };
}

type Result = ReturnType<typeof simulate>;
const mean = (rs: Result[], f: (r: Result) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
const report: Record<string, Record<string, unknown>> = {};
for (const load of loads) {
  const results = new Map<Policy, Result[]>(policies.map((p) => [p, []]));
  for (let seed = 1; seed <= seeds; seed++) {
    const work = workload(load, seed);
    for (const p of policies) results.get(p)!.push(simulate(work, p, seed));
  }
  console.log(`\nload ${load} (demand ÷ weekly quota), ${seeds} seeds × ${weeks} weeks; hours, mean over seeds`);
  console.log('policy    weighted  done   used  lostWk | ' + PRIORITY_ORDER.map((p) => `${p.padEnd(6)} resp/start/p90start`).join(' | '));
  for (const [p, rs] of results) {
    const row = PRIORITY_ORDER.map((q) => [mean(rs, (r) => r.byPriority[q]!.response), mean(rs, (r) => r.byPriority[q]!.start),
      mean(rs, (r) => r.byPriority[q]!.startP90)].map((x) => x.toFixed(1).padStart(5)).join('/')).join(' | ');
    console.log(`${p.padEnd(9)} ${mean(rs, (r) => r.weighted).toFixed(1).padStart(8)} ${(100 * mean(rs, (r) => r.done)).toFixed(0).padStart(4)}% ${(100 * mean(rs, (r) => r.utilization)).toFixed(0).padStart(4)}% ${(100 * mean(rs, (r) => r.expired)).toFixed(0).padStart(5)}% | ${row}`);
    report[`${load}:${p}`] = { weighted: mean(rs, (r) => r.weighted), done: mean(rs, (r) => r.done), utilization: mean(rs, (r) => r.utilization),
      expired: mean(rs, (r) => r.expired), byPriority: Object.fromEntries(PRIORITY_ORDER.map((q) => [q, {
        response: mean(rs, (r) => r.byPriority[q]!.response), start: mean(rs, (r) => r.byPriority[q]!.start),
        startP90: mean(rs, (r) => r.byPriority[q]!.startP90) }])) };
  }
}
if (process.argv.includes('--json')) console.log(JSON.stringify(report));
