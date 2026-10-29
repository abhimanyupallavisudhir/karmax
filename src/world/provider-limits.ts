import { limitFromMessage, type AccountNetwork, type ComputerLimits } from '../domain/computer-limits.js';
import { e2bTotalDiskGb } from './e2b-template.js';

/**
 * Ask a provider account what a computer may be, without making one (wiki
 * features/computers). E2B and Daytona both refuse a size above an account's
 * limit at once, with a 400 that states the limit, before building or starting
 * anything; Daytona's API also reports the organization's tier pool. Each probe
 * asks for an impossible size per dimension and reads the refusal. Anything a
 * probe was unexpectedly allowed to create is deleted again.
 *
 * Daytona also says what its network gives (`daytonaNetwork`).
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
  const organization = call('GET', `${base}/api-keys/current`).then((key) =>
    key.ok && typeof key.body?.organizationId === 'string' ? key.body.organizationId as string : undefined, () => undefined);
  const network = daytonaNetwork(call, base, organization).catch(() => undefined);
  const pool = (async () => {
    // The organization's tier: CPU, memory (GiB) and disk (GiB) across all its running sandboxes.
    const organizationId = await organization;
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
  const reach = await network;
  if (reach) limits.network = reach;
  if (limits.pool && !Object.keys(limits.pool).length) delete limits.pool;
  return finish(limits, options);
}

const BASIC_ONLY: AccountNetwork = { internet: 'basic', allowlist: false };
const OPEN: AccountNetwork = { internet: 'full', allowlist: true };
/** Daytona's words for a Tier 1–2 organization asked for a network rule. */
const RESTRICTED = /network access is restricted|cannot be overridden/i;

/**
 * What a Daytona organization's network gives (docs network-limits, checked
 * 2026-10-29): on Tier 1–2 "network access is restricted and cannot be
 * overridden at the sandbox level" — only Daytona's essential services, no
 * allowlist or block-all; Tier 3+ the open internet and per-sandbox rules.
 * The organization record says which (`sandboxLimitedNetworkEgress`), where
 * the key may read it (self-hosted Daytona; hosted Daytona answers 401).
 * Otherwise a sandbox is asked for with a domain allowlist and an impossible
 * disk, like the size probes: hosted Daytona refuses the rule for a Tier 1–2
 * organization before it looks at the size (checked live 2026-10-29), so a
 * size refusal means the rule was accepted. Nothing is made; anything that
 * was is deleted. Undefined when Daytona said neither.
 */
async function daytonaNetwork(call: ReturnType<typeof request>, base: string,
  organization: Promise<string | undefined>): Promise<AccountNetwork | undefined> {
  const organizationId = await organization;
  if (organizationId) {
    const record = await call('GET', `${base}/organizations/${encodeURIComponent(organizationId)}`).catch(() => undefined);
    const limited = record?.ok ? record.body?.sandboxLimitedNetworkEgress : undefined;
    if (typeof limited === 'boolean') return limited ? BASIC_ONLY : OPEN;
  }
  const answer = await call('POST', `${base}/sandbox`, { cpu: 1, memory: 1, disk: 100_000, buildInfo: { dockerfileContent: 'FROM alpine:3.20\n' },
    domainAllowList: 'example.com', labels: { karmaxProbe: 'network' }, autoStopInterval: 1, autoDeleteInterval: 0 });
  if (answer.ok) {
    const id = typeof answer.body?.id === 'string' ? answer.body.id : undefined;
    if (id) await call('DELETE', `${base}/sandbox/${encodeURIComponent(id)}`).catch(() => undefined);
    return OPEN;
  }
  const message = typeof answer.body?.message === 'string' ? answer.body.message : '';
  return RESTRICTED.test(message) ? BASIC_ONLY : limitFromMessage(message) ? OPEN : undefined;
}

function refusal(body: any, dimension: Dimension) {
  const limit = typeof body?.message === 'string' ? limitFromMessage(body.message) : undefined;
  return limit?.dimension === dimension ? limit : undefined;
}

function finish(limits: ComputerLimits, options: ProbeOptions): ComputerLimits {
  const order: Array<keyof ComputerLimits> = ['cpu', 'memoryMb', 'diskGb', 'pool', 'network'];
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
