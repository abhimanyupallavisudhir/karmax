/**
 * Quota scheduling simulator (wiki planned/quota-scheduling): today's
 * first-come-first-served leasing against index ordering, a pacing line and
 * the proposed index + protection-level policy, on traffic calibrated to
 * tavya.io (2026-08..10, see benchmarks/scheduling-calibration.json).
 *
 *   npx tsx benchmarks/scheduling.ts [--days 35] [--seeds 8] [--load 0.7,1,1.3] [--json out.json]
 *
 * Units: API-equivalent dollars of model use; minutes.
 */
import fs from 'node:fs';
import { SizeModel } from '../src/scheduling/size-model.js';
import { DEFAULT_SCHEDULING, schedule, type DemandForecast, type LoginState, type Priority, type QuotaWindow,
  type SchedulingParams, type TreeState, type TurnRequest } from '../src/scheduling/policy.js';

const calibration = JSON.parse(fs.readFileSync(new URL('./scheduling-calibration.json', import.meta.url), 'utf8'));
const DAY = 1440;
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

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

interface Config {
  policy: 'today' | 'index' | 'pacing' | 'proposed';
  reserve: number;
  load: number; days: number; warmup: number; seed: number;
  logins: number; session: number; week: number;
  mix: Record<Priority, number>;
  /** funding-analysis#2: one big tree with many sub-tasks at once, on top of the usual traffic. */
  burst?: { day: number; usd: number; lanes: number };
}

interface Tree {
  id: string; priority: Priority; arrival: number; size: number; attained: number; burn: number; lanes: number;
  running: number; firstStart?: number; done?: number; lastActive?: number;
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
  // Arrivals: hour-of-day profile × a gamma day factor (negative-binomial counts), scaled to the load.
  const capacityPerDay = config.logins * config.week / 7;
  const perDay = config.load * capacityPerDay / cal.treeMeanUsd;
  const profile: number[] = cal.arrivalsByUtcHour.map((x: number) => x * 24 / cal.arrivalsByUtcHour.reduce((s: number, v: number) => s + v, 0));
  const dayFactor = Array.from({ length: config.days + 1 }, () => r.gamma(cal.dailyDispersion) / cal.dailyDispersion);
  const rate = (t: number) => perDay / DAY * profile[Math.floor(t / 60) % 24]! * dayFactor[Math.floor(t / DAY)]!;
  const forecast: DemandForecast = {
    arrivals(from, to) { let n = 0; for (let t = from; t < to; t += 15) n += perDay / DAY * profile[Math.floor(t / 60) % 24]! * Math.min(15, to - t); return n; },
    dispersion: cal.dailyDispersion, mix: config.mix, size, burnRate: Math.exp(cal.burnUsdPerMinuteMu),
  };
  const params: SchedulingParams = { ...DEFAULT_SCHEDULING, reserve: config.policy === 'proposed' ? config.reserve : 0 };

  const logins = Array.from({ length: config.logins }, (_, i) => ({
    session: { used: 0, resetAt: undefined as number | undefined, byTree: new Map<string, number>() },
    week: { used: 0, resetAt: Math.round((i + 0.3) * 7 * DAY / config.logins) },
    running: 0,
  }));
  const end = config.days * DAY;
  const arriving: Tree[] = [];
  for (let t = 0, peak = perDay / DAY * 12; ; ) {
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
    arriving.splice(index < 0 ? arriving.length : index, 0, { id: 'burst', priority: 'medium', arrival: at, size: config.burst.usd, attained: 0,
      burn: Math.exp(cal.burnUsdPerMinuteMu), lanes: config.burst.lanes, running: 0,
      turnLength: () => Math.min(cal.turnMaxMinutes, own.lognormal(cal.turnMinutesMu, cal.turnMinutesSigma)) });
  }
  const trees: Tree[] = [];
  const turns: Turn[] = [];
  const waiting: { tree: Tree; at: number; id: string }[] = [];
  const m = { unusedSessionWithBacklog: 0, unusedWeekWithBacklog: 0, interrupted: 0, coldStarts: 0, maxShare: [] as number[], spent: 0 };
  let seq = 0;
  const request = (tree: Tree, now: number) => waiting.push({ tree, at: now, id: `q${seq++}` });

  const windowsOf = (i: number, now: number): QuotaWindow[] => {
    const l = logins[i]!;
    return [
      { kind: 'session', capacity: config.session, used: l.session.used, resetAt: l.session.resetAt, length: 300 },
      { kind: 'week', capacity: config.week, used: l.week.used, resetAt: l.week.resetAt, length: 7 * DAY },
    ].map((w) => ({ ...w, resetAt: w.resetAt !== undefined && w.resetAt <= now ? undefined : w.resetAt })) as QuotaWindow[];
  };
  const exhausted = (i: number) => logins[i]!.session.used >= config.session * (1 - 1e-3) || logins[i]!.week.used >= config.week * (1 - 1e-3);
  const remainingTurn = (t: Turn, now: number) => t.tree.burn * duration.residual(now - t.start, cal.turnMaxMinutes).mean;

  const start = (entry: { tree: Tree }, i: number, now: number) => {
    const tree = entry.tree, l = logins[i]!;
    if (l.session.resetAt === undefined) l.session.resetAt = now + 300;
    // A tree idle for over an hour has a cold prompt cache: re-writing its context costs quota, not progress.
    if (tree.lastActive !== undefined && tree.running === 0 && now - tree.lastActive > 60) { tree.size += cal.coldStartUsd; m.coldStarts++; }
    const d = tree.turnLength();
    turns.push({ id: `t${seq++}`, tree, login: i, start: now, end: now + d });
    tree.running++; l.running++; tree.firstStart ??= now;
  };
  const stop = (turn: Turn, now: number, interrupted: boolean) => {
    turns.splice(turns.indexOf(turn), 1);
    turn.tree.running--; logins[turn.login]!.running--; turn.tree.lastActive = now;
    if (interrupted) { m.interrupted++; turn.tree.size += cal.interruptUsd; }
    if (turn.tree.done === undefined) request(turn.tree, now);
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
    const loginStates: LoginState[] = logins.map((l, i) => ({ id: String(i), provider: 'claude', windows: windowsOf(i, now), running: l.running,
      committed: turns.filter((t) => t.login === i).reduce((s, t) => s + remainingTurn(t, now), 0) }));
    const live = trees.filter((t) => t.done === undefined);
    const treeStates: TreeState[] = live.map((t) => ({ id: t.id, priority: t.priority, attained: t.attained, burnRate: t.burn,
      turnCost: t.burn * meanTurnMinutes, running: t.running,
      committed: turns.filter((x) => x.tree === t).reduce((s, x) => s + remainingTurn(x, now), 0) }));
    const requests: TurnRequest[] = waiting.map((w) => ({ id: w.id, treeId: w.tree.id, requestedAt: w.at, logins: logins.map((_, i) => String(i)) }));
    let admissions = schedule(now, loginStates, treeStates, requests, forecast, params);
    if (config.policy === 'pacing') {
      // The earlier proposal: hold non-urgent work while a window is ahead of a straight line plus 25%.
      admissions = admissions.filter((a) => {
        const entry = waiting.find((w) => w.id === a.requestId)!;
        if (entry.tree.priority === 'urgent') return true;
        return windowsOf(Number(a.loginId), now).every((w) => w.resetAt === undefined
          || w.used / w.capacity < 0.25 + (now - (w.resetAt - w.length)) / w.length);
      });
    }
    for (const a of admissions) {
      const entry = waiting.find((w) => w.id === a.requestId)!;
      waiting.splice(waiting.indexOf(entry), 1); start(entry, Number(a.loginId), now);
    }
  };

  for (let now = 0; now < end; now++) {
    // Arrivals.
    while (arriving.length && arriving[0]!.arrival <= now) {
      const tree = arriving.shift()!;
      trees.push(tree);
      for (let k = 0; k < tree.lanes; k++) request(tree, tree.arrival);
    }
    // Resets.
    for (const [i, l] of logins.entries()) {
      if (l.session.resetAt !== undefined && l.session.resetAt <= now) {
        if (waiting.length) m.unusedSessionWithBacklog += Math.max(0, config.session - l.session.used);
        const total = [...l.session.byTree.values()].reduce((s, v) => s + v, 0);
        if (total > config.session * 0.5) m.maxShare.push(Math.max(...l.session.byTree.values()) / total);
        l.session = { used: 0, resetAt: undefined, byTree: new Map() };
      }
      if (l.week.resetAt <= now) {
        if (waiting.length) m.unusedWeekWithBacklog += Math.max(0, config.week - l.week.used);
        l.week = { used: 0, resetAt: l.week.resetAt + 7 * DAY };
      }
      void i;
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
      tree.attained += spend; l.session.used += spend; l.week.used += spend;
      if (now >= config.warmup * DAY && now < end - 7 * DAY) m.spent += spend; // away from both ends of the run
      l.session.byTree.set(tree.id, (l.session.byTree.get(tree.id) ?? 0) + spend);
      if (tree.attained >= tree.size - 1e-9 && tree.done === undefined) {
        tree.done = now + 1;
        for (const t of turns.filter((x) => x.tree === tree)) stop(t, now + 1, false);
        for (const w of waiting.filter((x) => x.tree === tree)) waiting.splice(waiting.indexOf(w), 1);
      }
    }
    for (const turn of turns.slice()) if (turn.end <= now + 1) stop(turn, now + 1, false);
    for (const [i] of logins.entries()) if (exhausted(i)) for (const t of turns.filter((x) => x.login === i)) stop(t, now + 1, true);
    if (now % 5 === 0 || turns.length < logins.length * 10) decide(now + 1);
    if (process.env.SIM_TRACE && now % 240 === 0) console.log(`T ${(now / DAY).toFixed(2)}d wait ${waiting.length} run ${turns.length} trees ${trees.filter((t) => t.done === undefined).length}`
      + ' ' + logins.map((l) => `s${Math.round(l.session.used)}${l.session.resetAt ? '' : '-'}/w${Math.round(l.week.used)}`).join(' '));
  }

  const burst = trees.find((t) => t.id === 'burst');
  const measured = trees.filter((t) => t !== burst && t.arrival >= config.warmup * DAY && t.arrival < end - 4 * DAY);
  // Others' tasks that arrived while the burst ran.
  const during = burst ? measured.filter((t) => t.arrival >= burst.arrival && t.arrival < (burst.done ?? end)) : [];
  const flow = (t: Tree) => ((t.done ?? end) - t.arrival) / 60;
  const startDelay = (t: Tree) => ((t.firstStart ?? end) - t.arrival);
  const byClass = Object.fromEntries(PRIORITIES.map((p) => {
    const ts = measured.filter((t) => t.priority === p);
    const delays = ts.map(startDelay).sort((a, b) => a - b);
    return [p, { n: ts.length, flowHours: ts.length ? ts.reduce((s, t) => s + flow(t), 0) / ts.length : 0,
      startP95Minutes: delays.length ? delays[Math.min(delays.length - 1, Math.floor(0.95 * delays.length))]! : 0 }];
  }));
  const span = (end - config.warmup * DAY) / DAY;
  return {
    weightedFlowHours: measured.reduce((s, t) => s + DEFAULT_SCHEDULING.weights[t.priority] * flow(t), 0) / Math.max(1, measured.length),
    byClass,
    unfinished: measured.filter((t) => t.done === undefined).length / Math.max(1, measured.length),
    usefulPerDay: measured.reduce((s, t) => s + Math.min(t.attained, t.size), 0) / span,
    spentPerDay: m.spent / (end / DAY - 7 - config.warmup),
    unusedSessionWithBacklogPerDay: m.unusedSessionWithBacklog / (end / DAY),
    unusedWeekWithBacklogPerDay: m.unusedWeekWithBacklog / (end / DAY),
    interruptedPerDay: m.interrupted / (end / DAY), coldStartsPerDay: m.coldStarts / (end / DAY),
    medianTopShare: m.maxShare.sort((a, b) => a - b)[Math.floor(m.maxShare.length / 2)] ?? 0,
    ...(burst ? { burstHours: flow(burst), othersDuringBurst: during.length,
      othersFlowDuringBurstHours: during.length ? during.reduce((s, t) => s + flow(t), 0) / during.length : 0 } : {}),
  };
}

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : fallback; };
if (process.argv[1]?.endsWith('scheduling.ts')) {
  const days = Number(arg('days', '35')), seeds = Number(arg('seeds', '8'));
  const loads = arg('load', '0.7,1,1.3').split(',').map(Number);
  const burst = arg('burst', '') ? { day: 6, usd: Number(arg('burst', '1500')), lanes: 20 } : undefined;
  const reserves = arg('reserve', '0.5,1,2').split(',').map(Number);
  const policies: [Config['policy'], number, string][] = [['today', 0, 'today (FIFO)'], ['index', 0, 'index only'],
    ['pacing', 0, 'index + pacing line'], ...reserves.map((k) => ['proposed', k, `proposed ×${k}`] as [Config['policy'], number, string])];
  const out: any[] = [];
  for (const load of loads) for (const [policy, reserve, label] of policies) {
    const runs = Array.from({ length: seeds }, (_, s) => simulate({ policy, reserve, load, days, warmup: 3, seed: 1000 + s,
      logins: 3, session: calibration.sessionUsd, week: calibration.weekUsd, mix: calibration.mix, ...(burst ? { burst } : {}) }));
    const mean = (f: (x: any) => number) => runs.reduce((s, x) => s + f(x), 0) / runs.length;
    const row = { load, label, weightedFlowHours: mean((x) => x.weightedFlowHours),
      flowHours: Object.fromEntries(PRIORITIES.map((p) => [p, mean((x) => x.byClass[p].flowHours)])),
      startP95Minutes: Object.fromEntries(PRIORITIES.map((p) => [p, mean((x) => x.byClass[p].startP95Minutes)])),
      usefulPerDay: mean((x) => x.usefulPerDay), spentPerDay: mean((x) => x.spentPerDay), unusedSessionWithBacklogPerDay: mean((x) => x.unusedSessionWithBacklogPerDay),
      unusedWeekWithBacklogPerDay: mean((x) => x.unusedWeekWithBacklogPerDay), interruptedPerDay: mean((x) => x.interruptedPerDay),
      coldStartsPerDay: mean((x) => x.coldStartsPerDay), medianTopShare: mean((x) => x.medianTopShare), unfinished: mean((x) => x.unfinished),
      ...(burst ? { burstHours: mean((x) => x.burstHours), othersFlowDuringBurstHours: mean((x) => x.othersFlowDuringBurstHours) } : {}) };
    out.push(row);
    const f = (v: number | undefined, d = 1) => (v ?? 0).toFixed(d).padStart(7);
    console.log(`load ${load} ${label.padEnd(20)} wflow ${f(row.weightedFlowHours)}h | flow L/M/H/U ${PRIORITIES.map((p) => f(row.flowHours[p])).join(' ')}h`
      + ` | start p95 H/U ${f(row.startP95Minutes.high, 0)} ${f(row.startP95Minutes.urgent, 0)}m | spent $${f(row.spentPerDay, 0)}/d`
      + ` | week lost w/ backlog $${f(row.unusedWeekWithBacklogPerDay, 0)}/d | cut ${f(row.interruptedPerDay)} cold ${f(row.coldStartsPerDay)} /d | top share ${f(row.medianTopShare, 2)}`
      + ('burstHours' in row ? ` | burst ${f(row.burstHours)}h, others meanwhile ${f(row.othersFlowDuringBurstHours)}h` : ''));
  }
  const json = arg('json', '');
  if (json) fs.writeFileSync(json, JSON.stringify(out, null, 2));
}
