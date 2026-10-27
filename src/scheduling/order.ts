/**
 * Orders people (or agents) set by dragging a row on the Queues page.
 *
 * Dropping X between A and B records "A before X" and "X before B". The
 * scheduler then adjusts ranks as little as possible to respect every recorded
 * order: a weighted isotonic regression of the log ranks in which the rows
 * people moved are nearly free and every other row is stiff, so X lands just
 * where it was dropped and no neighbour jumps (an unweighted one would pull B
 * down to meet X, below rows nobody touched). The adjusted rank is used both for
 * ordering and for holding quota back, so the list always shows what will
 * happen. An order lasts until one of its two rows is gone; dropping X again
 * replaces X's own earlier placement, and a newer order wins over an older one
 * that contradicts it.
 */
export interface OrderConstraint {
  /** The row that goes first. */
  above: string;
  /** The row that goes after it. */
  below: string;
  /** When it was recorded (any monotone clock). */
  at: number;
  /** Who recorded it (a user or agent id), for the pin's tooltip. */
  by?: string;
  /** Which of the two rows was dragged (it moves; the other holds its place). */
  moved?: 'above' | 'below';
}

/** Ratio between two rows pinned next to each other (log margin). */
const MARGIN = 1e-3;

/**
 * Records that `item` goes after `above` and before `below` (either may be
 * absent: the top or bottom of the list). Returns the new constraint list.
 */
export function placeItem(constraints: OrderConstraint[], item: string, neighbours: { above?: string; below?: string },
  at: number, by?: string): OrderConstraint[] {
  const kept = constraints.filter((c) => c.above !== item && c.below !== item);
  const added: OrderConstraint[] = [];
  if (neighbours.above && neighbours.above !== item) added.push({ above: neighbours.above, below: item, at, moved: 'below', ...(by ? { by } : {}) });
  if (neighbours.below && neighbours.below !== item) added.push({ above: item, below: neighbours.below, at, moved: 'above', ...(by ? { by } : {}) });
  return breakCycles([...kept, ...added], new Set(added));
}

/** Drops every order involving `item` (back to automatic order; also on a priority change). */
export function clearItem(constraints: OrderConstraint[], item: string): OrderConstraint[] {
  return constraints.filter((c) => c.above !== item && c.below !== item);
}

/** Drops orders whose rows are gone (finished, cancelled). */
export function pruneOrders(constraints: OrderConstraint[], live: (id: string) => boolean): OrderConstraint[] {
  return constraints.filter((c) => live(c.above) && live(c.below));
}

/** Removes the oldest constraint on any cycle until none is left; `keep` are never removed. */
function breakCycles(constraints: OrderConstraint[], keep: Set<OrderConstraint>): OrderConstraint[] {
  let list = constraints;
  for (;;) {
    const cycle = findCycle(list);
    if (!cycle) return list;
    const removable = cycle.filter((c) => !keep.has(c));
    if (!removable.length) return list.filter((c) => !cycle.includes(c) || keep.has(c));
    const oldest = removable.reduce((a, b) => (b.at < a.at ? b : a));
    list = list.filter((c) => c !== oldest);
  }
}

function findCycle(constraints: OrderConstraint[]): OrderConstraint[] | undefined {
  const edges = new Map<string, OrderConstraint[]>();
  for (const c of constraints) edges.set(c.above, [...(edges.get(c.above) ?? []), c]);
  const state = new Map<string, 'open' | 'done'>();
  const path: OrderConstraint[] = [];
  const visit = (node: string): OrderConstraint[] | undefined => {
    state.set(node, 'open');
    for (const edge of edges.get(node) ?? []) {
      const s = state.get(edge.below);
      path.push(edge);
      if (s === 'open') {
        const start = path.findIndex((e) => e.above === edge.below);
        return path.slice(start);
      }
      if (!s) { const found = visit(edge.below); if (found) return found; }
      path.pop();
    }
    state.set(node, 'done');
    return undefined;
  };
  for (const node of edges.keys()) if (!state.has(node)) { const found = visit(node); if (found) return found; }
  return undefined;
}

/** How much more a row nobody dragged resists moving than one somebody did. */
const STIFF = 1e6;

/**
 * The ranks closest to `ranks` that respect every constraint between present
 * rows, in weighted least squares on log rank (dragged rows weight 1, the rest
 * STIFF): Dykstra's projection onto the intersection of the half-spaces
 * log r_above − log r_below ≥ margin, which converges to the exact weighted
 * isotonic regression. Rows without constraints keep their rank.
 */
export function adjustRanks(ranks: Map<string, number>, constraints: OrderConstraint[]): Map<string, number> {
  const active = constraints.filter((c) => ranks.has(c.above) && ranks.has(c.below) && c.above !== c.below);
  if (!active.length) return ranks;
  const moved = new Set(active.flatMap((c) => c.moved === 'above' ? [c.above] : c.moved === 'below' ? [c.below] : [c.above, c.below]));
  const weight = (id: string) => (moved.has(id) ? 1 : STIFF);
  const x = new Map<string, number>();
  for (const [id, r] of ranks) x.set(id, Math.log(Math.max(r, 1e-300)));
  const original = new Map(x);
  // Dykstra: one correction per half-space.
  const correction = active.map(() => ({ above: 0, below: 0 }));
  for (let sweep = 0; sweep < 5000; sweep++) {
    let change = 0;
    active.forEach((c, i) => {
      const k = correction[i]!;
      const ya = x.get(c.above)! + k.above, yb = x.get(c.below)! + k.below;
      // Weighted projection of (ya, yb) onto ya − yb ≥ MARGIN: each side moves inversely to its weight.
      const gap = ya - yb - MARGIN;
      const ia = 1 / weight(c.above), ib = 1 / weight(c.below);
      const pa = gap >= 0 ? ya : ya - gap * ia / (ia + ib), pb = gap >= 0 ? yb : yb + gap * ib / (ia + ib);
      k.above = ya - pa; k.below = yb - pb;
      change = Math.max(change, Math.abs(pa - x.get(c.above)!), Math.abs(pb - x.get(c.below)!));
      x.set(c.above, pa); x.set(c.below, pb);
    });
    if (change < 1e-12) break;
  }
  const out = new Map(ranks);
  for (const [id, v] of x) if (v !== original.get(id)) out.set(id, Math.exp(v));
  return out;
}
