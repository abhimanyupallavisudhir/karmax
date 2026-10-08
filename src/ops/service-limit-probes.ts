/**
 * One probe per operator account (wiki features/service-limits). Each takes
 * its credential and a `fetch`, reads the provider's usage API, and returns
 * readings keyed by meter id. Tests stub `fetch` with recorded responses.
 */
import type { GitConnection } from '../domain/types.js';
import type { WorkerHeap } from '../temporal/worker-process.js';

export interface ProbeReading {
  used: number;
  /** A limit the provider reported (an entered limit still wins). */
  limit?: number;
  label?: string;
  unit?: 'count' | 'bytes' | 'hours';
  source?: 'api' | 'count' | 'host';
  detail?: string;
}
export interface ProbeResult { readings: Record<string, ProbeReading>; plan?: string }

/** The account isn't connected here: shown as such, never an alert. */
export class NotConnected extends Error {
  constructor() { super('not connected'); }
}

const TIMEOUT_MS = 20_000;
const GIB = 1024 ** 3;

async function json(response: Response, provider: string): Promise<any> {
  if (response.status === 401 || response.status === 403)
    throw new Error(`${provider} refused the credential (${response.status})`);
  if (!response.ok) throw new Error(`${provider} answered ${response.status}`);
  try { return await response.json(); } catch { throw new Error(`${provider} sent an unreadable answer`); }
}

// ─── Cloudflare (GraphQL Analytics; the token needs Account Analytics: Read) ───

const CLOUDFLARE_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
/** R2 operation classes (developers.cloudflare.com/r2/pricing). Deletes are free. */
const R2_CLASS_A = new Set(['ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload',
  'CreateMultipartUpload', 'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy',
  'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration']);
const R2_CLASS_B = new Set(['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption',
  'GetBucketLocation', 'GetBucketCors', 'GetBucketLifecycleConfiguration']);

async function cloudflareQuery(input: { fetch: typeof fetch; token: string; accountId: string }, query: string,
  variables: Record<string, string>): Promise<any> {
  const body = await json(await input.fetch(CLOUDFLARE_GRAPHQL, {
    method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { account: input.accountId, ...variables } }),
  }), 'Cloudflare');
  const error = body?.errors?.[0]?.message;
  if (error) throw new Error(`Cloudflare: ${String(error).slice(0, 160)}`);
  const account = body?.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('Cloudflare returned no data for the account');
  return account;
}

const utcDay = (now: number) => `${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`;
const utcMonth = (now: number) => `${new Date(now).toISOString().slice(0, 7)}-01T00:00:00Z`;

/** Requests to every Worker on the account since midnight UTC: the Free
 * plan's 100,000 a day is per account. */
export async function cloudflareWorkersUsage(input: { fetch: typeof fetch; token: string; accountId: string; now: number }): Promise<ProbeResult> {
  const account = await cloudflareQuery(input, `query ($account: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { requests } dimensions { scriptName } }
  } }
}`, { start: utcDay(input.now), end: new Date(input.now).toISOString() });
  const rows: any[] = account.workersInvocationsAdaptive ?? [];
  const byScript = new Map<string, number>();
  for (const row of rows) {
    const name = String(row?.dimensions?.scriptName ?? 'other');
    byScript.set(name, (byScript.get(name) ?? 0) + Number(row?.sum?.requests ?? 0));
  }
  const used = [...byScript.values()].reduce((sum, value) => sum + value, 0);
  const detail = [...byScript].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => `${name} ${n.toLocaleString('en-US')}`).join(' · ');
  return { readings: { 'cloudflare-workers.requests': { used, ...(detail ? { detail } : {}) } } };
}

/** R2 operations this month by class, and bytes stored now (every bucket). */
export async function cloudflareR2Usage(input: { fetch: typeof fetch; token: string; accountId: string; now: number }): Promise<ProbeResult> {
  const account = await cloudflareQuery(input, `query ($account: string!, $month: Time!, $since: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    operations: r2OperationsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $month, datetime_leq: $end }) { sum { requests } dimensions { actionType } }
    storage: r2StorageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $end }) { max { payloadSize metadataSize } dimensions { bucketName } }
  } }
}`, { month: utcMonth(input.now), since: new Date(input.now - 86_400_000).toISOString(), end: new Date(input.now).toISOString() });
  let classA = 0, classB = 0;
  for (const row of account.operations ?? []) {
    const action = String(row?.dimensions?.actionType ?? '');
    const requests = Number(row?.sum?.requests ?? 0);
    if (R2_CLASS_A.has(action)) classA += requests;
    else if (R2_CLASS_B.has(action)) classB += requests;
  }
  const buckets = new Map<string, number>();
  for (const row of account.storage ?? []) {
    const name = String(row?.dimensions?.bucketName ?? '');
    const bytes = Number(row?.max?.payloadSize ?? 0) + Number(row?.max?.metadataSize ?? 0);
    buckets.set(name, Math.max(buckets.get(name) ?? 0, bytes));
  }
  return { readings: {
    'cloudflare-r2.class-a': { used: classA },
    'cloudflare-r2.class-b': { used: classB },
    'cloudflare-r2.storage': { used: [...buckets.values()].reduce((sum, value) => sum + value, 0) },
  } };
}

// ─── Composio: the project key lists connected accounts; tool calls are ours ───

export async function composioUsage(input: { fetch: typeof fetch; apiKey: string; toolCalls: number; base?: string }): Promise<ProbeResult> {
  const base = input.base ?? 'https://backend.composio.dev';
  let active = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const url = new URL('/api/v3.1/connected_accounts', base);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const body = await json(await input.fetch(url, { headers: { 'x-api-key': input.apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) }), 'Composio');
    for (const item of body?.items ?? []) if (item?.status === 'ACTIVE' && !item?.is_disabled) active++;
    cursor = body?.next_cursor || undefined;
    if (!cursor) break;
  }
  return { readings: {
    'composio.tool-calls': { used: input.toolCalls },
    'composio.accounts': { used: active },
  } };
}

// ─── E2B: running sandboxes on the account; hours are metered by tavya ────────

export async function e2bUsage(input: { fetch: typeof fetch; apiKey: string; hours: number; base?: string }): Promise<ProbeResult> {
  const base = input.base ?? 'https://api.e2b.app';
  let running = 0;
  let next: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL('/v2/sandboxes', base);
    url.searchParams.set('state', 'running');
    url.searchParams.set('limit', '100');
    if (next) url.searchParams.set('nextToken', next);
    const response = await input.fetch(url, { headers: { 'X-API-Key': input.apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await json(response, 'E2B');
    // E2B counts every running sandbox before paginating.
    const total = Number(response.headers.get('x-total-running') ?? Number.NaN);
    if (Number.isFinite(total)) { running = total; break; }
    running += Array.isArray(body) ? body.length : 0;
    next = response.headers.get('x-next-token') || undefined;
    if (!next) break;
  }
  return { readings: {
    'e2b.sandboxes': { used: running },
    'e2b.hours': { used: Math.round(input.hours * 10) / 10 },
  } };
}

// ─── Daytona: the organization's usage against its tier's quotas ─────────────

const DAYTONA_TIERS: Record<number, string> = { 10: 'Tier 1', 100: 'Tier 2', 250: 'Tier 3', 500: 'Tier 4' };

export async function daytonaUsage(input: { fetch: typeof fetch; apiKey: string; apiUrl?: string }): Promise<ProbeResult> {
  const base = (input.apiUrl || 'https://app.daytona.io/api').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${input.apiKey}` };
  const key = await json(await input.fetch(`${base}/api-keys/current`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }), 'Daytona');
  const organizationId = typeof key?.organizationId === 'string' ? key.organizationId : undefined;
  if (!organizationId) throw new Error('Daytona did not say which organization the key belongs to');
  const usage = await json(await input.fetch(`${base}/organizations/${encodeURIComponent(organizationId)}/usage`,
    { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }), 'Daytona');
  const total = { cpu: [0, 0], memory: [0, 0], disk: [0, 0] } as Record<'cpu' | 'memory' | 'disk', [number, number]>;
  for (const region of usage?.regionUsage ?? []) {
    total.cpu[0] += Number(region?.currentCpuUsage ?? 0); total.cpu[1] += Number(region?.totalCpuQuota ?? 0);
    total.memory[0] += Number(region?.currentMemoryUsage ?? 0); total.memory[1] += Number(region?.totalMemoryQuota ?? 0);
    total.disk[0] += Number(region?.currentDiskUsage ?? 0); total.disk[1] += Number(region?.totalDiskQuota ?? 0);
  }
  if (!total.cpu[1] && !total.memory[1] && !total.disk[1]) throw new Error('Daytona reported no quotas');
  const ratio = (pair: [number, number]) => pair[1] > 0 ? pair[0] / pair[1] : 0;
  const tightest = (['cpu', 'memory', 'disk'] as const).reduce((a, b) => ratio(total[b]) > ratio(total[a]) ? b : a);
  const [used, limit] = total[tightest];
  // Daytona states memory and disk in GiB.
  const reading: ProbeReading = tightest === 'cpu' ? { used, limit, label: 'vCPUs in use', unit: 'count' }
    : { used: used * GIB, limit: limit * GIB, label: tightest === 'memory' ? 'Memory in use' : 'Disk in use', unit: 'bytes' };
  return {
    readings: { 'daytona.capacity': { ...reading,
      detail: `${total.cpu[0]} of ${total.cpu[1]} vCPUs · ${total.memory[0]} of ${total.memory[1]} GiB memory · ${total.disk[0]} of ${total.disk[1]} GiB disk` } },
    ...(DAYTONA_TIERS[total.cpu[1]] ? { plan: DAYTONA_TIERS[total.cpu[1]] } : {}),
  };
}

// ─── AgentMail: inboxes on the account; emails are counted as they arrive ────

export async function agentMailUsage(input: { fetch: typeof fetch; apiKey: string; received: number; base?: string }): Promise<ProbeResult> {
  const base = (input.base || 'https://api.agentmail.to/v0').replace(/\/+$/, '');
  const body = await json(await input.fetch(`${base}/inboxes?limit=1`,
    { headers: { authorization: `Bearer ${input.apiKey}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }), 'AgentMail');
  const count = Number(body?.count);
  if (!Number.isFinite(count)) throw new Error('AgentMail did not report its inboxes');
  return { readings: {
    'agentmail.inboxes': { used: count },
    'agentmail.messages': { used: input.received },
  } };
}

// ─── GitHub App: the busiest installation's hourly REST limit ────────────────

export async function githubUsage(input: { connections: GitConnection[];
  rateLimit: (connection: GitConnection) => Promise<{ limit: number; remaining: number; resetAt: number }> }): Promise<ProbeResult> {
  if (!input.connections.length) throw new NotConnected();
  const results = await Promise.allSettled(input.connections.map(async (connection) => ({ connection, ...(await input.rateLimit(connection)) })));
  const read = results.flatMap((result) => result.status === 'fulfilled' && result.value.limit > 0 ? [result.value] : []);
  if (!read.length) {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw new Error(failure?.reason instanceof Error ? failure.reason.message : 'GitHub returned no rate limit');
  }
  const busiest = read.reduce((a, b) => (b.limit - b.remaining) / b.limit > (a.limit - a.remaining) / a.limit ? b : a);
  const unread = results.length - read.length;
  return { readings: { 'github.api': { used: busiest.limit - busiest.remaining, limit: busiest.limit,
    detail: `${busiest.connection.accountLogin}${read.length > 1 ? `, busiest of ${read.length} installations` : ''}${unread ? ` (${unread} unreadable)` : ''}` } } };
}

// ─── This server ─────────────────────────────────────────────────────────────

export function hostUsage(input: {
  disk?: { used: number; total: number };
  memory: { total: number; available: number };
  heap?: WorkerHeap;
  database?: { used: number; max: number };
}): ProbeResult {
  const readings: Record<string, ProbeReading> = {
    'host.memory': { used: Math.max(0, input.memory.total - input.memory.available), limit: input.memory.total },
  };
  if (input.disk) readings['host.disk'] = { used: input.disk.used, limit: input.disk.total };
  if (input.heap) readings['host.heap'] = { used: input.heap.usedBytes, limit: input.heap.limitBytes };
  if (input.database) readings['host.database'] = { used: input.database.used, limit: input.database.max };
  return { readings };
}
