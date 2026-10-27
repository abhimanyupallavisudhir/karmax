import { ArrivalForecast, type ForecastState } from './forecast.js';
import type { Priority } from './policy.js';
import type { LogNormal } from './size-model.js';
import { kvJson, modelKey, type KvStore, type TreeLedger } from './state.js';

/**
 * An organization's fitted scheduling model (wiki features/quota-scheduling):
 * arrivals by priority and hour, the law of a tree's total spend, and how fast
 * trees spend. Refit at most hourly from its own history, shrunk toward the
 * installation's prior while its history is short.
 */
export interface SchedulingModel {
  fittedAt: number;
  forecast: ForecastState;
  size: LogNormal;
  /** Spend per minute of one running turn of a new tree. */
  burn: number;
  /** Turns a new tree runs at once. */
  lanes: number;
  /** Finished trees the size law was fitted on. */
  trees: number;
}

/**
 * tavya.io, 2026-08..10 (benchmarks/scheduling/calibration.json): trees cost
 * a log-normal amount, σ ≈ 1.5, mean ≈ $36 once sub-agents and limit-ended
 * turns are metered; a turn spends ≈ $0.48 a minute; 6% of trees run several
 * sub-tasks at once.
 */
export const PRIOR = {
  size: { mu: Math.log(36) - 1.53 ** 2 / 2, sigma: 1.53 },
  burn: 0.48,
  lanes: 1.3,
  /** Pseudo-trees the prior counts for. */
  weight: 20,
};

export const PRIORITY_BY_INDEX: Priority[] = ['medium', 'low', 'medium', 'high', 'urgent'];

/** Task priority (params.priority, 0 none … 4 urgent) for scheduling: none is medium. */
export function schedulingPriority(index: number | undefined): Priority {
  return PRIORITY_BY_INDEX[Math.max(0, Math.min(4, Math.round(index ?? 0)))]!;
}

/** Log-normal fit of finished trees' spend, shrunk toward the prior (normal–inverse-gamma style, by sample count). */
export function fitSize(spends: number[]): LogNormal {
  const logs = spends.filter((s) => s > 0.01).map(Math.log);
  const n = logs.length;
  if (n < 2) return PRIOR.size;
  const mean = logs.reduce((a, b) => a + b, 0) / n;
  const variance = logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const w = PRIOR.weight;
  const mu = (n * mean + w * PRIOR.size.mu) / (n + w);
  const sigma2 = (n * variance + w * PRIOR.size.sigma ** 2 + (n * w / (n + w)) * (mean - PRIOR.size.mu) ** 2) / (n + w);
  return { mu, sigma: Math.min(3, Math.max(0.5, Math.sqrt(sigma2))) };
}

export interface ModelSource extends KvStore {
  rootTaskArrivals(organizationId: string, since: number): Promise<{ id: string; createdAt: number; priority: number }[]>;
  taskCompletions(ids: string[]): Promise<Map<string, number>>;
  kvEntries(prefix: string): Promise<Array<{ key: string; value: string }>>;
}

const HISTORY_DAYS = 35;
const REFIT_MS = 60 * 60_000;

export async function fitModel(store: ModelSource, organizationId: string, nowMs: number): Promise<SchedulingModel> {
  const since = nowMs - HISTORY_DAYS * 86_400_000;
  const arrivals = await store.rootTaskArrivals(organizationId, since);
  const all = (await store.kvEntries('scheduling:tree:'))
    .map(({ key, value }) => { try { return { root: key.slice('scheduling:tree:'.length), ledger: JSON.parse(value) as TreeLedger }; } catch { return undefined; } })
    .filter((x): x is { root: string; ledger: TreeLedger } => !!x);
  // A priority changed after the task had waited a while counts as what it arrived with.
  const arrivedAs = new Map(all.filter((x) => x.ledger.arrivalPriority !== undefined).map((x) => [x.root, x.ledger.arrivalPriority!]));
  const forecast = new ArrivalForecast();
  for (const a of arrivals) forecast.observe(a.createdAt / 60_000, schedulingPriority(arrivedAs.get(a.id) ?? a.priority));
  forecast.advanceTo(nowMs / 60_000);
  const ledgers = all.filter((x) => x.ledger.organizationId === organizationId);
  const done = await store.taskCompletions(ledgers.map((l) => l.root));
  const finished = ledgers.filter((l) => done.has(l.root));
  const burns = ledgers.map((l) => l.ledger.burn).filter((b): b is number => typeof b === 'number' && b > 0).sort((a, b) => a - b);
  const burn = burns.length >= 5 ? burns[Math.floor(burns.length / 2)]! : PRIOR.burn;
  return { fittedAt: nowMs, forecast: forecast.toJSON(), size: fitSize(finished.map((l) => l.ledger.spent)), burn,
    lanes: PRIOR.lanes, trees: finished.length };
}

/** The organization's model, refit when older than an hour. */
export async function loadModel(store: ModelSource, organizationId: string, nowMs: number): Promise<SchedulingModel> {
  const saved = await kvJson<SchedulingModel>(store, modelKey(organizationId));
  if (saved && nowMs - saved.fittedAt < REFIT_MS && saved.forecast?.version === 1) return saved;
  const model = await fitModel(store, organizationId, nowMs);
  await store.kvSet(modelKey(organizationId), JSON.stringify(model));
  return model;
}
