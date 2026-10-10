import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { EmailService } from '../src/autonomy/email.js';
import { Vault } from '../src/autonomy/vault.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { Store } from '../src/store/db.js';
import {
  agentMailUsage, cloudflareR2Usage, cloudflareWorkersUsage, composioUsage, daytonaUsage, e2bUsage, githubUsage, hostUsage, NotConnected,
} from '../src/ops/service-limit-probes.js';
import { installationOperators, serviceLimitEmail, serviceLimitNotifier } from '../src/ops/service-limit-notices.js';
import {
  CLOUDFLARE_TOKEN_HANDLE, evaluateAlerts, mergeServiceLimitSettings, SERVICE_LIMIT_SETTINGS_KEY, SERVICE_LIMIT_STATE_KEY,
  probeError, ServiceLimitsInputError, ServiceLimitsService, type AlertInput, type ServiceLimitAlert,
} from '../src/ops/service-limits.js';
import { RECONCILIATION_REPORT_KEY } from '../src/store/object-reconciliation.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DAY = 86_400_000;
const ACCOUNT = '35e42bcea7b0b9f09dce2860d587d418';

type Call = { url: string; init?: RequestInit };
/** A `fetch` that answers from a routing function and records every call. */
function stubFetch(route: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push({ url: url.toString(), init });
    return route(url, init);
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const header = (call: Call, name: string) => new Headers(call.init?.headers).get(name);

describe('alerts at 80% and 95%', () => {
  const meter = (used: number, window: AlertInput['window'] = 'month'): AlertInput => ({
    key: 'composio.tool-calls', serviceId: 'composio', serviceName: 'Composio', meterId: 'composio.tool-calls',
    label: 'Tool calls this month', window, used, limit: 100_000, unit: 'count' });

  it('raises each level once per period, and clears below 80%', () => {
    let memory = {};
    const run = (input: AlertInput, at = NOW) => {
      const result = evaluateAlerts(memory, [input], at);
      memory = result.memory;
      return result.alerts.map((alert) => ({ level: alert.level, fresh: alert.fresh, period: alert.period }));
    };
    expect(run(meter(79_999))).toEqual([]);
    expect(run(meter(80_000))).toEqual([{ level: 80, fresh: true, period: '2026-10' }]);
    expect(run(meter(85_000), NOW + DAY)).toEqual([{ level: 80, fresh: false, period: '2026-10' }]);
    expect(run(meter(95_500))).toEqual([{ level: 95, fresh: true, period: '2026-10' }]);
    // Falling back to 80% shows the lower alert without announcing it again.
    expect(run(meter(90_000))).toEqual([{ level: 80, fresh: false, period: '2026-10' }]);
    // Below 80% nothing stands: the alert is withdrawn.
    expect(run(meter(10_000))).toEqual([]);
    expect(run(meter(96_000))).toEqual([{ level: 95, fresh: false, period: '2026-10' }]);
    // A new month is a new period.
    expect(run(meter(81_000), Date.parse('2026-11-02T00:00:00Z'))).toEqual([{ level: 80, fresh: true, period: '2026-11' }]);
  });

  it('jumping straight to 95% announces only 95%', () => {
    const first = evaluateAlerts({}, [meter(99_000)], NOW);
    expect(first.alerts.map((alert) => [alert.level, alert.fresh])).toEqual([[95, true]]);
    const second = evaluateAlerts(first.memory, [meter(85_000)], NOW);
    expect(second.alerts.map((alert) => [alert.level, alert.fresh])).toEqual([[80, false]]);
  });

  it('deduplicates gauges per UTC day', () => {
    const gauge = { ...meter(17, 'now'), key: 'e2b.sandboxes', limit: 20 };
    const first = evaluateAlerts({}, [gauge], NOW);
    expect(first.alerts[0]).toMatchObject({ level: 80, fresh: true, period: '2026-10-08' });
    const later = evaluateAlerts(evaluateAlerts(first.memory, [{ ...gauge, used: 2 }], NOW + 3600_000).memory, [gauge], NOW + 7200_000);
    expect(later.alerts[0]).toMatchObject({ level: 80, fresh: false });
    expect(evaluateAlerts(later.memory, [gauge], NOW + DAY).alerts[0]).toMatchObject({ fresh: true, period: '2026-10-09' });
  });

  it('a failing probe is its own alert, once a day', () => {
    const failure: AlertInput = { key: 'composio:probe', serviceId: 'composio', serviceName: 'Composio', error: 'Composio answered 500' };
    const first = evaluateAlerts({}, [failure], NOW);
    expect(first.alerts[0]).toMatchObject({ level: 'failed', fresh: true, period: '2026-10-08' });
    expect(evaluateAlerts(first.memory, [failure], NOW + 1000).alerts[0]!.fresh).toBe(false);
  });

  it('ignores meters without a limit and forgets old announcements', () => {
    expect(evaluateAlerts({}, [{ ...meter(5), limit: undefined }], NOW).alerts).toEqual([]);
    const { memory } = evaluateAlerts({ old: { 80: '2026-01' }, recent: { 95: '2026-10-01' } }, [], NOW);
    expect(memory).toEqual({ recent: { 95: '2026-10-01' } });
  });

  it('writes one email for every newly reached level', () => {
    const alert = (over: Partial<ServiceLimitAlert>): ServiceLimitAlert => ({ ...meter(96_123), level: 95, period: '2026-10', fresh: true,
      link: 'https://dashboard.composio.dev/~/org/settings/billing', ...over });
    const single = serviceLimitEmail([alert({})], 'tavya', 'https://tavya.io/');
    expect(single.subject).toBe('tavya: Composio is at 96% of its limit');
    expect(single.text).toContain('Tool calls this month 96,123 of 100,000 (96%). Upgrade: https://dashboard.composio.dev/~/org/settings/billing');
    expect(single.text).toContain('https://tavya.io/installation#installation-limits');
    const both = serviceLimitEmail([alert({}), alert({ level: 'failed', serviceName: 'E2B', error: 'E2B answered 502' })], 'tavya');
    expect(both.subject).toBe('tavya: 2 service limits need attention');
    expect(both.text).toContain("Can't read E2B usage: E2B answered 502.");
  });
});

describe('probe errors', () => {
  it('cut every resolved credential and anything token-shaped, and stay short', () => {
    expect(probeError(new Error('401 for key abc123secret and abc123secret-longer'), ['abc123secret', 'abc123secret-longer']))
      .toBe('401 for key [redacted] and [redacted]');
    expect(probeError(new Error(`Bearer ${'x'.repeat(40)} refused`))).toBe('[redacted] refused');
    expect(probeError(new Error('no answer '.repeat(50)), []).length).toBe(200);
    expect(probeError('')).toBe('no answer');
  });
});

describe('operator-editable settings', () => {
  it('validates and merges limits, plans and links; null restores the default', () => {
    let settings = mergeServiceLimitSettings({}, { services: { composio: { plan: 'Pro', limits: { 'composio.tool-calls': 500_000 },
      link: 'https://dashboard.composio.dev/billing' } }, cloudflare: { accountId: ACCOUNT.toUpperCase() } });
    expect(settings).toEqual({ cloudflare: { accountId: ACCOUNT },
      services: { composio: { plan: 'Pro', link: 'https://dashboard.composio.dev/billing', limits: { 'composio.tool-calls': 500_000 } } } });
    settings = mergeServiceLimitSettings(settings, { services: { composio: { plan: null, limits: { 'composio.tool-calls': null } } } });
    expect(settings.services).toEqual({ composio: { link: 'https://dashboard.composio.dev/billing' } });
    for (const input of [
      { services: { nope: {} } },
      { services: { composio: { limits: { 'e2b.sandboxes': 3 } } } },
      { services: { composio: { limits: { 'composio.tool-calls': -1 } } } },
      { services: { composio: { link: 'javascript:alert(1)' } } },
      { cloudflare: { accountId: 'not-an-account' } },
    ]) expect(() => mergeServiceLimitSettings({}, input as any)).toThrow(ServiceLimitsInputError);
  });
});

describe('probes against provider responses', () => {
  it('Cloudflare Workers: today’s requests across every script, by account', async () => {
    const stub = stubFetch(() => reply({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
      { sum: { requests: 9_000 }, dimensions: { scriptName: 'tavya-resource-repositories' } },
      { sum: { requests: 121 }, dimensions: { scriptName: 'other' } },
    ] }] } }, errors: null }));
    const result = await cloudflareWorkersUsage({ fetch: stub.fetch, token: 'cf-token', accountId: ACCOUNT, now: NOW });
    expect(result.readings['cloudflare-workers.requests']).toEqual({ used: 9_121, detail: 'tavya-resource-repositories 9,000 · other 121' });
    expect(stub.calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(header(stub.calls[0]!, 'authorization')).toBe('Bearer cf-token');
    const body = JSON.parse(String(stub.calls[0]!.init?.body));
    expect(body.variables).toEqual({ account: ACCOUNT, start: '2026-10-08T00:00:00Z', end: '2026-10-08T12:00:00.000Z' });
    expect(body.query).toContain('workersInvocationsAdaptive');
  });

  it('Cloudflare R2: operations by class this month and bytes stored', async () => {
    const stub = stubFetch(() => reply({ data: { viewer: { accounts: [{
      operations: [
        { sum: { requests: 2_000 }, dimensions: { actionType: 'PutObject' } },
        { sum: { requests: 300 }, dimensions: { actionType: 'ListObjects' } },
        { sum: { requests: 8_000 }, dimensions: { actionType: 'GetObject' } },
        { sum: { requests: 50 }, dimensions: { actionType: 'HeadObject' } },
        { sum: { requests: 999 }, dimensions: { actionType: 'DeleteObject' } },
      ],
      storage: [
        { max: { payloadSize: 4e9, metadataSize: 1e6 }, dimensions: { bucketName: 'tavya-storage' } },
        { max: { payloadSize: 1e9, metadataSize: 0 }, dimensions: { bucketName: 'backups' } },
      ],
    }] } } }));
    const result = await cloudflareR2Usage({ fetch: stub.fetch, token: 't', accountId: ACCOUNT, now: NOW });
    expect(result.readings).toEqual({
      'cloudflare-r2.class-a': { used: 2_300 }, 'cloudflare-r2.class-b': { used: 8_050 }, 'cloudflare-r2.storage': { used: 5.001e9 } });
    expect(JSON.parse(String(stub.calls[0]!.init?.body)).variables).toMatchObject({ month: '2026-10-01T00:00:00Z' });
  });

  it('Cloudflare: a GraphQL error or refused token is a failure with a readable reason', async () => {
    const denied = stubFetch(() => reply({ data: null, errors: [{ message: 'not authorized for that account' }] }));
    await expect(cloudflareWorkersUsage({ fetch: denied.fetch, token: 't', accountId: ACCOUNT, now: NOW }))
      .rejects.toThrow('Cloudflare: not authorized for that account');
    const refused = stubFetch(() => reply({}, 403));
    await expect(cloudflareR2Usage({ fetch: refused.fetch, token: 't', accountId: ACCOUNT, now: NOW }))
      .rejects.toThrow('Cloudflare refused the credential (403)');
  });

  it('Composio: active connected accounts across pages; tool calls are counted by tavya', async () => {
    const stub = stubFetch((url) => url.searchParams.get('cursor') === 'page2'
      ? reply({ items: [{ status: 'ACTIVE' }, { status: 'EXPIRED' }], next_cursor: null, total_items: 4 })
      : reply({ items: [{ status: 'ACTIVE' }, { status: 'ACTIVE', is_disabled: true }], next_cursor: 'page2', total_items: 4 }));
    const result = await composioUsage({ fetch: stub.fetch, apiKey: 'ak_project', toolCalls: 81_234 });
    expect(result.readings).toEqual({ 'composio.tool-calls': { used: 81_234 }, 'composio.accounts': { used: 2 } });
    expect(stub.calls.map((call) => new URL(call.url).pathname)).toEqual(['/api/v3.1/connected_accounts', '/api/v3.1/connected_accounts']);
    expect(header(stub.calls[0]!, 'x-api-key')).toBe('ak_project');
  });

  it('E2B: running sandboxes from X-Total-Running, else by paging', async () => {
    const counted = stubFetch(() => reply([{ sandboxID: 'a' }], 200, { 'x-total-running': '17' }));
    expect((await e2bUsage({ fetch: counted.fetch, apiKey: 'e2b_key', hours: 12.34 })).readings)
      .toEqual({ 'e2b.sandboxes': { used: 17 }, 'e2b.hours': { used: 12.3 } });
    expect(new URL(counted.calls[0]!.url).searchParams.get('state')).toBe('running');
    expect(header(counted.calls[0]!, 'x-api-key')).toBe('e2b_key');
    const paged = stubFetch((url) => url.searchParams.get('nextToken')
      ? reply([{}, {}]) : reply([{}, {}, {}], 200, { 'x-next-token': 'n2' }));
    expect((await e2bUsage({ fetch: paged.fetch, apiKey: 'k', hours: 0 })).readings['e2b.sandboxes']!.used).toBe(5);
  });

  it('Daytona: the resource closest to its tier limit, and the tier', async () => {
    const stub = stubFetch((url) => url.pathname.endsWith('/api-keys/current')
      ? reply({ name: 'tavya', organizationId: 'org-123' })
      : reply({ regionUsage: [
        { regionId: 'eu', totalCpuQuota: 10, currentCpuUsage: 4, totalMemoryQuota: 20, currentMemoryUsage: 8, totalDiskQuota: 30, currentDiskUsage: 27 },
      ], totalSnapshotQuota: 100, currentSnapshotUsage: 2 }));
    const result = await daytonaUsage({ fetch: stub.fetch, apiKey: 'dtn_key' });
    expect(result.plan).toBe('Tier 1');
    expect(result.readings['daytona.capacity']).toEqual({ used: 27 * 1024 ** 3, limit: 30 * 1024 ** 3, label: 'Disk in use', unit: 'bytes',
      detail: '4 of 10 vCPUs · 8 of 20 GiB memory · 27 of 30 GiB disk' });
    expect(stub.calls.map((call) => call.url)).toEqual([
      'https://app.daytona.io/api/api-keys/current', 'https://app.daytona.io/api/organizations/org-123/usage']);
    expect(header(stub.calls[1]!, 'authorization')).toBe('Bearer dtn_key');
  });

  it('Daytona: a sandbox-scoped key reads what its sandboxes use instead of failing', async () => {
    // tavya.io's key (2026-10-10): write:sandboxes and delete:sandboxes; the organization's usage answers 403.
    const stub = stubFetch((url) => {
      if (url.pathname.endsWith('/api-keys/current'))
        return reply({ name: 'tavya', organizationId: 'org-123', permissions: ['write:sandboxes', 'delete:sandboxes'] });
      if (url.pathname.endsWith('/usage')) return reply({ statusCode: 403, message: 'Access denied' }, 403);
      expect(url.pathname).toBe('/api/sandbox');
      return url.searchParams.get('cursor') === 'c2'
        ? reply({ items: [{ state: 'started', cpu: 4, memory: 8, disk: 20 }], nextCursor: null })
        : reply({ items: [{ state: 'started', cpu: 2, memory: 4, disk: 10 }, { state: 'stopped', cpu: 1, memory: 1, disk: 5 },
          { state: 'archived', cpu: 1, memory: 1, disk: 3 }], nextCursor: 'c2' });
    });
    const result = await daytonaUsage({ fetch: stub.fetch, apiKey: 'dtn_key' });
    expect(result.plan).toBe('Limited key');
    // Running sandboxes hold vCPUs and memory; every sandbox not archived holds its disk.
    expect(result.readings['daytona.capacity']).toEqual({ used: 6, label: 'vCPUs in use', unit: 'count',
      detail: '6 vCPUs · 12 GiB memory · 35 GiB disk' });
    expect(stub.calls.every((call) => header(call, 'authorization') === 'Bearer dtn_key')).toBe(true);
  });

  it('Daytona: a key it does not accept at all is still a failure', async () => {
    const stub = stubFetch(() => reply({ statusCode: 401, message: 'Invalid credentials' }, 401));
    await expect(daytonaUsage({ fetch: stub.fetch, apiKey: 'dtn_old' })).rejects.toThrow('Daytona refused the credential (401)');
  });

  it('AgentMail: inboxes from the API, received mail counted by tavya', async () => {
    const stub = stubFetch(() => reply({ count: 2, inboxes: [{ inbox_id: 'a@agentmail.to' }] }));
    expect((await agentMailUsage({ fetch: stub.fetch, apiKey: 'am_key', received: 40 })).readings)
      .toEqual({ 'agentmail.inboxes': { used: 2 }, 'agentmail.messages': { used: 40 } });
    expect(stub.calls[0]!.url).toBe('https://api.agentmail.to/v0/inboxes?limit=1');
  });

  it('GitHub: the busiest installation, ignoring one that cannot be read', async () => {
    const connection = (installationId: string, accountLogin: string) => ({ id: installationId, organizationId: 'o', provider: 'github' as const,
      installationId, accountLogin, createdAt: 0 });
    const result = await githubUsage({ connections: [connection('1', 'quiet'), connection('2', 'busy'), connection('3', 'broken')],
      rateLimit: async (c) => {
        if (c.accountLogin === 'broken') throw new Error('GitHub API 401: Bad credentials');
        return c.accountLogin === 'busy' ? { limit: 5_000, remaining: 600, resetAt: 0 } : { limit: 12_500, remaining: 12_000, resetAt: 0 };
      } });
    expect(result.readings['github.api']).toEqual({ used: 4_400, limit: 5_000, detail: 'busy, busiest of 2 installations (1 unreadable)' });
    await expect(githubUsage({ connections: [], rateLimit: async () => ({ limit: 1, remaining: 1, resetAt: 0 }) })).rejects.toBeInstanceOf(NotConnected);
  });

  it('this server: disk, memory, worker heap and database connections', () => {
    expect(hostUsage({ disk: { used: 85e9, total: 193e9 }, memory: { total: 8e9, available: 3e9 },
      heap: { usedBytes: 1.2e9, limitBytes: 2e9, at: NOW }, database: { used: 18, max: 100 } }).readings).toEqual({
      'host.disk': { used: 85e9, limit: 193e9 }, 'host.memory': { used: 5e9, limit: 8e9 },
      'host.heap': { used: 1.2e9, limit: 2e9 }, 'host.database': { used: 18, limit: 100 } });
    // The workflow thread's heap, where open tasks live, is its own meter (RT-35).
    expect(hostUsage({ memory: { total: 8e9, available: 3e9 }, heap: { usedBytes: 1, limitBytes: 2, at: NOW,
      workflows: { usedBytes: 0.9e9, limitBytes: 1.2e9 } } }).readings['host.workflow-heap']).toEqual({ used: 0.9e9, limit: 1.2e9 });
  });
});

// The service and the notices run on SQLite and, when KARMAX_TEST_POSTGRES_URL
// points at a disposable database, on PostgreSQL (production's database).
const postgresUrl = process.env.KARMAX_TEST_POSTGRES_URL;
const admin = postgresUrl ? new Pool({ connectionString: postgresUrl }) : undefined;
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => { await admin?.end(); });

for (const backend of ['sqlite', ...(postgresUrl ? ['postgres'] : [])]) describe(`service limits on ${backend}`, () => {
  async function fixture(options: { fetch?: typeof fetch; probeTimeoutMs?: number; heapAge?: number;
    notify?: (alerts: ServiceLimitAlert[]) => Promise<void> } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-service-limits-')); dirs.push(dir);
    if (backend === 'postgres') await admin!.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const store = await Store.create(backend === 'postgres' ? postgresUrl! : ':memory:');
    stores.push(store);
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    let now = NOW;
    const notices: ServiceLimitAlert[][] = [];
    /** A new instance on the same database and vault: what a restart sees. */
    const make = () => new ServiceLimitsService({ store, broker, now: () => now, dataDir: dir, env: {},
      fetch: options.fetch ?? stubFetch(() => reply({}, 500)).fetch, probeTimeoutMs: options.probeTimeoutMs,
      workerHeap: () => ({ usedBytes: 100e6, limitBytes: 2e9, at: now - (options.heapAge ?? 0) }),
      notify: options.notify ?? (async (alerts) => { notices.push(alerts); }) });
    const service = make();
    return { store, broker, service, notices, dir, make, setNow: (value: number) => { now = value; } };
  }

  it('shows untracked and deleted data in the managed bucket from its last reconciliation', async () => {
    const { store, service } = await fixture();
    expect((await service.run()).services.find((s) => s.id === 'managed-storage')).toMatchObject({ status: 'not-connected' });
    const organization = await store.createOrganization({ name: 'nisada-personal' });
    const tally = (bytes: number) => ({ count: 1, bytes });
    await store.kvSet(RECONCILIATION_REPORT_KEY, JSON.stringify({ at: NOW, mode: 'report', durationMs: 1, listed: tally(3e9),
      live: tally(1e9), pendingDelete: tally(1.5e9), pendingWrite: tally(0), untracked: tally(375e6), orphans: tally(375e6),
      deleted: tally(0), families: [], sample: [], organizations: {
        [organization.id]: { live: 1e9, pendingDelete: 1.5e9, pendingDeleteUntil: Date.parse('2026-11-09T00:00:00Z'), untracked: 375e6 } } }));
    const row = (await service.run()).services.find((s) => s.id === 'managed-storage')!;
    expect(row.status).toBe('ok');
    expect(row.meters.map((meter) => [meter.id, meter.used, meter.limit, meter.level, meter.detail])).toEqual([
      ['managed-storage.untracked', 375e6, 1024 ** 3, 0, 'nisada-personal 357.6 MiB'],
      ['managed-storage.pending-delete', 1.5e9, undefined, 0, 'all purged by 2026-11-09'],
    ]);
  });

  it('samples the connected accounts, keeps a history and announces each level once', async () => {
    let workers = 85_000;
    const stub = stubFetch((url, init) => {
      if (url.hostname === 'api.cloudflare.com') {
        const query = JSON.parse(String(init?.body)).query as string;
        return reply({ data: { viewer: { accounts: [query.includes('workersInvocationsAdaptive')
          ? { workersInvocationsAdaptive: [{ sum: { requests: workers }, dimensions: { scriptName: 'tavya-resource-repositories' } }] }
          : { operations: [{ sum: { requests: 10 }, dimensions: { actionType: 'PutObject' } }], storage: [] }] } } });
      }
      return reply({}, 404);
    });
    const { store, broker, service, notices, setNow } = await fixture({ fetch: stub.fetch });
    await service.configure({ cloudflare: { accountId: ACCOUNT, apiToken: 'cf-secret-token' } });
    for (let i = 0; i < 81_000; i += 27_000) await store.countServiceUsage('composio.tool-calls', NOW - DAY, 27_000);
    (await store.countServiceUsage('letsencrypt.certificates', NOW - 9 * DAY, 40)); // outside the 7-day window
    const view = await service.run();

    const workersRow = view.services.find((s) => s.id === 'cloudflare-workers')!;
    expect(workersRow).toMatchObject({ status: 'ok', plan: 'Free', planSource: 'published' });
    expect(workersRow.meters[0]).toMatchObject({ used: 85_000, usedSource: 'api', limit: 100_000, limitSource: 'published', level: 80,
      history: [[NOW, 85_000]], detail: 'tavya-resource-repositories 85,000' });
    expect(view.services.find((s) => s.id === 'composio')).toMatchObject({ status: 'not-connected', connect: expect.stringContaining('Composio') });
    expect(view.services.find((s) => s.id === 'host')!.meters.map((m) => m.id)).toEqual(
      backend === 'postgres' ? ['host.disk', 'host.memory', 'host.heap', 'host.database'] : ['host.disk', 'host.memory', 'host.heap']);
    expect(view.services.find((s) => s.id === 'host')!.meters.find((m) => m.id === 'host.heap'))
      .toMatchObject({ used: 100e6, limit: 2e9, usedSource: 'host', limitSource: 'api' });
    expect(notices.at(-1)!.map((a) => [a.key, a.level, a.fresh])).toEqual([['cloudflare-workers.requests', 80, true]]);

    // Same day, higher: 95% is new; then it stays without another announcement.
    workers = 97_000; setNow(NOW + 900_000);
    await service.run();
    expect(notices.at(-1)!.map((a) => [a.key, a.level, a.fresh])).toEqual([['cloudflare-workers.requests', 95, true]]);
    setNow(NOW + 1_800_000);
    const third = await service.run();
    expect(notices.at(-1)!.map((a) => [a.level, a.fresh])).toEqual([[95, false]]);
    // History keeps one point per hour (the hour's highest reading).
    expect(third.services.find((s) => s.id === 'cloudflare-workers')!.meters[0]!.history).toEqual([[NOW, 97_000]]);
    expect(third.services.find((s) => s.id === 'cloudflare-workers')!.meters[0]!.peak).toEqual({ used: 97_000, at: NOW });

    // Raising the limit clears the alert.
    await service.configure({ services: { 'cloudflare-workers': { plan: 'Paid', limits: { 'cloudflare-workers.requests': 10_000_000 } } } });
    const raised = await service.run();
    expect(notices.at(-1)).toEqual([]);
    expect(raised.services.find((s) => s.id === 'cloudflare-workers')).toMatchObject({ plan: 'Paid', planSource: 'entered' });
    expect(raised.services.find((s) => s.id === 'cloudflare-workers')!.meters[0]).toMatchObject({ limit: 10_000_000, limitSource: 'entered', level: 0 });

    // The token stays in the vault: never in the view, the settings or the state.
    const everything = JSON.stringify(raised) + (await store.kvGet(SERVICE_LIMIT_SETTINGS_KEY)) + (await store.kvGet(SERVICE_LIMIT_STATE_KEY));
    expect(everything).not.toContain('cf-secret-token');
    expect(await broker.hasHandle(CLOUDFLARE_TOKEN_HANDLE)).toBe(true);
    expect(raised.cloudflare).toEqual({ accountId: ACCOUNT, tokenConfigured: true });
    await service.configure({ cloudflare: { apiToken: null } });
    expect(await broker.hasHandle(CLOUDFLARE_TOKEN_HANDLE)).toBe(false);
  });

  it('counts tavya’s own sends, calls and certificates', async () => {
    const { store, broker, service } = await fixture();
    for (let i = 0; i < 3; i++) await store.countServiceUsage('composio.tool-calls', NOW);
    (await store.countServiceUsage('composio.tool-calls', NOW - 10 * DAY)); // September
    expect(await store.serviceUsageSince('composio.tool-calls', '2026-10-01')).toBe(3);
    expect(await store.serviceUsageSince('composio.tool-calls', '2026-09-01')).toBe(4);
    await store.pruneServiceUsage('2026-10-01');
    expect(await store.serviceUsageSince('composio.tool-calls', '2026-09-01')).toBe(3);

    // A preview hostname counts once toward Let's Encrypt, however often Caddy asks.
    const project = await store.createProject('Previews');
    const lease = { id: 'lease-1', organizationId: project.organizationId!, projectId: project.id, taskId: 't', worldId: 'w', generation: 1,
      port: 3000, public: false, provider: 'e2b', createdBy: 'user:u', createdAt: NOW, expiresAt: NOW + DAY, hostname: 'p-abc.preview.tavya.test' };
    await store.createPreviewLease(lease as any);
    await store.recordPreviewCertificateRequest('P-ABC.preview.tavya.test', NOW);
    await store.recordPreviewCertificateRequest('p-abc.preview.tavya.test', NOW + 1000);
    await store.recordPreviewCertificateRequest('p-unknown.preview.tavya.test', NOW);
    expect(await store.serviceUsageSince('letsencrypt.certificates', '2026-10-01')).toBe(1);

    // Resend: tavya's count, unless Resend's own report (every sender) is higher.
    await store.kvSet('email:outbound', JSON.stringify({ provider: 'resend', from: 'tavya <noreply@tavya.test>', secretHandle: 'email:resend' }));
    await broker.registerHandle('email:resend', 're_key', INSTALLATION_SCOPE);
    for (let i = 0; i < 5; i++) await store.countServiceUsage('email.sent:resend', NOW);
    let view = await service.run();
    expect(view.services.find((s) => s.id === 'resend')!.meters.map((m) => [m.id, m.used, m.usedSource, m.limit]))
      .toEqual([['resend.day', 5, 'count', 100], ['resend.month', 5, 'count', 3_000]]);
    await service.recordResendQuota({ daily: 9, monthly: 2_950 });
    view = await service.run();
    expect(view.services.find((s) => s.id === 'resend')!.meters.map((m) => [m.used, m.usedSource, m.level]))
      .toEqual([[9, 'api', 0], [2_950, 'api', 95]]);
  });

  it('a probe failing twice in a row is an alert; its last readings stand', async () => {
    let healthy = true;
    const stub = stubFetch(() => healthy ? reply({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 90_000 } }],
      operations: [], storage: [] }] } } }) : reply({}, 502));
    const { service, notices, setNow } = await fixture({ fetch: stub.fetch });
    await service.configure({ cloudflare: { accountId: ACCOUNT, apiToken: 'cf' } });
    await service.run();
    healthy = false;
    setNow(NOW + 900_000);
    const once = await service.run();
    expect(once.services.find((s) => s.id === 'cloudflare-workers')).toMatchObject({ status: 'failed', error: 'Cloudflare answered 502' });
    expect(once.services.find((s) => s.id === 'cloudflare-workers')!.meters[0]).toMatchObject({ used: 90_000, level: 80 });
    expect(notices.at(-1)!.map((a) => a.key)).toEqual(['cloudflare-workers.requests']);
    setNow(NOW + 1_800_000);
    await service.run();
    expect(notices.at(-1)!.filter((a) => a.level === 'failed').map((a) => [a.key, a.fresh, a.error]))
      .toEqual([['cloudflare-workers:probe', true, 'Cloudflare answered 502'], ['cloudflare-r2:probe', true, 'Cloudflare answered 502']]);
    healthy = true;
    setNow(NOW + 2_700_000);
    await service.run();
    expect(notices.at(-1)!.filter((a) => a.level === 'failed')).toEqual([]);
  });

  /** A Cloudflare stub answering `requests` for Workers and nothing for R2. */
  const cloudflareAt = (requests: () => number) => stubFetch(() => reply({ data: { viewer: { accounts: [{
    workersInvocationsAdaptive: [{ sum: { requests: requests() } }], operations: [], storage: [] }] } } }));

  it('a provider that never answers is cancelled at its deadline; the others are read', async () => {
    const aborted: string[] = [];
    const stub = stubFetch((url, init) => url.hostname === 'api.e2b.app'
      ? new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { aborted.push(url.hostname); reject(new Error('aborted')); }))
      : reply({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 5 } }], operations: [], storage: [] }] } } }));
    const { service, store, broker, dir } = await fixture({ fetch: stub.fetch, probeTimeoutMs: 200 });
    await service.configure({ cloudflare: { accountId: ACCOUNT, apiToken: 'cf' } });
    const hung = new ServiceLimitsService({ store, broker, dataDir: dir, env: {}, now: () => NOW, fetch: stub.fetch, probeTimeoutMs: 200,
      providerConnections: { resolve: async () => ({ apiKey: 'e2b_key', config: {} }) } });
    const started = Date.now();
    const view = await hung.run();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(view.services.find((s) => s.id === 'e2b')).toMatchObject({ status: 'failed', error: 'no answer within 1 s' });
    expect(view.services.find((s) => s.id === 'cloudflare-workers')).toMatchObject({ status: 'ok' });
    expect(aborted).toEqual(['api.e2b.app']);
  });

  it('never stores, returns or announces a credential, even when a provider echoes it', async () => {
    const echo = stubFetch((url, init) => {
      const token = new Headers(init?.headers).get('authorization') ?? new Headers(init?.headers).get('x-api-key');
      return reply({ data: null, errors: [{ message: `token ${token} is not valid for ${url.hostname}` }] });
    });
    const { service, store, notices, setNow } = await fixture({ fetch: echo.fetch });
    await service.configure({ cloudflare: { accountId: ACCOUNT, apiToken: 'cf-short-secret' } });
    await service.run();
    setNow(NOW + 900_000);
    const view = await service.run();
    expect(view.services.find((s) => s.id === 'cloudflare-workers')!.error)
      .toBe('Cloudflare: token Bearer [redacted] is not valid for api.cloudflare.com');
    const everything = JSON.stringify(view) + JSON.stringify(notices) + (await store.kvGet(SERVICE_LIMIT_STATE_KEY));
    expect(everything).not.toContain('cf-short-secret');
    expect(notices.at(-1)!.some((alert) => alert.level === 'failed')).toBe(true);
  });

  it('remembers what it announced across a restart, and announces again if delivery failed', async () => {
    let failDelivery = true;
    const delivered: ServiceLimitAlert[][] = [];
    const { service, make, setNow } = await fixture({ fetch: cloudflareAt(() => 90_000).fetch,
      notify: async (alerts) => { if (failDelivery) throw new Error('inbox unavailable'); delivered.push(alerts); } });
    await service.configure({ cloudflare: { accountId: ACCOUNT, apiToken: 'cf' } });
    await expect(service.run()).rejects.toThrow('inbox unavailable');
    failDelivery = false;
    setNow(NOW + 900_000);
    await make().run(); // a restarted process
    expect(delivered.at(-1)!.map((a) => [a.key, a.fresh])).toEqual([['cloudflare-workers.requests', true]]);
    setNow(NOW + 1_800_000);
    await make().run();
    expect(delivered.at(-1)!.map((a) => [a.key, a.fresh])).toEqual([['cloudflare-workers.requests', false]]);
  });

  it('keeps at most 7 days of hourly history', async () => {
    let requests = 0;
    const { service, store, setNow } = await fixture({ fetch: cloudflareAt(() => ++requests).fetch });
    await service.configure({ cloudflare: { accountId: ACCOUNT, apiToken: 'cf' } });
    let view;
    for (let at = NOW; at < NOW + 10 * DAY; at += 2 * 3600_000) { setNow(at); view = await service.run(); }
    for (const meter of view!.services.flatMap((s) => s.meters)) {
      expect(meter.history.length).toBeLessThanOrEqual(7 * 24);
      expect(meter.history.every(([at]) => at > NOW + 10 * DAY - 2 * 3600_000 - 7 * DAY)).toBe(true);
    }
    expect(view!.services.find((s) => s.id === 'cloudflare-workers')!.meters[0]!.history).toHaveLength(84);
    expect((await store.kvGet(SERVICE_LIMIT_STATE_KEY))!.length).toBeLessThan(64_000);
  });

  it('shows no worker heap when the worker has not reported recently', async () => {
    const { service } = await fixture({ heapAge: 5 * 60_000 });
    const host = (await service.run()).services.find((s) => s.id === 'host')!;
    expect(host.meters.map((m) => m.id)).not.toContain('host.heap');
  });

  it('notifies installation operators: an inbox item each, withdrawn when clear, and an email once', async () => {
    const { store } = await fixture();
    const authorization = await AuthorizationService.create(store);
    const operator = await store.createOrganization({ name: 'Operator', kind: 'personal', ownerUserId: 'op' });
    const tenant = await store.createOrganization({ name: 'Tenant', ownerUserId: 'tenant' });
    await authorization.grant('system:test', { principalId: 'user:op', scopeKey: 'global', profileId: 'god' });
    await authorization.grant('system:test', { principalId: 'user:tenant', scopeKey: `organization:${tenant.id}`, profileId: 'superadmin' });
    await authorization.grant('system:test', { principalId: 'user:viewer', scopeKey: 'global', profileId: 'viewer' });
    expect(await installationOperators(store, (p) => authorization.capabilities(p))).toEqual(['op']);

    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const notify = serviceLimitNotifier({ store, capabilities: (p) => authorization.capabilities(p),
      email: { configured: async () => true, send: async (message) => { sent.push(message); } },
      userEmail: async (userId) => `${userId}@tavya.test`, siteName: async () => 'tavya', publicUrl: 'https://tavya.test' });
    const alert: ServiceLimitAlert = { key: 'e2b.sandboxes', serviceId: 'e2b', serviceName: 'E2B', meterId: 'e2b.sandboxes',
      label: 'Running sandboxes', window: 'now', used: 19, limit: 20, unit: 'count', level: 95, period: '2026-10-08', fresh: true };
    await notify([alert]);
    const items = await store.listInbox('op', (await store.defaultOrganization('op', true))!.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ urgency: 'critical', subject: { kind: 'service-limit', service: 'e2b', level: 95, used: 19, limit: 20 } });
    expect(await store.listInbox('tenant', tenant.id)).toEqual([]);
    expect(sent).toEqual([{ to: 'op@tavya.test', subject: 'tavya: E2B is at 95% of its limit',
      text: 'E2B: Running sandboxes 19 of 20 (95%).\n\nService limits: https://tavya.test/installation#installation-limits' }]);

    // Standing, not fresh: the item stays, nothing is sent again.
    await notify([{ ...alert, fresh: false }]);
    expect(await store.listInbox('op', operator.id)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // Cleared: the item is withdrawn.
    await notify([]);
    expect(await store.listInbox('op', operator.id)).toEqual([]);
  });
});

describe('outbound email', () => {
  it('counts Resend sends and the quota Resend reports', async () => {
    const recorded: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"id":"e1"}', { status: 200,
      headers: { 'x-resend-daily-quota': '12', 'x-resend-monthly-quota': '345' } })) as typeof fetch;
    try {
      const email = new EmailService(() => ({ provider: 'resend', from: 'tavya <noreply@tavya.test>', secretHandle: 'h' }),
        () => 're_key', (sent) => { recorded.push(sent); });
      await email.send({ to: 'a@tavya.test', subject: 's', text: 't' });
    } finally { globalThis.fetch = original; }
    expect(recorded).toEqual([{ provider: 'resend', dailyQuota: 12, monthlyQuota: 345 }]);
  });
});
