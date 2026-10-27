import type { QuotaWindow } from './policy.js';

/**
 * What the scheduler remembers between decisions, in the store's kv (wiki
 * features/quota-scheduling):
 *
 *   scheduling:tree:<root task>   a task tree's spend, burn rate and last login
 *   quota:spent:<credential>      dollars a login has spent, cumulative
 *   quota:observed:<credential>   its latest usage readings per window, with the spend at that moment
 *   quota:capacity:<credential>   dollars per full window, learned from readings against spend
 *   scheduling:order:<org>        orders people set by dragging (order.ts)
 *   scheduling:queue:<org>        the last plan, for the Queues page
 *   scheduling:model:<org>        the fitted forecast, size law and burn rate (model.ts)
 */
export interface KvStore {
  kvGet(k: string): Promise<string | undefined>;
  kvSet(k: string, v: string): Promise<void> | void;
  kvCompareAndSet(k: string, expected: string | undefined, next: string | undefined): Promise<boolean>;
}

/** Read-modify-write a JSON kv entry atomically (compare-and-set, retried). */
export async function kvUpdate<T>(store: KvStore, key: string, fn: (prev: T | undefined) => T | undefined): Promise<T | undefined> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const raw = await store.kvGet(key);
    let prev: T | undefined;
    try { prev = raw === undefined ? undefined : JSON.parse(raw) as T; } catch { prev = undefined; }
    const next = fn(prev);
    if (await store.kvCompareAndSet(key, raw, next === undefined ? undefined : JSON.stringify(next))) return next;
  }
  throw new Error(`could not update ${key}: too much contention`);
}

export async function kvJson<T>(store: Pick<KvStore, 'kvGet'>, key: string): Promise<T | undefined> {
  const raw = await store.kvGet(key);
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

export interface TreeLedger {
  organizationId?: string;
  /** API-equivalent dollars the tree has spent. */
  spent: number;
  /** Spend per minute of one running turn (exponentially weighted). */
  burn?: number;
  lastLogin?: string;
  /** When its last turn ended (ms). */
  lastTurnAt?: number;
  /** Turns it has run. */
  turns?: number;
}

export const treeKey = (root: string) => `scheduling:tree:${root}`;
export const spentKey = (credential: string) => `quota:spent:${credential}`;
export const observedKey = (credential: string) => `quota:observed:${credential}`;
export const capacityKey = (credential: string) => `quota:capacity:${credential}`;
export const orderKey = (organization: string) => `scheduling:order:${organization}`;
export const queueKey = (organization: string) => `scheduling:queue:${organization}`;
export const modelKey = (organization: string) => `scheduling:model:${organization}`;

/** A finished turn: what it cost, how long it ran, where. */
export async function recordTurnSpend(store: KvStore, turn: { root: string; organizationId?: string; credential?: string;
  usd: number; minutes: number; at: number }): Promise<void> {
  if (!(turn.usd >= 0)) return;
  await kvUpdate<TreeLedger>(store, treeKey(turn.root), (prev) => {
    const burnSample = turn.minutes > 0.25 ? turn.usd / turn.minutes : undefined;
    return {
      ...prev,
      ...(turn.organizationId ? { organizationId: turn.organizationId } : {}),
      spent: (prev?.spent ?? 0) + turn.usd,
      ...(burnSample !== undefined ? { burn: prev?.burn === undefined ? burnSample : 0.7 * prev.burn + 0.3 * burnSample }
        : prev?.burn !== undefined ? { burn: prev.burn } : {}),
      ...(turn.credential ? { lastLogin: turn.credential } : prev?.lastLogin ? { lastLogin: prev.lastLogin } : {}),
      lastTurnAt: turn.at,
      turns: (prev?.turns ?? 0) + 1,
    };
  });
  if (turn.credential && turn.usd > 0) {
    await kvUpdate<{ usd: number; at: number }>(store, spentKey(turn.credential), (prev) => ({ usd: (prev?.usd ?? 0) + turn.usd, at: turn.at }));
  }
}

export type WindowKind = QuotaWindow['kind'];

export interface QuotaReading {
  /** Share of the window used, 0..1. */
  utilization: number;
  /** When the window resets (ms), if known. */
  resetsAt?: number;
  /** When it was read (ms). */
  at: number;
  /** The login's cumulative spend when it was read. */
  spentAt: number;
}

export type ObservedQuota = Partial<Record<WindowKind, QuotaReading>>;
export type LearnedCapacity = Partial<Record<WindowKind, { usd: number; samples: number }>>;

/** A login's usage reading (from a turn's stream or a usage probe): remembered, and used to learn its capacity. */
export async function recordQuotaReading(store: KvStore, credential: string, window: WindowKind,
  reading: { utilization: number; resetsAt?: number; at: number }): Promise<void> {
  if (!(reading.utilization >= 0 && reading.utilization <= 1.5)) return;
  const spent = (await kvJson<{ usd: number }>(store, spentKey(credential)))?.usd ?? 0;
  let previous: QuotaReading | undefined;
  await kvUpdate<ObservedQuota>(store, observedKey(credential), (prev) => {
    previous = prev?.[window];
    if (previous && previous.at > reading.at) return prev;
    return { ...prev, [window]: { utilization: reading.utilization, ...(reading.resetsAt ? { resetsAt: reading.resetsAt } : {}),
      at: reading.at, spentAt: spent } };
  });
  // Capacity: dollars spent between two readings of the same window, over the share it moved.
  const sameWindow = previous && (!previous.resetsAt || !reading.resetsAt || Math.abs(previous.resetsAt - reading.resetsAt) < 120_000);
  const moved = previous ? reading.utilization - previous.utilization : 0;
  const dollars = previous ? spent - previous.spentAt : 0;
  if (sameWindow && moved >= 0.02 && dollars > 0) {
    const sample = dollars / moved;
    await kvUpdate<LearnedCapacity>(store, capacityKey(credential), (prev) => {
      const old = prev?.[window];
      const prior = defaultCapacity(window);
      const clamped = Math.min(prior * 20, Math.max(prior / 20, sample));
      // Geometric moving average: capacities are positive and their errors multiplicative.
      const usd = old ? Math.exp(0.8 * Math.log(old.usd) + 0.2 * Math.log(clamped)) : clamped;
      return { ...prev, [window]: { usd, samples: (old?.samples ?? 0) + 1 } };
    });
  }
}

/**
 * Prior capacity of a subscription window in API-equivalent dollars, until its
 * readings say otherwise: Claude Max 20x on tavya.io (2026-10: ten Opus agents
 * emptied a 5-hour window in 16–34 minutes, 17% of its week).
 */
export function defaultCapacity(window: WindowKind): number {
  return window === 'session' ? 150 : 900;
}

export const SESSION_MINUTES = 300;
export const WEEK_MINUTES = 7 * 24 * 60;

/** A probe snapshot (src/agent/usage.ts UsageSnapshot), as much of it as the scheduler reads. */
export interface ProbeSnapshot {
  ok: boolean;
  at: number;
  session?: { pct: number; resetAt?: number };
  week?: { pct: number; resetAt?: number };
}

/**
 * A login's windows in dollars for the policy (minutes since the epoch): the
 * freshest reading of each window, from a turn's stream or a usage probe, plus
 * what the login has spent since.
 */
export async function loginWindows(store: KvStore, credential: string, nowMs: number): Promise<QuotaWindow[]> {
  const [observed, capacity, spent, probe] = await Promise.all([
    kvJson<ObservedQuota>(store, observedKey(credential)),
    kvJson<LearnedCapacity>(store, capacityKey(credential)),
    kvJson<{ usd: number }>(store, spentKey(credential)),
    kvJson<ProbeSnapshot>(store, `usage:${credential}`),
  ]);
  const spentNow = spent?.usd ?? 0;
  const out: QuotaWindow[] = [];
  for (const kind of ['session', 'week'] as const) {
    const usd = capacity?.[kind]?.usd ?? defaultCapacity(kind);
    const length = kind === 'session' ? SESSION_MINUTES : WEEK_MINUTES;
    const stream = observed?.[kind];
    const probed = probe?.ok ? probe[kind] : undefined;
    const reading: { utilization: number; resetsAt?: number; at: number; spentAt?: number } | undefined =
      stream && (!probed || stream.at >= (probe?.at ?? 0)) ? stream
        : probed ? { utilization: probed.pct / 100, ...(probed.resetAt ? { resetsAt: probed.resetAt } : {}), at: probe!.at }
          : undefined;
    if (!reading || (reading.resetsAt !== undefined && reading.resetsAt <= nowMs)) {
      // Never read, or reset since: a fresh window (a session starts at its first use).
      out.push({ kind, capacity: usd, used: 0, length, ...(kind === 'week' && reading?.resetsAt
        ? { resetAt: (reading.resetsAt + Math.ceil((nowMs - reading.resetsAt) / (length * 60_000)) * length * 60_000) / 60_000 } : {}) });
      continue;
    }
    const since = reading.spentAt === undefined ? 0 : Math.max(0, spentNow - reading.spentAt);
    out.push({ kind, capacity: usd, used: Math.min(usd, reading.utilization * usd + since), length,
      ...(reading.resetsAt ? { resetAt: reading.resetsAt / 60_000 } : kind === 'session' ? { resetAt: nowMs / 60_000 + length } : {}) });
  }
  return out;
}
