import { describe, expect, it } from 'vitest';
import { SizeModel, normalQuantile } from '../src/scheduling/size-model.js';
import { ArrivalForecast, seeded } from '../src/scheduling/forecast.js';
import { SampledDemand } from '../src/scheduling/pricing.js';
import { adjustRanks, clearItem, placeItem, pruneOrders, type OrderConstraint } from '../src/scheduling/order.js';
import { DEFAULT_SCHEDULING, schedule, treeRank, type Forecast, type LoginState, type TreeState, type TurnRequest }
  from '../src/scheduling/policy.js';
import { usageCostUsd } from '../src/scheduling/costs.js';
import { fitSize, PRIOR, schedulingPriority } from '../src/scheduling/model.js';
import { loginWindows, recordQuotaReading, recordTurnSpend, treeKey, type KvStore } from '../src/scheduling/state.js';

// Production task trees (wiki features/quota-scheduling): log-normal cost, σ ≈ 1.5.
const size = new SizeModel(PRIOR.size);
const HOUR = 60, DAY = 1440;

describe('size model', () => {
  it('matches Monte Carlo moments of a log-normal', () => {
    const u = seeded(7);
    const draws = Array.from({ length: 200_000 }, () => Math.exp(size.law.mu + size.law.sigma * normalQuantile(u())));
    const mc = (x: number) => draws.reduce((s, d) => s + Math.min(d, x), 0) / draws.length;
    for (const x of [1, 10, 100]) expect(size.expectedMin(x)).toBeCloseTo(mc(x), 0);
  });

  it('ranks a big spender ever lower: what it has spent says it is far from done', () => {
    expect(size.residual(100, 1e6).mean).toBeGreaterThan(size.residual(1, 1e6).mean * 3);
    expect(size.rank(100)).toBeLessThan(size.rank(10));
    expect(size.rank(10)).toBeLessThan(size.rank(0));
  });

  it('draws a size beyond what a tree has spent, and cuts its further spend at the lowest rank on the way', () => {
    const u = seeded(3);
    for (let i = 0; i < 100; i++) expect(size.sampleBeyond(50, u())).toBeGreaterThanOrEqual(50);
    const pieces: [number, number][] = [];
    size.pieces(0.1, 200, 3, (rank, quota) => pieces.push([rank, quota]));
    expect(pieces.reduce((s, [, q]) => s + q, 0)).toBeCloseTo(200, 6);
    // Never above the rank it starts at, never rising again.
    expect(Math.max(...pieces.map(([r]) => r))).toBeLessThanOrEqual(3 * size.rank(0.1) + 1e-12);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]![0]).toBeLessThanOrEqual(pieces[i - 1]![0]);
  });
});

describe('arrival forecast', () => {
  it('learns arrivals by priority and hour, and samples futures with that rhythm', () => {
    const f = new ArrivalForecast();
    // Three weeks: ten medium tasks each evening at 20:00, one urgent each morning at 09:00.
    for (let day = 0; day < 21; day++) {
      for (let i = 0; i < 10; i++) f.observe(day * DAY + 20 * HOUR + i, 'medium');
      f.observe(day * DAY + 9 * HOUR, 'urgent');
    }
    const now = 21 * DAY;
    f.advanceTo(now);
    expect(f.expected('medium', now + 20 * HOUR, now + 21 * HOUR)).toBeGreaterThan(5);
    expect(f.expected('medium', now + 12 * HOUR, now + 13 * HOUR)).toBeLessThan(1);
    const u = seeded(11);
    const evening = Array.from({ length: 50 }, () => f.sample(now + 19 * HOUR, now + 22 * HOUR, u).length);
    const noon = Array.from({ length: 50 }, () => f.sample(now + 11 * HOUR, now + 14 * HOUR, u).length);
    expect(evening.reduce((a, b) => a + b) / 50).toBeGreaterThan(5 * noon.reduce((a, b) => a + b) / 50);
    // It survives a round trip through the store.
    expect(ArrivalForecast.from(JSON.parse(JSON.stringify(f.toJSON()))).expected('urgent', now + 9 * HOUR, now + 10 * HOUR))
      .toBeCloseTo(f.expected('urgent', now + 9 * HOUR, now + 10 * HOUR), 9);
  });
});

describe('arrival forecast with little history', () => {
  it('expects nothing of a new organization, and one task in a day of history, not thousands an hour, after a few minutes', () => {
    expect(new ArrivalForecast().expected('urgent', 1_000_000, 1_000_000 + DAY)).toBe(0);
    const f = new ArrivalForecast();
    f.observe(1_000_000, 'medium');
    f.advanceTo(1_000_000.001);
    const total = ['low', 'medium', 'high', 'urgent'].reduce((n, p) => n + f.expected(p as any, 1_000_000, 1_000_000 + DAY), 0);
    expect(total).toBeGreaterThan(0.5);
    expect(total).toBeLessThan(2);
    expect(f.sample(1_000_000, 1_000_000 + 7 * DAY, seeded(1)).length).toBeLessThan(100);
  });
});

describe('sampled pricing', () => {
  it('prices the c-th unit by the rank of the demand above the buyer, Littlewood with two classes', () => {
    // High demand (rank 1) of 10 units in half the futures, none in the others; low demand (rank 0.1) always 100.
    const d = new SampledDemand(300);
    for (let s = 0; s < 100; s++) d.add((piece) => { if (s % 2) piece(1, 10, 10); piece(0.1, 100, 10); });
    // With 5 units left, a low buyer would displace high work half the time: price 0.5 ≥ 0.1, hold.
    expect(d.price(5, 0, 0, 0.1)).toBeCloseTo(0.5, 1);
    // With 50 units, high work never needs them all: the price for a low buyer is 0.
    expect(d.price(50, 0, 0, 0.1)).toBe(0);
    // Demand at the buyer's own rank never counts against it.
    expect(d.price(5, 0, 0, 1)).toBe(0);
    // A floor (the week's price) applies underneath.
    expect(d.price(50, 0.2, 0, 0.1)).toBeCloseTo(0.2, 6);
  });

  it('says when a held tree will clear the price as the demand ahead of it passes', () => {
    const d = new SampledDemand(240);
    // High work wanted in the first hour only.
    for (let s = 0; s < 20; s++) d.add((piece) => piece(1, 20, 30));
    expect(d.price(10, 0, 0, 0.1)).toBeGreaterThan(0.1);
    expect(d.releaseIn(0.1, 10)).toBe(60);
  });
});

describe('orders people set by dragging', () => {
  const ranks = new Map([['a', 4], ['b', 3], ['c', 2], ['d', 1]]);

  it('moves ranks as little as possible to keep every order (isotonic regression on log ranks)', () => {
    // Put d between a and b.
    const order = placeItem([], 'd', { above: 'a', below: 'b' }, 1);
    const adjusted = adjustRanks(ranks, order);
    const sorted = [...adjusted].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(sorted).toEqual(['a', 'd', 'b', 'c']);
    // The dragged row moves; the rows around it hold their ranks, so none of them jumps.
    expect(adjusted.get('a')).toBeCloseTo(4, 3);
    expect(adjusted.get('b')).toBeCloseTo(3, 3);
    expect(adjusted.get('c')).toBe(2);
    expect(adjusted.get('d')!).toBeGreaterThan(3);
    expect(adjusted.get('d')!).toBeLessThan(4);
  });

  it('replaces a row\'s own earlier placement, lets a newer order win over a contradicting older one, and forgets finished rows', () => {
    let order: OrderConstraint[] = placeItem([], 'd', { above: 'a', below: 'b' }, 1);
    order = placeItem(order, 'd', { above: 'c' }, 2);
    expect(order).toEqual([{ above: 'c', below: 'd', at: 2, moved: 'below' }]);
    order = placeItem(order, 'b', { below: 'c' }, 3);
    // c after b now, and the older "c before d" is kept since it does not contradict.
    order = placeItem(order, 'c', { below: 'd' }, 4);
    const adjusted = adjustRanks(ranks, order);
    expect(adjusted.get('b')!).toBeGreaterThan(adjusted.get('c')!);
    expect(adjusted.get('c')!).toBeGreaterThan(adjusted.get('d')!);
    // A cycle: a newer "d before b" breaks the oldest order on it.
    order = placeItem(order, 'd', { below: 'b' }, 5);
    const sorted = [...adjustRanks(ranks, order)].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(sorted.indexOf('d')).toBeLessThan(sorted.indexOf('b'));
    expect(clearItem(order, 'd').some((c) => c.above === 'd' || c.below === 'd')).toBe(false);
    expect(pruneOrders(order, (id) => id !== 'b').some((c) => c.above === 'b' || c.below === 'b')).toBe(false);
  });
});

const week = (used: number, resetIn: number) => ({ kind: 'week' as const, capacity: 900, used, resetAt: resetIn, length: 7 * DAY });
const login = (id: string, session: { used: number; resetAt?: number }, weekly: ReturnType<typeof week>): LoginState => ({
  id, provider: 'claude', running: 0, committed: 0,
  windows: [{ kind: 'session', capacity: 150, length: 5 * HOUR, ...session }, weekly] });
const tree = (id: string, priority: TreeState['priority'], attained = 0, lastLogin?: string): TreeState => ({
  id, priority, attained, burnRate: 0.4, turnCost: 3, running: 0, committed: 0, ...(lastLogin ? { lastLogin } : {}) });
const ask = (treeId: string, at = 0, logins = ['a', 'b']): TurnRequest => ({ id: `r-${treeId}`, treeId, requestedAt: at, logins });
/** Arrivals: `perHour` new trees of each listed priority, for `hours` from now. */
const forecast = (rates: Partial<Record<TreeState['priority'], number>>, hours = 1e9): Forecast => ({
  size, burnRate: 0.4, lanes: 1,
  arrivals: { sample: (from: number, to: number, u: () => number) => {
    const out: { at: number; priority: TreeState['priority'] }[] = [];
    for (const [priority, perHour] of Object.entries(rates) as [TreeState['priority'], number][]) {
      for (let t = from; t < Math.min(to, from + hours * HOUR); t += HOUR) {
        let n = 0; for (let k = 0, x = Math.exp(-perHour), p = x, v = u(); v > p && k < 100; k++) { x *= perHour / (k + 1); p += x; n = k + 1; }
        for (let i = 0; i < n; i++) out.push({ at: t + u() * HOUR, priority });
      }
    }
    return out;
  } },
});

describe('quota scheduling policy', () => {
  it('serves by priority, then by how little a tree has spent; urgent first', () => {
    const trees = [tree('hog', 'medium', 200), tree('fresh', 'medium'), tree('low', 'low'), tree('now', 'urgent', 50)];
    const order = trees.map((t) => [t.id, treeRank(t, size, DEFAULT_SCHEDULING)] as const).sort((x, y) => y[1] - x[1]).map((x) => x[0]);
    expect(order).toEqual(['now', 'fresh', 'low', 'hog']);
    const one = [{ ...login('a', { used: 0 }, week(0, 6 * DAY)), running: DEFAULT_SCHEDULING.maxConcurrent - 1 }];
    const result = schedule({ now: 0, logins: one, trees, requests: trees.map((t) => ask(t.id, 0, ['a'])), forecast: forecast({}) });
    expect(result.admissions.map((a) => a.requestId)).toEqual(['r-now']);
    expect(result.queue.map((e) => [e.requestId, e.status])).toEqual([['r-now', 'admit'], ['r-fresh', 'next'], ['r-low', 'next'], ['r-hog', 'next']]);
  });

  it('keeps a nearly spent window for better work expected soon, and spends it all near its reset', () => {
    const hog = tree('hog', 'low', 300);
    const evening = forecast({ high: 2 }, 5);
    const early = [login('a', { used: 120, resetAt: 4 * HOUR }, week(100, 5 * DAY)), login('b', { used: 140, resetAt: 4.5 * HOUR }, week(100, 6 * DAY))];
    const held = schedule({ now: 0, logins: early, trees: [hog], requests: [ask('hog')], forecast: evening });
    expect(held.admissions).toEqual([]);
    expect(held.queue[0]).toMatchObject({ status: 'held' });
    expect(held.queue[0]!.until).toBeGreaterThan(0);
    const late = [login('a', { used: 120, resetAt: 6 }, week(100, 5 * DAY)), login('b', { used: 140, resetAt: 9 }, week(100, 6 * DAY))];
    expect(schedule({ now: 0, logins: late, trees: [hog], requests: [ask('hog')], forecast: evening }).admissions).toHaveLength(1);
  });

  it('never holds work back for work ranked no higher than it', () => {
    // Plenty of medium work expected, little quota left: a fresh medium tree still starts.
    const tight = [login('a', { used: 145, resetAt: 4 * HOUR }, week(100, 5 * DAY))];
    const result = schedule({ now: 0, logins: tight, trees: [tree('t', 'medium')], requests: [ask('t', 0, ['a'])], forecast: forecast({ medium: 5 }) });
    expect(result.admissions).toHaveLength(1);
  });

  it('uses any quota left when no better work is expected', () => {
    const busy = [{ ...login('a', { used: 140, resetAt: 4 * HOUR }, week(0, 6 * DAY)), committed: 50, running: 3 }];
    expect(schedule({ now: 0, logins: busy, trees: [tree('t', 'low', 100)], requests: [ask('t', 0, ['a'])], forecast: forecast({}) })
      .admissions).toHaveLength(1);
  });

  it('starts a tree on the login that served it last, keeping its prompt cache warm', () => {
    const logins = [login('a', { used: 10, resetAt: 3 * HOUR }, week(100, 6 * DAY)), login('b', { used: 10, resetAt: 2 * HOUR }, week(100, 6 * DAY))];
    expect(schedule({ now: 0, logins, trees: [tree('t', 'medium', 5, 'a')], requests: [ask('t')], forecast: forecast({}) }).admissions)
      .toEqual([{ requestId: 'r-t', loginId: 'a' }]);
  });

  it('reports work whose every login has run out, with the earliest reset', () => {
    const spent = [login('a', { used: 150, resetAt: HOUR }, week(300, 5 * DAY)), { ...login('b', { used: 0 }, week(300, 6 * DAY)), blockedUntil: 2 * HOUR }];
    const result = schedule({ now: 0, logins: spent, trees: [tree('u', 'urgent')], requests: [ask('u')], forecast: forecast({}) });
    expect(result.queue[0]).toMatchObject({ status: 'quota', until: HOUR });
  });

  it('follows the orders people set by dragging, for trees and for tasks within a tree', () => {
    const trees = [tree('big', 'high'), tree('small', 'low')];
    const one = [{ ...login('a', { used: 0 }, week(0, 6 * DAY)), running: DEFAULT_SCHEDULING.maxConcurrent - 1 }];
    const order = placeItem([], 'small', { below: 'big' }, 1);
    const result = schedule({ now: 0, logins: one, trees, requests: trees.map((t) => ask(t.id, 0, ['a'])), forecast: forecast({}), order });
    expect(result.admissions.map((a) => a.requestId)).toEqual(['r-small']);
    expect(result.queue[0]).toMatchObject({ requestId: 'r-small', placed: true });
    // Within a tree: the second sub-task placed before the first.
    const subs: TurnRequest[] = [{ id: 'one', treeId: 'big', taskId: 'sub1', requestedAt: 0, logins: ['a'] },
      { id: 'two', treeId: 'big', taskId: 'sub2', requestedAt: 1, logins: ['a'] }];
    const within = schedule({ now: 0, logins: one, trees: [tree('big', 'high')], requests: subs, forecast: forecast({}),
      order: placeItem([], 'sub2', { below: 'sub1' }, 1) });
    expect(within.admissions.map((a) => a.requestId)).toEqual(['two']);
  });

  it('never keeps an API key\'s quota back: it has no windows', () => {
    const key: LoginState = { id: 'k', provider: 'claude', windows: [], running: 0, committed: 0 };
    expect(schedule({ now: 0, logins: [key], trees: [tree('t', 'low', 500)], requests: [ask('t', 0, ['k'])], forecast: forecast({ urgent: 5 }) })
      .admissions).toHaveLength(1);
  });
});

describe('what the scheduler learns', () => {
  const kv = (): KvStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, kvGet: async (k) => data.get(k), kvSet: (k, v) => { data.set(k, v); },
      kvCompareAndSet: async (k, expected, next) => {
        if (data.get(k) !== expected) return false;
        if (next === undefined) data.delete(k); else data.set(k, next);
        return true;
      } };
  };

  it('prices a turn\'s usage per model, sub-agents included', () => {
    expect(usageCostUsd({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }, 'claude-opus-5-5')).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
    expect(usageCostUsd({ inputTokens: 0, outputTokens: 0, models: {
      'claude-opus-5-5': { inputTokens: 0, outputTokens: 1e6 }, 'claude-sonnet-5': { inputTokens: 0, outputTokens: 1e6 } } })).toBeCloseTo(30, 6);
  });

  it('keeps a tree\'s spend and burn rate, and learns a login\'s capacity from its readings against its spend', async () => {
    const store = kv();
    await recordTurnSpend(store, { root: 'T', organizationId: 'org', credential: 'login:org:claude:x', usd: 10, minutes: 20, at: 1 });
    await recordQuotaReading(store, 'login:org:claude:x', 'session', { utilization: 0.1, resetsAt: 5 * 3600_000, at: 2 });
    await recordTurnSpend(store, { root: 'T', credential: 'login:org:claude:x', usd: 40, minutes: 80, at: 3 });
    await recordQuotaReading(store, 'login:org:claude:x', 'session', { utilization: 0.3, resetsAt: 5 * 3600_000, at: 4 });
    expect(JSON.parse(store.data.get(treeKey('T'))!)).toMatchObject({ spent: 50, burn: 0.5, lastLogin: 'login:org:claude:x', turns: 2 });
    // $40 moved the window 20 points: $200 a window.
    expect(JSON.parse(store.data.get('quota:capacity:login:org:claude:x')!).session.usd).toBeCloseTo(200, 6);
    const [session, weekly] = await loginWindows(store, 'login:org:claude:x', 60_000);
    expect(session).toMatchObject({ kind: 'session', resetAt: 300 });
    expect(session!.capacity).toBeCloseTo(200, 6);
    expect(session!.used).toBeCloseTo(60, 6);
    expect(weekly).toMatchObject({ kind: 'week', capacity: 900, used: 0 });
  });

  it('fits tree sizes, shrunk toward the prior while history is short; no priority runs as medium', () => {
    expect(fitSize([])).toEqual(PRIOR.size);
    const many = fitSize(Array.from({ length: 2000 }, (_, i) => Math.exp(1 + Math.sin(i))));
    expect(many.mu).toBeCloseTo(1, 0);
    expect(schedulingPriority(0)).toBe('medium');
    expect(schedulingPriority(1)).toBe('low');
    expect(schedulingPriority(4)).toBe('urgent');
  });
});
