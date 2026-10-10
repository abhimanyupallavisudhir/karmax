import type { ProjectConfig } from './types.js';

/**
 * The computer a task runs on — one value, edited as one block wherever an
 * agent is configured (the task form, Task defaults, the Parameters tab).
 *
 * Organization and project defaults stay canonically in the execution policy
 * (`OrganizationExecutionPolicy` / the project's `ProjectConfig` execution keys);
 * a task stores only its own sparse override in `params.computer`. This module
 * converts between the two and layers an override onto an effective config, so
 * every consumer (task input, world creation, restore, the lifecycle sweep)
 * resolves the same computer.
 */
export interface ComputerSpec {
  /** World backend: e2b | daytona (remote), worktree | container (self-hosted). */
  provider?: string;
  cpu?: number;
  memoryMb?: number;
  /** Free space for the task's files, in GiB. Absent ⇒ the provider default. */
  diskGb?: number;
  flavor?: 'headless' | 'desktop';
  /** How long a parked world keeps its sandbox before portable hibernation. */
  hibernateAfterDays?: number;
  network?: NonNullable<ProjectConfig['network']>;
}

/** What a task may still change once its world exists: the machine's size and
 * how long it sleeps. A different provider, experience or network policy is a
 * different computer, not a resize. */
export const IN_FLIGHT_COMPUTER_KEYS = ['cpu', 'memoryMb', 'diskGb', 'hibernateAfterDays'] as const;

/** The size karmax's default E2B template is built with. A shape equal to it
 * needs no sized template; anything else does (see `e2b-template.ts`). */
export const DEFAULT_MACHINE = { cpu: 2, memoryMb: 2048 } as const;

/** E2B grows a template's filesystem by at most this much free space. */
export const E2B_MAX_DISK_GB = 50;

const DAY_MS = 86_400_000;
const LIMITS = {
  cpu: { min: 1, max: 64, integer: true, label: 'CPU' },
  memoryMb: { min: 512, max: 262_144, integer: true, label: 'Memory' },
  diskGb: { min: 1, max: 2_048, integer: true, label: 'Disk' },
  hibernateAfterDays: { min: 0, max: 365, integer: false, label: 'Hibernate after' },
} as const;

/** Validate and canonicalize a computer value from a form, API caller or stored
 * param. Unknown keys are dropped; blank values mean "inherit". */
export function normalizeComputer(raw: unknown): ComputerSpec | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('computer must be an object');
  const value = raw as Record<string, unknown>;
  const out: ComputerSpec = {};
  if (value.provider != null && value.provider !== '') {
    if (typeof value.provider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.provider))
      throw new Error('computer provider is invalid');
    out.provider = value.provider;
  }
  for (const [key, limit] of Object.entries(LIMITS) as Array<[keyof typeof LIMITS, (typeof LIMITS)[keyof typeof LIMITS]]>) {
    const field = value[key];
    if (field == null || field === '') continue;
    const number = Number(field);
    if (!Number.isFinite(number) || number < limit.min || number > limit.max || (limit.integer && !Number.isInteger(number)))
      throw new Error(`${limit.label} must be ${limit.integer ? 'a whole number ' : ''}from ${limit.min} to ${limit.max}`);
    out[key] = number;
  }
  if (value.flavor != null && value.flavor !== '') {
    if (value.flavor !== 'headless' && value.flavor !== 'desktop') throw new Error('experience must be headless or desktop');
    out.flavor = value.flavor;
  }
  if (value.network != null) {
    if (typeof value.network !== 'object' || Array.isArray(value.network)) throw new Error('network must be an object');
    const network = value.network as Record<string, unknown>;
    const list = (entry: unknown) => Array.isArray(entry) ? entry.map((item) => String(item).trim()).filter(Boolean) : [];
    out.network = network.unrestricted === false
      ? { unrestricted: false, allowDomains: list(network.allowDomains), allowCidrs: list(network.allowCidrs) }
      : { unrestricted: true };
  }
  return Object.keys(out).length ? out : undefined;
}

/** The computer an execution config describes (sparse: only what it sets). */
export function computerOf(config: Partial<ProjectConfig> | undefined): ComputerSpec {
  const out: ComputerSpec = {};
  if (!config) return out;
  if (config.worldProvider) out.provider = config.worldProvider;
  if (config.resources?.cpu != null) out.cpu = config.resources.cpu;
  if (config.resources?.memoryMb != null) out.memoryMb = config.resources.memoryMb;
  if (config.resources?.diskGb != null) out.diskGb = config.resources.diskGb;
  if (config.environment?.flavor) out.flavor = config.environment.flavor;
  if (config.hibernateAfterMs != null) out.hibernateAfterDays = config.hibernateAfterMs / DAY_MS;
  if (config.network) out.network = { ...config.network };
  return out;
}

/** The execution-config keys a sparse computer sets — the shape a project
 * override or an organization policy patch is stored in. */
export function computerConfig(spec: ComputerSpec | undefined): Partial<ProjectConfig> {
  const out: Partial<ProjectConfig> = {};
  if (!spec) return out;
  if (spec.provider) out.worldProvider = spec.provider;
  const resources = {
    ...(spec.cpu != null ? { cpu: spec.cpu } : {}),
    ...(spec.memoryMb != null ? { memoryMb: spec.memoryMb } : {}),
    ...(spec.diskGb != null ? { diskGb: spec.diskGb } : {}),
  };
  if (Object.keys(resources).length) out.resources = resources;
  if (spec.flavor) out.environment = { flavor: spec.flavor };
  if (spec.hibernateAfterDays != null) out.hibernateAfterMs = Math.round(spec.hibernateAfterDays * DAY_MS);
  if (spec.network) out.network = { ...spec.network };
  return out;
}

/** Layer a task's sparse computer onto its project's effective config. Nested
 * resource and environment keys merge; the network policy is atomic. */
export function applyComputer<T extends Partial<ProjectConfig>>(config: T, spec: ComputerSpec | undefined): T {
  const patch = computerConfig(spec);
  if (!Object.keys(patch).length) return config;
  return {
    ...config,
    ...patch,
    ...(patch.resources ? { resources: { ...config.resources, ...patch.resources } } : {}),
    ...(patch.environment ? { environment: { ...config.environment, ...patch.environment } } : {}),
  };
}

/** The physical size of a machine, as recorded on a world when it is created. */
export interface MachineShape { cpu?: number; memoryMb?: number; diskGb?: number }

export function machineShape(config: Partial<ProjectConfig> | undefined): MachineShape {
  const resources = config?.resources ?? {};
  return {
    ...(resources.cpu != null ? { cpu: resources.cpu } : {}),
    ...(resources.memoryMb != null ? { memoryMb: resources.memoryMb } : {}),
    ...(resources.diskGb != null ? { diskGb: resources.diskGb } : {}),
  };
}

export function sameMachine(a: MachineShape | undefined, b: MachineShape | undefined): boolean {
  return (a?.cpu ?? DEFAULT_MACHINE.cpu) === (b?.cpu ?? DEFAULT_MACHINE.cpu)
    && (a?.memoryMb ?? DEFAULT_MACHINE.memoryMb) === (b?.memoryMb ?? DEFAULT_MACHINE.memoryMb)
    && (a?.diskGb ?? null) === (b?.diskGb ?? null);
}

/** "4 CPU · 8 GB · 50 GB disk" — how people read a machine. */
export function describeMachine(shape: MachineShape): string {
  const gb = (mb: number) => Number.isInteger(mb / 1024) ? String(mb / 1024) : (mb / 1024).toFixed(1);
  return [
    `${shape.cpu ?? DEFAULT_MACHINE.cpu} CPU`,
    `${gb(shape.memoryMb ?? DEFAULT_MACHINE.memoryMb)} GB`,
    ...(shape.diskGb != null ? [`${shape.diskGb} GB disk`] : []),
  ].join(' · ');
}

/** Reject an in-flight edit that would change more than the machine's size. */
export function assertInFlightComputerEdit(current: ComputerSpec, next: ComputerSpec): void {
  for (const key of ['provider', 'flavor'] as const) {
    if (next[key] !== undefined && next[key] !== current[key])
      throw new Error(`a running task's ${key === 'provider' ? 'computer provider' : 'experience'} can't change — only its CPU, memory, disk and hibernation`);
  }
  if (next.network !== undefined && JSON.stringify(next.network) !== JSON.stringify(current.network ?? { unrestricted: true }))
    throw new Error('a running task\'s outbound network can\'t change — only its CPU, memory, disk and hibernation');
}

/** Whether a task's Computer may still be resized. The Computer is the
 * platform's, not the workflow's: no workflow reads it, so every task may resize
 * until it ends, whatever workflow version started it — including tasks started
 * before the Computer existed, whose workflow input has no edit window for it
 * (pramana#3 ran out of disk with the form greyed out). A task with no view yet
 * hasn't started. */
export function computerResizable(view: { status?: string; pointOfNoReturnPassed?: boolean } | undefined): boolean {
  return !view || (!['done', 'cancelled', 'failed'].includes(view.status ?? '') && !view.pointOfNoReturnPassed);
}
