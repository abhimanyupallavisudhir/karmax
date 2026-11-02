import type { Store } from '../store/db.js';
import { computeChargeMicros, COMPUTE_PRICE_MULTIPLIER, STORAGE_PACK } from '../domain/entitlements.js';
import type { AccountPool } from '../domain/computer-limits.js';
import { usageCostUsd } from '../scheduling/costs.js';
import {
  capacityKey, defaultCapacity, kvJson, observedKey, SESSION_MINUTES, WEEK_MINUTES,
  type LearnedCapacity, type ObservedQuota, type ProbeSnapshot,
} from '../scheduling/state.js';

/**
 * The resource side of Insights (wiki features/insights): machines, storage
 * and model logins over the same days as the rest of the page, each with the
 * limit it runs against.
 *
 *   compute  `usage_events` world.active / world.disk: list cost (what the
 *            provider bills), what managed compute charged to credit (list ×
 *            COMPUTE_PRICE_MULTIPLIER), by provider, funding, project, task and
 *            machine size; the month's credit against cumulative charges; where
 *            provider "Any" routed new computers (`world.routed`); and, for
 *            operators, each managed account's peak use against its budget.
 *   storage  what managed storage holds per day (a daily snapshot, kv
 *            `storage-day:<org>:<YYYY-MM-DD>`, else estimated from what is
 *            stored now), by kind and project, against the plan's quota.
 *   logins   which model login served which share of the turns, and each
 *            subscription's 5-hour and weekly windows as the scheduler models
 *            them (API-equivalent dollars against learned capacity).
 *
 * Pure aggregation over rows the store already keeps; only
 * `recordStorageDay` writes (its snapshot).
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const LIST_LIMIT = 6;

/** The page's days: local days of the viewer, `days` long, ending today. */
export interface InsightWindow {
  days: number;
  /** Start of the first local day (ms). */
  from: number;
  /** Start of the preceding window of equal length. */
  previousFrom: number;
  now: number;
  /** Viewer's offset east of UTC, ms. */
  offset: number;
  /** Local-day number of the window's first day. */
  firstDay: number;
}

const localDay = (window: InsightWindow, ts: number) => Math.floor((ts + window.offset) / DAY);
const dayStart = (window: InsightWindow, index: number) => (window.firstDay + index) * DAY - window.offset;

/** Split [start, end) over the window's days, in proportion to time (a row
 * that lasted an hour across midnight counts half on each day). A row with no
 * duration falls on its start. */
function spread(window: InsightWindow, start: number, end: number, add: (index: number, share: number) => void): void {
  const first = localDay(window, start) - window.firstDay;
  if (!(end > start)) { if (first >= 0 && first < window.days) add(first, 1); return; }
  const last = localDay(window, end - 1) - window.firstDay;
  for (let index = Math.max(0, first); index <= Math.min(window.days - 1, last); index++) {
    const overlap = Math.min(end, dayStart(window, index + 1), window.now) - Math.max(start, dayStart(window, index));
    if (overlap > 0) add(index, overlap / (end - start));
  }
}

function parseJson(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, any>;
  try { return JSON.parse(String(value)) ?? {}; } catch { return {}; }
}

export type ComputeFundingKind = 'managed' | 'own';

export interface ComputeMoney {
  /** What the provider bills at list price (USD micros). */
  listMicros: number;
  /** What managed compute charged to the organization's credit (list × multiplier). */
  chargedMicros: number;
  /** Machine time (world.active), seconds. */
  activeSeconds: number;
  /** Disk kept, GB-hours (world.disk). */
  diskGbHours: number;
}

export interface ComputeBreakdownRow extends ComputeMoney { key: string; label: string; funding?: ComputeFundingKind; projectId?: string; num?: number }

export interface ComputeInsights {
  multiplier: number;
  totals: ComputeMoney & { managed: ComputeMoney; own: ComputeMoney };
  previous: ComputeMoney;
  daily: Array<ComputeMoney & { byProvider: Record<string, number>; byFunding: Record<ComputeFundingKind, number>;
    byProject: Record<string, number>; bySize: Record<string, number> }>;
  providers: ComputeBreakdownRow[];
  projects: ComputeBreakdownRow[];
  tasks: ComputeBreakdownRow[];
  sizes: ComputeBreakdownRow[];
  /** This calendar month's managed compute credit against what it charged. */
  credit?: ComputeCreditView;
  routing: RoutingInsights;
  /** Operators only: each managed account's peak use per day against its budget. */
  budgets?: Array<{ provider: string; pool: AccountPool; peakCpu: number[]; peakMachines: number[] }>;
}

export interface ComputeCreditView {
  month: string; from: number; to: number;
  /** The month's credit: the plan's, paid packs and gifted packs (USD micros at tavya's prices). */
  creditMicros: number; includedMicros: number; packMicros: number; giftMicros: number;
  /** Top-up credit left (lasts until used). */
  topUpMicros: number;
  usedMicros: number; heldMicros: number; availableMicros: number;
  /** Cumulative charges at the end of each UTC day of the month so far. */
  cumulative: number[];
  daysInMonth: number;
}

export interface RoutingInsights {
  /** New or restored computers provider "Any" placed in the window. */
  total: number;
  /** Placements where a better-ranked account was full and the next took it. */
  fellOver: number;
  /** Placements where nothing had room. */
  unplaced: number;
  providers: Array<{ provider: string; funding?: string; count: number; reasons: Array<{ reason: string; count: number }> }>;
  /** Accounts that were full when asked, and how often. */
  full: Array<{ provider: string; count: number }>;
}

export type StorageKind = 'resources' | 'workspaces' | 'reviewFiles' | 'other';
export const STORAGE_KINDS: StorageKind[] = ['resources', 'workspaces', 'reviewFiles', 'other'];
type KindBytes = Record<StorageKind, number>;
const noBytes = (): KindBytes => ({ resources: 0, workspaces: 0, reviewFiles: 0, other: 0 });

export interface StorageInsights {
  /** Bytes managed storage holds now, as the quota counts them. */
  bytes: number;
  byKind: KindBytes;
  /** Null: unmetered (a private installation). */
  quotaBytes: number | null;
  includedBytes: number | null;
  packs: { paid: number; gifted: number; packBytes: number; monthlyCents: number };
  daily: Array<{ bytes: number; byKind: KindBytes; byProject: Record<string, number>;
    /** Uploaded that day, by kind (checkpoint and resource saves, review files). */
    added: number;
    /** No snapshot that day: reconstructed from what is stored now (deleted data is missing). */
    estimated?: true }>;
  projects: Array<{ id: string; name: string; bytes: number; byKind: KindBytes }>;
}

export interface LoginInsights {
  id: string;
  provider: string;
  turns: number;
  tokens: number;
  /** API-equivalent dollars (list API prices): how subscriptions' quotas are measured. */
  usd: number;
  /** Share of all logins' API-equivalent dollars in the window. */
  share: number;
  daily: number[];
  dailyTokens: number[];
  /** Subscriptions only: dollars per window (learned from readings, else the prior). */
  capacity?: { session: number; week: number; learned: boolean };
  /** The last 7 days hourly: use of the 5-hour window and of the week, 0..1 of capacity, as the scheduler models it. */
  hourly?: { from: number; session: number[]; week: number[] };
  /** The provider's latest readings (share 0..1, reset time). */
  observed?: { session?: { utilization: number; resetsAt?: number; at: number }; week?: { utilization: number; resetsAt?: number; at: number } };
}

const emptyMoney = (): ComputeMoney => ({ listMicros: 0, chargedMicros: 0, activeSeconds: 0, diskGbHours: 0 });
const roundMoney = <T extends ComputeMoney>(entry: T): T => ({ ...entry, listMicros: Math.round(entry.listMicros),
  chargedMicros: Math.round(entry.chargedMicros), activeSeconds: Math.round(entry.activeSeconds),
  diskGbHours: Math.round(entry.diskGbHours * 100) / 100 });

/** A machine's size as people name it: "2 CPU · 4 GB". */
export function machineSizeLabel(metadata: Record<string, any>): string {
  const cpu = Number(metadata.cpu), memoryMb = Number(metadata.memoryMb);
  if (!(cpu > 0)) return 'Unknown size';
  const gb = memoryMb > 0 ? memoryMb / 1024 : undefined;
  return `${cpu} CPU${gb ? ` · ${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB` : ''}`;
}

interface UsageRow { organizationId: string; projectId: string | null; taskId: string | null; provider: string; kind: string;
  quantity: number; costMicros: number; fundingSource: string; metadata: Record<string, any>; startedAt: number; endedAt: number }

async function computeRows(store: Store, organizationId: string | null, from: number, to: number, managedOnly = false): Promise<UsageRow[]> {
  const rows = (await store.db.prepare(`SELECT organizationId, projectId, taskId, provider, kind, quantity, costMicros,
      fundingSource, metadata, startedAt, endedAt FROM usage_events
    WHERE kind IN ('world.active','world.disk')${organizationId ? ' AND organizationId=?' : ''}${managedOnly ? " AND fundingSource='managed'" : ''}
      AND startedAt<? AND (endedAt>? OR startedAt>=?)`)
    .all(...(organizationId ? [organizationId] : []), to, from, from)) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ organizationId: String(row.organizationId), projectId: row.projectId == null ? null : String(row.projectId),
    taskId: row.taskId == null ? null : String(row.taskId), provider: String(row.provider), kind: String(row.kind),
    quantity: Number(row.quantity) || 0, costMicros: Number(row.costMicros) || 0, fundingSource: String(row.fundingSource),
    metadata: parseJson(row.metadata), startedAt: Number(row.startedAt), endedAt: Number(row.endedAt) }));
}

/** One row's measures, scaled by the share of it that falls in a bucket. */
function measure(row: UsageRow, share: number): ComputeMoney {
  const managed = row.fundingSource === 'managed';
  const listMicros = row.costMicros * share;
  const seconds = row.quantity * share;
  return { listMicros, chargedMicros: managed ? listMicros * COMPUTE_PRICE_MULTIPLIER : 0,
    activeSeconds: row.kind === 'world.active' ? seconds : 0,
    diskGbHours: row.kind === 'world.disk' ? (seconds / 3600) * (Number(row.metadata.diskGb) || 0) : 0 };
}
function add(into: ComputeMoney, value: ComputeMoney): void {
  into.listMicros += value.listMicros; into.chargedMicros += value.chargedMicros;
  into.activeSeconds += value.activeSeconds; into.diskGbHours += value.diskGbHours;
}

export async function computeInsights(store: Store, organizationId: string, window: InsightWindow, context: {
  projectName: Map<string, string>;
  task: (taskId: string) => { title: string; num?: number; projectId: string } | undefined;
  /** Hosted with managed compute offered: show the month's credit. */
  credit?: boolean;
  /** Operators: the installation's managed accounts and their budgets. */
  budgets?: Array<{ provider: string; pool?: AccountPool }>;
}): Promise<ComputeInsights> {
  const rows = await computeRows(store, organizationId, window.previousFrom, window.now + 1);
  const totals = { ...emptyMoney(), managed: emptyMoney(), own: emptyMoney() };
  const previous = emptyMoney();
  const daily = Array.from({ length: window.days }, () => ({ ...emptyMoney(), byProvider: {} as Record<string, number>,
    byFunding: { managed: 0, own: 0 } as Record<ComputeFundingKind, number>, byProject: {} as Record<string, number>,
    bySize: {} as Record<string, number> }));
  const groups = { providers: new Map<string, ComputeBreakdownRow>(), projects: new Map<string, ComputeBreakdownRow>(),
    tasks: new Map<string, ComputeBreakdownRow>(), sizes: new Map<string, ComputeBreakdownRow>() };
  const group = (map: Map<string, ComputeBreakdownRow>, key: string, make: () => Omit<ComputeBreakdownRow, keyof ComputeMoney>) => {
    let entry = map.get(key);
    if (!entry) map.set(key, entry = { ...make(), ...emptyMoney() });
    return entry;
  };
  // A disk row says nothing about the machine: its size is the task's machine,
  // so disk cost goes to the size its machine ran at.
  const sizeOfTask = new Map<string, string>();
  for (const row of rows) if (row.kind === 'world.active' && row.taskId && Number(row.metadata.cpu) > 0)
    sizeOfTask.set(row.taskId, machineSizeLabel(row.metadata));
  for (const row of rows) {
    const funding: ComputeFundingKind = row.fundingSource === 'managed' ? 'managed' : 'own';
    if (row.startedAt < window.from) {
      const part = Math.min(1, row.endedAt > row.startedAt ? Math.max(0, (Math.min(row.endedAt, window.from) - row.startedAt) / (row.endedAt - row.startedAt)) : 1);
      add(previous, measure(row, part));
    }
    const size = row.kind === 'world.active' ? machineSizeLabel(row.metadata) : (row.taskId && sizeOfTask.get(row.taskId)) || 'Unknown size';
    let inside = 0;
    spread(window, row.startedAt, row.endedAt, (index, share) => {
      inside += share;
      const value = measure(row, share);
      const day = daily[index]!;
      add(day, value);
      day.byProvider[row.provider] = (day.byProvider[row.provider] ?? 0) + value.listMicros;
      day.byFunding[funding] += value.listMicros;
      day.byProject[row.projectId ?? ''] = (day.byProject[row.projectId ?? ''] ?? 0) + value.listMicros;
      day.bySize[size] = (day.bySize[size] ?? 0) + value.listMicros;
    });
    if (!inside) continue;
    const value = measure(row, inside);
    add(totals, value); add(totals[funding], value);
    add(group(groups.providers, `${row.provider}\u0000${funding}`, () => ({ key: row.provider, label: row.provider, funding })), value);
    add(group(groups.projects, row.projectId ?? '', () => ({ key: row.projectId ?? '',
      label: row.projectId ? context.projectName.get(row.projectId) ?? row.projectId : 'Unattributed' })), value);
    if (row.taskId) add(group(groups.tasks, row.taskId, () => {
      const task = context.task(row.taskId!);
      return { key: row.taskId!, label: task?.title ?? row.taskId!, ...(task ? { projectId: task.projectId } : {}),
        ...(task?.num != null ? { num: task.num } : {}) };
    }), value);
    add(group(groups.sizes, size, () => ({ key: size, label: size })), value);
  }
  const ranked = (map: Map<string, ComputeBreakdownRow>, limit = Infinity) => [...map.values()].map(roundMoney)
    .sort((a, b) => b.listMicros - a.listMicros || b.activeSeconds - a.activeSeconds).slice(0, limit);
  const result: ComputeInsights = {
    multiplier: COMPUTE_PRICE_MULTIPLIER,
    totals: { ...roundMoney(totals), managed: roundMoney(totals.managed), own: roundMoney(totals.own) },
    previous: roundMoney(previous),
    daily: daily.map((day) => ({ ...roundMoney(day), byProvider: roundValues(day.byProvider), byFunding: roundValues(day.byFunding),
      byProject: roundValues(day.byProject), bySize: roundValues(day.bySize) })),
    providers: ranked(groups.providers), projects: ranked(groups.projects), tasks: ranked(groups.tasks, LIST_LIMIT * 2),
    sizes: ranked(groups.sizes),
    routing: await routingInsights(store, organizationId, window),
  };
  if (context.credit) {
    const credit = await creditView(store, organizationId, window.now);
    if (credit) result.credit = credit;
  }
  if (context.budgets?.length) result.budgets = await budgetInsights(store, window, context.budgets);
  return result;
}

function roundValues<K extends string>(values: Record<K, number>): Record<K, number> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(value as number)])) as Record<K, number>;
}

/** The month's credit and how it was used, day by day (UTC, as billing counts). */
async function creditView(store: Store, organizationId: string, now: number): Promise<ComputeCreditView | undefined> {
  const { computeCredit } = await import('../world/managed-compute.js');
  const credit = await computeCredit(store, organizationId, now);
  if (credit.creditMicros == null) return undefined;
  const entitlements = await store.organizationEntitlements(organizationId);
  const daysInMonth = Math.round((credit.to - credit.from) / DAY);
  const today = Math.min(daysInMonth - 1, Math.floor((now - credit.from) / DAY));
  const perDay = Array.from({ length: today + 1 }, () => 0);
  for (const row of await computeRows(store, organizationId, credit.from, credit.to, true)) {
    const start = Math.max(row.startedAt, credit.from), end = Math.min(row.endedAt, credit.to);
    const duration = row.endedAt - row.startedAt;
    if (!(duration > 0)) { const index = Math.floor((row.startedAt - credit.from) / DAY); if (perDay[index] !== undefined) perDay[index] += row.costMicros; continue; }
    for (let index = Math.floor((start - credit.from) / DAY); index <= Math.min(today, Math.floor((end - 1 - credit.from) / DAY)); index++) {
      const overlap = Math.min(end, credit.from + (index + 1) * DAY) - Math.max(start, credit.from + index * DAY);
      if (overlap > 0) perDay[index]! += row.costMicros * overlap / duration;
    }
  }
  let running = 0;
  const cumulative = perDay.map((micros) => (running += micros, computeChargeMicros(running)));
  const packMicros = entitlements.computePacks * entitlements.computePackCreditMicros;
  const giftMicros = entitlements.giftedComputePacks * entitlements.computePackCreditMicros;
  return { month: new Date(credit.from).toISOString().slice(0, 7), from: credit.from, to: credit.to,
    creditMicros: credit.creditMicros, includedMicros: entitlements.includedComputeCreditMicros ?? 0, packMicros, giftMicros,
    topUpMicros: credit.topUpMicros, usedMicros: credit.usedMicros, heldMicros: credit.heldMicros,
    availableMicros: credit.availableMicros ?? 0, cumulative, daysInMonth };
}

/** Where provider "Any" put this organization's computers, and why. */
async function routingInsights(store: Store, organizationId: string, window: InsightWindow): Promise<RoutingInsights> {
  const events = (await store.db.prepare(`SELECT e.payload FROM events e JOIN tasks t ON t.id=e.taskId JOIN projects p ON p.id=t.projectId
    WHERE e.type='world.routed' AND COALESCE(p.organizationId, 'org_personal')=? AND e.ts>=? AND e.ts<=?`)
    .all(organizationId, window.from, window.now)) as Array<{ payload: string }>;
  const providers = new Map<string, { provider: string; funding?: string; count: number; reasons: Map<string, number> }>();
  const full = new Map<string, number>();
  let fellOver = 0, unplaced = 0;
  for (const { payload } of events) {
    const decision = parseJson(payload);
    const candidates: Array<{ provider?: string; outcome?: string }> = Array.isArray(decision.candidates) ? decision.candidates : [];
    const refused = candidates.filter((candidate) => candidate.outcome === 'full' || candidate.outcome === 'down');
    for (const candidate of refused) if (candidate.provider) full.set(candidate.provider, (full.get(candidate.provider) ?? 0) + 1);
    if (!decision.provider) { unplaced++; continue; }
    if (refused.length) fellOver++;
    const key = `${decision.provider}\u0000${decision.funding ?? ''}`;
    let entry = providers.get(key);
    if (!entry) providers.set(key, entry = { provider: String(decision.provider), ...(decision.funding ? { funding: String(decision.funding) } : {}),
      count: 0, reasons: new Map() });
    entry.count++;
    // "cheapest that fits; Hetzner was full" → the rule's own words, not the circumstance.
    const reason = String(decision.reason ?? '').split(';')[0]!.trim() || 'chosen';
    entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
  }
  return {
    total: events.length - unplaced, fellOver, unplaced,
    providers: [...providers.values()].sort((a, b) => b.count - a.count).map((entry) => ({ provider: entry.provider,
      ...(entry.funding ? { funding: entry.funding } : {}), count: entry.count,
      reasons: [...entry.reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 3) })),
    full: [...full].map(([provider, count]) => ({ provider, count })).sort((a, b) => b.count - a.count),
  };
}

/** Each managed account's peak CPUs and machines running at once per day,
 * across every organization (what its budget bounds), from booked machine time. */
async function budgetInsights(store: Store, window: InsightWindow, accounts: Array<{ provider: string; pool?: AccountPool }>):
  Promise<NonNullable<ComputeInsights['budgets']>> {
  const rows = (await computeRows(store, null, window.from, window.now + 1, true)).filter((row) => row.kind === 'world.active' && row.endedAt > row.startedAt);
  return accounts.map((account) => {
    const peakCpu = Array.from({ length: window.days }, () => 0);
    const peakMachines = Array.from({ length: window.days }, () => 0);
    // Sweep: at equal times an end comes before a start, so back-to-back
    // rows of one machine (hourly bookings) never count twice.
    const edges: Array<[number, number, number]> = [];
    for (const row of rows.filter((value) => value.provider === account.provider)) {
      const cpu = Number(row.metadata.cpu) || 0;
      edges.push([row.startedAt, 1, cpu], [row.endedAt, -1, -cpu]);
    }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let machines = 0, cpu = 0, day = -1;
    const note = (index: number) => {
      if (index < 0 || index >= window.days) return;
      peakMachines[index] = Math.max(peakMachines[index]!, machines);
      peakCpu[index] = Math.max(peakCpu[index]!, cpu);
    };
    for (const [at, dm, dc] of edges) {
      // Machines still running at midnight run on the next day too.
      const index = localDay(window, at) - window.firstDay;
      for (; day < Math.min(index, window.days); day++) note(day + 1);
      machines += dm; cpu += dc;
      if (dm > 0) note(index);
    }
    return { provider: account.provider, pool: account.pool ?? {}, peakCpu, peakMachines };
  }).filter((account) => Object.keys(account.pool).length || account.peakMachines.some(Boolean));
}

// ── Storage ──────────────────────────────────────────────────────────────────

export const storageDayKey = (organizationId: string, day: string) => `storage-day:${organizationId}:${day}`;
const STORAGE_DAY_KEEP_DAYS = 120;

interface StorageNow { bytes: number; byKind: KindBytes; byProject: Map<string, KindBytes>;
  /** For days without a snapshot: when each stored thing appeared. */
  dated: Array<{ at: number; projectId: string; kind: StorageKind; bytes: number }> }

/** What managed storage holds now, as the quota counts it, split by kind and project. */
async function storageNow(store: Store, organizationId: string): Promise<StorageNow> {
  const managed = (await store.listStorageLocations(organizationId)).find((location) => location.kind === 'managed');
  const bytes = managed ? (await store.storageLocationUsage(managed.id)).retainedBytes : 0;
  const contents = await store.organizationStorageContents(organizationId);
  const byKind = noBytes();
  const byProject = new Map<string, KindBytes>();
  const dated: StorageNow['dated'] = [];
  const put = (projectId: string, kind: StorageKind, value: number, at: number) => {
    if (!(value > 0)) return;
    byKind[kind] += value;
    if (!byProject.has(projectId)) byProject.set(projectId, noBytes());
    byProject.get(projectId)![kind] += value;
    dated.push({ at, projectId, kind, bytes: value });
  };
  const firstRevision = new Map<string, number>();
  for (const revision of contents.revisions)
    firstRevision.set(revision.attachmentId, Math.min(firstRevision.get(revision.attachmentId) ?? Infinity, revision.createdAt));
  for (const attachment of contents.attachments)
    put(attachment.projectId, 'resources', contents.repositoryBytes.get(attachment.id) ?? 0, firstRevision.get(attachment.id) ?? 0);
  for (const checkpoint of contents.checkpoints) put(checkpoint.projectId, 'workspaces', checkpoint.bytes, checkpoint.createdAt);
  for (const artifact of contents.artifacts) put(artifact.projectId, 'reviewFiles', artifact.bytes, artifact.createdAt);
  const counted = byKind.resources + byKind.workspaces + byKind.reviewFiles;
  byKind.other = managed ? Math.max(0, bytes - counted) : 0;
  return { bytes: managed ? bytes : counted, byKind, byProject, dated };
}

interface StorageSnapshot { at: number; bytes: number; byKind: KindBytes; byProject: Record<string, number> }

/** Remember what the organization stores today (the last write of a UTC day
 * stands for it); keeps STORAGE_DAY_KEEP_DAYS days. Hourly, from the managed
 * storage sweep. */
export async function recordStorageDay(store: Store, organizationId: string, now = Date.now()): Promise<void> {
  const current = await storageNow(store, organizationId);
  const snapshot: StorageSnapshot = { at: now, bytes: current.bytes, byKind: current.byKind,
    byProject: Object.fromEntries([...current.byProject].map(([id, kinds]) => [id, STORAGE_KINDS.reduce((sum, kind) => sum + kinds[kind], 0)])) };
  await store.kvSet(storageDayKey(organizationId, new Date(now).toISOString().slice(0, 10)), JSON.stringify(snapshot));
  const oldest = new Date(now - STORAGE_DAY_KEEP_DAYS * DAY).toISOString().slice(0, 10);
  for (const entry of await store.kvEntries(`storage-day:${organizationId}:`))
    if (entry.key.slice(-10) < oldest) await store.kvDelete(entry.key);
}

export async function storageInsights(store: Store, organizationId: string, window: InsightWindow,
  projectName: Map<string, string>): Promise<StorageInsights> {
  const [current, entitlements, snapshots, uploads] = await Promise.all([
    storageNow(store, organizationId),
    store.organizationEntitlements(organizationId),
    store.kvEntries(`storage-day:${organizationId}:`),
    store.db.prepare(`SELECT quantity, startedAt FROM usage_events WHERE organizationId=? AND fundingSource='managed'
      AND kind IN ('checkpoint.storage','resource.storage') AND startedAt>=? AND startedAt<=?`).all(organizationId, window.from, window.now),
  ]);
  const byDay = new Map<string, StorageSnapshot>();
  for (const entry of snapshots) { try { byDay.set(entry.key.slice(-10), JSON.parse(entry.value)); } catch { /* unreadable */ } }
  const daily: StorageInsights['daily'] = Array.from({ length: window.days }, (_, index) => {
    const day = new Date((window.firstDay + index) * DAY).toISOString().slice(0, 10);
    if (index === window.days - 1) return { bytes: current.bytes, byKind: { ...current.byKind },
      byProject: Object.fromEntries([...current.byProject].map(([id, kinds]) => [id, STORAGE_KINDS.reduce((sum, kind) => sum + kinds[kind], 0)])), added: 0 };
    const snapshot = byDay.get(day);
    if (snapshot) return { bytes: snapshot.bytes, byKind: { ...noBytes(), ...snapshot.byKind }, byProject: snapshot.byProject ?? {}, added: 0 };
    // Before snapshots: what is stored now and existed by the end of that day.
    const end = dayStart(window, index + 1);
    const byKind = noBytes();
    const perProject: Record<string, number> = {};
    for (const item of current.dated) if (item.at < end) { byKind[item.kind] += item.bytes; perProject[item.projectId] = (perProject[item.projectId] ?? 0) + item.bytes; }
    return { bytes: STORAGE_KINDS.reduce((sum, kind) => sum + byKind[kind], 0), byKind, byProject: perProject, added: 0, estimated: true };
  });
  for (const row of uploads as Array<{ quantity: number; startedAt: number }>) {
    const index = localDay(window, Number(row.startedAt)) - window.firstDay;
    if (daily[index]) daily[index]!.added += Number(row.quantity) || 0;
  }
  const paid = entitlements.storagePacks, gifted = entitlements.giftedStoragePacks;
  return {
    bytes: current.bytes, byKind: current.byKind,
    quotaBytes: entitlements.storageQuotaBytes, includedBytes: entitlements.includedStorageBytes,
    packs: { paid, gifted, packBytes: entitlements.storagePackBytes, monthlyCents: paid * STORAGE_PACK.monthlyPriceCents },
    daily,
    projects: [...current.byProject].map(([id, byKind]) => ({ id, name: projectName.get(id) ?? id,
      bytes: STORAGE_KINDS.reduce((sum, kind) => sum + byKind[kind], 0), byKind }))
      .filter((project) => project.bytes > 0).sort((a, b) => b.bytes - a.bytes),
  };
}

// ── Model logins ─────────────────────────────────────────────────────────────

export interface TokenRow { provider: string; quantity: number; metadata: Record<string, any>; startedAt: number }

/** API-equivalent dollars of one turn's reported usage (scheduling/costs.ts). */
export function turnUsd(metadata: Record<string, any>): number {
  const counters = { inputTokens: Number(metadata.inputTokens) || 0, outputTokens: Number(metadata.outputTokens) || 0,
    cacheReadTokens: Number(metadata.cacheReadTokens) || 0, cacheWriteTokens: Number(metadata.cacheWriteTokens) || 0,
    inputTokensIncludeCacheRead: Boolean(metadata.inputTokensIncludeCacheRead),
    ...(metadata.models && typeof metadata.models === 'object' ? { models: metadata.models } : {}) };
  return usageCostUsd(counters, typeof metadata.model === 'string' ? metadata.model : undefined);
}

/** Which login served which share, and each subscription's windows against
 * its capacity (wiki features/quota-scheduling). `rows` are the window's and
 * the previous week's agent.tokens rows. */
export async function loginInsights(store: Store, rows: TokenRow[], window: InsightWindow): Promise<LoginInsights[]> {
  const logins = new Map<string, LoginInsights & { turnsAt: Array<[number, number]> }>();
  const hoursFrom = Math.floor((window.now - 7 * DAY) / HOUR) * HOUR;
  for (const row of rows) {
    const id = typeof row.metadata.account === 'string' && row.metadata.account ? row.metadata.account : `unattributed:${row.provider}`;
    let entry = logins.get(id);
    if (!entry) logins.set(id, entry = { id, provider: row.provider, turns: 0, tokens: 0, usd: 0, share: 0,
      daily: Array.from({ length: window.days }, () => 0), dailyTokens: Array.from({ length: window.days }, () => 0), turnsAt: [] });
    const usd = turnUsd(row.metadata);
    // The windows look back up to a week before the chart's first hour.
    if (row.startedAt >= hoursFrom - 7 * DAY) entry.turnsAt.push([row.startedAt, usd]);
    if (row.startedAt < window.from || row.startedAt > window.now) continue;
    const index = localDay(window, row.startedAt) - window.firstDay;
    entry.turns++; entry.tokens += row.quantity; entry.usd += usd;
    entry.daily[index]! += usd; entry.dailyTokens[index]! += row.quantity;
  }
  const total = [...logins.values()].reduce((sum, login) => sum + login.usd, 0);
  const hours = Math.ceil((window.now - hoursFrom) / HOUR);
  const out: LoginInsights[] = [];
  for (const { turnsAt, ...login } of logins.values()) {
    if (!login.turns) continue;
    login.share = total > 0 ? login.usd / total : 0;
    login.usd = Math.round(login.usd * 100) / 100;
    login.daily = login.daily.map((value) => Math.round(value * 100) / 100);
    if (login.id.startsWith('login:')) {
      const [observed, learned, probe] = await Promise.all([
        kvJson<ObservedQuota>(store, observedKey(login.id)),
        kvJson<LearnedCapacity>(store, capacityKey(login.id)),
        kvJson<ProbeSnapshot>(store, `usage:${login.id}`),
      ]);
      const capacity = { session: learned?.session?.usd ?? defaultCapacity('session'), week: learned?.week?.usd ?? defaultCapacity('week'),
        learned: Boolean(learned?.session || learned?.week) };
      login.capacity = { session: Math.round(capacity.session * 100) / 100, week: Math.round(capacity.week * 100) / 100, learned: capacity.learned };
      const reading = (kind: 'session' | 'week') => {
        const stream = observed?.[kind];
        const probed = probe?.ok ? probe[kind] : undefined;
        if (stream && (!probed || stream.at >= (probe?.at ?? 0)))
          return { utilization: stream.utilization, ...(stream.resetsAt ? { resetsAt: stream.resetsAt } : {}), at: stream.at };
        return probed ? { utilization: probed.pct / 100, ...(probed.resetAt ? { resetsAt: probed.resetAt } : {}), at: probe!.at } : undefined;
      };
      const session = reading('session'), week = reading('week');
      if (session || week) login.observed = { ...(session ? { session } : {}), ...(week ? { week } : {}) };
      login.hourly = windowSeries(turnsAt, hoursFrom, hours, capacity, week?.resetsAt);
    }
    out.push(login);
  }
  return out.sort((a, b) => b.usd - a.usd || b.turns - a.turns);
}

/** Hour by hour, how full the 5-hour window and the week were. A 5-hour
 * window opens at the first turn after the last one closed; the week resets
 * at a fixed time (the provider's reading names one; else a week after the
 * first turn seen). Turns are counted when they finished. */
function windowSeries(turns: Array<[number, number]>, from: number, hours: number,
  capacity: { session: number; week: number }, weekResetsAt?: number): { from: number; session: number[]; week: number[] } {
  const sorted = [...turns].sort((a, b) => a[0] - b[0]);
  const sessionMs = SESSION_MINUTES * 60_000, weekMs = WEEK_MINUTES * 60_000;
  const anchor = weekResetsAt ?? (sorted[0]?.[0] ?? from) + weekMs;
  const weekStart = (at: number) => anchor - Math.ceil((anchor - at) / weekMs) * weekMs;
  const session: number[] = [], week: number[] = [];
  let next = 0, windowStart = -Infinity, windowUsd = 0, currentWeek = -Infinity, weekUsd = 0;
  for (let hour = 0; hour < hours; hour++) {
    const end = from + (hour + 1) * HOUR;
    for (; next < sorted.length && sorted[next]![0] < end; next++) {
      const [at, usd] = sorted[next]!;
      if (at >= windowStart + sessionMs) { windowStart = at; windowUsd = 0; }
      windowUsd += usd;
      const start = weekStart(at);
      if (start !== currentWeek) { currentWeek = start; weekUsd = 0; }
      weekUsd += usd;
    }
    const sessionOpen = end - 1 < windowStart + sessionMs;
    session.push(sessionOpen ? Math.round((windowUsd / capacity.session) * 1000) / 1000 : 0);
    week.push(weekStart(end - 1) === currentWeek ? Math.round((weekUsd / capacity.week) * 1000) / 1000 : 0);
  }
  return { from, session, week };
}
