import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { organizationInsights } from '../src/platform/insights.js';

const DAY = 86_400_000;
// Noon UTC on a fixed date, so local-day bucketing is easy to reason about.
const NOW = Date.UTC(2026, 8, 23, 12);

async function seed() {
  const store = await Store.create(':memory:');
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'user_1' } as any);
  const other = await store.createOrganization({ name: 'Other', ownerUserId: 'user_1' } as any);
  const web = await store.createProject('Web', {}, organization.id);
  const api = await store.createProject('Backend', {}, organization.id);
  const foreign = await store.createProject('Foreign', {}, other.id);
  const task = async (projectId: string, title: string, createdAt: number, params: Record<string, unknown> = {}) => {
    const created = await store.createTask({ projectId, title, workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: title, ...params } as any });
    await store.db.prepare('UPDATE tasks SET createdAt=? WHERE id=?').run(createdAt, created.id);
    return created;
  };
  const view = (taskId: string, stage: string, status: string, extra: Record<string, unknown> = {}) =>
    store.saveView(taskId, { taskId, stage, status, actions: [], messages: [], transcripts: {}, ...extra } as any);
  const publish = (taskId: string, ts: number, stage: string, status: string) =>
    store.appendEvent({ taskId, type: 'view.updated', ts, payload: { stage, status } });
  return { store, organization, other, web, api, foreign, task, view, publish };
}

describe('organization insights', () => {
  it('retains first completion dates after event retention removes the event', async () => {
    const { store, organization, web, task, publish } = await seed();
    try {
      const shipped = await task(web.id, 'Shipped', NOW - 2 * DAY);
      await publish(shipped.id, NOW - DAY, 'done', 'done');
      await store.retentionSweep(NOW + 100 * DAY);
      expect((await store.eventsSince(shipped.id, 0)).some((event) => event.type === 'view.updated')).toBe(false);
      const queries: string[] = [];
      const prepare = store.db.prepare.bind(store.db);
      store.db.prepare = ((sql: string) => { queries.push(sql); return prepare(sql); }) as typeof store.db.prepare;
      expect((await store.insightRows(organization.id, NOW - 30 * DAY, NOW)).completions)
        .toEqual([{ taskId: shipped.id, doneAt: NOW - DAY }]);
      expect(queries.some((sql) => sql.includes("e.payload LIKE"))).toBe(false);
    } finally { await store.close(); }
  });

  it('counts shipped work once, in the local day it first reached done, within the organization', async () => {
    const { store, organization, web, api, foreign, task, view, publish } = await seed();
    try {
      const shipped = await task(web.id, 'Ship login', NOW - 3 * DAY);
      await view(shipped.id, 'done', 'done', { pr: { url: 'https://github.com/acme/web/pull/7' } });
      await publish(shipped.id, NOW - 2 * DAY, 'review', 'waiting');
      await publish(shipped.id, NOW - DAY, 'done', 'done');
      await publish(shipped.id, NOW - 1000, 'done', 'done'); // a later re-save is not a second shipment

      const old = await task(api.id, 'Old work', NOW - 40 * DAY);
      await view(old.id, 'done', 'done');
      await publish(old.id, NOW - 35 * DAY, 'done', 'done'); // previous 30-day window
      await publish(old.id, NOW - 2 * DAY, 'done', 'done'); // a re-save inside the window still does not count

      const working = await task(api.id, 'Build API', NOW - 2 * DAY);
      await view(working.id, 'do', 'active');
      const review = await task(web.id, 'Review copy', NOW - DAY);
      await view(review.id, 'review', 'waiting');
      await task(web.id, 'A draft', NOW - DAY, { draft: true });
      const broken = await task(web.id, 'Broke mid-turn', NOW - DAY);
      await view(broken.id, 'do', 'failed'); // a failure is failed work, not queued work in its stage

      const elsewhere = await task(foreign.id, 'Not ours', NOW - DAY);
      await view(elsewhere.id, 'done', 'done');
      await publish(elsewhere.id, NOW - DAY, 'done', 'done');

      const insights = await organizationInsights(store, organization.id, { days: 30, now: NOW });
      expect(insights.totals).toMatchObject({ shipped: 1, created: 4, medianShipMs: 2 * DAY });
      expect(insights.previous).toMatchObject({ shipped: 1, created: 1 });
      expect(insights.daily).toHaveLength(30);
      expect(insights.daily.at(-1)!.day).toBe('2026-09-23');
      expect(insights.daily.at(-2)).toMatchObject({ day: '2026-09-22', shipped: 1 });
      expect(insights.pipeline).toEqual({ stages: { do: { open: 1, working: 1, waiting: 0 }, review: { open: 1, working: 0, waiting: 1 },
        failed: { open: 1, working: 0, waiting: 0 } },
        working: 1, waiting: 1, drafts: 1 });
      expect(insights.working.map((ref) => ref.title)).toEqual(['Build API']);
      expect(insights.waiting.map((ref) => ref.title)).toEqual(['Review copy']);
      expect(insights.recent).toEqual([expect.objectContaining({ title: 'Ship login', at: NOW - DAY,
        pr: 'https://github.com/acme/web/pull/7', projectId: web.id })]);
      expect(insights.projects.map((project) => [project.name, project.shipped, project.open]))
        .toEqual([['Web', 1, 2], ['Backend', 0, 1]]);
      expect(insights.spend).toBeUndefined();
      expect(insights.totals.spendMicros).toBeUndefined();
    } finally { await store.close(); }
  });

  it('buckets by the viewer\'s local day', async () => {
    const { store, organization, web, task, view, publish } = await seed();
    try {
      const late = await task(web.id, 'Late night', NOW - DAY);
      await view(late.id, 'done', 'done');
      // 23:30 UTC on the 22nd is already the 23rd in UTC+2.
      await publish(late.id, Date.UTC(2026, 8, 22, 23, 30), 'done', 'done');
      const utc = await organizationInsights(store, organization.id, { days: 7, now: NOW });
      const east = await organizationInsights(store, organization.id, { days: 7, now: NOW, utcOffsetMinutes: 120 });
      expect(utc.daily.find((day) => day.shipped)?.day).toBe('2026-09-22');
      expect(east.daily.find((day) => day.shipped)?.day).toBe('2026-09-23');
    } finally { await store.close(); }
  });

  it('aggregates agent turns, time, tokens by model, and gated spend', async () => {
    const { store, organization, web, task } = await seed();
    try {
      const work = await task(web.id, 'Agent work', NOW - 2 * DAY);
      const admit = async (id: string, model: string, at: number, seconds: number, completed: boolean) => {
        await store.admitAgentUsage({ id, organizationId: organization.id, projectId: web.id, taskId: work.id,
          provider: 'anthropic', model, fundingSource: 'byok', now: at });
        await store.finishUsageAdmission(id, completed, at + seconds * 1000, [{
          id: `usage:tokens:${id}`, organizationId: organization.id, projectId: web.id, taskId: work.id,
          provider: 'anthropic', kind: 'agent.tokens', quantity: 1000, unit: 'token', costMicros: 0,
          startedAt: at + seconds * 1000, endedAt: at + seconds * 1000, fundingSource: 'byok',
          metadata: { model, inputTokens: 800, outputTokens: 200 },
        }]);
      };
      await admit('turn-1', 'claude-opus', NOW - DAY, 600, true);
      await admit('turn-2', 'claude-opus', NOW - DAY + 3_600_000, 300, false);
      await admit('turn-3', 'claude-haiku', NOW - 3_600_000, 60, true);
      await store.recordUsage({ organizationId: organization.id, projectId: web.id, taskId: work.id, provider: 'e2b',
        kind: 'world.active', quantity: 60, unit: 'second', costMicros: 250_000, startedAt: NOW - DAY, endedAt: NOW - DAY });
      await store.db.prepare(`INSERT INTO payment_spend_requests (id, organizationId, projectId, taskId, cardId, amount,
        currency, merchant, why, status, createdAt, updatedAt, expiresAt) VALUES ('spend-1', ?, ?, ?, 'card', 1250, 'usd', 'Domains', 'buy', 'settled', ?, ?, ?)`)
        .run(organization.id, web.id, work.id, NOW - DAY, NOW - DAY, NOW + DAY);

      const insights = await organizationInsights(store, organization.id, { days: 7, now: NOW, includeSpend: true });
      expect(insights.totals).toMatchObject({ turns: 3, meteredTurns: 3, failedTurns: 1, agentSeconds: 960, tokens: 3000,
        inputTokens: 2400, outputTokens: 600, spendMicros: 250_000 + 12_500_000 });
      expect(insights.spend).toEqual({ modelMicros: 250_000, cardMicros: 12_500_000 });
      expect(insights.models).toEqual([
        { model: 'claude-opus', provider: 'anthropic', turns: 2, meteredTurns: 2, failedTurns: 1, agentSeconds: 900, tokens: 2000 },
        { model: 'claude-haiku', provider: 'anthropic', turns: 1, meteredTurns: 1, failedTurns: 0, agentSeconds: 60, tokens: 1000 },
      ]);
      expect(insights.daily.at(-2)!.tokensByModel).toEqual({ 'claude-opus': 2000 });
      expect(insights.projects[0]).toMatchObject({ name: 'Web', turns: 3, agentSeconds: 960, tokens: 3000 });
    } finally { await store.close(); }
  });

  /** Production showed 834 GPT turns with 0 tokens: Codex subscription turns did
   * not report usage, and the page ranked and colored models as if they had used
   * nothing. Turns without a provider reading are counted as unreported, models
   * rank by work done, and input is measured the same way for every provider
   * (Anthropic's inputTokens excludes cache reads; OpenAI's includes them). */
  it('treats missing usage as unreported and measures input consistently across providers', async () => {
    const { store, organization, web, task } = await seed();
    try {
      const work = await task(web.id, 'Mixed agents', NOW - 2 * DAY);
      const turn = async (id: string, provider: string, model: string, at: number, tokens?: { quantity: number; input: number; output: number }) => {
        await store.admitAgentUsage({ id, organizationId: organization.id, projectId: web.id, taskId: work.id,
          provider, model, fundingSource: 'byok', now: at });
        await store.finishUsageAdmission(id, true, at + 60_000, tokens ? [{
          id: `usage:tokens:${id}`, organizationId: organization.id, projectId: web.id, taskId: work.id,
          provider, kind: 'agent.tokens', quantity: tokens.quantity, unit: 'token', costMicros: 0,
          startedAt: at + 60_000, endedAt: at + 60_000, fundingSource: 'byok',
          metadata: { model, inputTokens: tokens.input, outputTokens: tokens.output },
        }] : []);
      };
      // Anthropic: 100 fresh input + 9,700 cache reads/writes + 200 output = 10,000.
      await turn('claude-1', 'anthropic', 'claude-opus', NOW - DAY, { quantity: 10_000, input: 100, output: 200 });
      // OpenAI (after the fix): input already includes cached input.
      await turn('gpt-1', 'openai', 'gpt-6', NOW - DAY, { quantity: 3_050, input: 3_000, output: 50 });
      // OpenAI (before the fix): three turns that never reported usage.
      for (const id of ['gpt-2', 'gpt-3', 'gpt-4']) await turn(id, 'openai', 'gpt-6', NOW - DAY + 1000);

      const insights = await organizationInsights(store, organization.id, { days: 7, now: NOW });
      expect(insights.totals).toMatchObject({ turns: 5, meteredTurns: 2, tokens: 13_050, inputTokens: 12_800, outputTokens: 250 });
      expect(insights.models.map((model) => [model.model, model.turns, model.meteredTurns, model.tokens]))
        .toEqual([['gpt-6', 4, 1, 3_050], ['claude-opus', 1, 1, 10_000]]);
    } finally { await store.close(); }
  });

  it('falls back to a 30-day window for an unsupported period', async () => {
    const { store, organization } = await seed();
    try {
      expect((await organizationInsights(store, organization.id, { days: 3, now: NOW })).days).toBe(30);
    } finally { await store.close(); }
  });
});
