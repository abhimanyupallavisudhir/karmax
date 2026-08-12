import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Store } from '../src/store/db.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import {
  externalTriggerMatches,
  mappedExternalParams,
  renderExternalTemplate,
  type ExternalEventEnvelope,
} from '../src/domain/external-events.js';
import {
  ExternalEventDispatcher,
  genericWebhookSignature,
  verifyDiscordSignature,
  verifyGenericWebhookSignature,
  verifySlackSignature,
} from '../src/integrations/external-events.js';

const envelope = (over: Partial<ExternalEventEnvelope> = {}): ExternalEventEnvelope => ({
  schema: 'karmax.external-event/1', id: 'evt-1', organizationId: 'org-1',
  sourceId: 'github:repo-1', provider: 'github', type: 'github.issue.label-added',
  deliveryKey: 'delivery-1', occurredAt: 100, receivedAt: 110,
  subject: { externalId: 'acme/app#42', url: 'https://github.com/acme/app/issues/42' },
  data: { repository: { full_name: 'acme/app' }, issue: { number: 42, title: 'Fix it', body: 'Untrusted body' },
    label: { name: 'planned' } },
  ...over,
});

describe('external event binding', () => {
  it('matches dot-path filters and renders only simple bounded substitutions', () => {
    const event = envelope();
    const trigger = { kind: 'external' as const, sourceId: event.sourceId, type: event.type,
      where: { 'label.name': 'planned' }, map: {
        title: '{{ issue.title }}',
        prompt: 'Implement {{ repository.full_name }}#{{ issue.number }}\n<external-content>{{ issue.body }}</external-content>',
      } };
    expect(externalTriggerMatches(trigger, event)).toBe(true);
    expect(mappedExternalParams(trigger, event)).toEqual({ title: 'Fix it',
      prompt: 'Implement acme/app#42\n<external-content>Untrusted body</external-content>' });
    expect(renderExternalTemplate('{{ constructor.prototype }}', event)).toBe('');
    expect(renderExternalTemplate('{{ data.__proto__.polluted }}', event)).toBe('');
    expect(() => mappedExternalParams({ ...trigger, map: { _authorization: 'god' } }, event))
      .toThrow(/authority-owned/);
  });

  it('authenticates generic webhooks with a timestamped exact-body HMAC', () => {
    const secret = 'secret';
    const raw = Buffer.from('{"type":"work.ready","data":{}}');
    const seconds = 1_700_000_000;
    const signature = genericWebhookSignature(secret, seconds, raw);
    expect(verifyGenericWebhookSignature(secret, String(seconds), signature, raw, seconds * 1000)).toBe(true);
    expect(verifyGenericWebhookSignature(secret, String(seconds), signature, Buffer.from('{}'), seconds * 1000)).toBe(false);
    expect(verifyGenericWebhookSignature(secret, String(seconds - 301),
      genericWebhookSignature(secret, seconds - 301, raw), raw, seconds * 1000)).toBe(false);
  });

  it('verifies Slack replay windows and Discord Ed25519 interaction signatures', () => {
    const raw = Buffer.from('{"type":1}');
    const seconds = 1_700_000_000;
    const slack = `v0=${crypto.createHmac('sha256', 'slack-secret').update(`v0:${seconds}:`).update(raw).digest('hex')}`;
    expect(verifySlackSignature('slack-secret', String(seconds), slack, raw, seconds * 1000)).toBe(true);
    expect(verifySlackSignature('slack-secret', String(seconds - 301), slack, raw, seconds * 1000)).toBe(false);

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const timestamp = '1700000000';
    const signature = crypto.sign(null, Buffer.concat([Buffer.from(timestamp), raw]), privateKey).toString('hex');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const publicKeyHex = spki.subarray(spki.length - 32).toString('hex');
    expect(verifyDiscordSignature(publicKeyHex, timestamp, signature, raw)).toBe(true);
    expect(verifyDiscordSignature(publicKeyHex, timestamp, signature, Buffer.from('{}'))).toBe(false);
  });
});

describe('durable external event dispatcher', () => {
  it('dead-letters exhausted deliveries and allows an explicit replay', () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Ops', ownerUserId: 'owner' });
    let now = Date.now();
    const inserted = store.insertExternalEvent({ schema: 'karmax.external-event/1', organizationId: organization.id,
      sourceId: 'webhook:test', provider: 'webhook', type: 'test.failed', deliveryKey: 'one',
      occurredAt: now, receivedAt: now, data: {} }).event;
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(store.claimPendingExternalEvents(now)).toHaveLength(1);
      store.failExternalEvent(inserted.id, `failure ${attempt + 1}`, now + 1);
      now += 2;
    }
    expect(store.getExternalEvent(inserted.id)).toMatchObject({ state: 'dead-letter', attempts: 10,
      lastError: 'failure 10' });
    expect(store.claimPendingExternalEvents(now)).toHaveLength(0);
    expect(store.replayExternalEvent(inserted.id)).toMatchObject({ state: 'pending', attempts: 0 });
    expect(store.claimPendingExternalEvents(now)).toHaveLength(1);
    store.close();
  });

  it('deduplicates deliveries and creates exactly one mapped run with provenance', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = store.createProject('App', {}, organization.id);
    const template = store.createTask({ projectId: project.id, title: 'Planned issue', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'base', repeatable: true, triggerState: 'armed', triggers: [{
        kind: 'external', sourceId: 'github:repo-1', type: 'github.issue.label-added',
        where: { 'label.name': 'planned' }, map: { title: '{{ issue.title }}',
          prompt: 'Issue {{ repository.full_name }}#{{ issue.number }}: {{ issue.body }}' }, recurring: true,
      }] } });
    const bus = new KarmaxBus();
    const spawned: Array<{ taskId: string; title?: string; prompt?: unknown }> = [];
    const dispatcher = new ExternalEventDispatcher({ store, bus, spawn: async (input) => {
      spawned.push({ taskId: input.taskId, title: input.title, prompt: input.params.prompt });
      if (!store.getTask(input.taskId)) store.createTask({ id: input.taskId, projectId: project.id,
        title: input.title ?? template.title, workflow: template.workflow, workflowVersion: template.workflowVersion,
        params: { prompt: String(input.params.prompt ?? ''), runOf: template.id } });
      return { id: input.taskId };
    } });
    const { schema: _schema, id: _id, receivedAt: _receivedAt, ...input } =
      { ...envelope(), organizationId: organization.id };
    const first = dispatcher.ingest(input);
    const duplicate = dispatcher.ingest(input);
    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    await dispatcher.processNow();
    await dispatcher.processNow();
    expect(spawned).toEqual([{ taskId: expect.stringMatching(/^task_/), title: 'Fix it',
      prompt: expect.stringMatching(/Karmax external event:[\s\S]*Issue acme\/app#42: Untrusted body/) }]);
    expect(store.getExternalEvent(first.event.id)).toMatchObject({ state: 'delivered', taskIds: [spawned[0]!.taskId] });
    expect(store.eventsOfType(spawned[0]!.taskId, 'external.triggered')).toHaveLength(1);
    expect(store.eventsOfType(template.id, 'external.run-created')).toHaveLength(1);
    store.close();
  });

  it('reuses the fixed task claim after a failed dispatch', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Retry', ownerUserId: 'owner' });
    const project = store.createProject('App', {}, organization.id);
    const template = store.createTask({ projectId: project.id, title: 'T', workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'base', repeatable: true, triggerState: 'armed', triggers: [{ kind: 'external',
        provider: 'github', type: 'github.issue.label-added', map: { prompt: '{{ issue.title }}' } }] } });
    let now = Date.now();
    const taskIds: string[] = [];
    let fail = true;
    const dispatcher = new ExternalEventDispatcher({ store, bus: new KarmaxBus(), now: () => now,
      spawn: async ({ taskId }) => { taskIds.push(taskId); if (fail) throw new Error('temporary'); return { id: taskId }; } });
    const { schema: _schema, id: _id, receivedAt: _receivedAt, ...input } =
      envelope({ organizationId: organization.id });
    const { event } = dispatcher.ingest(input);
    await dispatcher.processNow();
    expect(store.getExternalEvent(event.id)?.state).toBe('failed');
    fail = false; now += 10_000;
    await dispatcher.processNow();
    expect(taskIds).toHaveLength(2);
    expect(new Set(taskIds).size).toBe(1);
    expect(store.getExternalEvent(event.id)?.state).toBe('delivered');
    expect(store.externalTriggerRun(event.id, template.id)?.taskId).toBe(taskIds[0]);
    store.close();
  });
});
