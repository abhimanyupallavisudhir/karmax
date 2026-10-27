import { ArrivalForecast } from './forecast.js';
import { loadModel, schedulingPriority, type ModelSource, type SchedulingModel } from './model.js';
import type { OrderConstraint } from './order.js';
import { DEFAULT_SCHEDULING, schedule, type LoginState, type QueueStatus, type TreeState, type TurnRequest } from './policy.js';
import { SizeModel } from './size-model.js';
import { kvJson, loginWindows, orderKey, queueKey, treeKey, type TreeLedger } from './state.js';

/**
 * The account coordinator's scheduling step (wiki features/quota-scheduling):
 * from the coordinator's logins, queued turn requests and granted leases, the
 * grants to make now, why the others wait, and when to look again. One
 * organization's turns never share its logins with another's, so each is
 * planned on its own, with its own fitted model and orders.
 */

export interface PlanAccount {
  id: string;
  provider: string;
  kind?: 'login' | 'ambient' | 'key';
  status: string;
  inUse: number;
  maxConcurrent: number;
  resetAt?: number;
}
export interface PlanInput {
  accounts: PlanAccount[];
  /** Queued requests, oldest first, that some credential could serve now. */
  queue: { taskId: string; turnId: string; provider?: string; allowed?: string[] }[];
  granted: { taskId: string; turnId: string; accountId: string; grantedAt?: number }[];
}
export interface PlanHold { taskId: string; turnId: string; status: Exclude<QueueStatus, 'admit'>; until?: number }
export interface PlanOutput {
  grants: { taskId: string; turnId: string; accountId: string }[];
  holds: PlanHold[];
  /** Plan again after this long even if nothing changes (prices fall as resets near). */
  recheckMs: number;
  /** Running turns to ask to pause: far more important work is blocked on their login. */
  yields?: { taskId: string; turnId: string }[];
}

/** A blocked turn ranked this many times higher than a running one may ask it to pause … */
export const YIELD_RATIO = 3;
/** … once that one has run this long (its prompt cache is warm; a cut short turn wastes it). */
export const YIELD_AFTER_MS = 10 * 60_000;

/** A plan saved for the Queues page. */
export interface QueueSnapshot {
  at: number;
  running: { taskId: string; turnId: string; root: string; accountId: string; grantedAt?: number }[];
  waiting: { taskId: string; turnId: string; root: string; status: QueueStatus; until?: number; accountId?: string; placed?: boolean;
    priority: string }[];
  prices: Record<string, { session: number; week: number }>;
}

export interface PlannerStore extends ModelSource {
  taskTree(taskId: string): Promise<{ root: string; priority: number; organizationId: string; createdAt: number } | undefined>;
}

// Turn lengths on tavya.io: log-normal, median 1.9 min, p99 48 min (calibration.json).
const TURN_MINUTES = new SizeModel({ mu: 0.64, sigma: 1.71 });
const TURN_CAP = 120;
const MIN_RECHECK = 60_000, MAX_RECHECK = 10 * 60_000;

export async function planGrants(store: PlannerStore, input: PlanInput, nowMs = Date.now()): Promise<PlanOutput> {
  const now = nowMs / 60_000;
  const tasks = new Map<string, Awaited<ReturnType<PlannerStore['taskTree']>>>();
  for (const id of new Set([...input.queue.map((q) => q.taskId), ...input.granted.map((g) => g.taskId)])) {
    tasks.set(id, await store.taskTree(id));
  }
  const byOrg = new Map<string, { queue: PlanInput['queue']; granted: PlanInput['granted'] }>();
  const group = (taskId: string) => {
    const org = tasks.get(taskId)?.organizationId ?? 'org_personal';
    if (!byOrg.has(org)) byOrg.set(org, { queue: [], granted: [] });
    return byOrg.get(org)!;
  };
  for (const q of input.queue) group(q.taskId).queue.push(q);
  for (const g of input.granted) group(g.taskId).granted.push(g);

  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const output: PlanOutput = { grants: [], holds: [], recheckMs: MAX_RECHECK, yields: [] };
  for (const [org, part] of byOrg) {
    if (!part.queue.length && !part.granted.length) continue;
    let model: SchedulingModel | undefined;
    try { model = await loadModel(store, org, nowMs); } catch { model = undefined; }
    const result = await planOrganization(store, org, part, accounts, tasks, model, nowMs, now);
    output.grants.push(...result.grants);
    output.holds.push(...result.holds);
    output.yields!.push(...(result.yields ?? []));
    output.recheckMs = Math.min(output.recheckMs, result.recheckMs);
  }
  return output;
}

async function planOrganization(store: PlannerStore, org: string, part: { queue: PlanInput['queue']; granted: PlanInput['granted'] },
  accounts: Map<string, PlanAccount>, tasks: Map<string, Awaited<ReturnType<PlannerStore['taskTree']>>>,
  model: SchedulingModel | undefined, nowMs: number, now: number): Promise<PlanOutput> {
  const size = new SizeModel(model?.size ?? { mu: Math.log(36) - 1.53 ** 2 / 2, sigma: 1.53 });
  const defaultBurn = model?.burn ?? 0.48;
  const meanTurn = TURN_MINUTES.expectedMin(TURN_CAP);
  const allowedFor = (q: PlanInput['queue'][number]) => q.allowed
    ?? [...accounts.values()].filter((a) => a.provider === q.provider).map((a) => a.id);
  const loginIds = new Set<string>([...part.queue.flatMap(allowedFor), ...part.granted.map((g) => g.accountId)]);
  const root = (taskId: string) => tasks.get(taskId)?.root ?? taskId;

  // Trees: what each has spent, how fast, what it is running.
  const roots = new Set([...part.queue, ...part.granted].map((x) => root(x.taskId)));
  const ledgers = new Map<string, TreeLedger | undefined>();
  for (const r of roots) ledgers.set(r, await kvJson<TreeLedger>(store, treeKey(r)));
  const remainingTurn = (burn: number, grantedAt?: number) =>
    burn * TURN_MINUTES.residual(grantedAt ? Math.max(0, now - grantedAt / 60_000) : 0, TURN_CAP).mean;
  const trees: TreeState[] = [...roots].map((r) => {
    const ledger = ledgers.get(r);
    const burn = ledger?.burn ?? defaultBurn;
    const running = part.granted.filter((g) => root(g.taskId) === r);
    const waiting = part.queue.filter((q) => root(q.taskId) === r).length;
    const rootTask = tasks.get(r) ?? [...tasks.values()].find((t) => t?.root === r);
    return { id: r, priority: schedulingPriority(rootTask?.priority), attained: ledger?.spent ?? 0, burnRate: burn,
      turnCost: burn * meanTurn, running: running.length, lanes: Math.max(1, running.length + waiting),
      committed: running.reduce((s, g) => s + remainingTurn(burn, g.grantedAt), 0),
      ...(ledger?.lastLogin ? { lastLogin: ledger.lastLogin } : {}) };
  });
  const burnOf = new Map(trees.map((t) => [t.id, t.burnRate]));

  // Logins: their windows in dollars, what their running turns will still spend.
  const logins: LoginState[] = [];
  for (const id of loginIds) {
    const a = accounts.get(id);
    if (!a) continue;
    const blocked = a.status === 'exhausted' ? (a.resetAt ?? nowMs + 60 * 60_000) / 60_000
      : a.status === 'available' ? undefined : Number.MAX_SAFE_INTEGER;
    logins.push({ id, provider: a.provider, running: a.inUse, maxConcurrent: a.maxConcurrent,
      windows: a.kind === 'login' || a.kind === undefined ? await loginWindows(store, id, nowMs) : [],
      committed: part.granted.filter((g) => g.accountId === id).reduce((s, g) => s + remainingTurn(burnOf.get(root(g.taskId)) ?? defaultBurn, g.grantedAt), 0),
      ...(blocked !== undefined ? { blockedUntil: blocked } : {}) });
  }

  const requests: TurnRequest[] = part.queue.map((q, i) => ({ id: `${q.taskId}\u0000${q.turnId}`, treeId: root(q.taskId), taskId: q.taskId,
    requestedAt: now - (part.queue.length - i) * 1e-6, logins: allowedFor(q) }));
  const order = (await kvJson<OrderConstraint[]>(store, orderKey(org))) ?? [];
  const forecast = { arrivals: model ? ArrivalForecast.from(model.forecast) : new ArrivalForecast(), size, burnRate: defaultBurn,
    lanes: model?.lanes ?? 1.3 };
  const result = schedule({ now, logins, trees, requests, forecast, order, params: DEFAULT_SCHEDULING, seed: Math.floor(nowMs / 60_000) });

  const split = (id: string) => { const [taskId, turnId] = id.split('\u0000') as [string, string]; return { taskId, turnId }; };
  const grants = result.admissions.map((a) => ({ ...split(a.requestId), accountId: a.loginId }));
  const holds: PlanHold[] = result.queue.filter((e) => e.status !== 'admit')
    .map((e) => ({ ...split(e.requestId), status: e.status as PlanHold['status'], ...(e.until !== undefined ? { until: Math.round(e.until * 60_000) } : {}) }));
  // Ask the least important long-running turns to pause for far more important blocked work.
  const yields: { taskId: string; turnId: string }[] = [];
  const asked = new Set<string>();
  const runningTurns = part.granted.map((g) => ({ ...g, rank: result.ranks[root(g.taskId)] ?? Infinity }))
    .filter((g) => g.grantedAt !== undefined && nowMs - g.grantedAt >= YIELD_AFTER_MS).sort((a, b) => a.rank - b.rank);
  for (const entry of result.queue.filter((e) => e.status === 'held' || e.status === 'next').sort((a, b) => b.rank - a.rank)) {
    const request = requests.find((r) => r.id === entry.requestId)!;
    const victim = runningTurns.find((g) => !asked.has(`${g.taskId}:${g.turnId}`) && request.logins.includes(g.accountId)
      && g.rank * YIELD_RATIO <= entry.rank && root(g.taskId) !== entry.treeId);
    if (!victim) continue;
    asked.add(`${victim.taskId}:${victim.turnId}`);
    yields.push({ taskId: victim.taskId, turnId: victim.turnId });
  }
  const nextUntil = holds.map((h) => h.until).filter((u): u is number => u !== undefined && u > nowMs);
  const recheckMs = Math.max(MIN_RECHECK, Math.min(MAX_RECHECK, ...nextUntil.map((u) => u - nowMs)));

  const snapshot: QueueSnapshot = {
    at: nowMs,
    running: part.granted.map((g) => ({ taskId: g.taskId, turnId: g.turnId, root: root(g.taskId), accountId: g.accountId,
      ...(g.grantedAt ? { grantedAt: g.grantedAt } : {}) })),
    waiting: result.queue.map((e) => ({ ...split(e.requestId), root: e.treeId, status: e.status,
      priority: trees.find((t) => t.id === e.treeId)!.priority,
      ...(e.until !== undefined ? { until: Math.round(e.until * 60_000) } : {}), ...(e.loginId ? { accountId: e.loginId } : {}),
      ...(e.placed ? { placed: true } : {}) })),
    prices: result.prices,
  };
  await store.kvSet(queueKey(org), JSON.stringify(snapshot));
  return { grants, holds, recheckMs, yields };
}
