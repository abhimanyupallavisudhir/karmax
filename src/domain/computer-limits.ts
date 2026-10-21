import { describeMachine, type ComputeRegion, type MachineShape } from './computer.js';

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
  /** What else a Computer may ask of it; the form shows only these. */
  features: ComputerFeatures;
  /** List price in USD, for ranking where "Any" runs a task (compute-router.ts):
   * per vCPU-hour, per GB of memory per hour, per GB of disk per month, and
   * per running hour whatever the size (a public IPv4 address). */
  price: { cpuHour: number; gbHour: number; diskGbMonth: number; hour?: number };
  /** Typical seconds from a parked world to a working one (measured, wiki
   * features/vm-worlds); breaks a tie in price. */
  wakeSeconds: number;
  /** Where its machines run, from the account's region setting. */
  region(config: { region?: string; target?: string }): ComputeRegion | undefined;
}

/** Options beyond size that a provider may or may not offer. */
export interface ComputerFeatures {
  /** A screen people can watch and take over (`flavor: 'desktop'`). */
  desktop: boolean;
  /** Outbound network limited to an allowlist (`network.unrestricted: false`). */
  allowlist: boolean;
  /** Project setup baked into an image or snapshot (Project Settings →
   * Environment); without it setup runs live in every new world. */
  environmentBuilds: boolean;
}

const ALL_FEATURES: ComputerFeatures = { desktop: true, allowlist: true, environmentBuilds: true };
const VM_FEATURES: ComputerFeatures = { desktop: false, allowlist: false, environmentBuilds: false };

/** One entry per cloud provider. A new provider (Fly.io, Hetzner…) adds its
 * documented facts here and, if its API can tell, a probe in provider-limits.ts. */
// Prices are the providers' public list prices (2026-10, USD; EUR at 1.17),
// reduced to a line per resource so any size can be compared. They rank
// candidates only: usage is billed from each provider's own records.
const PROVIDERS: Record<string, ProviderFacts> = {
  // Measured 2026-10-10: the default template has 22 GB of disk. Until the
  // account is asked, offer only what every account has. E2B's cloud runs in
  // the US; its disk costs nothing extra.
  e2b: { label: 'E2B', defaults: { cpu: 2, memoryMb: 2048, diskGb: 22 }, limits: { cpu: 8, memoryMb: 8192, diskGb: 22 }, features: ALL_FEATURES,
    price: { cpuHour: 0.0504, gbHour: 0.0162, diskGbMonth: 0 }, wakeSeconds: 2, region: () => 'us' },
  // Daytona's documented per-sandbox maximum (raised by its support); karmax
  // starts a default computer on `daytona-medium` (2 vCPU / 4 GiB / 8 GB).
  daytona: { label: 'Daytona', defaults: { cpu: 2, memoryMb: 4096, diskGb: 8 }, limits: { cpu: 4, memoryMb: 8192, diskGb: 10 }, features: ALL_FEATURES,
    price: { cpuHour: 0.0504, gbHour: 0.0162, diskGbMonth: 0.08 }, wakeSeconds: 3,
    region: (config) => (config.target === 'eu' ? 'eu' : 'us') },
  // VM worlds (wiki features/vm-worlds): disk is the volume mounted as the
  // home, the size `df ~` shows. Fly: a volume holds at most 500 GB, the
  // largest machine is performance-16x with 128 GB; no account API says more.
  fly: { label: 'Fly.io', defaults: { cpu: 2, memoryMb: 2048, diskGb: 20 }, limits: { cpu: 16, memoryMb: 131_072, diskGb: 500 }, features: VM_FEATURES,
    price: { cpuHour: 0.0037, gbHour: 0.01, diskGbMonth: 0.15 }, wakeSeconds: 5, region: (config) => flyRegion(config.region ?? 'fra') },
  // Hetzner: volumes up to 10 TB; the largest machine is whatever server type
  // the location offers (the connection test asks), else the shared CPX51.
  // A default computer gets the cheapest type covering it (CPX11, 2 CPU / 2 GB, 2026-10-10).
  hetzner: { label: 'Hetzner', defaults: { cpu: 2, memoryMb: 2048, diskGb: 20 }, limits: { cpu: 16, memoryMb: 32_768, diskGb: 10_240 }, features: VM_FEATURES,
    price: { cpuHour: 0.0035, gbHour: 0.0012, diskGbMonth: 0.09, hour: 0.0012 }, wakeSeconds: 35,
    region: (config) => (/^(?:ash|hil)/.test(config.region ?? '') ? 'us' : /^(?:fsn|nbg|hel)/.test(config.region ?? 'fsn1') ? 'eu' : undefined) },
  // AWS: an EBS gp3 volume holds 16 TiB; the largest machine is the largest
  // instance of karmax's families in the region (the connection test asks).
  // A default computer is the cheapest covering it (c7i-flex.large, 2 CPU / 4 GB).
  aws: { label: 'AWS', defaults: { cpu: 2, memoryMb: 2048, diskGb: 20 }, limits: { cpu: 64, memoryMb: 262_144, diskGb: 16_384 }, features: VM_FEATURES,
    price: { cpuHour: 0.0336, gbHour: 0.0045, diskGbMonth: 0.08, hour: 0.005 }, wakeSeconds: 30,
    region: (config) => cloudRegion(config.region ?? 'eu-central-1', 'eu-', 'us-') },
  // Google Cloud: E2 custom machines of exactly the size asked (2–32 CPUs, up
  // to 128 GB), within the region's CPU quota; a pd-balanced disk holds 64 TB.
  gcp: { label: 'Google Cloud', defaults: { cpu: 2, memoryMb: 2048, diskGb: 20 }, limits: { cpu: 32, memoryMb: 131_072, diskGb: 65_536 }, features: VM_FEATURES,
    price: { cpuHour: 0.0218, gbHour: 0.0029, diskGbMonth: 0.1, hour: 0.005 }, wakeSeconds: 50,
    region: (config) => cloudRegion(config.region ?? 'europe-west3-a', 'europe-', 'us-') },
};

function cloudRegion(code: string, eu: string, us: string): ComputeRegion | undefined {
  return code.startsWith(eu) ? 'eu' : code.startsWith(us) ? 'us' : undefined;
}

const FLY_EU = new Set(['ams', 'arn', 'cdg', 'fra', 'lhr', 'mad', 'otp', 'waw']);
const FLY_US = new Set(['atl', 'bos', 'den', 'dfw', 'ewr', 'iad', 'lax', 'mia', 'ord', 'phx', 'sea', 'sjc']);
function flyRegion(code: string): ComputeRegion | undefined {
  return FLY_EU.has(code) ? 'eu' : FLY_US.has(code) ? 'us' : undefined;
}

/** Every provider with an account record, in a fixed order. */
export function cloudProviders(): string[] {
  return Object.keys(PROVIDERS);
}

/** What a machine of `shape` costs per hour on `provider` at list price, in USD
 * micros; undefined for a provider without a record (this machine). A size it
 * leaves out is the provider's default. */
export function listPriceMicrosPerHour(provider: string, shape: MachineShape): number | undefined {
  const facts = PROVIDERS[provider];
  if (!facts) return undefined;
  const cpu = shape.cpu ?? facts.defaults.cpu;
  const gb = (shape.memoryMb ?? facts.defaults.memoryMb) / 1024;
  const disk = shape.diskGb ?? facts.defaults.diskGb;
  const { price } = facts;
  return Math.round((cpu * price.cpuHour + gb * price.gbHour + disk * price.diskGbMonth / 730 + (price.hour ?? 0)) * 1e6);
}

/** Typical wake time, in seconds. */
export function providerWakeSeconds(provider: string): number {
  return PROVIDERS[provider]?.wakeSeconds ?? 0;
}

/** Where an account's machines run (EU or US), when known. */
export function providerRegion(provider: string, config: { region?: string; target?: string } = {}): ComputeRegion | undefined {
  return PROVIDERS[provider]?.region(config);
}

export function providerLabel(provider: string): string {
  return PROVIDERS[provider]?.label ?? provider;
}

/** What else a Computer on `provider` may ask for. A provider without a
 * record (this machine, Docker) offers everything. */
export function providerFeatures(provider: string): ComputerFeatures {
  return { ...(PROVIDERS[provider]?.features ?? ALL_FEATURES) };
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
