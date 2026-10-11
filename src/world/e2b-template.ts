import crypto from 'node:crypto';
import { DEFAULT_MACHINE, sameMachine, type MachineShape } from '../domain/computer.js';
import { fitComputer, limitFromMessage, providerDefaults, type ComputerLimits } from '../domain/computer-limits.js';

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

/** Disk on an E2B machine that is not free: the template's files plus the
 * filesystem's own overhead. E2B sizes disk as free space (`minFreeDiskMb`);
 * people see the machine's total, so karmax converts. Measured 2026-10-10 on the
 * default template: at a 25600 MiB free-disk ceiling, `df` shows 29841 MiB in
 * all and 25726 MiB free (and 22517 / 18485 MiB as built). */
export const E2B_USED_DISK_MB = 29_841 - 25_726;
const E2B_DEFAULT_DISK_GB = providerDefaults('e2b')!.diskGb;

/** The total disk (GB) of a machine with `freeMb` of free disk. */
export const e2bTotalDiskGb = (freeMb: number): number => Math.floor((freeMb + E2B_USED_DISK_MB) / 1024);

/** The free disk to ask E2B for so a machine has `totalGb` in all; none when
 * the default template already has that much. */
export function e2bFreeDiskMb(totalGb: number | undefined): number | undefined {
  return totalGb != null && totalGb > E2B_DEFAULT_DISK_GB ? totalGb * 1024 - E2B_USED_DISK_MB : undefined;
}

/** A shape as E2B builds it: a disk the default template already has is no change. */
function e2bShape(shape: MachineShape): MachineShape {
  const { diskGb, ...rest } = shape;
  return e2bFreeDiskMb(diskGb) !== undefined ? shape : rest;
}

/** E2B fixes CPU, memory and disk per template, not per sandbox. A Computer
 * of another size therefore runs on a template derived from its base with that
 * size: built once per organization (each builds with its own key), named
 * deterministically, then reused by every task asking for that size. */
export function needsSizedTemplate(shape: MachineShape): boolean {
  return !sameMachine(e2bShape(shape), DEFAULT_MACHINE);
}

export function sizedTemplateName(base: string, shape: MachineShape): string {
  const sized = e2bShape(shape);
  // `total`: disk names the machine's total since 2026-10-10; templates named
  // for free disk before then are never mistaken for these.
  const key = [base, sized.cpu ?? DEFAULT_MACHINE.cpu, sized.memoryMb ?? DEFAULT_MACHINE.memoryMb, sized.diskGb ?? 0,
    ...(sized.diskGb != null ? ['total'] : [])].join('|');
  return `karmax-sized-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/** The template a world of this shape starts from. */
export function e2bWorldTemplate(base: string, shape: MachineShape): string {
  return needsSizedTemplate(shape) ? sizedTemplateName(base, shape) : base;
}

/** E2B's build options for a shape. */
export function sizedBuildOptions(shape: MachineShape): { cpuCount: number; memoryMB: number; minFreeDiskMb?: number } {
  const minFreeDiskMb = e2bFreeDiskMb(shape.diskGb);
  return {
    cpuCount: shape.cpu ?? DEFAULT_MACHINE.cpu,
    memoryMB: shape.memoryMb ?? DEFAULT_MACHINE.memoryMb,
    ...(minFreeDiskMb !== undefined ? { minFreeDiskMb } : {}),
  };
}

/** What E2B's refusal of a size says the account allows, in karmax's units. */
export function e2bLimitFromError(error: unknown): ComputerLimits | undefined {
  const limit = limitFromMessage(error instanceof Error ? error.message : String(error));
  if (!limit) return undefined;
  if (limit.dimension === 'disk') return { diskGb: limit.unit === 'GB' ? limit.value : e2bTotalDiskGb(limit.value) };
  if (limit.dimension === 'memory') return { memoryMb: limit.unit === 'GB' ? limit.value * 1024 : limit.value };
  return { cpu: limit.value };
}

/** The total disk ceiling (GB) E2B states when it refuses a disk above it. It
 * depends on the account's tier (29 GB total, 25600 MiB free, on one Pro team). */
export function e2bDiskLimitGb(error: unknown): number | undefined {
  return e2bLimitFromError(error)?.diskGb;
}

/** Make a template of `base` at `shape`'s size exist, and say which one. A
 * size above the account's limit is refused at once (HTTP 400, before any
 * build), so the template is made at that limit under the fitted shape's own
 * name, and the limit is returned for the connection to remember. */
export async function buildSizedTemplate(base: string, name: string, shape: MachineShape,
  options: { apiKey?: string }): Promise<{ name: string; diskGb?: number; shape?: MachineShape; limits?: ComputerLimits }> {
  const { Template } = await import('e2b');
  const connection = options.apiKey ? { apiKey: options.apiKey } : {};
  const build = async (target: string, size: MachineShape) => {
    if (!(await Template.exists(target, connection)))
      await Template.build(Template().fromTemplate(base), target, { ...connection, ...sizedBuildOptions(size) });
  };
  let size = shape, target = name;
  const limits: ComputerLimits = {};
  for (let attempt = 0; ; attempt++) {
    try {
      await build(target, size);
      break;
    } catch (error) {
      const learned = e2bLimitFromError(error);
      const fitted = learned && attempt < 3 ? fitComputer(size, learned) : undefined;
      if (!learned || !fitted?.reduced.length) throw error;
      Object.assign(limits, learned);
      size = fitted.shape;
      target = sizedTemplateName(base, size);
    }
  }
  if (target === name) return { name };
  return { name: target, shape: size, limits, ...(size.diskGb !== shape.diskGb && size.diskGb != null ? { diskGb: size.diskGb } : {}) };
}
