import crypto from 'node:crypto';
import { DEFAULT_MACHINE, E2B_MAX_DISK_GB, sameMachine, type MachineShape } from '../domain/computer.js';

// Public, package-only browser/runtime build; usable with each organization's
// own E2B key. Keep this release default aligned with environments/browser.
export const DEFAULT_E2B_TEMPLATE = 'uj125w982t7wflqad4ig';

/** The template an E2B sandbox starts from when nothing more specific is
 * chosen: the organization's Compute template, else the installation's, else
 * karmax's own. Task worlds and environment builders both start here, so a
 * project environment is built on exactly what its worlds would otherwise run. */
export function e2bTemplate(configured?: string): string {
  return configured?.trim() || process.env.KARMAX_E2B_TEMPLATE?.trim() || DEFAULT_E2B_TEMPLATE;
}

/** E2B fixes CPU, memory and disk per template, not per sandbox. A Computer
 * of another size therefore runs on a template derived from its base with that
 * size: built once per organization (each builds with its own key), named
 * deterministically, then reused by every task asking for that size. */
export function needsSizedTemplate(shape: MachineShape): boolean {
  return !sameMachine(shape, DEFAULT_MACHINE);
}

export function sizedTemplateName(base: string, shape: MachineShape): string {
  const key = [base, shape.cpu ?? DEFAULT_MACHINE.cpu, shape.memoryMb ?? DEFAULT_MACHINE.memoryMb, shape.diskGb ?? 0].join('|');
  return `karmax-sized-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/** The template a world of this shape starts from. */
export function e2bWorldTemplate(base: string, shape: MachineShape): string {
  return needsSizedTemplate(shape) ? sizedTemplateName(base, shape) : base;
}

/** E2B's build options for a shape. Disk is free space after the build, capped
 * at what E2B grows a filesystem to. */
export function sizedBuildOptions(shape: MachineShape): { cpuCount: number; memoryMB: number; minFreeDiskMb?: number } {
  return {
    cpuCount: shape.cpu ?? DEFAULT_MACHINE.cpu,
    memoryMB: shape.memoryMb ?? DEFAULT_MACHINE.memoryMb,
    ...(shape.diskGb != null ? { minFreeDiskMb: Math.min(shape.diskGb, E2B_MAX_DISK_GB) * 1024 } : {}),
  };
}

/** The free-disk ceiling (GiB) E2B states when it refuses a request above it.
 * It depends on the account's tier (25 GiB on one Pro team, 2026-10-07). */
export function e2bDiskLimitGb(error: unknown): number | undefined {
  const match = /free disk can't be higher than (\d+) MiB/i.exec(error instanceof Error ? error.message : String(error));
  return match ? Math.floor(Number(match[1]) / 1024) : undefined;
}

/** Make a template of `base` at `shape`'s size exist, and say which one. A
 * disk above the account's ceiling is refused at once (HTTP 400, before any
 * build), so the template is made at the ceiling under that shape's own name:
 * every later request learns the real disk the same quick way, never by
 * trusting a name that promises more than it holds. */
export async function buildSizedTemplate(base: string, name: string, shape: MachineShape,
  options: { apiKey?: string }): Promise<{ name: string; diskGb?: number }> {
  const { Template } = await import('e2b');
  const connection = options.apiKey ? { apiKey: options.apiKey } : {};
  const build = async (target: string, size: MachineShape) => {
    if (!(await Template.exists(target, connection)))
      await Template.build(Template().fromTemplate(base), target, { ...connection, ...sizedBuildOptions(size) });
  };
  try {
    await build(name, shape);
    return { name };
  } catch (error) {
    const limit = e2bDiskLimitGb(error);
    if (!limit || shape.diskGb == null || limit >= shape.diskGb) throw error;
    const capped = { ...shape, diskGb: limit };
    await build(sizedTemplateName(base, capped), capped);
    return { name: sizedTemplateName(base, capped), diskGb: limit };
  }
}
