import type { Priority } from './policy.js';

export const PRIORITY_ORDER: Priority[] = ['low', 'medium', 'high', 'urgent'];
export type Random = () => number;

export function poisson(mean: number, u: Random): number {
  if (!(mean > 0)) return 0;
  mean = Math.min(mean, 10_000);
  if (mean > 50) return Math.max(0, Math.round(mean + Math.sqrt(mean) * Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u())));
  let k = 0, p = Math.exp(-mean), s = p;
  const x = u();
  while (x > s && k < 1000) { k++; p *= mean / k; s += p; }
  return k;
}

export function geometric(mean: number, u: Random): number {
  return mean <= 1 ? 1 : 1 + Math.floor(Math.log(u() || 1e-12) / Math.log(1 - 1 / mean));
}

/** Gamma(shape, 1/shape): mean 1 (Marsaglia–Tsang). */
export function gammaMeanOne(shape: number, u: Random): number {
  if (!Number.isFinite(shape)) return 1;
  if (shape < 1) return gammaMeanOne(shape + 1, u) * Math.pow(u() || 1e-12, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const z = Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
    const v = Math.pow(1 + c * z, 3);
    if (v > 0 && Math.log(u() || 1e-12) < 0.5 * z * z + d - d * v + d * Math.log(v)) return d * v / shape;
  }
}

/** Seeded uniform generator (mulberry32), so a scheduling decision can be replayed. */
export function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ForecastState {
  version: 1;
  batch: number;
  halfLifeDays: number;
  priorHours: number;
  last: number;
  counts: Record<Priority, number[]>;
  exposure: number[];
  /** Root tasks per day, oldest first, ending with the day of `last`. */
  days: number[];
  firstDay: number;
}

/** Pseudo-hours of no arrivals a priority's mean rate is shrunk toward. */
const PRIOR_RATE_HOURS = 24;

/**
 * Root tasks arriving, by priority and hour of the day (UTC), learned online:
 * exponentially decayed counts (half-life `halfLifeDays`), each hour shrunk
 * toward the priority's mean rate by `priorHours` hours of pseudo-exposure, and
 * that mean toward no arrivals by a day of it: a new organization has shown no
 * demand to keep quota for, and a few minutes of history never read as
 * thousands of tasks an hour.
 * Sub-tasks are part of their tree, not new demand. Tasks come in batches
 * (`batch` on average, filed together) and some days are busier than others:
 * the day-to-day swing is the variance of daily counts beyond what batching
 * explains, so sampled futures are as uncertain as the past was.
 * Times are minutes since the epoch.
 */

export class ArrivalForecast {
  private readonly counts = new Map<Priority, Float64Array>();
  private readonly exposure = new Float64Array(24);
  private days: number[] = [];
  private firstDay = 0;
  /** Minutes up to which exposure is counted; -1 before the first observation. */
  private last = -1;

  constructor(private readonly batch = 3, private readonly halfLifeDays = 14, private readonly priorHours = 2) {
    for (const p of PRIORITY_ORDER) this.counts.set(p, new Float64Array(24));
  }

  static from(state: ForecastState): ArrivalForecast {
    const f = new ArrivalForecast(state.batch, state.halfLifeDays, state.priorHours);
    for (const p of PRIORITY_ORDER) f.counts.set(p, Float64Array.from(state.counts[p] ?? Array.from({ length: 24 }, () => 0)));
    state.exposure.forEach((v, h) => { f.exposure[h] = v; });
    f.days = [...state.days];
    f.firstDay = state.firstDay;
    f.last = state.last;
    return f;
  }

  toJSON(): ForecastState {
    return { version: 1, batch: this.batch, halfLifeDays: this.halfLifeDays, priorHours: this.priorHours, last: this.last,
      counts: Object.fromEntries(PRIORITY_ORDER.map((p) => [p, Array.from(this.counts.get(p)!)])) as Record<Priority, number[]>,
      exposure: Array.from(this.exposure), days: [...this.days], firstDay: this.firstDay };
  }

  /** Brings the decayed counts and exposure up to `now`. */
  advanceTo(now: number): void {
    if (this.last < 0) { this.last = now; this.firstDay = Math.floor(now / 1440); return; }
    if (now <= this.last) return;
    const keep = Math.pow(0.5, (now - this.last) / (this.halfLifeDays * 1440));
    for (const row of this.counts.values()) for (let h = 0; h < 24; h++) row[h]! *= keep;
    for (let h = 0; h < 24; h++) this.exposure[h]! *= keep;
    for (let t = this.last; t < now; t += 60) this.exposure[Math.floor(t / 60) % 24]! += Math.min(60, now - t) / 60;
    this.last = now;
  }

  observe(now: number, priority: Priority): void {
    this.advanceTo(now);
    this.counts.get(priority)![Math.floor(now / 60) % 24]! += 1;
    let day = Math.floor(now / 1440) - this.firstDay;
    while (this.days.length <= day) this.days.push(0);
    if (this.days.length > 60) { const drop = this.days.length - 60; this.days.splice(0, drop); this.firstDay += drop; day -= drop; }
    this.days[day]! += 1;
  }

  /** Shape of the day multiplier's gamma distribution (Infinity: no swing beyond batching). */
  swing(now: number): number {
    const today = Math.floor(now / 1440) - this.firstDay;
    const recent = this.days.slice(Math.max(0, today - 28), Math.max(0, today));
    if (recent.length < 7) return Infinity;
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / (recent.length - 1);
    // A Poisson number of geometric batches has variance mean·(2·batch − 1).
    const excess = (variance - mean * (2 * this.batch - 1)) / (mean * mean);
    return mean > 0 && excess > 0 ? 1 / excess : Infinity;
  }

  /** Expected arrivals of `priority` in [from, to). */
  expected(priority: Priority, from: number, to: number): number {
    const row = this.counts.get(priority)!;
    let all = 0, seen = 0;
    for (let h = 0; h < 24; h++) { all += row[h]!; seen += this.exposure[h]!; }
    const mean = all / (seen + PRIOR_RATE_HOURS);
    let total = 0;
    for (let t = from; t < to; t += 60) {
      const h = Math.floor(t / 60) % 24;
      const rate = (row[h]! + this.priorHours * mean) / (this.exposure[h]! + this.priorHours);
      total += rate * Math.min(60, to - t) / 60;
    }
    return total;
  }

  /** One sampled future: the root tasks arriving in [from, to). */
  sample(from: number, to: number, u: Random): { at: number; priority: Priority }[] {
    const shape = this.swing(from), multiplier = new Map<number, number>();
    const out: { at: number; priority: Priority }[] = [];
    for (let t = from; t < to; t += 60) {
      const slot = Math.min(60, to - t), day = Math.floor(t / 1440);
      if (!multiplier.has(day)) multiplier.set(day, gammaMeanOne(shape, u));
      const rates = PRIORITY_ORDER.map((p) => this.expected(p, t, t + slot));
      const total = rates.reduce((a, b) => a + b, 0);
      if (total <= 0) continue;
      for (let b = poisson(multiplier.get(day)! * total / this.batch, u); b > 0; b--) {
        const at = t + u() * slot;
        for (let i = geometric(this.batch, u); i > 0; i--) {
          let x = u() * total, priority: Priority = 'medium';
          for (let k = 0; k < PRIORITY_ORDER.length; k++) { x -= rates[k]!; if (x <= 0) { priority = PRIORITY_ORDER[k]!; break; } }
          out.push({ at, priority });
        }
      }
    }
    return out;
  }
}
