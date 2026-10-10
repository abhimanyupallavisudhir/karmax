import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TriggerScheduler, createTriggerFire } from '../src/platform/trigger-scheduler.js';
import type { TaskRecord } from '../src/domain/types.js';

/**
 * External events end to end (wiki planned/external-connectors-and-automations):
 * a real gateway, a real Temporal worker and the trigger dispatcher. A webhook
 * delivery and an emitted event each become a project event; the armed series
 * whose trigger matches starts a run that carries the event.
 */
describe('project events start runs (real gateway + Temporal)', () => {
  let h: Harness;
  let base: string;
  let token: string;
  let scheduler: TriggerScheduler;
  let projectId: string;
  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  beforeAll(async () => {
    h = await bootHarness('mock');
    scheduler = new TriggerScheduler({ store: h.store, bus: h.bus, fire: createTriggerFire(h.api, h.tokens), inboxSweepMs: 0, reconcileMs: 0 });
    h.api.setTriggerArmer(scheduler);
    await scheduler.start();
    base = (await h.startGateway()).url;
    token = ((await (await fetch(`${base}/api/session`)).json()) as { token: string }).token;
    const repo = await h.makeRepo('events-repo');
    projectId = (await h.store.createProject('Events', { repos: [repo], defaultBase: 'main', defaultTarget: 'main' })).id;
  }, 90_000);
  afterAll(async () => {
    await scheduler?.stop();
    await h?.stop();
  });

  const runsOf = async (seriesId: string): Promise<TaskRecord[]> =>
    (await h.store.listTasks(projectId)).filter((task) => task.params?.runOf === seriesId);

  const createSeries = async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/projects/${projectId}/tasks`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return (await response.json()) as TaskRecord;
  };

  it('turns a signed webhook delivery into a run that carries the event', async () => {
    const series = await createSeries({ title: 'Fix {{title}}', prompt: 'Investigate the alert.',
      params: { triggers: [{ kind: 'event', type: 'sentry.alert', where: { level: { in: ['error', 'fatal'] } }, recurring: true }] } });
    const created = await fetch(`${base}/api/projects/${projectId}/webhooks`, { method: 'POST', headers: auth(), body: JSON.stringify({ name: 'Sentry', type: 'sentry.alert' }) });
    expect(created.status).toBe(201);
    const { hook, secret, url } = (await created.json()) as { hook: { id: string }; secret: string; url: string };
    expect(url).toBe(`${base}/api/hooks/${hook.id}`);
    const listed = (await (await fetch(`${base}/api/projects/${projectId}/webhooks`, { headers: auth() })).json()) as { webhooks: unknown[] };
    expect(JSON.stringify(listed)).not.toContain(secret);

    const body = JSON.stringify({ title: 'Boom in checkout', level: 'error' });
    const sign = (text: string, key = secret) => `sha256=${crypto.createHmac('sha256', key).update(text).digest('hex')}`;
    const deliver = (text: string, headers: Record<string, string>) => fetch(`${url}`, { method: 'POST', body: text,
      headers: { 'content-type': 'application/json', ...headers } });

    expect((await deliver(body, { 'x-hub-signature-256': sign(body, 'wrong') })).status).toBe(401);
    expect((await deliver(body, {})).status).toBe(401);
    expect((await fetch(`${base}/api/hooks/hook_missing`, { method: 'POST', body })).status).toBe(401);

    const accepted = await deliver(body, { 'x-hub-signature-256': sign(body), 'idempotency-key': 'alert-1' });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ accepted: true, duplicate: false });
    const repeat = await deliver(body, { authorization: `Bearer ${secret}`, 'idempotency-key': 'alert-1' });
    expect(await repeat.json()).toMatchObject({ accepted: true, duplicate: true });
    const ignored = JSON.stringify({ title: 'Just a warning', level: 'warning' });
    expect((await deliver(ignored, { 'x-hub-signature-256': sign(ignored) })).status).toBe(202);

    await expect.poll(async () => (await runsOf(series.id)).length, { timeout: 30_000 }).toBe(1);
    const [run] = await runsOf(series.id);
    expect(run!.title).toBe('Fix Boom in checkout');
    expect(run!.params.trigger).toMatchObject({ type: 'sentry.alert', source: `webhook:${hook.id}`, payload: { level: 'error' } });
    expect(String(run!.params.prompt)).toMatch(/^Investigate the alert\.\n\nThis run was started by the event `sentry\.alert`/);
    expect(String(run!.params.prompt)).toContain('<untrusted-data source="event payload">');
    // The run is a real workflow.
    await expect.poll(async () => Boolean(await h.client.workflow.getHandle(run!.id).describe().catch(() => undefined)), { timeout: 30_000 }).toBe(true);

    const events = (await (await fetch(`${base}/api/projects/${projectId}/events?type=sentry.*`, { headers: auth() })).json()) as Array<{ claims: Array<{ state: string; runId?: string }>; payload: { level: string } }>;
    expect(events.map((event) => event.payload.level)).toEqual(['warning', 'error']);
    expect(events[1]!.claims).toMatchObject([{ state: 'started', runId: run!.id }]);
    expect(events[0]!.claims).toEqual([]);
  }, 120_000);

  it('starts a run from an emitted event and collapses re-emits of the same key', async () => {
    const series = await createSeries({ title: 'New order', prompt: 'Process the order.',
      params: { triggers: [{ kind: 'event', type: 'orders.created', recurring: true }] } });
    const emit = () => fetch(`${base}/api/projects/${projectId}/events`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ type: 'orders.created', key: 'order-7', subject: 'https://shop.example/orders/7', payload: { id: 7 } }) });
    const first = await emit();
    expect(first.status).toBe(201);
    expect((await emit()).status).toBe(200);
    await expect.poll(async () => (await runsOf(series.id)).length, { timeout: 30_000 }).toBe(1);
    expect((await runsOf(series.id))[0]!.params.trigger).toMatchObject({ key: 'order-7', subject: 'https://shop.example/orders/7' });
    const bad = await fetch(`${base}/api/projects/${projectId}/events`, { method: 'POST', headers: auth(), body: JSON.stringify({ type: 'not valid' }) });
    expect(bad.status).toBe(400);
  }, 120_000);
});
