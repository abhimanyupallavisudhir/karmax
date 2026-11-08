import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import type { TaskView } from '../src/domain/types.js';
import { projectEventMatchesTrigger, validateTriggers } from '../src/domain/triggers.js';
import { applyTriggerContext, triggerContext, type ProjectEvent } from '../src/domain/project-events.js';
import { ERROR_EVENT_SOURCE, ERROR_EVENT_TYPE, ERROR_REPORTS_KEY, ErrorReporter, configureErrorReports, errorFingerprint,
  normalizeErrorMessage, ownFrame, reportError, scrubSecrets } from '../src/platform/error-reports.js';
import { ERROR_FIXER_TITLE, ERROR_FIXER_TRIGGER, errorReportSettings, saveErrorReportSettings } from '../src/platform/error-fixer.js';

const stores: Store[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

async function fixture() {
  const store = await Store.create(':memory:');
  stores.push(store);
  const ops = await store.createProject('tavya');
  const customer = await store.createProject('pramana');
  return { store, ops, customer };
}

const events = async (store: Store, projectId: string) => (await store.listProjectEvents(projectId)).filter((event) => event.type === ERROR_EVENT_TYPE);

describe('error fingerprints', () => {
  it('group occurrences of one bug across tasks, ids, counts and sizes', () => {
    const a = 'infrastructure: could not reach the VM over SSH: Timed out while waiting for handshake (still failing after 5 waits)';
    const b = 'infrastructure: could not reach the VM over SSH: Timed out while waiting for handshake (still failing after 3 waits)';
    expect(errorFingerprint('escalation', 'Escalation', a)).toBe(errorFingerprint('escalation', 'Escalation', b));
    expect(normalizeErrorMessage('task task_mvsitnou5bac9c9f45 world kx-91ed573c73-644ecc751cf9 at 10.0.0.12'))
      .toBe('task <id> world kx-<hex>-<hex> at <n>.<n>.<n>.<n>');
    expect(errorFingerprint('escalation', 'Escalation', a))
      .not.toBe(errorFingerprint('escalation', 'Escalation', 'infrastructure: Hetzner refused a new server'));
    // Same message, a different place in the code: a different bug.
    const at = (frame: string) => `Error: boom\n    at ${frame}\n    at node:internal/process`;
    expect(errorFingerprint('request', 'Error', 'boom', at('handle (/app/src/gateway/server.ts:10:5)')))
      .toBe(errorFingerprint('request', 'Error', 'boom', at('handle (/app/src/gateway/server.ts:99:1)')));
    expect(errorFingerprint('request', 'Error', 'boom', at('handle (/app/src/gateway/server.ts:10:5)')))
      .not.toBe(errorFingerprint('request', 'Error', 'boom', at('run (/app/src/world/runners.ts:10:5)')));
    expect(ownFrame(at('async ErrorThing.run (/app/src/world/runners.ts:10:5)'))).toBe('src/world/runners.ts ErrorThing.run');
  });

  it('never carry a credential the error text did', () => {
    const text = scrubSecrets('push to https://x-access-token:ghs_abcdefghijklmnop1234@github.com/o/r failed; header Bearer abcdefghijklmnopqrstuvwx; key sk-ant-api03-abcdefghijkl');
    expect(text).not.toMatch(/ghs_abcdefghijklmnop1234|abcdefghijklmnopqrstuvwx|sk-ant-api03/);
    expect(text).toContain('github.com/o/r');
  });
});

describe('the error reporter', () => {
  it('reports nothing until the installation names a project', async () => {
    const { store, ops } = await fixture();
    const reporter = new ErrorReporter(store);
    expect(await reporter.report({ kind: 'request', error: new Error('boom') })).toBeUndefined();
    expect(await events(store, ops.id)).toEqual([]);
  });

  it('records one platform event per error per day, throttled before the database', async () => {
    const { store, ops, customer } = await fixture();
    await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId: ops.id }));
    let now = Date.parse('2026-11-08T11:24:28Z');
    const reporter = new ErrorReporter(store, { now: () => now, revision: 'abc123', role: 'worker' });
    const error = Object.assign(new Error('infrastructure: could not reach the VM over SSH: Timed out while waiting for handshake (still failing after 5 waits)'), { name: 'Escalation' });
    const event = await reporter.report({ kind: 'escalation', error, where: 'stage do', taskId: 'task_mvsitnou5bac9c9f45', projectId: customer.id });
    expect(event).toMatchObject({ source: ERROR_EVENT_SOURCE, type: ERROR_EVENT_TYPE, projectId: ops.id, hops: 0,
      key: `${event!.payload.fingerprint}:2026-11-08`, subject: `tavya-error:${event!.payload.fingerprint}` });
    expect(event!.payload).toMatchObject({ kind: 'escalation', name: 'Escalation', where: 'stage do', taskId: 'task_mvsitnou5bac9c9f45',
      projectId: customer.id, revision: 'abc123', process: 'worker',
      summary: `Escalation: ${error.message}`.slice(0, 120) });
    // Again at once, and again an hour later the same day: one event.
    expect(await reporter.report({ kind: 'escalation', error })).toBeUndefined();
    now += 3_600_000;
    expect(await reporter.report({ kind: 'escalation', error })).toBeUndefined();
    // The next day it is news again.
    now = Date.parse('2026-11-09T09:00:00Z');
    expect(await reporter.report({ kind: 'escalation', error })).toMatchObject({ key: `${event!.payload.fingerprint}:2026-11-09` });
    expect(await events(store, ops.id)).toHaveLength(2);
  });

  it('caps a storm of different errors at 20 a minute per process', async () => {
    const { store, ops } = await fixture();
    await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId: ops.id }));
    const reporter = new ErrorReporter(store, { now: () => 1_000_000 });
    for (let i = 0; i < 50; i++) await reporter.report({ kind: 'request', error: new Error(`distinct failure ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}`) });
    expect(await events(store, ops.id)).toHaveLength(20);
  });
});

describe('the fixer', () => {
  it('starts only from the platform: an event anyone emits with the same type does not', async () => {
    expect(await validateTriggers([ERROR_FIXER_TRIGGER])).toEqual([]);
    const event = (source: string): ProjectEvent => ({ id: 'pev_1', organizationId: 'org_a', projectId: 'proj_a', source, type: ERROR_EVENT_TYPE,
      key: 'k', occurredAt: 1, receivedAt: 1, payload: { summary: 'boom' }, origin: 'external', hops: 0 });
    expect(projectEventMatchesTrigger(ERROR_FIXER_TRIGGER, event('tavya'))).toBe(true);
    for (const forged of ['user:usr_1', 'task:task_1', 'webhook:hook_1', 'github', 'system:github-recovery'])
      expect(projectEventMatchesTrigger(ERROR_FIXER_TRIGGER, event(forged))).toBe(false);
    // Its run is titled from the error and reads the event as data, not instructions.
    const run = applyTriggerContext(ERROR_FIXER_TITLE, { prompt: 'fix it' }, triggerContext(event('tavya')));
    expect(run.title).toBe('Fix: boom');
    expect(run.params.prompt).toMatch(/fix it[\s\S]*event payload/);
  });

  it('is made once in the chosen project, with the caller\'s authority; null turns reports off', async () => {
    const { store, ops } = await fixture();
    const made: Array<{ token: string; input: any }> = [];
    const api = { createTask: async (token: string, input: any) => {
      made.push({ token, input });
      return store.createTask({ projectId: input.projectId, title: input.title, workflow: 'software-dev', workflowVersion: '1.30.0',
        params: { prompt: input.prompt, ...input.params } });
    } } as any;
    const first = await saveErrorReportSettings(store, api, 'tok_operator', ops.id);
    expect(first).toEqual({ projectId: ops.id, fixerTaskId: expect.stringMatching(/^task_/) });
    expect(made).toEqual([{ token: 'tok_operator', input: expect.objectContaining({ projectId: ops.id, title: ERROR_FIXER_TITLE,
      params: expect.objectContaining({ repeatable: true, triggers: [ERROR_FIXER_TRIGGER] }) }) }]);
    // Saving again keeps the same fixer.
    expect(await saveErrorReportSettings(store, api, 'tok_operator', ops.id)).toEqual(first);
    expect(made).toHaveLength(1);
    expect(await errorReportSettings(store)).toEqual(first);
    expect(await saveErrorReportSettings(store, api, 'tok_operator', null)).toEqual({});
    expect(await errorReportSettings(store)).toEqual({});
    expect(await store.kvGet(ERROR_REPORTS_KEY)).toBeUndefined();
  });
});

describe('a task stopped by a failure', () => {
  async function publishing() {
    const { store, ops, customer } = await fixture();
    configureErrorReports(store, { revision: 'rev1', role: 'worker' });
    await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId: ops.id }));
    const task = await store.createTask({ projectId: customer.id, title: 'T', workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: 'p' } });
    const core = makeCoreActivities({ store, worlds: new WorldRegistry(), adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
    const view = (patch: Partial<TaskView>, at: number) => ({ taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
      messages: [], actions: [], state: {}, updatedAt: at, ...patch }) as TaskView;
    let seq = 0;
    const publish = (patch: Partial<TaskView>) => core.publishView(task.id, view(patch, ++seq));
    return { store, ops, task, publish };
  }

  it('is reported once, with what stopped it (pramana#137)', async () => {
    const ctx = vi.spyOn(Context, 'current').mockReturnValue({ info: { workflowExecution: { runId: 'run' }, activityId: 'publish' } } as any);
    try {
      const { store, ops, task, publish } = await publishing();
      const error = 'infrastructure: could not reach the VM over SSH: Timed out while waiting for handshake (still failing after 5 waits)';
      await publish({});
      await publish({ status: 'blocked', error, waitingFor: { kind: 'human', reason: 'error', audience: ['@creator', '@admins'], detail: error } as any });
      await vi.waitFor(async () => expect(await events(store, ops.id)).toHaveLength(1));
      const [event] = await events(store, ops.id);
      expect(event!.payload).toMatchObject({ kind: 'escalation', name: 'Escalation', taskId: task.id, message: error,
        detail: { audience: ['@creator', '@admins'], waitingFor: 'human' } });
      // The same failure published again (a status refresh) is not news.
      await publish({ status: 'blocked', error, waitingFor: { kind: 'human', reason: 'error', audience: ['@creator', '@admins'], detail: error } as any });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await events(store, ops.id)).toHaveLength(1);
    } finally { ctx.mockRestore(); }
  });

  it('is not reported when the organization must act (a credential, a hard limit)', async () => {
    const ctx = vi.spyOn(Context, 'current').mockReturnValue({ info: { workflowExecution: { runId: 'run' }, activityId: 'publish' } } as any);
    try {
      const { store, ops, publish } = await publishing();
      await publish({ status: 'blocked', error: 'Every Claude login needs a sign-in', waitingFor: { kind: 'human', reason: 'error', audience: ['@admins'] } as any });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await events(store, ops.id)).toEqual([]);
      // An agent's ordinary question is no error at all.
      await publish({ status: 'waiting', waitingFor: { kind: 'human', audience: ['@creator'] } as any });
      reportError({ kind: 'request', error: new Error('ok') }); // the reporter itself works
      await vi.waitFor(async () => expect(await events(store, ops.id)).toHaveLength(1));
    } finally { ctx.mockRestore(); }
  });
});
