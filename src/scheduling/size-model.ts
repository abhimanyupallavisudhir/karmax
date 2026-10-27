/**
 * How much quota a task tree will spend in all, as a log-normal law over its
 * cost (API-equivalent dollars, sub-tasks included). Production trees fit one
 * well: σ ≈ 1.5, median ≈ $4.5 (metered 2026-08..10). Its mean residual life
 * grows with what a tree has already spent ($20 more after $1, $209 more after
 * $100), which is what makes the Gittins rank fall as a tree spends: a big
 * spender is ever less likely to be about to finish.
 */
export interface LogNormal { mu: number; sigma: number }

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Inverse standard normal CDF (Acklam, relative error < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const tail = (q: number) => (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
    / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
    / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export class SizeModel {
  private readonly ranks: { a: number; rank: number }[];
  readonly mean: number;

  constructor(readonly law: LogNormal) {
    this.mean = Math.exp(law.mu + law.sigma ** 2 / 2);
    this.ranks = this.rankTable();
  }

  cdf(s: number): number { return s <= 0 ? 0 : normalCdf((Math.log(s) - this.law.mu) / this.law.sigma); }
  survival(s: number): number { return 1 - this.cdf(s); }

  /** E[min(S, x)] = ∫₀ˣ P(S > s) ds. */
  expectedMin(x: number): number {
    if (x <= 0) return 0;
    const { mu, sigma } = this.law;
    const z = (Math.log(x) - mu) / sigma;
    return this.mean * normalCdf(z - sigma) + x * (1 - normalCdf(z));
  }

  /** E[min(S, x)²] = ∫₀ˣ 2s P(S > s) ds (Simpson on a square-root grid, exact enough here). */
  expectedMinSquared(x: number): number {
    if (x <= 0) return 0;
    const n = 48;
    let sum = 0;
    for (let i = 0; i <= n; i++) {
      const u = i / n, s = x * u * u; // ds = 2x u du
      const f = 2 * s * this.survival(s) * 2 * x * u;
      sum += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * f;
    }
    return sum / (3 * n);
  }

  /** What a tree that has spent `a` spends within its next `t`: mean and variance of min(S − a, t) given S > a. */
  residual(a: number, t: number): { mean: number; variance: number } {
    const alive = this.survival(a);
    if (alive < 1e-12 || t <= 0) return { mean: 0, variance: 0 };
    const mean = (this.expectedMin(a + t) - this.expectedMin(a)) / alive;
    // E[min(S−a,t)²] = ∫₀ᵗ 2r P(S > a + r) dr / P(S > a)
    const n = 48;
    let second = 0;
    for (let i = 0; i <= n; i++) {
      const u = i / n, r = t * u * u;
      second += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * 2 * r * this.survival(a + r) * 2 * t * u;
    }
    second /= 3 * n * alive;
    return { mean, variance: Math.max(0, second - mean * mean) };
  }

  /**
   * Gittins rank of a tree that has spent `a`: the best ratio, over how much
   * more to spend (Δ), of the chance it finishes within Δ to what that costs.
   * It is the expected completions per unit of quota, so ranking by it (times
   * a priority's delay cost) minimises weighted waiting for unknown sizes
   * (Gittins; Aalto, Ayesta & Righter 2009; Scully et al. 2020 for many servers).
   */
  rank(a: number): number {
    const table = this.ranks;
    if (a <= table[0]!.a) return table[0]!.rank;
    for (let i = 1; i < table.length; i++) {
      const hi = table[i]!;
      if (a <= hi.a) {
        const lo = table[i - 1]!, f = Math.log(a / lo.a) / Math.log(hi.a / lo.a);
        return Math.exp(Math.log(lo.rank) + f * (Math.log(hi.rank) - Math.log(lo.rank)));
      }
    }
    return this.rankAt(a);
  }

  /** A total size drawn given that it exceeds `a` (`u` uniform in [0, 1)). */
  sampleBeyond(a: number, u: number): number {
    const p = Math.min(1 - 1e-12, this.cdf(a) + u * (1 - this.cdf(a)));
    return Math.max(a, Math.exp(this.law.mu + this.law.sigma * normalQuantile(p)));
  }

  /**
   * The spend a tree makes from `a` to `a + amount`, cut where its rank changes,
   * each piece at the lowest rank on the way there (times `weight`): a tree must
   * win quota at that rank before it reaches a later, higher one, so counting
   * its later spend at that higher rank would overstate its claim.
   */
  pieces(a: number, amount: number, weight: number, out: (rank: number, quota: number) => void): void {
    const table = this.ranks, end = a + amount;
    let at = a, lowest = this.rank(a);
    for (const point of table) {
      if (point.a <= at) continue;
      if (at >= end) return;
      const next = Math.min(end, point.a);
      out(weight * lowest, next - at);
      at = next;
      lowest = Math.min(lowest, point.rank);
    }
    if (at < end) out(weight * Math.min(lowest, this.rankAt(end)), end - at);
  }

  private rankAt(a: number): number {
    const median = Math.exp(this.law.mu);
    const alive = this.survival(a);
    if (alive < 1e-12) return 1e-12;
    let best = 0;
    for (let i = 0; i <= 240; i++) {
      const delta = median * 10 ** (-3 + 6 * i / 240);
      const work = this.expectedMin(a + delta) - this.expectedMin(a);
      if (work > 0) best = Math.max(best, (this.cdf(a + delta) - this.cdf(a)) / work);
    }
    return Math.max(best, alive / Math.max(1e-12, this.mean - this.expectedMin(a)), 1e-12);
  }

  private rankTable(): { a: number; rank: number }[] {
    const median = Math.exp(this.law.mu);
    return Array.from({ length: 121 }, (_, i) => {
      const a = median * 10 ** (-3 + 6 * i / 120);
      return { a, rank: this.rankAt(a) };
    });
  }
}
