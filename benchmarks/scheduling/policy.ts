/**
 * The quota scheduler's policy core (wiki planned/quota-scheduling), pure so the
 * simulator here and, later, the account coordinator's pricing activity share it.
 *
 * Quota is measured in units of one subscription's capacity (an agent-minute at a
 * reference burn rate in the simulator; a utilization point in production).
 *   - index(w, a)      what one more unit is worth to a task tree: its priority weight
 *                      times the Gittins index of its size distribution at the quota
 *                      it has already used (falls as a heavy-tailed tree grows).
 *   - price(c)         what the c-th unit left of a quota is worth if held: E[V_(c)], the
 *                      index of the c-th unit of demand (sampled arrivals plus the trees
 *                      already waiting) before that quota resets, 0 if demand runs out
 *                      first. The weekly quota is priced so; a 5-hour window at
 *                      E[max(V_(c), weekly price)], since a unit left in it keeps its
 *                      weekly unit.
 * A unit goes to a tree only if its index is at least the price of the account it
 * would come from.
 */

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type Random = () => number;

export const poisson = (mean: number, u: Random): number => {
  if (mean > 50) return Math.max(0, Math.round(mean + Math.sqrt(mean) * Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u())));
  let k = 0, p = Math.exp(-mean), s = p;
  const x = u();
  while (x > s) { k++; p *= mean / k; s += p; }
  return k;
};
export const geometric = (mean: number, u: Random): number => mean <= 1 ? 1 : 1 + Math.floor(Math.log(u()) / Math.log(1 - 1 / mean));
/** Gamma(shape, 1/shape): mean 1 (Marsaglia–Tsang). */
export const gammaMeanOne = (shape: number, u: Random): number => {
  if (!Number.isFinite(shape)) return 1;
  if (shape < 1) return gammaMeanOne(shape + 1, u) * Math.pow(u(), 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const z = Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    const v = Math.pow(1 + c * z, 3);
    if (v > 0 && Math.log(u()) < 0.5 * z * z + d - d * v + d * Math.log(v)) return d * v / shape;
  }
};
export const PRIORITY_ORDER: Priority[] = ['low', 'normal', 'high', 'urgent'];

/** Tree sizes in quota units: log-normal, truncated at `cap`. */
export interface SizeModel { mu: number; sigma: number; cap: number }

const erf = (x: number): number => {
  // Abramowitz–Stegun 7.1.26, |error| < 1.5e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const phi = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

/** Survival, its integral and the Gittins index of a size model on a log grid. */
export class SizeTable {
  readonly x: number[] = [0];
  readonly survival: number[] = [1];
  /** ∫₀^x S(u) du. */
  readonly area: number[] = [0];
  readonly gittins: number[] = [];

  constructor(readonly model: SizeModel, points = 240) {
    const { mu, sigma, cap } = model;
    const top = phi((Math.log(cap) - mu) / sigma);
    const s = (x: number) => x >= cap ? 0 : (top - phi((Math.log(x) - mu) / sigma)) / top;
    const lo = Math.log(0.5), hi = Math.log(cap);
    for (let i = 0; i < points; i++) {
      const x = Math.exp(lo + (hi - lo) * i / (points - 1));
      const prev = this.x.at(-1)!;
      this.x.push(x);
      this.survival.push(i === points - 1 ? 0 : s(x));
      this.area.push(this.area.at(-1)! + (x - prev) * (this.survival.at(-2)! + this.survival.at(-1)!) / 2);
    }
    // G(a) = max_Δ P(S ≤ a+Δ | S > a) / E[min(S−a, Δ) | S > a]; S(a) cancels.
    const n = this.x.length;
    for (let i = 0; i < n; i++) {
      let best = 0;
      for (let j = i + 1; j < n; j++) {
        const spent = this.area[j]! - this.area[i]!;
        if (spent > 0) best = Math.max(best, (this.survival[i]! - this.survival[j]!) / spent);
      }
      this.gittins.push(best);
    }
  }

  private cell(a: number): number {
    // Largest grid index with x ≤ a.
    let lo = 0, hi = this.x.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.x[mid]! <= a) lo = mid; else hi = mid - 1; }
    return lo;
  }

  survivalAt(a: number): number {
    const i = this.cell(a);
    if (i >= this.x.length - 1) return 0;
    const f = (a - this.x[i]!) / (this.x[i + 1]! - this.x[i]!);
    return this.survival[i]! + f * (this.survival[i + 1]! - this.survival[i]!);
  }

  index(a: number): number { return this.gittins[Math.min(this.cell(a), this.gittins.length - 1)]!; }

  /** A size drawn given that it exceeds `a` (inverse survival). */
  sampleBeyond(a: number, u: number): number {
    const target = this.survivalAt(a) * u;
    let lo = this.cell(a), hi = this.x.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.survival[mid]! > target) lo = mid + 1; else hi = mid; }
    return Math.max(a, this.x[lo]!);
  }

  /** Pieces [index, quota] a tree uses from `a` to `a + amount`: each at the lowest
   *  index on the way there, which it must win first. */
  pieces(a: number, amount: number, weight: number, out: (index: number, quota: number) => void): void {
    let at = a, lowest = Infinity;
    const end = a + amount;
    for (let i = this.cell(a); at < end && i < this.x.length - 1; i++) {
      const next = Math.min(end, this.x[i + 1]!);
      lowest = Math.min(lowest, this.gittins[i]!);
      if (next > at) out(weight * lowest, next - at);
      at = next;
    }
  }
}

/**
 * Sampled demand before a quota resets. Each scenario is a histogram of quota over
 * log-spaced index levels (3% apart from 1e-6 to 100), kept as the quota demanded at
 * each level or higher, so memory and lookups stay constant however long the queue.
 */
export class SampledDemand {
  private readonly scenarios: Float64Array[] = [];
  private readonly step: number;

  constructor(private readonly lo = 1e-6, hi = 100, private readonly levels = 600) {
    this.step = Math.log(hi / lo) / (levels - 1);
  }

  private level(index: number): number {
    return index <= this.lo ? 0 : Math.min(this.levels - 1, Math.floor(Math.log(index / this.lo) / this.step));
  }

  /** Adds one scenario: `fill` reports each piece of demand as (index, quota). */
  add(fill: (piece: (index: number, quota: number) => void) => void): void {
    const atOrAbove = new Float64Array(this.levels);
    fill((index, quota) => { if (index > 0 && quota > 0) atOrAbove[this.level(index)]! += quota; });
    for (let l = this.levels - 2; l >= 0; l--) atOrAbove[l]! += atOrAbove[l + 1]!;
    this.scenarios.push(atOrAbove);
  }

  /** E[max(V_(c), floor)]: V_(c) is the index of the c-th unit of demand (0 if none). */
  price(c: number, floor: number): number {
    if (!this.scenarios.length) return floor;
    let sum = 0;
    for (const atOrAbove of this.scenarios) {
      // The highest level whose demand at or above it reaches c (levels are lower bounds).
      if (atOrAbove[0]! < c) { sum += floor; continue; }
      let lo = 0, hi = this.levels - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (atOrAbove[mid]! >= c) lo = mid; else hi = mid - 1; }
      sum += Math.max(this.lo * Math.exp(lo * this.step), floor);
    }
    return sum / this.scenarios.length;
  }
}

/**
 * Arrival rate per priority and hour of the day, learned online: exponentially
 * decayed counts (half-life `halfLifeDays`), each hour shrunk toward the priority's
 * mean rate by `priorHours` hours of pseudo-exposure. Root tasks only: sub-tasks are
 * part of their tree, not new demand. (Hour of the week once a year of data exists.)
 * Arrivals come in batches (`batch` tasks on average, filed together) and some days
 * are busier than others: the day-to-day swing is the variance of daily counts beyond
 * what batching explains, so sampled futures are as uncertain as the past was.
 */
export class ArrivalForecast {
  private readonly counts = new Map<Priority, Float64Array>();
  private readonly exposure = new Float64Array(24);
  private readonly days: number[] = [];
  private last = 0;

  constructor(private readonly batch = 3, private readonly halfLifeDays = 14, private readonly priorHours = 2) {
    for (const p of PRIORITY_ORDER) this.counts.set(p, new Float64Array(24));
  }

  /** Brings the decayed counts and exposure up to `now`. */
  advanceTo(now: number): void {
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
    const day = Math.floor(now / 1440);
    while (this.days.length <= day) this.days.push(0);
    this.days[day]! += 1;
  }

  /** Shape of the day multiplier's gamma distribution (Infinity: no swing beyond batching). */
  swing(now: number): number {
    const today = Math.floor(now / 1440);
    const recent = this.days.slice(Math.max(0, today - 28), today);
    while (recent.length < Math.min(28, today)) recent.push(0);
    if (recent.length < 7) return Infinity;
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / (recent.length - 1);
    // A Poisson number of geometric batches has variance mean·(2·batch − 1).
    const excess = (variance - mean * (2 * this.batch - 1)) / (mean * mean);
    return mean > 0 && excess > 0 ? 1 / excess : Infinity;
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
      for (let b = poisson(multiplier.get(day)! * total / this.batch, u); b > 0; b--) {
        const at = t + u() * slot;
        for (let i = geometric(this.batch, u); i > 0; i--) {
          let x = u() * total, priority: Priority = 'normal';
          for (let k = 0; k < PRIORITY_ORDER.length; k++) { x -= rates[k]!; if (x <= 0) { priority = PRIORITY_ORDER[k]!; break; } }
          out.push({ at, priority });
        }
      }
    }
    return out;
  }

  /** Expected arrivals of `priority` in [from, to) (minutes), from what was seen until now. */
  expected(priority: Priority, from: number, to: number): number {
    const row = this.counts.get(priority)!;
    let all = 0, seen = 0;
    for (let h = 0; h < 24; h++) { all += row[h]!; seen += this.exposure[h]!; }
    const mean = seen > 0 ? all / seen : 0;
    let total = 0;
    for (let t = from; t < to; t += 60) {
      const h = Math.floor(t / 60) % 24;
      const rate = (row[h]! + this.priorHours * mean) / (this.exposure[h]! + this.priorHours);
      total += rate * Math.min(60, to - t) / 60;
    }
    return total;
  }
}
