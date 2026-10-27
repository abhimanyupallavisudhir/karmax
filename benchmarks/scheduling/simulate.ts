/**
 * Quota scheduling simulator (wiki features/quota-scheduling): today's
 * first-come-first-served leasing against rank order alone, the first
 * Littlewood design, and the scheduler (src/scheduling/policy.ts), on traffic
 * calibrated to tavya.io (calibration.json).
 *
 *   npx tsx benchmarks/scheduling/simulate.ts [--days 35] [--seeds 8] [--load 0.7,1,1.3] [--burst 1500]
 *     [--policies today,index,littlewood,littlewood-learned,scheduler] [--mix low:.1,medium:.75,high:.12,urgent:.03] [--json out.json]
 *
 * Logins work like Claude Max: a 5-hour window that starts at first use and a
 * weekly limit, staggered. Turns run their measured lengths and are not
 * preempted; a login that runs out cuts its turns. A tree resuming on another
 * login, or after an hour, re-writes its prompt cache (extra spend).
 * Units: API-equivalent dollars of model use; minutes.
 */
import fs from 'node:fs';
import { SizeModel } from '../../src/scheduling/size-model.js';
import { ArrivalForecast } from '../../src/scheduling/forecast.js';
import { DEFAULT_SCHEDULING, schedule, type DemandCache, type LoginState, type Priority, type QuotaWindow,
  type TreeState, type TurnRequest } from '../../src/scheduling/policy.js';
import * as littlewood from './littlewood.js';

const calibration = JSON.parse(fs.readFileSync(new URL('./calibration.json', import.meta.url), 'utf8'));
const DAY = 1440, WEEK = 7 * DAY;
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];
const WEIGHTS = DEFAULT_SCHEDULING.weights;

export type Policy = 'today' | 'index' | 'littlewood' | 'littlewood-learned' | 'scheduler';

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
  const gamma = (k: number): number => { // Marsaglia–Tsang
    if (k < 1) return gamma(k + 1) * next() ** (1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) { const x = normal(), v = (1 + c * x) ** 3; if (v > 0 && Math.log(next()) < x * x / 2 + d - d * v + d * Math.log(v)) return d * v; }
  };
  return { next, normal, gamma, lognormal: (mu: number, sigma: number) => Math.exp(mu + sigma * normal()) };
}

export interface Config {
  policy: Policy;
  load: number; days: number; warmup: number; seed: number;
  logins: number; session: number; week: number;
  mix: Record<Priority, number>;
  /** funding-analysis#2: one big tree with many sub-tasks at once, on top of the usual traffic. */
  burst?: { day: number; usd: number; lanes: number };
}

interface Tree {
  id: string; priority: Priority; arrival: number; size: number; attained: number; burn: number; lanes: number;
  running: number; firstStart?: number; done?: number; lastActive?: number; lastLogin?: number;
  /** Its own stream for turn lengths, so every policy sees the same work (common random numbers). */
  turnLength: () => number;
}
interface Turn { id: string; tree: Tree; login: number; start: number; end: number }

export function simulate(config: Config) {
  const r = rng(config.seed);
  const cal = calibration;
  const size = new SizeModel({ mu: Math.log(cal.treeMeanUsd) - cal.treeSigma ** 2 / 2, sigma: cal.treeSigma });
  const duration = new SizeModel({ mu: cal.turnMinutesMu, sigma: cal.turnMinutesSigma });
  const meanTurnMinutes = duration.expectedMin(cal.turnMaxMinutes);
  const burnRate = Math.exp(cal.burnUsdPerMinuteMu + cal.burnUsdPerMinuteSigma ** 2 / 2);
  // Arrivals: hour-of-day profile × a gamma day factor, scaled to the load.
  const perDay = config.load * config.logins * config.week / 7 / cal.treeMeanUsd;
  const profile: number[] = cal.arrivalsByUtcHour.map((x: number) => x * 24 / cal.arrivalsByUtcHour.reduce((s: number, v: number) => s + v, 0));
  const dayFactor = Array.from({ length: config.days + 1 }, () => r.gamma(cal.dailyDispersion) / cal.dailyDispersion);
  const rate = (t: number) => perDay / DAY * profile[Math.floor(t / 60) % 24]! * dayFactor[Math.floor(t / DAY)]!;
  const end = config.days * DAY;

  const arriving: Tree[] = [];
  for (let t = 0, peak = perDay / DAY * 12; ;) {
    t += -Math.log(r.next() || 1e-12) / peak;
    if (t >= end) break;
    if (r.next() >= Math.min(1, rate(t) / peak)) continue;
    const u = r.next();
    let acc = 0, priority: Priority = 'medium';
    for (const p of PRIORITIES) { acc += config.mix[p]; if (u < acc) { priority = p; break; } }
    const lanes = r.next() < cal.parallelShare ? 2 + Math.floor(r.next() * (cal.maxLanes - 1)) : 1;
    const own = rng(config.seed * 7919 + arriving.length);
    arriving.push({ id: `T${arriving.length}`, priority, arrival: t, size: r.lognormal(size.law.mu, size.law.sigma), attained: 0,
      burn: r.lognormal(cal.burnUsdPerMinuteMu, cal.burnUsdPerMinuteSigma), lanes, running: 0,
      turnLength: () => Math.min(cal.turnMaxMinutes, own.lognormal(cal.turnMinutesMu, cal.turnMinutesSigma)) });
  }
  if (config.burst) {
    const own = rng(config.seed * 7919 + 999_999);
    const at = config.burst.day * DAY + 18 * 60;
    const index = arriving.findIndex((t) => t.arrival > at);
    arriving.splice(index < 0 ? arriving.length : index, 0, { id: 'burst', priority: 'medium', arrival: at, size: config.burst.usd,
      attained: 0, burn: Math.exp(cal.burnUsdPerMinuteMu), lanes: config.burst.lanes, running: 0,
      turnLength: () => Math.min(cal.turnMaxMinutes, own.lognormal(cal.turnMinutesMu, cal.turnMinutesSigma)) });
  }

  const logins = Array.from({ length: config.logins }, (_, i) => ({
    session: { used: 0, resetAt: undefined as number | undefined },
    week: { used: 0, resetAt: Math.round((i + 0.3) * WEEK / config.logins) },
    running: 0,
  }));
  const trees: Tree[] = [];
  const turns: Turn[] = [];
  const waiting: { tree: Tree; at: number; id: string }[] = [];
  const m = { weekExpired: 0, weekResets: 0, interrupted: 0, coldStarts: 0, spent: 0 };
  /** Minutes each tree had a turn waiting while a login had room and quota: kept back, not out of quota. */
  const heldMinutes = new Map<Tree, number>();
  let seq = 0;
  const request = (tree: Tree, now: number) => waiting.push({ tree, at: now, id: `q${seq++}` });

  // What the scheduler learns as it goes: arrivals by priority and hour.
  const learned = new ArrivalForecast();
  const cache: DemandCache = { entries: new Map(), sessionTtl: 10, weekTtl: 30 };

  const windowsOf = (i: number, now: number): QuotaWindow[] => {
    const l = logins[i]!;
    return [
      { kind: 'session', capacity: config.session, used: l.session.used, resetAt: l.session.resetAt, length: 300 },
      { kind: 'week', capacity: config.week, used: l.week.used, resetAt: l.week.resetAt, length: WEEK },
    ].map((w) => ({ ...w, resetAt: w.resetAt !== undefined && w.resetAt <= now ? undefined : w.resetAt })) as QuotaWindow[];
  };
  const exhausted = (i: number) => logins[i]!.session.used >= config.session * (1 - 1e-3) || logins[i]!.week.used >= config.week * (1 - 1e-3);
  const remainingTurn = (t: Turn, now: number) => t.tree.burn * duration.residual(now - t.start, cal.turnMaxMinutes).mean;

  const start = (entry: { tree: Tree }, i: number, now: number) => {
    const tree = entry.tree, l = logins[i]!;
    if (l.session.resetAt === undefined) l.session.resetAt = now + 300;
    // A prompt cache lives with one login for up to an hour: elsewhere or later, the context is written again.
    if (tree.lastActive !== undefined && tree.running === 0 && (now - tree.lastActive > 60 || tree.lastLogin !== i)) {
      tree.size += cal.coldStartUsd; m.coldStarts++;
    }
    turns.push({ id: `t${seq++}`, tree, login: i, start: now, end: now + tree.turnLength() });
    tree.running++; l.running++; tree.firstStart ??= now; tree.lastLogin = i;
  };
  const stop = (turn: Turn, now: number, interrupted: boolean) => {
    turns.splice(turns.indexOf(turn), 1);
    turn.tree.running--; logins[turn.login]!.running--; turn.tree.lastActive = now;
    if (interrupted) { m.interrupted++; turn.tree.size += cal.interruptUsd; }
    if (turn.tree.done === undefined) request(turn.tree, now);
  };

  const snapshot = (now: number) => {
    const loginStates: LoginState[] = logins.map((l, i) => ({ id: String(i), provider: 'claude', windows: windowsOf(i, now),
      running: l.running, committed: turns.filter((t) => t.login === i).reduce((s, t) => s + remainingTurn(t, now), 0) }));
    const treeStates: TreeState[] = trees.filter((t) => t.done === undefined).map((t) => ({ id: t.id, priority: t.priority,
      attained: t.attained, burnRate: t.burn, turnCost: t.burn * meanTurnMinutes, running: t.running, lanes: t.lanes,
      committed: turns.filter((x) => x.tree === t).reduce((s, x) => s + remainingTurn(x, now), 0),
      ...(t.lastLogin !== undefined ? { lastLogin: String(t.lastLogin) } : {}) }));
    const requests: TurnRequest[] = waiting.map((w) => ({ id: w.id, treeId: w.tree.id, requestedAt: w.at, logins: logins.map((_, i) => String(i)) }));
    return { loginStates, treeStates, requests };
  };

  const decide = (now: number) => {
    if (!waiting.length) return;
    if (config.policy === 'today') {
      // First come, first served; each request takes the first login with room (its credential order).
      waiting.sort((a, b) => a.at - b.at);
      for (const entry of waiting.slice()) {
        const i = logins.findIndex((l, j) => l.running < 10 && !exhausted(j));
        if (i < 0) break;
        waiting.splice(waiting.indexOf(entry), 1); start(entry, i, now);
      }
      return;
    }
    const { loginStates, treeStates, requests } = snapshot(now);
    let admissions: { requestId: string; loginId: string }[];
    if (config.policy.startsWith('littlewood')) {
      // The first design: Littlewood protection levels (normal approximation, ×0.75), told the true
      // arrival rates, or ('littlewood-learned') the rates learned as it goes, like the scheduler.
      learned.advanceTo(now);
      const told = config.policy === 'littlewood';
      admissions = littlewood.schedule(now, loginStates.map((l) => ({ ...l, windows: l.windows })), treeStates, requests, {
        arrivals(from, to) {
          if (!told) return PRIORITIES.reduce((n, p) => n + learned.expected(p, from, to), 0);
          let n = 0; for (let t = from; t < to; t += 15) n += perDay / DAY * profile[Math.floor(t / 60) % 24]! * Math.min(15, to - t); return n;
        },
        dispersion: cal.dailyDispersion,
        mix: told ? config.mix : (() => {
          const e = Object.fromEntries(PRIORITIES.map((p) => [p, learned.expected(p, now - DAY, now)])) as Record<Priority, number>;
          const total = PRIORITIES.reduce((n, p) => n + e[p], 0) || 1;
          return Object.fromEntries(PRIORITIES.map((p) => [p, e[p] / total])) as Record<Priority, number>;
        })(),
        size, burnRate: Math.exp(cal.burnUsdPerMinuteMu),
      }, { ...littlewood.DEFAULT_SCHEDULING, reserve: 0.75 });
    } else {
      learned.advanceTo(now);
      admissions = schedule({ now, logins: loginStates, trees: treeStates, requests, seed: config.seed,
        forecast: { arrivals: learned, size, burnRate, lanes: 1 + cal.parallelShare * (cal.maxLanes / 2) },
        params: { ...DEFAULT_SCHEDULING, holdBack: config.policy !== 'index' } }, cache).admissions;
    }
    for (const a of admissions) {
      const entry = waiting.find((w) => w.id === a.requestId)!;
      waiting.splice(waiting.indexOf(entry), 1); start(entry, Number(a.loginId), now);
    }
  };

  for (let now = 0; now < end; now++) {
    while (arriving.length && arriving[0]!.arrival <= now) {
      const tree = arriving.shift()!;
      trees.push(tree);
      learned.observe(tree.arrival, tree.priority);
      for (let k = 0; k < tree.lanes; k++) request(tree, tree.arrival);
    }
    for (const l of logins) {
      if (l.session.resetAt !== undefined && l.session.resetAt <= now) l.session = { used: 0, resetAt: undefined };
      if (l.week.resetAt <= now) {
        if (now >= config.warmup * DAY && now < end - WEEK) { m.weekExpired += Math.max(0, config.week - l.week.used); m.weekResets++; }
        l.week = { used: 0, resetAt: l.week.resetAt + WEEK };
      }
    }
    // One minute of work; a login's turns share what its windows have left (none spends past a limit).
    const scale = logins.map((l, i) => {
      const want = turns.filter((t) => t.login === i).reduce((s, t) => s + Math.min(t.tree.burn, t.tree.size - t.tree.attained), 0);
      const left = Math.max(0, Math.min(config.session - l.session.used, config.week - l.week.used));
      return want > left ? left / want : 1;
    });
    for (const turn of turns.slice()) {
      const tree = turn.tree, l = logins[turn.login]!;
      const spend = Math.min(tree.burn, tree.size - tree.attained) * scale[turn.login]!;
      tree.attained += spend; l.session.used += spend; l.week.used += spend; m.spent += spend;
      if (tree.attained >= tree.size - 1e-9 && tree.done === undefined) {
        tree.done = now + 1;
        for (const t of turns.filter((x) => x.tree === tree)) stop(t, now + 1, false);
        for (const w of waiting.filter((x) => x.tree === tree)) waiting.splice(waiting.indexOf(w), 1);
      }
    }
    for (const turn of turns.slice()) if (turn.end <= now + 1) stop(turn, now + 1, false);
    for (const [i] of logins.entries()) if (exhausted(i)) for (const t of turns.filter((x) => x.login === i)) stop(t, now + 1, true);
    if (now % 5 === 0 || turns.length < logins.length * 10) decide(now + 1);
    if (logins.some((l, i) => l.running < 10 && !exhausted(i))) for (const w of waiting) heldMinutes.set(w.tree, (heldMinutes.get(w.tree) ?? 0) + 1);
  }

  const burst = trees.find((t) => t.id === 'burst');
  const measured = trees.filter((t) => t !== burst && t.arrival >= config.warmup * DAY && t.arrival < end - 4 * DAY);
  const during = burst ? measured.filter((t) => t.arrival >= burst.arrival && t.arrival < (burst.done ?? end)) : [];
  const flow = (t: Tree) => ((t.done ?? end) - t.arrival) / 60;
  const startDelay = (t: Tree) => ((t.firstStart ?? end) - t.arrival);
  const byClass = Object.fromEntries(PRIORITIES.map((p) => {
    const ts = measured.filter((t) => t.priority === p);
    const delays = ts.map(startDelay).sort((a, b) => a - b);
    const held = ts.filter((t) => (heldMinutes.get(t) ?? 0) > 5);
    return [p, { n: ts.length, heldShare: ts.length ? held.length / ts.length : 0,
      heldHours: ts.length ? ts.reduce((s, t) => s + (heldMinutes.get(t) ?? 0), 0) / ts.length / 60 : 0, flowHours: ts.length ? ts.reduce((s, t) => s + flow(t), 0) / ts.length : 0,
      startP95Minutes: delays.length ? delays[Math.min(delays.length - 1, Math.floor(0.95 * delays.length))]! : 0 }];
  }));
  return {
    weightedFlowHours: measured.reduce((s, t) => s + WEIGHTS[t.priority] * flow(t), 0) / Math.max(1, measured.length),
    byClass,
    done: measured.filter((t) => t.done !== undefined).length / Math.max(1, measured.length),
    /** Weekly quota that expired unused (share of what reset). */
    lostWeek: m.weekResets ? m.weekExpired / (m.weekResets * config.week) : 0,
    interruptedPerDay: m.interrupted / (end / DAY), coldStartsPerDay: m.coldStarts / (end / DAY),
    ...(burst ? { burstHours: flow(burst), othersFlowDuringBurstHours: during.length ? during.reduce((s, t) => s + flow(t), 0) / during.length : 0 } : {}),
  };
}

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : fallback; };
if (process.argv[1]?.endsWith('simulate.ts')) {
  const days = Number(arg('days', '35')), seeds = Number(arg('seeds', '8'));
  const loads = arg('load', '0.7,1,1.3').split(',').map(Number);
  const burst = arg('burst', '') ? { day: 6, usd: Number(arg('burst', '1500')), lanes: 20 } : undefined;
  const policies = arg('policies', 'today,index,littlewood-learned,scheduler').split(',') as Policy[];
  const mix = arg('mix', '') ? { low: 0, medium: 0, high: 0, urgent: 0, ...Object.fromEntries(arg('mix', '').split(',')
    .map((x) => x.split(':')).map(([p, v]) => [p, Number(v ?? 1)])) } as Record<Priority, number> : calibration.mix;
  const out: any[] = [];
  for (const load of loads) for (const policy of policies) {
    const runs = Array.from({ length: seeds }, (_, s) => simulate({ policy, load, days, warmup: 3, seed: 1000 + s,
      logins: 3, session: calibration.sessionUsd, week: calibration.weekUsd, mix, ...(burst ? { burst } : {}) }));
    const mean = (f: (x: any) => number) => runs.reduce((s, x) => s + f(x), 0) / runs.length;
    const row = { load, policy, weightedFlowHours: mean((x) => x.weightedFlowHours), done: mean((x) => x.done), lostWeek: mean((x) => x.lostWeek),
      flowHours: Object.fromEntries(PRIORITIES.map((p) => [p, mean((x) => x.byClass[p].flowHours)])),
      startP95Minutes: Object.fromEntries(PRIORITIES.map((p) => [p, mean((x) => x.byClass[p].startP95Minutes)])),
      heldShare: Object.fromEntries(PRIORITIES.map((p) => [p, mean((x) => x.byClass[p].heldShare)])),
      heldHours: Object.fromEntries(PRIORITIES.map((p) => [p, mean((x) => x.byClass[p].heldHours)])),
      interruptedPerDay: mean((x) => x.interruptedPerDay), coldStartsPerDay: mean((x) => x.coldStartsPerDay),
      ...(burst ? { burstHours: mean((x) => x.burstHours), othersFlowDuringBurstHours: mean((x) => x.othersFlowDuringBurstHours) } : {}) };
    out.push(row);
    const f = (v: number | undefined, d = 1) => (v ?? 0).toFixed(d).padStart(7);
    console.log(`load ${load} ${policy.padEnd(11)} wflow ${f(row.weightedFlowHours)}h | flow L/M/H/U ${PRIORITIES.map((p) => f(row.flowHours[p])).join(' ')}h`
      + ` | start p95 M/H/U ${f(row.startP95Minutes.medium, 0)} ${f(row.startP95Minutes.high, 0)} ${f(row.startP95Minutes.urgent, 0)}m`
      + ` | held (>5 min with quota free) M/H ${f(100 * row.heldShare.medium!, 0)} ${f(100 * row.heldShare.high!, 0)}%, ${f(row.heldHours.medium!, 2)} ${f(row.heldHours.high!, 2)}h/tree`
      + ` | done ${f(100 * row.done, 0)}% | week lost ${f(100 * row.lostWeek, 1)}% | cut ${f(row.interruptedPerDay)} cold ${f(row.coldStartsPerDay)} /d`
      + ('burstHours' in row ? ` | burst ${f(row.burstHours)}h, others meanwhile ${f(row.othersFlowDuringBurstHours)}h` : ''));
  }
  const json = arg('json', '');
  if (json) fs.writeFileSync(json, JSON.stringify(out, null, 2));
}
