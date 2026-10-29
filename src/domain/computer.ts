import type { ProjectConfig } from './types.js';
import { measuresNetwork, providerFeatures, providerLabel, type NetworkChoice } from './computer-limits.js';

export type { NetworkChoice };

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
  /** World backend: `any` (tavya chooses: src/world/compute-router.ts), a
   * cloud provider (e2b, daytona, fly, hetzner, aws, gcp) or, self-hosted,
   * worktree | container. */
  provider?: string;
  cpu?: number;
  memoryMb?: number;
  /** The machine's total disk, in GB. Absent ⇒ the provider default. */
  diskGb?: number;
  flavor?: 'headless' | 'desktop';
  /** How long a parked world keeps its sandbox before portable hibernation. */
  hibernateAfterDays?: number;
  network?: NonNullable<ProjectConfig['network']>;
  /** Where "Any" may run it; a named provider runs where its account is. */
  region?: ComputeRegion;
}

/**
 * The outbound network a Computer asks for (wiki features/computers):
 * - `full` — the open internet (`{unrestricted: true}`, and no value at all);
 * - `basic` — package registries, Git hosts, AI and cloud APIs are enough
 *   (`{basic: true}`), so "Any" may also pick an account that reaches only
 *   those (Daytona Tier 1–2); the machine itself is not restricted by tavya;
 * - `allowlist` — only the listed domains and CIDRs (`{unrestricted: false, …}`).
 * Values stored before Basic existed keep their meaning.
 */
export const NETWORK_CHOICES = ['full', 'basic', 'allowlist'] as const;
const NETWORK_VALUES: Record<NetworkChoice, NonNullable<ProjectConfig['network']>> = {
  full: { unrestricted: true }, basic: { basic: true }, allowlist: { unrestricted: false, allowDomains: [], allowCidrs: [] } };
export function networkChoice(network: { unrestricted?: boolean; basic?: boolean } | null | undefined): NetworkChoice {
  return network?.unrestricted === false ? 'allowlist' : network?.basic === true ? 'basic' : 'full';
}

/** A sparse change to a stored network policy (set_execution_policy): a
 * named choice replaces it, keeping an allowlist's lists; the legacy
 * `unrestricted` flag sets Full or the allowlist; lists change only themselves. */
export function changeNetwork(base: ProjectConfig['network'] | undefined, change: { choice?: NetworkChoice; unrestricted?: boolean;
  allowDomains?: string[]; allowCidrs?: string[] }): NonNullable<ProjectConfig['network']> {
  let network: NonNullable<ProjectConfig['network']> = { ...base };
  if (change.choice) network = change.choice === 'allowlist'
    ? { unrestricted: false, allowDomains: base?.allowDomains ?? [], allowCidrs: base?.allowCidrs ?? [] } : { ...NETWORK_VALUES[change.choice] };
  if (change.unrestricted !== undefined) { delete network.basic; network.unrestricted = change.unrestricted; }
  if (change.allowDomains !== undefined) network.allowDomains = change.allowDomains;
  if (change.allowCidrs !== undefined) network.allowCidrs = change.allowCidrs;
  return network;
}

/** The provider value that asks tavya to choose (wiki features/compute-routing). */
export const ANY_PROVIDER = 'any';
export function isAnyProvider(provider: string | undefined): boolean {
  return provider === ANY_PROVIDER;
}

/** Where a computer runs, as people ask for it (data residency). */
export const COMPUTE_REGIONS = ['eu', 'us'] as const;
export type ComputeRegion = (typeof COMPUTE_REGIONS)[number];

/** Cloud providers an organization can connect for task worlds (BYOK). */
export const CLOUD_WORLD_PROVIDERS = ['e2b', 'daytona', 'fly', 'hetzner', 'aws', 'gcp'] as const;
export type CloudWorldProvider = (typeof CLOUD_WORLD_PROVIDERS)[number];
/** A cloud provider, or "Any" (which picks one). */
export function isCloudProvider(provider: string | undefined): boolean {
  return isAnyProvider(provider) || (CLOUD_WORLD_PROVIDERS as readonly string[]).includes(provider ?? '');
}

/** The cloud providers whose worlds are VMs reached over SSH (src/world/vm/):
 * the disk is a volume that keeps everything and grows in place. */
export const VM_WORLD_PROVIDERS = ['fly', 'hetzner', 'aws', 'gcp'] as const;
export function isVmWorldProvider(provider: string | undefined): boolean {
  return (VM_WORLD_PROVIDERS as readonly string[]).includes(provider ?? '');
}

/** What a task may still change once its world exists: the machine's size and
 * how long it sleeps. A different provider, experience or network policy is a
 * different computer, not a resize. */
export const IN_FLIGHT_COMPUTER_KEYS = ['cpu', 'memoryMb', 'diskGb', 'hibernateAfterDays'] as const;

/** The size karmax's default E2B template is built with. A shape equal to it
 * needs no sized template; anything else does (see `e2b-template.ts`). */
export const DEFAULT_MACHINE = { cpu: 2, memoryMb: 2048 } as const;

const DAY_MS = 86_400_000;
const LIMITS = {
  cpu: { min: 1, max: 64, integer: true, label: 'CPU' },
  memoryMb: { min: 512, max: 262_144, integer: true, label: 'Memory' },
  diskGb: { min: 1, max: 10_240, integer: true, label: 'Disk' },
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
  if (value.network != null && value.network !== '') {
    // The API, MCP and CLI may name the choice; the form sends the stored shape.
    const named = typeof value.network === 'string';
    if (named && !(NETWORK_CHOICES as readonly unknown[]).includes(value.network)) throw new Error('network must be full, basic or allowlist');
    if (!named && (typeof value.network !== 'object' || Array.isArray(value.network))) throw new Error('network must be an object');
    const network = (named ? NETWORK_VALUES[value.network as NetworkChoice] : value.network) as Record<string, unknown>;
    const list = (entry: unknown) => Array.isArray(entry) ? entry.map((item) => String(item).trim()).filter(Boolean) : [];
    const choice = networkChoice(network);
    out.network = choice === 'allowlist'
      ? { unrestricted: false, allowDomains: list(network.allowDomains), allowCidrs: list(network.allowCidrs) }
      : { ...NETWORK_VALUES[choice] };
  }
  if (value.region != null && value.region !== '') {
    if (!(COMPUTE_REGIONS as readonly unknown[]).includes(value.region)) throw new Error(`region must be ${COMPUTE_REGIONS.join(' or ')}`);
    out.region = value.region as ComputeRegion;
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
  if (config.region) out.region = config.region;
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
  if (spec.region) out.region = spec.region;
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

const LOCAL_PROVIDERS = new Set(['worktree', 'container', 'memory']);

/** Reject an in-flight edit that would change more than the machine's size and
 * where it runs. A running task may move to another cloud provider (it moves at
 * its next idle park, through its checkpoint), unless that provider lacks
 * something the task relies on; its experience and network never change. */
export function assertInFlightComputerEdit(current: ComputerSpec, next: ComputerSpec): void {
  if (next.flavor !== undefined && next.flavor !== current.flavor)
    throw new Error('a running task\'s experience can\'t change — only its provider, CPU, memory, disk and hibernation');
  if (next.network !== undefined && JSON.stringify(normalizeComputer({ network: next.network })?.network)
    !== JSON.stringify(normalizeComputer({ network: current.network ?? { unrestricted: true } })?.network))
    throw new Error('a running task\'s outbound network can\'t change — only its provider, CPU, memory, disk and hibernation');
  // "Any" never moves a world that exists: it routes the next new one.
  if (next.provider === undefined || next.provider === current.provider || isAnyProvider(next.provider)) return;
  if (LOCAL_PROVIDERS.has(next.provider) || (current.provider && LOCAL_PROVIDERS.has(current.provider)))
    throw new Error('a running task moves only between cloud providers');
  const features = providerFeatures(next.provider);
  if (current.flavor === 'desktop' && !features.desktop)
    throw new Error(`${providerLabel(next.provider)} has no desktop, which this task uses`);
  // A provider that measures its network per account (Daytona) is judged on
  // that account when the edit is saved (assertFits), not on documented facts.
  if (networkChoice(current.network) === 'allowlist' && !features.allowlist && !measuresNetwork(next.provider))
    throw new Error(`${providerLabel(next.provider)} has no outbound allowlist, which this task uses`);
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
