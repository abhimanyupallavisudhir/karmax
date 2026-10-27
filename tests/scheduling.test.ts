import { describe, expect, it } from 'vitest';
import { SizeModel, normalQuantile } from '../src/scheduling/size-model.js';
import { DEFAULT_SCHEDULING, schedule, treeRank, type DemandForecast, type LoginState, type TreeState, type TurnRequest }
  from '../src/scheduling/policy.js';

// Production task trees (wiki planned/quota-scheduling): log-normal cost, σ ≈ 1.5.
const size = new SizeModel({ mu: Math.log(36) - 1.53 ** 2 / 2, sigma: 1.53 });
const HOUR = 60, DAY = 1440;

describe('size model', () => {
  it('matches Monte Carlo moments of a log-normal', () => {
    let seed = 7;
    const uniform = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const draws = Array.from({ length: 200_000 }, () => Math.exp(size.law.mu + size.law.sigma * normalQuantile(uniform())));
    const mc = (x: number) => draws.reduce((s, d) => s + Math.min(d, x), 0) / draws.length;
    for (const x of [1, 10, 100]) expect(size.expectedMin(x)).toBeCloseTo(mc(x), 0);
    expect(size.expectedMinSquared(30)).toBeCloseTo(draws.reduce((s, d) => s + Math.min(d, 30) ** 2, 0) / draws.length, -1);
  });

  it('ranks a big spender ever lower: what it has spent says it is far from done', () => {
    expect(size.residual(100, 1e6).mean).toBeGreaterThan(size.residual(1, 1e6).mean * 3);
    expect(size.rank(100)).toBeLessThan(size.rank(10));
    expect(size.rank(10)).toBeLessThan(size.rank(0));
  });
});

const week = (used: number, resetIn: number) => ({ kind: 'week' as const, capacity: 900, used, resetAt: resetIn, length: 7 * DAY });
const login = (id: string, session: { used: number; resetAt?: number }, weekly: ReturnType<typeof week>): LoginState => ({
  id, provider: 'claude', running: 0, committed: 0,
  windows: [{ kind: 'session', capacity: 150, length: 5 * HOUR, ...session }, weekly] });
const tree = (id: string, priority: TreeState['priority'], attained = 0): TreeState => ({
  id, priority, attained, burnRate: 0.4, turnCost: 3, running: 0, committed: 0 });
const ask = (treeId: string, at = 0): TurnRequest => ({ id: `r-${treeId}`, treeId, requestedAt: at, logins: ['a', 'b'] });
const forecast = (perHour: number): DemandForecast => ({
  arrivals: (from, to) => perHour * (to - from) / HOUR, dispersion: 2.3, size, burnRate: 0.4,
  mix: { low: 0.1, medium: 0.75, high: 0.12, urgent: 0.03 } });

describe('quota scheduling policy', () => {
  it('serves by priority, then by how little a tree has spent; urgent first', () => {
    const trees = [tree('hog', 'medium', 200), tree('fresh', 'medium'), tree('low', 'low'), tree('now', 'urgent', 50)];
    const one = [login('a', { used: 0 }, week(0, 6 * DAY))].map((l) => ({ ...l, running: DEFAULT_SCHEDULING.maxConcurrent - 1 }));
    const order = trees.map((t) => [t.id, treeRank(t, size, DEFAULT_SCHEDULING)] as const).sort((x, y) => y[1] - x[1]).map((x) => x[0]);
    expect(order).toEqual(['now', 'fresh', 'low', 'hog']);
    // One free slot: it goes to the urgent tree.
    expect(schedule(0, one, trees, trees.map((t) => ask(t.id)), forecast(0)).map((a) => a.requestId)).toEqual(['r-now']);
  });

  it('keeps a nearly spent window for better work early on, and spends it all near its reset', () => {
    const hog = tree('hog', 'low', 300);
    const early = [login('a', { used: 120, resetAt: 4 * HOUR }, week(100, 5 * DAY)), login('b', { used: 140, resetAt: 4.5 * HOUR }, week(100, 6 * DAY))];
    // An evening peak: two trees an hour for the next five hours, then quiet; the weeks have room for it.
    const peak: DemandForecast = { ...forecast(0), arrivals: (from, to) => 2 * Math.max(0, Math.min(to, 5 * HOUR) - from) / HOUR };
    expect(schedule(0, early, [hog], [ask('hog')], peak)).toEqual([]);
    const late = [login('a', { used: 120, resetAt: 6 }, week(100, 5 * DAY)), login('b', { used: 140, resetAt: 9 }, week(100, 6 * DAY))];
    expect(schedule(0, late, [hog], [ask('hog')], peak)).toEqual([{ requestId: 'r-hog', loginId: 'a' }]);
  });

  it('uses any quota left when no better work is expected, however much running turns may still spend', () => {
    const busy = [login('a', { used: 140, resetAt: 4 * HOUR }, week(0, 6 * DAY))].map((l) => ({ ...l, committed: 50, running: 3 }));
    expect(schedule(0, busy, [tree('t', 'medium')], [{ ...ask('t'), logins: ['a'] }], forecast(0))).toHaveLength(1);
  });

  it('drains the login whose week resets soonest instead of running every week out together', () => {
    const logins = [login('a', { used: 0 }, week(700, 6 * DAY)), login('b', { used: 0 }, week(700, 6 * HOUR))];
    expect(schedule(0, logins, [tree('t', 'medium')], [ask('t')], forecast(2))).toEqual([{ requestId: 'r-t', loginId: 'b' }]);
  });

  it('never holds urgent work back, but only uses a login with quota left', () => {
    const spent = [login('a', { used: 150, resetAt: HOUR }, week(300, 5 * DAY)), login('b', { used: 149, resetAt: 4 * HOUR }, week(300, 6 * DAY))];
    expect(schedule(0, spent, [tree('u', 'urgent', 400)], [ask('u')], forecast(5))).toEqual([{ requestId: 'r-u', loginId: 'b' }]);
  });
});
