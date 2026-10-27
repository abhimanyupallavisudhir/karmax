/**
 * What the next unit of a quota is worth, if kept, to work ranked above `r`:
 * E[V^{>r}_(c)], the rank of the c-th unit of demand ranked above r that will
 * want quota before it resets (0 if there is less than that), over sampled
 * futures. A tree of rank r gets the unit now only if r is at least that.
 *
 * Only demand ranked above r counts: a unit that would go to work ranked no
 * higher is worth no more kept than used now, and kept it only makes this tree
 * wait. With two priorities this is Littlewood's rule (serve the lower if
 * r_low ≥ r_high · P(D_high ≥ c)); with many it is the exact form of EMSR, and
 * sampling gives it with the demand's real shape instead of a normal law.
 *
 * Each scenario keeps, for a few times ahead (slices of the horizon), how much
 * demand at or above each rank is still to come then, so the same samples also
 * say when a held turn's price will have fallen below its rank.
 */
export class SampledDemand {
  private readonly scenarios: Float64Array[][] = [];
  private readonly step: number;

  constructor(readonly horizon: number, readonly slices = 8, private readonly lo = 1e-6, hi = 100, private readonly levels = 400) {
    this.step = Math.log(hi / lo) / (levels - 1);
  }

  private level(rank: number): number {
    return rank <= this.lo ? 0 : Math.min(this.levels - 1, Math.floor(Math.log(rank / this.lo) / this.step));
  }

  get size(): number { return this.scenarios.length; }

  /** Adds one scenario: `fill` reports each piece of demand as (rank, quota, minutes from now it is wanted). */
  add(fill: (piece: (rank: number, quota: number, at: number) => void) => void): void {
    const bySlice = Array.from({ length: this.slices }, () => new Float64Array(this.levels));
    fill((rank, quota, at) => {
      if (!(rank > 0) || !(quota > 0)) return;
      const level = this.level(rank);
      // Demand wanted at `at` is still to come at every slice start before it.
      const last = Math.min(this.slices - 1, Math.floor(Math.max(0, at) / this.horizon * this.slices));
      for (let s = 0; s <= last; s++) bySlice[s]![level]! += quota;
    });
    for (const histogram of bySlice) for (let l = this.levels - 2; l >= 0; l--) histogram[l]! += histogram[l + 1]!;
    this.scenarios.push(bySlice);
  }

  /**
   * E[max(V^{>above}_(c), floor)]: counting only demand ranked above `above`, and
   * still to come `slice` slices from now.
   */
  price(c: number, floor = 0, slice = 0, above = 0): number {
    if (!this.scenarios.length) return floor;
    const start = above > 0 ? Math.min(this.levels - 1, this.level(above) + 1) : 0;
    let sum = 0;
    for (const bySlice of this.scenarios) {
      const atOrAbove = bySlice[Math.min(slice, this.slices - 1)]!;
      // No quota free of running turns: it is still not kept for anything but higher-ranked work.
      const units = Math.max(c, 1e-9);
      if (atOrAbove[start]! < units) { sum += floor; continue; }
      // The highest level whose demand at or above it reaches c (levels are lower bounds).
      let lo = start, hi = this.levels - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (atOrAbove[mid]! >= units) lo = mid; else hi = mid - 1; }
      sum += Math.max(this.lo * Math.exp(lo * this.step), floor);
    }
    return sum / this.scenarios.length;
  }

  /** Minutes from now until a tree of `rank` clears the price (the horizon if it doesn't). */
  releaseIn(rank: number, c: number, floor = 0): number {
    for (let s = 0; s < this.slices; s++) if (this.price(c, floor, s, rank) <= rank) return s * this.horizon / this.slices;
    return this.horizon;
  }
}
