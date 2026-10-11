import { limitFromMessage, type ComputerLimits } from '../domain/computer-limits.js';
import { e2bTotalDiskGb } from './e2b-template.js';

/**
 * Ask a provider account what a computer may be, without making one (wiki
 * features/computers). E2B and Daytona both refuse a size above an account's
 * limit at once, with a 400 that states the limit, before building or starting
 * anything; Daytona's API also reports the organization's tier pool. Each probe
 * asks for an impossible size per dimension and reads the refusal. Anything a
 * probe was unexpectedly allowed to create is deleted again.
 */
interface ProbeOptions { fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number }

type Dimension = 'cpu' | 'memory' | 'disk';
const LIMIT_KEY = { cpu: 'cpu', memory: 'memoryMb', disk: 'diskGb' } as const;

/** E2B's control-plane API, as its SDK derives it. */
export function e2bApiUrl(): string {
  return process.env.E2B_API_URL?.replace(/\/$/, '') || `https://api.${process.env.E2B_DOMAIN || 'e2b.app'}`;
}

export async function probeE2BLimits(apiKey: string, options: ProbeOptions & { apiUrl?: string } = {}): Promise<ComputerLimits> {
  const base = options.apiUrl ?? e2bApiUrl();
  const call = request(options, { 'X-API-Key': apiKey });
  // A huge CPU count is refused by the API's schema (at most 32) before the
  // account's own limit is consulted; 32 itself reaches the account's.
  const asks: Array<[Dimension, Record<string, number>]> = [
    ['disk', { cpuCount: 2, memoryMB: 2048, minFreeDiskMb: 100 * 1024 * 1024 }],
    ['memory', { cpuCount: 2, memoryMB: 100 * 1024 * 1024 }],
    ['cpu', { cpuCount: 32, memoryMB: 2048 }],
  ];
  const limits: ComputerLimits = {};
  await Promise.all(asks.map(async ([dimension, size]) => {
    const answer = await call('POST', `${base}/v3/templates`, { name: 'karmax-limits-probe', ...size }).catch(() => undefined);
    if (!answer) return;
    if (answer.ok) {
      // The account allows even this: that is its limit, and the build request goes.
      const id = typeof answer.body?.templateID === 'string' ? answer.body.templateID : undefined;
      if (id) await call('DELETE', `${base}/templates/${encodeURIComponent(id)}`).catch(() => undefined);
      limits[LIMIT_KEY[dimension]] = dimension === 'disk' ? e2bTotalDiskGb(size.minFreeDiskMb!) : dimension === 'memory' ? size.memoryMB : size.cpuCount;
      return;
    }
    const limit = refusal(answer.body, dimension);
    if (limit) limits[LIMIT_KEY[dimension]] = dimension === 'disk'
      ? (limit.unit === 'GB' ? limit.value : e2bTotalDiskGb(limit.value))
      : dimension === 'memory' ? (limit.unit === 'GB' ? limit.value * 1024 : limit.value) : limit.value;
  }));
  return finish(limits, options);
}

export async function probeDaytonaLimits(apiKey: string,
  options: ProbeOptions & { apiUrl?: string; target?: string } = {}): Promise<ComputerLimits> {
  const base = (options.apiUrl ?? 'https://app.daytona.io/api').replace(/\/$/, '');
  const call = request(options, { Authorization: `Bearer ${apiKey}` });
  const limits: ComputerLimits = {};
  const huge = 100_000;
  // An image build, not a snapshot: Daytona takes resources only with one. The
  // per-sandbox check runs before anything is queued.
  const asks: Array<[Dimension, Record<string, number>]> = [
    ['disk', { cpu: 1, memory: 1, disk: huge }], ['memory', { cpu: 1, memory: huge, disk: 3 }], ['cpu', { cpu: huge, memory: 1, disk: 3 }]];
  const pool = (async () => {
    // The organization's tier: CPU, memory (GiB) and disk (GiB) across all its running sandboxes.
    const key = await call('GET', `${base}/api-keys/current`);
    const organizationId = key.ok && typeof key.body?.organizationId === 'string' ? key.body.organizationId : undefined;
    if (!organizationId) return;
    const usage = await call('GET', `${base}/organizations/${encodeURIComponent(organizationId)}/usage`);
    const regions = Array.isArray(usage.body?.regionUsage) ? usage.body.regionUsage as Array<Record<string, unknown>> : [];
    const containers = regions.filter((region) => (region.sandboxClass ?? 'container') === 'container' && Number(region.totalDiskQuota) > 0);
    const region = containers.find((candidate) => candidate.regionId === options.target) ?? containers[0];
    if (!region) return;
    const number = (value: unknown) => (typeof value === 'number' && value > 0 ? value : undefined);
    const own = { cpu: number(region.totalCpuQuota), memoryMb: number(region.totalMemoryQuota) && Number(region.totalMemoryQuota) * 1024,
      diskGb: number(region.totalDiskQuota) };
    limits.pool = Object.fromEntries(Object.entries(own).filter(([, value]) => value));
    // Support can raise an organization's per-sandbox maxima; the API then says so.
    if (number(region.maxCpuPerSandbox)) limits.cpu = Number(region.maxCpuPerSandbox);
    if (number(region.maxMemoryPerSandbox)) limits.memoryMb = Number(region.maxMemoryPerSandbox) * 1024;
    if (number(region.maxDiskPerSandbox)) limits.diskGb = Number(region.maxDiskPerSandbox);
  })().catch(() => undefined);
  const refused: ComputerLimits = {};
  await Promise.all(asks.map(async ([dimension, resources]) => {
    const answer = await call('POST', `${base}/sandbox`, { ...resources, buildInfo: { dockerfileContent: 'FROM alpine:3.20\n' },
      labels: { karmaxProbe: 'limits' }, autoStopInterval: 1, autoDeleteInterval: 0 }).catch(() => undefined);
    if (!answer) return;
    if (answer.ok) {
      const id = typeof answer.body?.id === 'string' ? answer.body.id : undefined;
      if (id) await call('DELETE', `${base}/sandbox/${encodeURIComponent(id)}`).catch(() => undefined);
      return;
    }
    const limit = refusal(answer.body, dimension);
    if (limit) refused[LIMIT_KEY[dimension]] = dimension === 'memory' ? limit.value * 1024 : limit.value;
  }));
  await pool;
  // What a refusal states is what this account enforces, whatever the usage report says.
  Object.assign(limits, refused);
  if (limits.pool && !Object.keys(limits.pool).length) delete limits.pool;
  return finish(limits, options);
}

function refusal(body: any, dimension: Dimension) {
  const limit = typeof body?.message === 'string' ? limitFromMessage(body.message) : undefined;
  return limit?.dimension === dimension ? limit : undefined;
}

function finish(limits: ComputerLimits, options: ProbeOptions): ComputerLimits {
  const order: Array<keyof ComputerLimits> = ['cpu', 'memoryMb', 'diskGb', 'pool'];
  const out = Object.fromEntries(order.filter((key) => limits[key] !== undefined).map((key) => [key, limits[key]])) as ComputerLimits;
  return { ...out, checkedAt: (options.now ?? Date.now)() };
}

function request(options: ProbeOptions, headers: Record<string, string>) {
  const fetcher = options.fetch ?? globalThis.fetch;
  return async (method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; body: any }> => {
    const response = await fetcher(url, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = { message: text }; }
    return { ok: response.ok, status: response.status, body: parsed };
  };
}
