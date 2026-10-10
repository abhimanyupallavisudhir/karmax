import { describeMachine, type MachineShape } from './computer.js';

/**
 * What one provider account lets a Computer be (wiki features/computers).
 *
 * Hosted worlds run on each organization's own provider key, so the ceiling is
 * that account's tier, not a tavya plan: E2B caps free disk, memory and CPU per
 * team; Daytona caps each sandbox and the organization's running total. Every
 * world provider fills in the same record: what it measured from the provider
 * (`measured`, stored on the connection), what a person entered in Advanced
 * (`configured`), and, failing both, the provider's documented defaults.
 *
 * Disk is always the machine's *total* disk in GB (what `df` shows as Size),
 * whatever the provider counts, so nobody reasons about free versus total.
 */
export interface ComputerLimits {
  /** Most CPUs one machine may have. */
  cpu?: number;
  /** Most memory one machine may have, in MiB. */
  memoryMb?: number;
  /** Largest total disk one machine may have, in GB. */
  diskGb?: number;
  /** The organization's total across all its running machines, when the
   * provider has one (Daytona's tiers). One machine never exceeds it. */
  pool?: { cpu?: number; memoryMb?: number; diskGb?: number };
  /** When the provider was last asked. */
  checkedAt?: number;
}

export type LimitSource = 'provider' | 'configured' | 'default';
export type LimitKey = 'cpu' | 'memoryMb' | 'diskGb';

/** The effective limits, with where each one came from. */
export interface EffectiveComputerLimits extends ComputerLimits {
  source: Partial<Record<LimitKey, LimitSource>>;
}

const KEYS: LimitKey[] = ['cpu', 'memoryMb', 'diskGb'];

interface ProviderFacts {
  label: string;
  /** What a machine gets when nothing else is asked. */
  defaults: Required<MachineShape>;
  /** Documented per-machine maxima, used until the account itself is asked. */
  limits: ComputerLimits;
}

/** One entry per cloud provider. A new provider (Fly.io, Hetzner…) adds its
 * documented facts here and, if its API can tell, a probe in provider-limits.ts. */
const PROVIDERS: Record<string, ProviderFacts> = {
  // Measured 2026-10-10: the default template has 22 GB of disk. Until the
  // account is asked, offer only what every account has.
  e2b: { label: 'E2B', defaults: { cpu: 2, memoryMb: 2048, diskGb: 22 }, limits: { cpu: 8, memoryMb: 8192, diskGb: 22 } },
  // Daytona's documented per-sandbox maximum (raised by its support); karmax
  // starts a default computer on `daytona-medium` (2 vCPU / 4 GiB / 8 GB).
  daytona: { label: 'Daytona', defaults: { cpu: 2, memoryMb: 4096, diskGb: 8 }, limits: { cpu: 4, memoryMb: 8192, diskGb: 10 } },
};

export function providerLabel(provider: string): string {
  return PROVIDERS[provider]?.label ?? provider;
}

/** The machine a provider gives when the Computer asks for nothing more. */
export function providerDefaults(provider: string): Required<MachineShape> | undefined {
  return PROVIDERS[provider] ? { ...PROVIDERS[provider].defaults } : undefined;
}

/** Configured over measured over documented, per limit; a machine is never
 * allowed more than the organization's whole pool. Providers without an
 * account (this machine, Docker) have no limits. */
export function computerLimits(provider: string, measured?: ComputerLimits, configured?: Partial<Record<LimitKey, number>>): EffectiveComputerLimits {
  const facts = PROVIDERS[provider];
  if (!facts) return { source: {} };
  const out: EffectiveComputerLimits = { source: {} };
  for (const key of KEYS) {
    const chosen: [number | undefined, LimitSource][] = [[configured?.[key], 'configured'], [measured?.[key], 'provider'], [facts.limits[key], 'default']];
    let [value, source] = chosen.find(([candidate]) => positive(candidate)) ?? [undefined, 'default'];
    const pool = measured?.pool?.[key];
    if (positive(pool) && (value === undefined || pool < value)) [value, source] = [pool, 'provider'];
    if (value !== undefined) { out[key] = value; out.source[key] = source; }
  }
  if (measured?.pool && Object.keys(measured.pool).length) out.pool = { ...measured.pool };
  if (measured?.checkedAt) out.checkedAt = measured.checkedAt;
  return out;
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const gb = (mb: number) => Number.isInteger(mb / 1024) ? String(mb / 1024) : (mb / 1024).toFixed(1);

/** Refuse a size the account cannot give, before any machine is made. Only the
 * sizes `spec` names are judged. */
export function assertComputerFits(spec: MachineShape, limits: ComputerLimits, provider: string): void {
  const where = `on this ${providerLabel(provider)} account`;
  if (spec.diskGb != null && limits.diskGb != null && spec.diskGb > limits.diskGb)
    throw new Error(`Disk can be at most ${limits.diskGb} GB ${where}`);
  if (spec.memoryMb != null && limits.memoryMb != null && spec.memoryMb > limits.memoryMb)
    throw new Error(`Memory can be at most ${gb(limits.memoryMb)} GB ${where}`);
  if (spec.cpu != null && limits.cpu != null && spec.cpu > limits.cpu)
    throw new Error(`CPU can be at most ${limits.cpu} ${where}`);
}

/** The part of `spec` that fits; what had to give is listed for a warning. */
export function fitComputer(spec: MachineShape, limits: ComputerLimits): { shape: MachineShape; reduced: LimitKey[] } {
  const shape = { ...spec };
  const reduced: LimitKey[] = [];
  for (const key of KEYS) {
    const limit = limits[key];
    if (shape[key] != null && limit != null && shape[key]! > limit) { shape[key] = limit; reduced.push(key); }
  }
  return { shape, reduced };
}

/** "This E2B account allows at most 8 CPU and 29 GB of disk, so this computer
 * has …, not …" — said when a stored size had to be fitted to the account. */
export function limitWarning(provider: string, reduced: LimitKey[], actual: MachineShape, requested: MachineShape): string {
  const parts = reduced.map((key) => key === 'cpu' ? `${actual.cpu} CPU` : key === 'memoryMb' ? `${gb(actual.memoryMb!)} GB of memory` : `${actual.diskGb} GB of disk`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `This ${providerLabel(provider)} account allows at most ${list}, so this computer has ${describeMachine(actual)}, not ${describeMachine(requested)}.`;
}

/**
 * The limit a provider states when it refuses a size, e.g. E2B's "Minimum free
 * disk can't be higher than 25600 MiB" or Daytona's "Disk request 12GB exceeds
 * maximum allowed per sandbox (10GB)".
 */
export function limitFromMessage(message: string): { dimension: 'cpu' | 'memory' | 'disk'; value: number; unit?: 'MiB' | 'GB' } | undefined {
  const match = /(?:can't be higher than|must be at most|maximum allowed per sandbox \()\s*(\d+)\s*(MiB|GB|GiB)?/i.exec(message);
  if (!match) return undefined;
  const head = message.slice(0, match.index).toLowerCase();
  const dimension = /disk/.test(head) ? 'disk' : /memory|ram/.test(head) ? 'memory' : /cpu/.test(head) ? 'cpu' : undefined;
  if (!dimension) return undefined;
  const unit = match[2] ? (match[2].toLowerCase() === 'mib' ? 'MiB' : 'GB') : undefined;
  return { dimension, value: Number(match[1]), ...(unit ? { unit } : {}) };
}
