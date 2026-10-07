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

/** Build `name` from `base` with the shape's size unless it already exists. */
export async function buildSizedTemplate(base: string, name: string, shape: MachineShape, options: { apiKey?: string }): Promise<void> {
  const { Template } = await import('e2b');
  const connection = options.apiKey ? { apiKey: options.apiKey } : {};
  if (await Template.exists(name, connection)) return;
  await Template.build(Template().fromTemplate(base), name, { ...connection, ...sizedBuildOptions(shape) });
}
