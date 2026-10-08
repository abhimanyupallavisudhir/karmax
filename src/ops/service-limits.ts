/**
 * Installation → Service limits: the operator's shared third-party accounts
 * and this host, measured against their plan limits, with alerts at 80% and
 * 95% (wiki features/service-limits).
 *
 * Providers rarely expose the plan itself, so every limit is a published
 * default the operator can override, and every number says where it came
 * from: the provider's API, tavya's own count, or this server. Provider
 * credentials stay in the broker; nothing here returns one.
 */
import fs from 'node:fs';
import os from 'node:os';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { OutboundEmailConfig } from '../autonomy/email.js';
import type { MailboxConfig } from '../autonomy/mailbox.js';
import { INSTALLATION_SCOPE } from '../autonomy/vault-keys.js';
import type { GitConnection } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { WorkerHeap } from '../temporal/worker-process.js';
import {
  agentMailUsage, cloudflareR2Usage, cloudflareWorkersUsage, composioUsage, daytonaUsage, e2bUsage, githubUsage,
  hostUsage, NotConnected, type ProbeReading, type ProbeResult,
} from './service-limit-probes.js';

export type MeterUnit = 'count' | 'bytes' | 'hours';
/** The period a meter's usage accrues over; `now` is a gauge. */
export type MeterWindow = 'day' | 'month' | 'week' | 'hour' | 'now';
export type UsedSource = 'api' | 'count' | 'host';
export type LimitSource = 'published' | 'api' | 'entered';

export interface MeterSpec { id: string; label: string; unit: MeterUnit; window: MeterWindow; source: UsedSource; limit?: number; tip: string }
export interface ServiceSpec {
  id: string; name: string; tip: string; plan?: string;
  link?: { url: string; label: string };
  /** What to do when it isn't connected. */
  connect: string;
  meters: MeterSpec[];
}

export const ALERT_THRESHOLDS = [0.8, 0.95] as const;
/** Cloudflare's free R2 storage, 10 GB, read as binary gigabytes (the console's unit). */
const GB = 1024 ** 3;

export const SERVICE_CATALOG: ServiceSpec[] = [
  { id: 'cloudflare-workers', name: 'Cloudflare Workers', plan: 'Free',
    link: { url: 'https://dash.cloudflare.com/?to=/:account/workers/plans', label: 'Upgrade' },
    tip: 'Project data is saved and restored through Cloudflare Workers. The Free plan serves 100,000 requests a day; above that, saves and restores fail until midnight UTC. Workers Paid is $5/month.',
    connect: 'Add a Cloudflare API token that can read account analytics.',
    meters: [{ id: 'cloudflare-workers.requests', label: 'Requests today', unit: 'count', window: 'day', source: 'api', limit: 100_000,
      tip: 'Requests to your Workers since midnight UTC, from Cloudflare’s analytics.' }] },
  { id: 'cloudflare-r2', name: 'Cloudflare R2', plan: 'Free allowance',
    link: { url: 'https://dash.cloudflare.com/?to=/:account/r2/overview', label: 'Billing' },
    tip: 'Project data is stored in R2. Past the free allowance R2 charges the card on the account; nothing stops working.',
    connect: 'Add a Cloudflare API token that can read account analytics.',
    meters: [
      { id: 'cloudflare-r2.class-a', label: 'Writes this month', unit: 'count', window: 'month', source: 'api', limit: 1_000_000,
        tip: 'Uploads and listings this month (Class A operations). 1 million a month are free.' },
      { id: 'cloudflare-r2.class-b', label: 'Reads this month', unit: 'count', window: 'month', source: 'api', limit: 10_000_000,
        tip: 'Downloads this month (Class B operations). 10 million a month are free.' },
      { id: 'cloudflare-r2.storage', label: 'Stored', unit: 'bytes', window: 'now', source: 'api', limit: 10 * GB,
        tip: 'Data stored in every bucket now. 10 GB is free.' },
    ] },
  { id: 'composio', name: 'Composio', plan: 'Hobby',
    link: { url: 'https://dashboard.composio.dev/~/org/settings/billing', label: 'Upgrade' },
    tip: 'Composio runs app connections for every organization. At 100,000 tool calls Hobby pauses every connection until next month; Pro is $29/month.',
    connect: 'Add the Composio key under Installation → Composio.',
    meters: [
      { id: 'composio.tool-calls', label: 'Tool calls this month', unit: 'count', window: 'month', source: 'count', limit: 100_000,
        tip: 'Tool calls agents made through connected apps this month (UTC), counted by tavya.' },
      { id: 'composio.accounts', label: 'Connected accounts', unit: 'count', window: 'now', source: 'api',
        tip: 'Accounts people have connected. No Composio plan limits them.' },
    ] },
  { id: 'e2b', name: 'E2B', plan: 'Hobby',
    link: { url: 'https://console.e2b.dev/?tab=billing', label: 'Upgrade' },
    tip: 'Task sandboxes run on this E2B account. Hobby runs 20 at once and pauses each after an hour; Pro runs 100 for 24 hours.',
    connect: 'Connect E2B in the operator organization’s Compute settings.',
    meters: [
      { id: 'e2b.sandboxes', label: 'Running sandboxes', unit: 'count', window: 'now', source: 'api', limit: 20,
        tip: 'Sandboxes running on the account now. New ones are refused at the limit.' },
      { id: 'e2b.hours', label: 'Hours this month', unit: 'hours', window: 'month', source: 'count',
        tip: 'Sandbox running time this month, metered by tavya. Enter a limit to be warned before a budget runs out.' },
    ] },
  { id: 'daytona', name: 'Daytona',
    link: { url: 'https://app.daytona.io/dashboard/limits', label: 'Upgrade' },
    tip: 'Daytona caps the vCPUs, memory and disk that running sandboxes use together. Higher tiers come with account top-ups.',
    connect: 'Connect Daytona in the operator organization’s Compute settings.',
    meters: [{ id: 'daytona.capacity', label: 'In use', unit: 'count', window: 'now', source: 'api',
      tip: 'Whichever of vCPUs, memory and disk is closest to the tier’s limit.' }] },
  { id: 'resend', name: 'Resend', plan: 'Free',
    link: { url: 'https://resend.com/settings/billing', label: 'Upgrade' },
    tip: 'Resend sends sign-up, password and alert emails. Free sends 100 a day and 3,000 a month; Pro is $20/month for 50,000.',
    connect: 'Choose Resend under Installation → Email.',
    meters: [
      { id: 'resend.day', label: 'Emails today', unit: 'count', window: 'day', source: 'count', limit: 100,
        tip: 'Emails sent since midnight UTC.' },
      { id: 'resend.month', label: 'Emails this month', unit: 'count', window: 'month', source: 'count', limit: 3_000,
        tip: 'Emails sent this month (UTC).' },
    ] },
  { id: 'agentmail', name: 'AgentMail', plan: 'Free',
    link: { url: 'https://www.agentmail.to/pricing', label: 'Upgrade' },
    tip: 'Agents receive sign-up codes and links here. Free has 3 inboxes and 3,000 emails a month.',
    connect: 'Connect AgentMail in the operator organization’s agent mail settings.',
    meters: [
      { id: 'agentmail.inboxes', label: 'Inboxes', unit: 'count', window: 'now', source: 'api', limit: 3,
        tip: 'Inboxes on the account.' },
      { id: 'agentmail.messages', label: 'Emails this month', unit: 'count', window: 'month', source: 'count', limit: 3_000,
        tip: 'Emails agents received this month (UTC), counted by tavya.' },
    ] },
  { id: 'letsencrypt', name: 'Let’s Encrypt',
    link: { url: 'https://letsencrypt.org/docs/rate-limits/', label: 'Limits' },
    tip: 'Every live preview gets its own certificate. Let’s Encrypt issues 50 new certificates a week per domain; after that new previews fail to load. A wildcard certificate removes the limit.',
    connect: 'Previews here aren’t served on their own domain.',
    meters: [{ id: 'letsencrypt.certificates', label: 'Certificates, 7 days', unit: 'count', window: 'week', source: 'count', limit: 50,
      tip: 'New preview certificates requested in the last 7 days, counted by tavya.' }] },
  { id: 'github', name: 'GitHub App',
    link: { url: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api', label: 'Limits' },
    tip: 'Each installation of the GitHub App may make 5,000 or more API calls an hour; past that GitHub refuses them until the hour resets.',
    connect: 'Set up the GitHub App under Installation → GitHub.',
    meters: [{ id: 'github.api', label: 'API calls this hour', unit: 'count', window: 'hour', source: 'api',
      tip: 'Calls this hour by the busiest installation, from GitHub.' }] },
  { id: 'host', name: 'This server',
    tip: 'The machine tavya runs on.',
    connect: '',
    meters: [
      { id: 'host.disk', label: 'Disk', unit: 'bytes', window: 'now', source: 'host',
        tip: 'Space used on the disk that holds tavya’s data.' },
      { id: 'host.memory', label: 'Memory', unit: 'bytes', window: 'now', source: 'host',
        tip: 'Memory in use on the server.' },
      { id: 'host.heap', label: 'Worker heap', unit: 'bytes', window: 'now', source: 'host',
        tip: 'Memory used by the process that runs agent work. If it reaches its limit the process crashes and restarts.' },
      { id: 'host.workflow-heap', label: 'Workflow heap', unit: 'bytes', window: 'now', source: 'host',
        tip: 'Memory holding open tasks. Near its limit tavya keeps fewer tasks in memory, so they respond more slowly; at it, the process restarts.' },
      { id: 'host.database', label: 'Database connections', unit: 'count', window: 'now', source: 'host',
        tip: 'Connections open to PostgreSQL, against its maximum.' },
    ] },
];

const METERS = new Map(SERVICE_CATALOG.flatMap((service) => service.meters.map((meter) => [meter.id, { service, meter }] as const)));

// ─── Settings ────────────────────────────────────────────────────────────────

export interface ServiceLimitSettings {
  /** The organization whose E2B, Daytona and AgentMail accounts are the operator's. */
  operatorOrganizationId?: string;
  cloudflare?: { accountId?: string };
  services?: Record<string, { plan?: string; link?: string; limits?: Record<string, number> }>;
}
export interface ServiceLimitSettingsInput {
  operatorOrganizationId?: string | null;
  cloudflare?: { accountId?: string | null; apiToken?: string | null };
  services?: Record<string, { plan?: string | null; link?: string | null; limits?: Record<string, number | null> }>;
}

export const SERVICE_LIMIT_SETTINGS_KEY = 'service-limits:settings';
export const SERVICE_LIMIT_STATE_KEY = 'service-limits:state';
/** The quota Resend reported with the last send; its own key, because sends
 * happen while the sampler holds the state above. */
const RESEND_QUOTA_KEY = 'service-limits:resend-quota';
export const CLOUDFLARE_TOKEN_HANDLE = 'service-limits:cloudflare:api-token';
/** The Composio project key, stored by ServiceConnections. */
const COMPOSIO_KEY_HANDLE = 'service-connections:composio:api-key';

export class ServiceLimitsInputError extends Error {}

/** Merge an operator's edit into the stored settings: `null` restores a default. */
export function mergeServiceLimitSettings(current: ServiceLimitSettings, input: ServiceLimitSettingsInput): ServiceLimitSettings {
  const next: ServiceLimitSettings = structuredClone(current);
  if (input.operatorOrganizationId !== undefined) {
    if (input.operatorOrganizationId === null) delete next.operatorOrganizationId;
    else if (typeof input.operatorOrganizationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.operatorOrganizationId))
      throw new ServiceLimitsInputError('Choose an organization');
    else next.operatorOrganizationId = input.operatorOrganizationId;
  }
  if (input.cloudflare?.accountId !== undefined) {
    const id = input.cloudflare.accountId === null ? '' : String(input.cloudflare.accountId).trim().toLowerCase();
    if (id && !/^[0-9a-f]{32}$/.test(id)) throw new ServiceLimitsInputError('A Cloudflare account ID is 32 hexadecimal characters');
    next.cloudflare = { ...next.cloudflare, ...(id ? { accountId: id } : {}) };
    if (!id) delete next.cloudflare.accountId;
  }
  for (const [serviceId, edit] of Object.entries(input.services ?? {})) {
    const spec = SERVICE_CATALOG.find((service) => service.id === serviceId);
    if (!spec) throw new ServiceLimitsInputError(`Unknown service: ${serviceId}`);
    const entry = { ...next.services?.[serviceId] };
    if (edit.plan !== undefined) {
      const plan = edit.plan === null ? '' : String(edit.plan).trim();
      if (plan.length > 60) throw new ServiceLimitsInputError('Plan names are at most 60 characters');
      if (plan) entry.plan = plan; else delete entry.plan;
    }
    if (edit.link !== undefined) {
      const link = edit.link === null ? '' : String(edit.link).trim();
      if (link) {
        let url: URL;
        try { url = new URL(link); } catch { throw new ServiceLimitsInputError('Enter the upgrade link as an https:// address'); }
        if (url.protocol !== 'https:' || link.length > 500) throw new ServiceLimitsInputError('Enter the upgrade link as an https:// address');
        entry.link = url.toString();
      } else delete entry.link;
    }
    for (const [meterId, value] of Object.entries(edit.limits ?? {})) {
      if (!spec.meters.some((meter) => meter.id === meterId)) throw new ServiceLimitsInputError(`Unknown measure: ${meterId}`);
      const limits = { ...entry.limits };
      if (value === null) delete limits[meterId];
      else if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e18)
        throw new ServiceLimitsInputError('A limit is a number above 0');
      else limits[meterId] = value;
      if (Object.keys(limits).length) entry.limits = limits; else delete entry.limits;
    }
    next.services = { ...next.services };
    if (Object.keys(entry).length) next.services[serviceId] = entry; else delete next.services[serviceId];
  }
  return next;
}

// ─── Alerts: thresholds, deduplication and clearing (pure) ─────────────────────

export type AlertLevel = 80 | 95 | 'failed';
export interface AlertInput {
  key: string;
  serviceId: string; serviceName: string;
  meterId?: string; label?: string; window?: MeterWindow;
  used?: number; limit?: number; unit?: MeterUnit;
  /** A probe that kept failing: the alert is about not being able to read it. */
  error?: string;
  link?: string;
}
export interface ServiceLimitAlert extends AlertInput {
  level: AlertLevel; period: string;
  /** First time this level is reached in this period: notify (push and email). */
  fresh: boolean;
}
/** key → level → the last period that level was announced in. */
export type AlertMemory = Record<string, Partial<Record<'80' | '95' | 'failed', string>>>;

const isoDay = (now: number) => new Date(now).toISOString().slice(0, 10);
/** Alerts are deduplicated per period: the counter's own window for daily and
 * monthly allowances, a UTC day for gauges and rolling windows (so one that
 * hovers around a threshold is announced at most once a day). */
export function alertPeriod(window: MeterWindow | undefined, now: number): string {
  return window === 'month' ? isoDay(now).slice(0, 7) : isoDay(now);
}

export function alertLevel(used: number | undefined, limit: number | undefined): 0 | 80 | 95 {
  if (used === undefined || !limit || limit <= 0) return 0;
  const ratio = used / limit;
  return ratio >= ALERT_THRESHOLDS[1] ? 95 : ratio >= ALERT_THRESHOLDS[0] ? 80 : 0;
}

/**
 * The alerts that stand now. A meter at or above 80% (95%) of its limit has an
 * alert; below 80% it has none, which withdraws it. Each level is announced
 * (`fresh`) once per period: crossing 95% also counts as having announced 80%,
 * and falling back and rising again within the period shows the alert without
 * announcing it again. Failures are inputs with `error`.
 */
export function evaluateAlerts(memory: AlertMemory, inputs: AlertInput[], now: number): { memory: AlertMemory; alerts: ServiceLimitAlert[] } {
  const next: AlertMemory = structuredClone(memory);
  const alerts: ServiceLimitAlert[] = [];
  for (const input of inputs) {
    const level: AlertLevel | 0 = input.error !== undefined ? 'failed' : alertLevel(input.used, input.limit);
    if (!level) continue;
    const period = alertPeriod(input.error !== undefined ? 'day' : input.window, now);
    const announced = next[input.key] ?? {};
    const fresh = announced[String(level) as '80'] !== period;
    if (fresh) {
      announced[String(level) as '80'] = period;
      if (level === 95) announced['80'] = period;
      next[input.key] = announced;
    }
    alerts.push({ ...input, level, period, fresh });
  }
  // Forget announcements older than any period still running.
  const oldest = isoDay(now - 40 * 86_400_000);
  for (const [key, levels] of Object.entries(next)) {
    for (const [level, period] of Object.entries(levels)) if (period && period.slice(0, 10) < oldest.slice(0, period.length))
      delete levels[level as '80'];
    if (!Object.keys(levels).length) delete next[key];
  }
  return { memory: next, alerts };
}

// ─── The service ─────────────────────────────────────────────────────────────

interface StoredReading { used: number; limit?: number; label?: string; unit?: MeterUnit; source?: UsedSource; detail?: string; at: number }
interface StoredService { status: 'ok' | 'not-connected' | 'failed'; checkedAt: number; error?: string; failures?: number; plan?: string }
export interface ServiceLimitState {
  checkedAt?: number;
  services: Record<string, StoredService>;
  readings: Record<string, StoredReading>;
  /** Hourly maxima for the last 7 days: [hourStartMs, used]. */
  history: Record<string, Array<[number, number]>>;
  alerts: AlertMemory;
}

export interface ServiceLimitMeterView {
  id: string; label: string; tip: string; unit: MeterUnit; window: MeterWindow;
  used?: number; usedSource: UsedSource; limit?: number; limitSource?: LimitSource;
  level: 0 | 80 | 95; detail?: string; at?: number;
  /** The highest reading of the last 7 days. */
  peak?: { used: number; at: number };
  history: Array<[number, number]>;
}
export interface ServiceLimitServiceView {
  id: string; name: string; tip: string;
  plan?: string; planSource?: LimitSource;
  link?: { url: string; label: string };
  status: 'ok' | 'not-connected' | 'failed' | 'unchecked';
  error?: string; connect?: string; checkedAt?: number;
  meters: ServiceLimitMeterView[];
}
export interface ServiceLimitsView {
  checkedAt?: number;
  thresholds: readonly number[];
  operatorOrganizationId: string;
  cloudflare: { accountId?: string; tokenConfigured: boolean };
  services: ServiceLimitServiceView[];
}

export interface ServiceLimitsDeps {
  store: Store;
  broker?: CredentialBroker;
  fetch?: typeof fetch;
  now?: () => number;
  providerConnections?: { resolve(organizationId: string | undefined, provider: string): Promise<{ apiKey: string; config: { apiUrl?: string } }> };
  githubApp?: { configured(): boolean; rateLimit(connection: GitConnection, signal?: AbortSignal): Promise<{ limit: number; remaining: number; resetAt: number }> };
  /** The activity worker's V8 heap (its own process in process mode). */
  workerHeap?: () => WorkerHeap | undefined;
  /** A directory on the disk that holds tavya's data. */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Receives every standing alert after each check (an empty list clears them). */
  notify?: (alerts: ServiceLimitAlert[]) => Promise<void>;
  probeTimeoutMs?: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** History: one point per hour for 7 days, at most 168 per meter. */
const HISTORY_MS = 7 * DAY;
const HEAP_FRESH_MS = 2 * 60_000;

export class ServiceLimitsService {
  private running?: Promise<ServiceLimitsView>;
  constructor(private deps: ServiceLimitsDeps) {}

  private now() { return this.deps.now?.() ?? Date.now(); }
  private get env() { return this.deps.env ?? process.env; }

  async settings(): Promise<ServiceLimitSettings> {
    try { return JSON.parse((await this.deps.store.kvGet(SERVICE_LIMIT_SETTINGS_KEY)) ?? '{}'); } catch { return {}; }
  }

  private async state(): Promise<ServiceLimitState> {
    let value: Partial<ServiceLimitState> = {};
    try { value = JSON.parse((await this.deps.store.kvGet(SERVICE_LIMIT_STATE_KEY)) ?? '{}'); } catch { /* start over */ }
    return { services: {}, readings: {}, history: {}, alerts: {}, ...value };
  }

  /** Record what Resend reported with a send: it counts sends from every client of the account. */
  async recordResendQuota(quota: { daily?: number; monthly?: number }): Promise<void> {
    if (quota.daily === undefined && quota.monthly === undefined) return;
    (await this.deps.store.kvSet(RESEND_QUOTA_KEY, JSON.stringify({ at: this.now(), ...quota })));
  }

  async configure(input: ServiceLimitSettingsInput): Promise<void> {
    const next = mergeServiceLimitSettings(await this.settings(), input);
    if (next.operatorOrganizationId && !(await this.deps.store.getOrganization(next.operatorOrganizationId)))
      throw new ServiceLimitsInputError('Choose an existing organization');
    const token = input.cloudflare?.apiToken;
    if (token !== undefined) {
      if (!this.deps.broker) throw new ServiceLimitsInputError('The vault is unavailable');
      const value = token === null ? '' : String(token).trim();
      if (value.length > 500 || /\s/.test(value)) throw new ServiceLimitsInputError('Paste the Cloudflare API token on its own');
      if (value) (await this.deps.broker.registerHandle(CLOUDFLARE_TOKEN_HANDLE, value, INSTALLATION_SCOPE));
      else (await this.deps.broker.deleteHandle(CLOUDFLARE_TOKEN_HANDLE));
    }
    (await this.deps.store.kvSet(SERVICE_LIMIT_SETTINGS_KEY, JSON.stringify(next)));
  }

  /** Sample every source, store the readings and raise or clear alerts.
   * Concurrent callers share one run. */
  run(): Promise<ServiceLimitsView> {
    return this.running ??= this.sample().finally(() => { this.running = undefined; });
  }

  private secret(handle: string | undefined, used?: Set<string>): string | undefined {
    if (!handle || !this.deps.broker?.hasHandle(handle)) return undefined;
    const value = this.deps.broker.resolve(handle, { caps: [`use-credential:${handle}`] });
    used?.add(value);
    return value;
  }

  private operatorOrganization(settings: ServiceLimitSettings): string {
    return settings.operatorOrganizationId ?? 'org_personal';
  }

  private cloudflareAccount(settings: ServiceLimitSettings): string | undefined {
    if (settings.cloudflare?.accountId) return settings.cloudflare.accountId;
    // The R2 object store's endpoint names the account.
    return /^https:\/\/([0-9a-f]{32})\.(?:[a-z]+\.)?r2\.cloudflarestorage\.com/i.exec(this.env.KARMAX_S3_ENDPOINT ?? '')?.[1]?.toLowerCase();
  }

  /** Each probe gets a `fetch` (and `signal`) bound to its own deadline, so a
   * provider that never answers is cancelled, not just abandoned. Every secret
   * a probe resolves goes into `secrets`, to be redacted from its errors. */
  private probes(settings: ServiceLimitSettings, now: number, secrets: Set<string>):
    Record<string, (fetcher: typeof fetch, signal: AbortSignal) => Promise<ProbeResult>> {
    const { store } = this.deps;
    const secret = (handle: string | undefined) => this.secret(handle, secrets);
    const day = isoDay(now);
    const month = `${day.slice(0, 7)}-01`;
    const organizationId = this.operatorOrganization(settings);
    const cloudflare = () => {
      const token = secret(CLOUDFLARE_TOKEN_HANDLE);
      const accountId = this.cloudflareAccount(settings);
      if (!token || !accountId) throw new NotConnected();
      return { token, accountId };
    };
    const connection = async (provider: string) => {
      let resolved;
      try { resolved = await this.deps.providerConnections!.resolve(organizationId, provider); }
      catch { throw new NotConnected(); }
      secrets.add(resolved.apiKey);
      return resolved;
    };
    return {
      'cloudflare-workers': async (fetcher) => cloudflareWorkersUsage({ fetch: fetcher, now, ...cloudflare() }),
      'cloudflare-r2': async (fetcher) => cloudflareR2Usage({ fetch: fetcher, now, ...cloudflare() }),
      composio: async (fetcher) => {
        const apiKey = secret(COMPOSIO_KEY_HANDLE);
        if (!apiKey) throw new NotConnected();
        return composioUsage({ fetch: fetcher, apiKey, toolCalls: await store.serviceUsageSince('composio.tool-calls', month) });
      },
      e2b: async (fetcher) => {
        if (!this.deps.providerConnections) throw new NotConnected();
        const { apiKey } = await connection('e2b');
        const seconds = await store.worldActiveSeconds(organizationId, 'e2b', Date.parse(`${month}T00:00:00Z`));
        return e2bUsage({ fetch: fetcher, apiKey, hours: seconds / 3600 });
      },
      daytona: async (fetcher) => {
        if (!this.deps.providerConnections) throw new NotConnected();
        const { apiKey, config } = await connection('daytona');
        return daytonaUsage({ fetch: fetcher, apiKey, apiUrl: config.apiUrl ?? this.env.DAYTONA_API_URL });
      },
      resend: async () => {
        let config: OutboundEmailConfig = {};
        try { config = JSON.parse((await store.kvGet('email:outbound')) ?? '{}'); } catch { /* not connected */ }
        if (config.provider !== 'resend' || !secret(config.secretHandle)) throw new NotConnected();
        const sentToday = await store.serviceUsageSince('email.sent:resend', day);
        const sentMonth = await store.serviceUsageSince('email.sent:resend', month);
        // Resend's own figure covers every sender on the account; ours only tavya.
        let quota: { at: number; daily?: number; monthly?: number } | undefined;
        try { quota = JSON.parse((await store.kvGet(RESEND_QUOTA_KEY)) ?? 'null') ?? undefined; } catch { /* counted only */ }
        const daily = quota?.daily !== undefined && quota.at >= Date.parse(`${day}T00:00:00Z`) ? quota.daily : undefined;
        const monthly = quota?.monthly !== undefined && quota.at >= Date.parse(`${month}T00:00:00Z`) ? quota.monthly : undefined;
        const pick = (counted: number, reported?: number): ProbeReading => reported !== undefined && reported >= counted
          ? { used: reported, source: 'api' } : { used: counted, source: 'count' };
        return { readings: { 'resend.day': pick(sentToday, daily), 'resend.month': pick(sentMonth, monthly) } };
      },
      agentmail: async (fetcher) => {
        let config: MailboxConfig = {};
        try { config = JSON.parse((await store.kvGet(`agent-mail:provider:${organizationId}`)) ?? '{}'); } catch { /* not connected */ }
        const apiKey = config.provider === 'agentmail' ? secret(`mailbox:agentmail:${organizationId}:auth`) : undefined;
        if (!apiKey) throw new NotConnected();
        return agentMailUsage({ fetch: fetcher, apiKey, base: this.env.KARMAX_AGENTMAIL_BASE,
          received: await store.serviceUsageSince(`agentmail.received:${organizationId}`, month) });
      },
      letsencrypt: async () => {
        if (!this.env.KARMAX_PREVIEW_ORIGIN) throw new NotConnected();
        // Daily buckets: the 7-day window is read a little wide, never short.
        const certificates = await store.serviceUsageSince('letsencrypt.certificates', isoDay(now - 7 * DAY));
        return { readings: { 'letsencrypt.certificates': { used: certificates } } };
      },
      github: async (_fetcher, signal) => {
        const app = this.deps.githubApp;
        if (!app?.configured()) throw new NotConnected();
        const connections = new Map<string, GitConnection>();
        for (const organization of await store.listOrganizations())
          for (const connection of await store.listGitConnections(organization.id))
            if (!connection.suspendedAt && !connections.has(connection.installationId)) connections.set(connection.installationId, connection);
        return githubUsage({ connections: [...connections.values()].slice(0, 50), rateLimit: (c) => app.rateLimit(c, signal) });
      },
      host: async () => {
        let disk: { used: number; total: number } | undefined;
        try {
          const stats = await fs.promises.statfs(this.deps.dataDir ?? os.homedir());
          disk = { total: stats.blocks * stats.bsize, used: (stats.blocks - stats.bavail) * stats.bsize };
        } catch { /* reported as absent */ }
        let available: number | undefined;
        try { available = Number(/^MemAvailable:\s+(\d+)/m.exec(await fs.promises.readFile('/proc/meminfo', 'utf8'))?.[1]) * 1024 || undefined; } catch { /* not Linux */ }
        // The heartbeat refreshes it every 10 s; an old one means the worker
        // isn't answering (or predates the field), which is not a reading.
        const heap = this.deps.workerHeap?.();
        return hostUsage({ disk, memory: { total: os.totalmem(), available: available ?? os.freemem() },
          heap: heap && now - heap.at < HEAP_FRESH_MS ? heap : undefined,
          database: await store.databaseConnections().catch(() => undefined) });
      },
    };
  }

  private async sample(): Promise<ServiceLimitsView> {
    const now = this.now();
    const settings = await this.settings();
    const state = await this.state();
    const secrets = new Set<string>();
    const probes = this.probes(settings, now, secrets);
    const timeout = this.deps.probeTimeoutMs ?? 30_000;
    const fetcher = this.deps.fetch ?? fetch;
    // Probes run concurrently, each against its own deadline: at the deadline
    // its requests are aborted and the run goes on without it.
    const results = await Promise.all(SERVICE_CATALOG.map(async (spec) => {
      const deadline = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const bounded: typeof fetch = (input, init) => fetcher(input, { ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal });
      try {
        const result = await Promise.race([probes[spec.id]!(bounded, deadline.signal), new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`no answer within ${Math.ceil(timeout / 1000)} s`));
            deadline.abort();
          }, timeout);
        })]);
        return { spec, result };
      } catch (error) {
        return { spec, error };
      } finally { clearTimeout(timer); }
    }));
    for (const { spec, result, error } of results) {
      const previous = state.services[spec.id];
      if (error instanceof NotConnected) {
        state.services[spec.id] = { status: 'not-connected', checkedAt: now };
        for (const meter of spec.meters) delete state.readings[meter.id];
        continue;
      }
      if (error || !result) {
        state.services[spec.id] = { ...previous, status: 'failed', checkedAt: now,
          error: probeError(error, secrets), failures: (previous?.status === 'failed' ? previous.failures ?? 1 : 0) + 1 };
        continue;
      }
      state.services[spec.id] = { status: 'ok', checkedAt: now, ...(result.plan ? { plan: result.plan } : {}) };
      for (const meter of spec.meters) {
        const reading = result.readings[meter.id];
        if (!reading) { delete state.readings[meter.id]; continue; }
        state.readings[meter.id] = { ...reading, at: now };
        const hour = now - (now % HOUR);
        const points = (state.history[meter.id] ?? []).filter(([at]) => at > now - HISTORY_MS);
        const last = points[points.length - 1];
        if (last && last[0] === hour) last[1] = Math.max(last[1], reading.used);
        else points.push([hour, reading.used]);
        state.history[meter.id] = points;
      }
    }
    for (const meterId of Object.keys(state.history)) if (!METERS.has(meterId)) delete state.history[meterId];
    state.checkedAt = now;
    const view = this.render(settings, state);
    const evaluated = evaluateAlerts(state.alerts, alertInputs(view, state), now);
    // Readings first; the announcements are recorded only once notify has
    // delivered them, so a failed delivery is announced again next run
    // (at least once) and a restart never forgets what was already sent.
    (await this.deps.store.kvSet(SERVICE_LIMIT_STATE_KEY, JSON.stringify(state)));
    (await this.deps.store.pruneServiceUsage(isoDay(now - 62 * DAY)));
    if (this.deps.notify) await this.deps.notify(evaluated.alerts);
    state.alerts = evaluated.memory;
    (await this.deps.store.kvSet(SERVICE_LIMIT_STATE_KEY, JSON.stringify(state)));
    return view;
  }

  async view(): Promise<ServiceLimitsView> {
    return this.render(await this.settings(), await this.state());
  }

  private render(settings: ServiceLimitSettings, state: ServiceLimitState): ServiceLimitsView {
    return {
      checkedAt: state.checkedAt,
      thresholds: ALERT_THRESHOLDS,
      operatorOrganizationId: this.operatorOrganization(settings),
      cloudflare: { accountId: this.cloudflareAccount(settings), tokenConfigured: Boolean(this.deps.broker?.hasHandle(CLOUDFLARE_TOKEN_HANDLE)) },
      services: SERVICE_CATALOG.map((spec) => {
        const entered = settings.services?.[spec.id];
        const stored = state.services[spec.id];
        const plan = entered?.plan ?? stored?.plan ?? spec.plan;
        const meters = spec.meters.flatMap((meter): ServiceLimitMeterView[] => {
          const reading = state.readings[meter.id];
          if (!reading && stored?.status === 'ok') return []; // e.g. no database connections on SQLite
          const limit = entered?.limits?.[meter.id] ?? reading?.limit ?? meter.limit;
          const limitSource: LimitSource | undefined = entered?.limits?.[meter.id] !== undefined ? 'entered'
            : reading?.limit !== undefined ? 'api' : meter.limit !== undefined ? 'published' : undefined;
          const history = state.history[meter.id] ?? [];
          const peak = history.reduce<{ used: number; at: number } | undefined>((best, [at, used]) =>
            !best || used >= best.used ? { used, at } : best, undefined);
          return [{
            id: meter.id, label: reading?.label ?? meter.label, tip: meter.tip, unit: reading?.unit ?? meter.unit, window: meter.window,
            used: reading?.used, usedSource: reading?.source ?? meter.source, limit, limitSource,
            level: alertLevel(reading?.used, limit), detail: reading?.detail, at: reading?.at, peak, history,
          }];
        });
        const link = entered?.link ? { url: entered.link, label: spec.link?.label ?? 'Upgrade' } : spec.link;
        return {
          id: spec.id, name: spec.name, tip: spec.tip,
          ...(plan ? { plan, planSource: entered?.plan ? 'entered' as const : stored?.plan ? 'api' as const : 'published' as const } : {}),
          ...(link ? { link } : {}),
          status: stored?.status ?? 'unchecked',
          ...(stored?.status === 'failed' ? { error: stored.error } : {}),
          ...(stored?.status === 'not-connected' && spec.connect ? { connect: spec.connect } : {}),
          checkedAt: stored?.checkedAt,
          meters,
        };
      }),
    };
  }
}

/** A probe has to fail twice in a row (about 30 minutes) before it is an
 * alert: one network blip is not worth waking the operator. */
const FAILURES_BEFORE_ALERT = 2;

function alertInputs(view: ServiceLimitsView, state: ServiceLimitState): AlertInput[] {
  return view.services.flatMap((service): AlertInput[] => {
    const base = { serviceId: service.id, serviceName: service.name, ...(service.link ? { link: service.link.url } : {}) };
    const failing = service.status === 'failed' && (state.services[service.id]?.failures ?? 0) >= FAILURES_BEFORE_ALERT
      ? [{ ...base, key: `${service.id}:probe`, error: service.error ?? 'no answer' }] : [];
    // A failed probe keeps its last readings: an alert it raised stands until a
    // reading shows usage has dropped.
    return [...failing, ...service.meters.map((meter) => ({ ...base, key: meter.id, meterId: meter.id, label: meter.label,
      window: meter.window, used: meter.used, limit: meter.limit, unit: meter.unit }))];
  });
}

/** Provider errors can echo the request: every credential the run resolved is
 * cut out verbatim (as world-provider `test()` does), then anything that looks
 * like a token, and the reason is kept short. */
export function probeError(error: unknown, secrets: Iterable<string> = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [...secrets].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length))
    message = message.split(secret).join('[redacted]');
  message = message.replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
  return message.slice(0, 200) || 'no answer';
}
