/** How long a skipped seq may still commit. PostgreSQL assigns a seq at insert,
 * not at commit, so an open transaction's row can appear below rows already
 * read; a rolled-back or deleted row never appears, so the wait is bounded. */
export const GAP_GRACE_MS = 60_000;
/** Bounds the gap set. Rows replaced before a reader saw them (streamed agent
 * output) also leave gaps; past the bound the oldest gaps, the least likely
 * to still commit, give way to new ones. */
const MAX_GAPS = 4096;
/** Seqs per re-read of the gaps. */
export const GAP_QUERY_BATCH = 500;

/** The seqs a lossless forward reader of `events` passed without a row. Store
 * transactions commit concurrently, so seqs are not commit-ordered: each one
 * is re-read until its row commits or GAP_GRACE_MS passes. */
export class EventGaps {
  /** Skipped seq → when the cursor first passed it. */
  private readonly gaps = new Map<number, number>();

  /** Record every seq between `cursor` and the ascending `seqs` just read. */
  note(cursor: number, seqs: readonly number[], now = Date.now()): void {
    let previous = cursor;
    for (const seq of seqs) {
      for (let gap = Math.max(previous + 1, seq - MAX_GAPS); gap < seq; gap++) this.gaps.set(gap, now);
      previous = seq;
    }
    for (const seq of this.gaps.keys()) {
      if (this.gaps.size <= MAX_GAPS) break;
      this.gaps.delete(seq);
    }
  }

  /** Gaps still worth re-reading, in batches; expired ones are dropped. */
  pending(now = Date.now()): number[][] {
    for (const [seq, since] of this.gaps) if (now - since > GAP_GRACE_MS) this.gaps.delete(seq);
    const wanted = [...this.gaps.keys()];
    const batches: number[][] = [];
    for (let offset = 0; offset < wanted.length; offset += GAP_QUERY_BATCH) batches.push(wanted.slice(offset, offset + GAP_QUERY_BATCH));
    return batches;
  }

  /** Seqs whose rows have now been read. */
  fill(seqs: Iterable<number>): void { for (const seq of seqs) this.gaps.delete(seq); }
}
