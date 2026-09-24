import type { Store } from '../store/db.js';

/**
 * Organization Insights — what the organization's agents got done and what it
 * took: tasks shipped vs started, agent time, tokens, spend, the live pipeline,
 * and per-project / per-model breakdowns. Pure aggregation over rows the store
 * already records (task views, `view.updated` events, usage admissions and
 * token events, card spend); nothing here writes.
 *
 * Days are bucketed in the caller's local time (`utcOffsetMinutes`, east of UTC
 * positive) so "today" matches the viewer's wall clock. The window is the last
 * `days` local days including today; every total is paired with the preceding
 * window of equal length so the page can show a trend.
 */

export const INSIGHT_PERIODS = [7, 30, 90] as const;
const DAY = 86_400_000;
const OPEN_STAGES = ['setup', 'do', 'review', 'pr', 'merge', 'resolve', 'escalated', 'failed'] as const;
const LIST_LIMIT = 6;

export interface InsightTotals {
  /** meteredTurns: turns whose provider reported token usage (older Codex subscription turns did not). */
  shipped: number; created: number; turns: number; meteredTurns: number; failedTurns: number; agentSeconds: number;
  tokens: number; inputTokens: number; outputTokens: number; medianShipMs: number | null;
  spendMicros?: number;
}
export interface InsightStage { open: number; working: number; waiting: number }
export interface InsightTaskRef { taskId: string; num?: number; title: string; projectId: string; stage?: string; at?: number; pr?: string }
export interface OrganizationInsights {
  days: number; from: number; to: number; utcOffsetMinutes: number;
  totals: InsightTotals; previous: InsightTotals;
  daily: Array<{ day: string; shipped: number; created: number; turns: number; agentSeconds: number; tokens: number;
    tokensByModel: Record<string, number> }>;
  models: Array<{ model: string; provider: string; turns: number; meteredTurns: number; failedTurns: number; agentSeconds: number; tokens: number }>;
  projects: Array<{ id: string; name: string; shipped: number; open: number; turns: number; agentSeconds: number;
    tokens: number; daily: number[] }>;
  /** Open work right now, per stage: how much an agent holds vs. how much waits on a person. */
  pipeline: { stages: Record<string, InsightStage>; working: number; waiting: number; drafts: number };
  working: InsightTaskRef[]; waiting: InsightTaskRef[]; recent: InsightTaskRef[];
  spend?: { modelMicros: number; cardMicros: number };
}

function emptyTotals(): InsightTotals {
  return { shipped: 0, created: 0, turns: 0, meteredTurns: 0, failedTurns: 0, agentSeconds: 0, tokens: 0, inputTokens: 0, outputTokens: 0, medianShipMs: null };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function parseJson(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, any>;
  try { return JSON.parse(String(value)) ?? {}; } catch { return {}; }
}

export async function organizationInsights(store: Store, organizationId: string, options: {
  days?: number; utcOffsetMinutes?: number; now?: number; includeSpend?: boolean;
} = {}): Promise<OrganizationInsights> {
  const days = (INSIGHT_PERIODS as readonly number[]).includes(Number(options.days)) ? Number(options.days) : 30;
  const offset = Math.max(-14 * 60, Math.min(14 * 60, Math.round(Number(options.utcOffsetMinutes) || 0))) * 60_000;
  const now = options.now ?? Date.now();
  // Local-midnight bucketing: shift into local time, floor to the day, shift back.
  const dayIndex = (ts: number) => Math.floor((ts + offset) / DAY);
  const today = dayIndex(now);
  const firstDay = today - days + 1;
  const from = firstDay * DAY - offset;
  const previousFrom = from - days * DAY;
  const bucket = (ts: number) => dayIndex(ts) - firstDay; // 0‥days-1 inside the window, negative before it
  const inWindow = (ts: number) => ts >= from && ts <= now;
  const inPrevious = (ts: number) => ts >= previousFrom && ts < from;

  const projects = (await store.listProjects()).filter((project) => (project.organizationId ?? 'org_personal') === organizationId);
  const projectName = new Map(projects.map((project) => [project.id, project.name]));
  const summaries = (await Promise.all(projects.map((project) => store.listTaskSummaries(project.id)))).flat();
  const taskById = new Map(summaries.map((task) => [task.id, task]));
  const rows = await store.insightRows(organizationId, previousFrom, now);

  const totals = emptyTotals();
  const previous = emptyTotals();
  const daily = Array.from({ length: days }, (_, index) => ({
    day: new Date((firstDay + index) * DAY).toISOString().slice(0, 10),
    shipped: 0, created: 0, turns: 0, agentSeconds: 0, tokens: 0, tokensByModel: {} as Record<string, number>,
  }));
  const perProject = new Map(projects.map((project) => [project.id, {
    id: project.id, name: project.name, shipped: 0, open: 0, turns: 0, agentSeconds: 0, tokens: 0,
    daily: Array.from({ length: days }, () => 0),
  }]));
  const perModel = new Map<string, OrganizationInsights['models'][number]>();
  const modelEntry = (model: string, provider: string) => {
    const key = model || provider || 'unknown';
    let entry = perModel.get(key);
    if (!entry) perModel.set(key, entry = { model: key, provider: provider || '', turns: 0, meteredTurns: 0, failedTurns: 0, agentSeconds: 0, tokens: 0 });
    return entry;
  };
  const ref = (task: typeof summaries[number], extra: Partial<InsightTaskRef> = {}): InsightTaskRef => ({
    taskId: task.id, ...(task.num != null ? { num: task.num } : {}), title: task.title, projectId: task.projectId,
    ...(task.lastView?.stage ? { stage: task.lastView.stage } : {}), ...extra,
  });

  // Started: every non-draft task created in the window (drafts are not work yet).
  for (const task of summaries) {
    if (task.params?.draft) continue;
    if (inWindow(task.createdAt)) { totals.created++; daily[bucket(task.createdAt)]!.created++; }
    else if (inPrevious(task.createdAt)) previous.created++;
  }

  // Shipped: first transition into `done`.
  const shipDurations: number[] = [];
  const previousShipDurations: number[] = [];
  const recent: Array<{ task: typeof summaries[number]; at: number }> = [];
  for (const { taskId, doneAt } of rows.completions) {
    const task = taskById.get(taskId);
    if (inWindow(doneAt)) {
      totals.shipped++;
      daily[bucket(doneAt)]!.shipped++;
      if (task) {
        shipDurations.push(Math.max(0, doneAt - task.createdAt));
        const project = perProject.get(task.projectId);
        if (project) { project.shipped++; project.daily[bucket(doneAt)]!++; }
        recent.push({ task, at: doneAt });
      }
    } else if (inPrevious(doneAt)) {
      previous.shipped++;
      if (task) previousShipDurations.push(Math.max(0, doneAt - task.createdAt));
    }
  }
  totals.medianShipMs = median(shipDurations);
  previous.medianShipMs = median(previousShipDurations);

  // Agent turns: one admission per turn; duration includes any host-slot wait. A
  // turn's token reading is keyed by its admission id; a turn without one is
  // unreported (never "used 0 tokens").
  const metered = new Set(rows.tokens.map((row) => row.id.replace(/^usage:tokens:/, '')));
  for (const admission of rows.admissions) {
    const seconds = Math.max(0, ((admission.releasedAt ?? now) - admission.createdAt) / 1000);
    const failed = admission.state === 'released';
    const reported = metered.has(admission.id);
    if (inWindow(admission.createdAt)) {
      totals.turns++; totals.agentSeconds += seconds; if (failed) totals.failedTurns++; if (reported) totals.meteredTurns++;
      const day = daily[bucket(admission.createdAt)]!;
      day.turns++; day.agentSeconds += seconds;
      const model = modelEntry(admission.model ?? '', admission.provider);
      model.turns++; model.agentSeconds += seconds; if (failed) model.failedTurns++; if (reported) model.meteredTurns++;
      const project = perProject.get(admission.projectId);
      if (project) { project.turns++; project.agentSeconds += seconds; }
    } else if (inPrevious(admission.createdAt)) {
      previous.turns++; previous.agentSeconds += seconds; if (failed) previous.failedTurns++; if (reported) previous.meteredTurns++;
    }
  }

  // Tokens: provider-reported per turn. Input is everything but output, so it is
  // measured alike for every provider: Anthropic's inputTokens excludes cache
  // reads/writes (usually most of the total), OpenAI's already includes them.
  for (const row of rows.tokens) {
    const metadata = parseJson(row.metadata);
    const output = Math.min(row.quantity, Number(metadata.outputTokens ?? 0));
    const input = row.quantity - output;
    if (inWindow(row.startedAt)) {
      totals.tokens += row.quantity; totals.inputTokens += input; totals.outputTokens += output;
      const day = daily[bucket(row.startedAt)]!;
      const model = modelEntry(String(metadata.model ?? ''), row.provider);
      day.tokens += row.quantity;
      day.tokensByModel[model.model] = (day.tokensByModel[model.model] ?? 0) + row.quantity;
      model.tokens += row.quantity;
      const project = row.projectId ? perProject.get(row.projectId) : undefined;
      if (project) project.tokens += row.quantity;
    } else if (inPrevious(row.startedAt)) {
      previous.tokens += row.quantity; previous.inputTokens += input; previous.outputTokens += output;
    }
  }

  // The live board: what is open right now, by stage, and who holds it.
  const stages: Record<string, InsightStage> = {};
  const working: InsightTaskRef[] = [];
  const waiting: InsightTaskRef[] = [];
  let drafts = 0, workingCount = 0, waitingCount = 0;
  for (const task of summaries) {
    const view = task.lastView;
    if (task.params?.draft) { drafts++; continue; }
    if (!view || task.params?.archived || view.status === 'done' || view.status === 'cancelled') continue;
    // A failure is failed work wherever it stopped, never queued work in that stage.
    const stage = view.status === 'failed' ? 'failed' : (OPEN_STAGES as readonly string[]).includes(view.stage) ? view.stage : null;
    if (!stage) continue;
    const entry = stages[stage] ??= { open: 0, working: 0, waiting: 0 };
    entry.open++;
    const project = perProject.get(task.projectId);
    if (project) project.open++;
    if (view.status === 'active') {
      entry.working++; workingCount++;
      if (working.length < LIST_LIMIT) working.push(ref(task));
    } else if (view.status === 'waiting' || view.status === 'blocked') {
      entry.waiting++; waitingCount++;
      if (waiting.length < LIST_LIMIT) waiting.push(ref(task));
    }
  }

  const result: OrganizationInsights = {
    days, from, to: now, utcOffsetMinutes: offset / 60_000,
    totals, previous, daily,
    // Ranked by work done: tokens are missing for unreported turns, turns never are.
    models: [...perModel.values()].sort((a, b) => b.turns - a.turns || b.tokens - a.tokens),
    projects: [...perProject.values()]
      .filter((project) => project.shipped || project.open || project.turns || project.tokens)
      .sort((a, b) => b.shipped - a.shipped || b.agentSeconds - a.agentSeconds || b.open - a.open),
    pipeline: { stages, working: workingCount, waiting: waitingCount, drafts },
    working, waiting,
    recent: recent.sort((a, b) => b.at - a.at).slice(0, LIST_LIMIT).map(({ task, at }) => {
      const pr = task.lastView?.pr?.url ?? task.lastView?.prs?.find((entry: any) => entry?.url)?.url;
      return ref(task, { at, ...(pr ? { pr } : {}) });
    }),
  };
  for (const project of result.projects) if (!projectName.has(project.id)) project.name = project.id;

  // Money is gated separately (payment:read): model cost the organization
  // incurred plus what agents spent on cards. Card amounts are minor units; only
  // USD is summed so the figure is never a silent mix of currencies.
  if (options.includeSpend) {
    const cardMicros = (window: (ts: number) => boolean) => rows.cardSpend
      .filter((row) => row.currency.toLowerCase() === 'usd' && window(row.createdAt))
      .reduce((sum, row) => sum + row.amount * 10_000, 0);
    const modelMicros = (await store.usageSummary(organizationId, from, now + 1)).costMicros;
    const previousModelMicros = (await store.usageSummary(organizationId, previousFrom, from)).costMicros;
    result.spend = { modelMicros, cardMicros: cardMicros(inWindow) };
    totals.spendMicros = modelMicros + result.spend.cardMicros;
    previous.spendMicros = previousModelMicros + cardMicros(inPrevious);
  }
  return result;
}
