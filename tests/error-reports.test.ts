import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@temporalio/activity';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import type { TaskView } from '../src/domain/types.js';
import { projectEventMatchesTrigger, validateTriggers } from '../src/domain/triggers.js';
import { applyTriggerContext, triggerContext, type ProjectEvent } from '../src/domain/project-events.js';
import { DEPLOY_EVENT_TYPE, ERROR_EVENT_SOURCE, ERROR_EVENT_TYPE, ERROR_REPORTS_KEY, ErrorReporter, configureErrorReports, errorFingerprint,
  normalizeErrorMessage, ownFrame, ownFrames, recordDeploy, rememberTaskFailure, reportError, reportFromPerson, scrubSecrets } from '../src/platform/error-reports.js';
import { buildHistory, buildRevision } from '../src/util/build-revision.js';
import { ERROR_FIXER_PROMPT, ERROR_FIXER_TEMPLATE_ID, ERROR_FIXER_TITLE, ERROR_FIXER_TRIGGER, errorFixerKey, errorReportSettings, saveErrorReportSettings,
  upgradeErrorFixer } from '../src/platform/error-fixer.js';
import { STORE_TASKS } from '../src/domain/task-store.js';
import { BRAND } from '../src/domain/brand.js';

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
  const at = (...frames: string[]) => `Error: boom\n${frames.map((frame) => `    at ${frame}`).join('\n')}\n    at node:internal/process`;

  it('group occurrences of one bug across tasks, ids, counts and sizes', () => {
    const a = 'infrastructure: could not reach the VM over SSH: Timed out while waiting for handshake (still failing after 5 waits)';
    const b = 'infrastructure: could not reach the VM over SSH: Timed out while waiting for handshake (still failing after 3 waits)';
    expect(errorFingerprint('escalation', 'Escalation', a)).toBe(errorFingerprint('escalation', 'Escalation', b));
    expect(normalizeErrorMessage('task task_mvsitnou5bac9c9f45 world kx-91ed573c73-644ecc751cf9 at 10.0.0.12'))
      .toBe('task <id> world kx-<hex>-<hex> at <n>.<n>.<n>.<n>');
    expect(errorFingerprint('escalation', 'Escalation', a))
      .not.toBe(errorFingerprint('escalation', 'Escalation', 'infrastructure: Hetzner refused a new server'));
    expect(ownFrame(at('async ErrorThing.run (/app/src/world/runners.ts:10:5)'))).toBe('src/world/runners.ts ErrorThing.run');
  });

  it('are where the error was thrown when that is known, whatever it said and however it surfaced', () => {
    const vault = at('VaultStore.read (/app/src/autonomy/vault.ts:10:5)', 'Broker.open (/app/src/autonomy/broker.ts:40:9)');
    // One throw site that words its message per case is one bug (the vault's "api-key" and "ssh-key" were two).
    expect(errorFingerprint('escalation', 'VaultError', 'the api-key item is unreadable', vault))
      .toBe(errorFingerprint('escalation', 'VaultError', 'the ssh-key item is unreadable', vault));
    // …and so is the same failure answering a request 500 here and stopping a task there.
    expect(errorFingerprint('request', 'VaultError', 'x', vault)).toBe(errorFingerprint('escalation', 'VaultError', 'y', vault));
    // Line numbers move with every edit; the place does not.
    expect(errorFingerprint('request', 'Error', 'boom', at('handle (/app/src/gateway/server.ts:10:5)')))
      .toBe(errorFingerprint('request', 'Error', 'boom', at('handle (/app/src/gateway/server.ts:99:1)')));
    // Another place, or the same place reached another way, is another bug.
    expect(errorFingerprint('request', 'Error', 'boom', at('handle (/app/src/gateway/server.ts:10:5)')))
      .not.toBe(errorFingerprint('request', 'Error', 'boom', at('run (/app/src/world/runners.ts:10:5)')));
    expect(errorFingerprint('request', 'VaultError', 'x', vault))
      .not.toBe(errorFingerprint('request', 'VaultError', 'x', at('VaultStore.read (/app/src/autonomy/vault.ts:10:5)', 'Sweep.run (/app/src/world/runners.ts:1:1)')));
    expect(ownFrames(vault)).toEqual(['src/autonomy/vault.ts VaultStore.read', 'src/autonomy/broker.ts Broker.open']);
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
    await reporter.flush();
    expect(await events(store, ops.id)).toEqual([]);
  });

  it('keeps one event per bug and counts every occurrence on it', async () => {
    const { store, ops, customer } = await fixture();
    await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId: ops.id }));
    let now = Date.parse('2026-11-08T11:24:28Z');
    const reporter = new ErrorReporter(store, { now: () => now, revision: 'abc123', role: 'worker' });
    const error = Object.assign(new Error('infrastructure: could not reach the VM over SSH: Timed out while waiting for handshake (still failing after 5 waits)'), { name: 'Escalation', stack: undefined });
    const event = await reporter.report({ kind: 'escalation', error, where: 'stage do', taskId: 'task_mvsitnou5bac9c9f45', projectId: customer.id, organizationId: 'org_a' });
    expect(event).toMatchObject({ source: ERROR_EVENT_SOURCE, type: ERROR_EVENT_TYPE, projectId: ops.id, hops: 0, count: 1,
      key: event!.payload.fingerprint, subject: `tavya-error:${event!.payload.fingerprint}` });
    expect(event!.payload).toMatchObject({ kind: 'escalation', name: 'Escalation', where: 'stage do', taskId: 'task_mvsitnou5bac9c9f45',
      projectId: customer.id, revision: 'abc123', process: 'worker',
      summary: `Escalation: ${error.message}`.slice(0, 120) });
    // An outage: thousands of occurrences are counted in memory and written together.
    for (let i = 0; i < 4_000; i++)
      expect(await reporter.report({ kind: 'escalation', error, taskId: `task_${i}`, organizationId: i % 2 ? 'org_a' : 'org_b' })).toBeUndefined();
    now += 60_000;
    await reporter.flush();
    // Days later it is still the same bug.
    now = Date.parse('2026-11-12T09:00:00Z');
    await reporter.report({ kind: 'escalation', error, organizationId: 'org_c' });
    await reporter.flush();
    const [bug, ...others] = await events(store, ops.id);
    expect(others).toEqual([]);
    expect(bug).toMatchObject({ id: event!.id, count: 4_002, receivedAt: Date.parse('2026-11-08T11:24:28Z'), lastSeenAt: now });
    expect(bug!.distinct).toMatchObject({ organizationId: ['org_a', 'org_b', 'org_c'], revision: ['abc123'] });
    // Its first occurrence stays the event; the latest are kept beside it.
    expect(bug!.payload.taskId).toBe('task_mvsitnou5bac9c9f45');
    expect(bug!.recent!.at(-1)).toMatchObject({ at: now, payload: { organizationId: 'org_c' } });
  });

  it('writes a storm of different bugs as one event each, dropping none', async () => {
    const { store, ops } = await fixture();
    await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId: ops.id }));
    const reporter = new ErrorReporter(store, { now: () => 1_000_000 });
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (let round = 0; round < 3; round++)
      for (let i = 0; i < 50; i++) await reporter.report({ kind: 'request', error: new Error(`distinct failure ${letters[i % 26]}${letters[Math.floor(i / 26)]}`) });
    await reporter.flush();
    const all = await events(store, ops.id);
    expect(all).toHaveLength(50);
    expect(all.every((event) => event.count === 3)).toBe(true);
  });

  it('counts a person\'s report of a task\'s error on the bug the platform reported it under', async () => {
    const { store, ops, customer } = await fixture();
    await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId: ops.id }));
    const reporter = configureErrorReports(store, { revision: 'rev1', role: 'gateway' });
    const text = 'infrastructure: could not reach the VM over SSH: Timed out while waiting for handshake';
    // The worker reported it with the failing activity's stack, which the gateway does not have.
    const thrown = Object.assign(new Error(text), { name: 'WorldUnreachable', stack: `WorldUnreachable: x\n    at SshTransport.exec (/app/src/world/vm/ssh.ts:342:18)` });
    const first = (await reporter.report({ kind: 'escalation', error: thrown, taskId: 'task_1', projectId: customer.id }))!;
    expect(await reportFromPerson(store, { by: 'user:usr_1', task: { id: 'task_1', projectId: customer.id, error: text, stage: 'do' }, note: 'Retry did nothing' })).toBe(true);
    const [bug, ...others] = await events(store, ops.id);
    expect(others).toEqual([]);
    expect(bug).toMatchObject({ id: first.id, count: 2 });
    expect(bug!.recent!.at(-1)!.payload).toMatchObject({ kind: 'reported', detail: { reportedBy: 'user:usr_1', note: 'Retry did nothing' } });
    // An error in their own words is a report of its own, marked as theirs.
    expect(await reportFromPerson(store, { by: 'user:usr_1', message: 'HTTP 502', where: '/org/project/tasks/:n' })).toBe(true);
    const reported = (await events(store, ops.id)).find((event) => event.id !== first.id)!;
    expect(reported.payload).toMatchObject({ kind: 'reported', name: 'Reported', message: 'HTTP 502', detail: { inTheirWords: true } });
    // Off: nothing to report to.
    await store.kvDelete(ERROR_REPORTS_KEY);
    reporter.invalidate();
    expect(await reportFromPerson(store, { by: 'user:usr_1', message: 'boom' })).toBe(false);
  });
});

describe('a deploy', () => {
  it('is recorded once per new revision, with the commits it shipped', async () => {
    const { store, ops } = await fixture();
    const sha = (n: number) => String(n).padStart(40, 'a');
    // Reports off: the revision is remembered, nothing is said.
    expect(await recordDeploy(store, { history: [sha(2), sha(1)] })).toBeUndefined();
    await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId: ops.id }));
    expect(await recordDeploy(store, { history: [sha(2), sha(1)] })).toBeUndefined(); // the same revision booting again
    const deployed = (await recordDeploy(store, { history: [sha(5), sha(4), sha(3), sha(2), sha(1)] }))!;
    expect(deployed).toMatchObject({ type: DEPLOY_EVENT_TYPE, source: ERROR_EVENT_SOURCE, projectId: ops.id,
      payload: { revision: sha(5), previous: sha(2), commits: [sha(5), sha(4), sha(3)] } });
    expect(await recordDeploy(store, { history: [sha(5), sha(4), sha(3), sha(2), sha(1)] })).toBeUndefined();
    // An unknown revision (no build record) says nothing.
    expect(await recordDeploy(store, { history: [] })).toBeUndefined();
  });

  it('takes the revision from the image and the commits from whoever started it', async () => {
    const { store, ops } = await fixture();
    const sha = (n: number) => String(n).padStart(40, 'b');
    const short = (n: number) => sha(n).slice(0, 12);
    await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId: ops.id }));
    await recordDeploy(store, { revision: sha(2), history: [short(2), short(1)] });
    // deploy/karmax names abbreviated commits; the previous revision is found among them.
    expect((await recordDeploy(store, { revision: sha(5), history: [short(5), short(4), short(3), short(2), short(1)] }))!.payload)
      .toMatchObject({ revision: sha(5), previous: sha(2), commits: [short(5), short(4), short(3)] });
    // A history that is not this revision's (a release image started by hand) is left out.
    const bare = (await recordDeploy(store, { revision: sha(7), history: [short(5), short(4)] }))!;
    expect(bare.payload).toMatchObject({ revision: sha(7), previous: sha(5) });
    expect(bare.payload).not.toHaveProperty('commits');
    // The same with no history at all.
    expect((await recordDeploy(store, { revision: sha(8), history: [] }))!.payload).not.toHaveProperty('commits');
  });

  it('reads the history the environment names, else the checkout', () => {
    const sha = 'c'.repeat(40);
    expect(buildHistory({ KARMAX_REVISION_HISTORY: `${sha.slice(0, 12)} ABCDEF123456\n nonsense ${'d'.repeat(41)} ` }))
      .toEqual([sha.slice(0, 12), 'abcdef123456']);
    expect(buildRevision({ KARMAX_REVISION: sha, KARMAX_REVISION_HISTORY: 'abcdef123456' })).toBe(sha);
    expect(buildRevision({ KARMAX_REVISION_HISTORY: 'abcdef123456' })).toBeUndefined(); // an abbreviation is not a revision
    expect(buildHistory({})[0]).toMatch(/^[0-9a-f]{40}$/); // this checkout
  });
});

describe('the fixer', () => {
  it('starts only from the platform: an event anyone emits with the same type does not', async () => {
    expect(await validateTriggers([ERROR_FIXER_TRIGGER])).toEqual([]);
    const event = (source: string): ProjectEvent => ({ id: 'pev_1', organizationId: 'org_a', projectId: 'proj_a', source, type: ERROR_EVENT_TYPE,
      key: 'k', occurredAt: 1, receivedAt: 1, lastSeenAt: 1, count: 1, payload: { summary: 'boom' }, origin: 'external', hops: 0 });
    expect(projectEventMatchesTrigger(ERROR_FIXER_TRIGGER, event('tavya'))).toBe(true);
    for (const forged of ['user:usr_1', 'task:task_1', 'webhook:hook_1', 'github', 'system:github-recovery'])
      expect(projectEventMatchesTrigger(ERROR_FIXER_TRIGGER, event(forged))).toBe(false);
    // Its run is titled from the error and reads the event as data, not instructions.
    const run = applyTriggerContext(ERROR_FIXER_TITLE, { prompt: 'fix it' }, triggerContext(event('tavya')));
    expect(run.title).toBe('Fix: boom');
    expect(run.params.prompt).toMatch(/fix it[\s\S]*event payload/);
    // It keeps one task per bug, asks first, and waits for the deploy that ships a fix.
    expect(ERROR_FIXER_TRIGGER).toMatchObject({ source: 'tavya', concurrency: { key: '{{fingerprint}}', mode: 'continue', after: { type: DEPLOY_EVENT_TYPE, source: 'tavya' } },
      maxRunning: 3, settleMinutes: 5, gate: { prompt: expect.stringContaining('Skip') } });
  });

  it('is the store\'s error fixer, listening to an app\'s errors there', async () => {
    const entry = STORE_TASKS.find((task) => task.id === ERROR_FIXER_TEMPLATE_ID)!;
    const [trigger] = entry.task.params.triggers as [typeof ERROR_FIXER_TRIGGER];
    expect(await validateTriggers([trigger])).toEqual([]);
    expect(trigger).toMatchObject({ type: 'app.error', concurrency: { key: '{{$key}}', mode: 'continue' } });
    expect(trigger.source).toBeUndefined();
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
      params: expect.objectContaining({ repeatable: true, triggers: [ERROR_FIXER_TRIGGER], template: ERROR_FIXER_TEMPLATE_ID }) }) }]);
    // Saving again keeps the same fixer.
    expect(await saveErrorReportSettings(store, api, 'tok_operator', ops.id)).toEqual(first);
    expect(made).toHaveLength(1);
    expect(await errorReportSettings(store)).toEqual(first);
    expect(await saveErrorReportSettings(store, api, 'tok_operator', null)).toEqual({});
    expect(await errorReportSettings(store)).toEqual({});
    expect(await store.kvGet(ERROR_REPORTS_KEY)).toBeUndefined();
  });

  it('saved when one run heard every error becomes one task per bug at boot, once, unless someone changed it', async () => {
    const { store, ops } = await fixture();
    const before = { kind: 'event', type: ERROR_EVENT_TYPE, source: 'tavya', recurring: true, concurrency: { key: '', mode: 'tell' }, maxPerHour: 6 };
    const fixer = await store.createTask({ projectId: ops.id, title: 'Fix: {{summary}}', workflow: 'software-dev', workflowVersion: '1.30.0',
      params: { prompt: `## Fix an error ${BRAND} could not recover from\nold words`, repeatable: true, triggers: [before], template: 'fix-errors', triggerState: 'armed' } as any });
    await store.kvSet(ERROR_REPORTS_KEY, JSON.stringify({ projectId: ops.id }));
    await store.kvSet(errorFixerKey(ops.id), fixer.id);
    const rearmed: string[] = [];
    expect(await upgradeErrorFixer(store, async (id) => { rearmed.push(id); })).toBe(true);
    const after = (await store.getTask(fixer.id))!;
    expect(after.params.triggers).toEqual([ERROR_FIXER_TRIGGER]);
    expect(after.params.prompt).toBe(ERROR_FIXER_PROMPT);
    expect(after.title).toBe(ERROR_FIXER_TITLE);
    expect(after.params.confirm).toBeUndefined(); // who reviews its runs is not this upgrade's to change
    expect(rearmed).toEqual([fixer.id]);
    expect(await upgradeErrorFixer(store, async () => undefined)).toBe(false);
    // One a person gave another trigger stays theirs.
    await store.updateTaskParams(fixer.id, { ...after.params, triggers: [{ ...before, concurrency: { key: '{{where}}', mode: 'tell' } }] } as any);
    expect(await upgradeErrorFixer(store, async () => undefined)).toBe(false);
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

  it('is told apart by where its activity failed, not by what the task then said', async () => {
    const ctx = vi.spyOn(Context, 'current').mockReturnValue({ info: { workflowExecution: { runId: 'run' }, activityId: 'publish' } } as any);
    try {
      const { store, ops, task, publish } = await publishing();
      // The worker's activity interceptor remembers what failed for the task.
      const thrown = Object.assign(new Error('could not reach the VM over SSH: Timed out while waiting for handshake'),
        { name: 'WorldUnreachable', stack: 'WorldUnreachable: x\n    at SshTransport.exec (/app/src/world/vm/ssh.ts:342:18)\n    at VmWorld.exec (/app/src/world/vm/world.ts:48:20)' });
      rememberTaskFailure(task.id, thrown);
      const error = 'infrastructure: could not reach the VM over SSH: Timed out while waiting for handshake (still failing after 5 waits)';
      await publish({ status: 'blocked', error, waitingFor: { kind: 'human', reason: 'error', audience: ['@creator'], detail: error } as any });
      await vi.waitFor(async () => expect(await events(store, ops.id)).toHaveLength(1));
      const [event] = await events(store, ops.id);
      expect(event!.payload).toMatchObject({ kind: 'escalation', name: 'WorldUnreachable', message: error, taskId: task.id });
      expect(event!.payload.stack).toContain('src/world/vm/ssh.ts');
      expect(event!.key).toBe(errorFingerprint('request', 'WorldUnreachable', 'anything', thrown.stack));
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
