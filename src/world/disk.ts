import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { World } from './types.js';

/**
 * A world's disk (wiki features/computers, "Running out of disk"): measured by
 * `src/agent/disk-guard.sh`, which also keeps the ballast that lets a full
 * world start its agent; shown as the task's usage meter; and named when a turn
 * fails because the disk is full.
 */
export const DISK_GUARD_SCRIPT = fs.readFileSync(fileURLToPath(new URL('../agent/disk-guard.sh', import.meta.url)), 'utf8');

/** At this share of the disk the agent is told, with the largest paths. */
export const DISK_WARN_RATIO = 0.9;
/** Below this share the warning may be given again. */
export const DISK_REARM_RATIO = 0.85;
/** Less free space than this when something failed means the disk was full. */
const FULL_KB = 100 * 1024;

export interface DiskSpace { totalKb: number; usedKb: number; availKb: number }
export interface DiskCheck {
  disk: DiskSpace;
  /** Free space before the ballast was released (equal to `disk.availKb` otherwise). */
  availBeforeKb: number;
  memory?: { totalKb: number; availKb: number };
  ballast: 'present' | 'created' | 'released' | 'missing';
  ballastKb: number;
}

/** What the task's usage meter shows (MB, as measured at `at`). */
export interface WorldUsage {
  at: number;
  disk?: { usedMb: number; totalMb: number };
  memory?: { usedMb: number; totalMb: number };
}

export interface LargestPaths {
  paths: Array<{ kb: number; path: string }>;
  /** Deleted files a running process still holds open: their space is not free. */
  held: Array<{ kb: number; pid: number; command: string; path: string }>;
}

/** The command that runs the guard in a world: the script inline, nothing uploaded. */
export function diskCheckCommand(command: 'check' | 'largest', root: string): [string, ...string[]] {
  return ['sh', '-c', DISK_GUARD_SCRIPT, 'disk-guard', command, root];
}

export function parseDiskCheck(output: string): DiskCheck | undefined {
  const line = output.split('\n').find((candidate) => candidate.startsWith('KARMAX_USAGE '));
  if (!line) return undefined;
  const fields = Object.fromEntries(line.split(' ').slice(1).map((pair) => pair.split('=') as [string, string]));
  const number = (key: string) => Number(fields[key] ?? NaN);
  if (!(number('disk_total_kb') > 0)) return undefined;
  const memory = number('mem_total_kb') > 0 ? { totalKb: number('mem_total_kb'), availKb: number('mem_avail_kb') } : undefined;
  const ballast = ['present', 'created', 'released', 'missing'].includes(fields.ballast ?? '') ? fields.ballast as DiskCheck['ballast'] : 'missing';
  return { disk: { totalKb: number('disk_total_kb'), usedKb: number('disk_used_kb'), availKb: number('disk_avail_kb') },
    availBeforeKb: number('disk_avail_before_kb'), ...(memory ? { memory } : {}), ballast, ballastKb: number('ballast_kb') };
}

export function worldUsage(check: DiskCheck, at = Date.now()): WorldUsage {
  const mb = (kb: number) => Math.round(kb / 1024);
  return { at, disk: { usedMb: mb(check.disk.usedKb), totalMb: mb(check.disk.totalKb) },
    ...(check.memory ? { memory: { usedMb: mb(check.memory.totalKb - check.memory.availKb), totalMb: mb(check.memory.totalKb) } } : {}) };
}

/** The largest paths, keeping the most specific: a directory is dropped when
 * one entry inside it accounts for most of it. */
export function parseLargest(output: string, limit = 6): LargestPaths {
  const paths: LargestPaths['paths'] = [];
  const held: LargestPaths['held'] = [];
  for (const line of output.split('\n')) {
    const entry = /^P (\d+) (.+)$/.exec(line);
    if (entry) { paths.push({ kb: Number(entry[1]), path: entry[2]! }); continue; }
    const open = /^H (\d+) (\d+) ([^\t]*)\t(.+)$/.exec(line);
    if (open) held.push({ kb: Number(open[1]), pid: Number(open[2]), command: open[3]!, path: open[4]! });
  }
  const inside = (child: string, parent: string) => child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
  const specific = paths.filter((candidate) => !paths.some((other) => other !== candidate && inside(other.path, candidate.path)
    && other.kb >= candidate.kb * 0.5));
  specific.sort((a, b) => b.kb - a.kb);
  held.sort((a, b) => b.kb - a.kb);
  return { paths: specific.slice(0, limit), held: held.slice(0, 3) };
}

/** Run the guard's check in a world. Undefined when the world cannot answer. */
export async function checkWorldDisk(world: World, timeoutMs = 30_000): Promise<DiskCheck | undefined> {
  const [cmd, ...args] = diskCheckCommand('check', world.handle.root);
  const result = await world.exec(cmd, args, { timeoutMs, cwd: world.handle.root }).catch(() => undefined);
  return result ? parseDiskCheck(result.stdout) : undefined;
}

export async function largestWorldPaths(world: World, timeoutMs = 45_000): Promise<LargestPaths | undefined> {
  const [cmd, ...args] = diskCheckCommand('largest', world.handle.root);
  const result = await world.exec(cmd, args, { timeoutMs, cwd: world.handle.root }).catch(() => undefined);
  return result ? parseLargest(result.stdout) : undefined;
}

export const diskRatio = (disk: DiskSpace) => (disk.totalKb > 0 ? disk.usedKb / disk.totalKb : 0);

/** Whether a failure's moment found the disk full. */
export function diskWasFull(check: DiskCheck | undefined): boolean {
  return !!check && check.availBeforeKb < Math.max(FULL_KB, check.disk.totalKb * 0.002);
}

/** What a process says when it could not write because the disk is full. */
export function isDiskFullMessage(message: string): boolean {
  return /\bENOSPC\b|no space left on device|database or disk is full|disk quota exceeded|\bEDQUOT\b|not enough space on (the )?disk/i.test(message);
}

const gb = (kb: number) => {
  const value = kb / 2 ** 20;
  return value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
};

/** "Disk 20 of 22 GB used (91%)". */
export function describeDisk(disk: DiskSpace): string {
  return `Disk ${gb(disk.usedKb)} of ${gb(disk.totalKb)} GB used (${Math.round(diskRatio(disk) * 100)}%)`;
}

function describeLargest(largest: LargestPaths | undefined): string {
  if (!largest || (!largest.paths.length && !largest.held.length)) return '';
  const lines = [
    ...largest.paths.map((entry) => `- ${gb(entry.kb)} GB ${entry.path}`),
    ...largest.held.map((entry) => `- ${gb(entry.kb)} GB held open by PID ${entry.pid} (${entry.command}): ${entry.path}`),
  ];
  return `\nLargest:\n${lines.join('\n')}`;
}

/** How the agent grows its disk, or that it cannot. */
function growth(disk: DiskSpace, maxDiskGb: number | undefined, taskId: string | undefined): string {
  if (maxDiskGb == null || !taskId) return '';
  if (maxDiskGb <= Math.round(disk.totalKb / 2 ** 20))
    return ' This is the largest disk this account allows: delete what you no longer need (build outputs, caches, old copies), or move large data out of the world.';
  return ` Delete what you no longer need, or grow the disk to ${maxDiskGb} GB: platform_request(POST, "/api/tasks/${taskId}/bigger-disk", {"diskGb": ${maxDiskGb}}), then end your turn with pause(3) without jobs to move to it.`;
}

export type DiskNotice =
  | { kind: 'nearly-full'; disk: DiskSpace; largest?: LargestPaths; maxDiskGb?: number; taskId?: string }
  | { kind: 'ballast-released'; disk: DiskSpace; maxDiskGb?: number; taskId?: string }
  | { kind: 'was-full'; disk: DiskSpace; largest?: LargestPaths; maxDiskGb?: number; taskId?: string };

/** What the agent is told about its disk. */
export function diskNotice(notice: DiskNotice): string {
  const head = `[tavya disk] ${describeDisk(notice.disk)}.`;
  if (notice.kind === 'ballast-released')
    return `${head} The disk was nearly full, so the 512 MB reserve kept for starting you was deleted; it comes back once there is room.`
      + growth(notice.disk, notice.maxDiskGb, notice.taskId);
  if (notice.kind === 'was-full')
    return `${head} Your last turn stopped because the disk was full.` + growth(notice.disk, notice.maxDiskGb, notice.taskId)
      + describeLargest(notice.largest);
  return `${head}` + growth(notice.disk, notice.maxDiskGb, notice.taskId) + describeLargest(notice.largest);
}

/** Why a turn failed with a full disk, for the task's error and its parent. */
export function outOfDiskMessage({ disk, maxDiskGb, taskId, detail }:
  { disk?: DiskSpace; maxDiskGb?: number; taskId: string; detail?: string }): string {
  const total = disk ? Math.round(disk.totalKb / 2 ** 20) : undefined;
  const grow = maxDiskGb != null && total != null && maxDiskGb <= total
    ? ` It already has the largest disk this account allows (${maxDiskGb} GB): free space in its terminal.`
    : ` Bigger disk${maxDiskGb != null ? ` (up to ${maxDiskGb} GB)` : ''} fixes it (POST /api/tasks/${taskId}/bigger-disk).`;
  const cause = detail?.trim() ? ` Last error: ${detail.trim().split('\n')[0]!.slice(0, 240)}` : '';
  return `Out of disk: this task's computer filled ${total != null ? `its ${total} GB disk` : 'its disk'}, so its agent stopped.${grow}${cause}`;
}
