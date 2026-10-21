/**
 * Usage of clouds that bill a stopped machine nothing (AWS, Google Cloud): a
 * machine's runs, cut into fixed slices. The usage feed books a row once and
 * never changes it (`reconcileProviderUsage`), so only a slice that is over —
 * a full one, or the last of a run that ended — is reported; a run in
 * progress is booked slice by slice as the sweep sees it.
 */

/** How long one booked slice of a run is. */
export const RUN_SLICE_MS = 5 * 60_000;
/** How long one booked slice of a disk is (disks bill whatever the machine does). */
export const DISK_SLICE_MS = 3_600_000;

export interface MachineRun { start: number; end?: number }
export interface RunSlice { id: string; start: number; end: number }

/** The finished slices of `runs` that end after `from`. A run's slices are
 * named by its start, so a run seen again yields the same ids. */
export function runSlices(runs: MachineRun[], now: number, from: number, sliceMs = RUN_SLICE_MS): RunSlice[] {
  const slices: RunSlice[] = [];
  const seen = new Set<number>();
  for (const run of runs) {
    if (!Number.isFinite(run.start) || seen.has(run.start)) continue;
    seen.add(run.start);
    const last = Math.min(run.end ?? now, now);
    const first = Math.max(0, Math.floor((from - run.start) / sliceMs));
    for (let index = first; run.start + index * sliceMs < last; index++) {
      const start = run.start + index * sliceMs;
      const end = Math.min(start + sliceMs, last);
      // Still running and not yet a whole slice: reported once it is.
      if (end < start + sliceMs && run.end === undefined) break;
      if (end > from) slices.push({ id: `${run.start}:${index}`, start, end });
    }
  }
  return slices;
}

/** The whole hours a disk has existed, since `from`; for a disk being
 * deleted at `deletedAt`, also the part of an hour it lived last (clouds bill
 * a disk by the second, and a deleted disk is never listed again). */
export function diskHours(created: number, now: number, from: number, deletedAt?: number): RunSlice[] {
  const slices: RunSlice[] = [];
  const until = deletedAt === undefined ? now : Math.min(now, deletedAt);
  const first = Math.max(0, Math.ceil((from - created) / DISK_SLICE_MS));
  for (let hour = first; created + hour * DISK_SLICE_MS < until; hour++) {
    const start = created + hour * DISK_SLICE_MS;
    const end = Math.min(start + DISK_SLICE_MS, until);
    if (end < start + DISK_SLICE_MS && deletedAt === undefined) break;
    slices.push({ id: String(hour), start, end });
  }
  return slices;
}

/** How far back a world's final usage reaches: the feed books everything
 * older while the world still exists. */
export const FINAL_USAGE_WINDOW_MS = 24 * 3_600_000;

/** A driver's `usage` asked for one world about to be deleted: its machines
 * and disks only, everything they still do ending at `at`. */
export interface FinalUsage { ref: Record<string, string>; at: number }

/** `<start>-<end>`: a run kept in a tag or label until the feed has booked it. */
export function encodeRun(run: { start: number; end: number }): string { return `${run.start}-${run.end}`; }
export function decodeRun(value: string | undefined): MachineRun | undefined {
  const match = value?.match(/^(\d+)-(\d+)$/);
  return match ? { start: Number(match[1]), end: Number(match[2]) } : undefined;
}
