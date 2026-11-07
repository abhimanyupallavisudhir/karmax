import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { continuedReply } from '../src/domain/forks.js';

/**
 * A message said while a task cannot take one (setting up its computer,
 * opening its pull request, resolving a conflict) is kept, shown as not sent,
 * and delivered in order the moment the task takes messages again (wiki
 * features/queued-messages). Its sender may take it back until then.
 */
async function fixture(stage = 'setup', actions: unknown[] = [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }]) {
  const store = (await Store.create(':memory:'));
  (await store.claimPersonalOrganization('owner'));
  const project = (await store.createProject('Queued'));
  const authorization = (await AuthorizationService.create(store));
  (await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' }));
  (await authorization.grant('system:test', { principalId: 'user:other', scopeKey: projectScope(project.id), profileId: 'maintainer' }));
  const tokens = new TokenAuthority(store);
  const tokenFor = async (principal: string) => (await tokens.mintPrincipal(
    principal, (await authorization.capabilities(principal, project.id, 'org_personal')), project.id, undefined, 'org_personal',
  )).token;
  const signals: unknown[][] = [];
  const client = { workflow: {
    getHandle: () => ({ signal: async (...args: unknown[]) => { signals.push(args); }, query: async () => undefined }),
    start: async () => ({}),
  } } as any;
  const bus = new KarmaxBus();
  store.onEventRecorded((event) => bus.emit(event));
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization, bus });
  const task = (await store.createTask({ projectId: project.id, title: 'Queue', workflow: 'software-dev', workflowVersion: '1.30.0',
    createdBy: { kind: 'user', userId: 'owner' }, params: { prompt: 'start', 'agent:do': { provider: 'mock' } } }));
  const view = (over: Record<string, unknown> = {}) => ({ taskId: task.id, title: 'Queue', workflow: 'software-dev', stage, status: 'active',
    messages: [{ id: 'm0', role: 'user', text: 'start', ts: 1 }], actions, state: {}, updatedAt: 1,
    participants: [{ key: 'do', label: 'Agent', role: 'do', state: 'idle', messages: 0 }], ...over }) as any;
  (await store.saveView(task.id, view()));
  const followUps = () => signals.filter(([name]) => name === 'followUp').map(([, message]) => (message as { id: string; text: string }));
  const settled = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  return { store, api, task, tokenFor, followUps, view, settled };
}

const DO_ACTIONS = [
  { name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true },
  { name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true },
];

describe('queued messages', () => {
  it('a task between stages offers its message box, and keeps what is said there', async () => {
    const f = await fixture();
    const owner = await f.tokenFor('user:owner');
    const offered = await f.api.getTaskView(owner, f.task.id);
    expect(offered?.actions.find((action) => action.name === 'followUp')).toMatchObject({ queues: true, roles: ['do'] });
    // Before Cancel, as the workflow orders its own follow-up.
    expect(offered?.actions.map((action) => action.name)).toEqual(['followUp', 'cancel']);

    const posted = await f.api.postTaskMessage(owner, f.task.id, { text: 'Use the staging database' });
    expect(posted.message).toMatchObject({ text: 'Use the staging database', queued: true, author: 'user:owner' });
    await f.settled();
    expect(f.followUps()).toEqual([]);
    const shown = await f.api.getTaskView(owner, f.task.id);
    expect(shown?.pendingMessages).toEqual([{ role: 'do', mine: true, message: expect.objectContaining({ text: 'Use the staging database' }) }]);
    // Only its sender sees it as theirs.
    expect((await f.api.getTaskView(await f.tokenFor('user:other'), f.task.id))?.pendingMessages?.[0]?.mine).toBeUndefined();
    expect((await f.store.eventsOfType(f.task.id, 'conversation.pending')).length).toBe(1);
  });

  it('delivers what was kept, in order and as said, once the task takes messages', async () => {
    const f = await fixture();
    const owner = await f.tokenFor('user:owner');
    const first = (await f.api.postTaskMessage(owner, f.task.id, { text: 'one' })).message!;
    const second = (await f.api.signalTask(owner, f.task.id, 'followUp', 'two'))!;
    expect(second.queued).toBe(true);
    await f.settled();
    expect(f.followUps()).toEqual([]);

    (await f.store.saveView(f.task.id, f.view({ stage: 'do', actions: DO_ACTIONS, updatedAt: 2 })));
    await f.settled();
    expect(f.followUps().map((message) => [message.id, message.text])).toEqual([[first.id, 'one'], [second.id, 'two']]);
    expect(f.followUps()[0]).not.toHaveProperty('queued');
    expect((await f.api.getTaskView(owner, f.task.id))?.pendingMessages).toBeUndefined();
    // Every open conversation shows them as said.
    const said = (await f.store.eventsOfType(f.task.id, 'conversation.message')).map((event) => (event.payload as any).message.id);
    expect(said).toEqual([first.id, second.id]);

    // While the task takes messages they go at once, as always.
    const third = (await f.api.postTaskMessage(owner, f.task.id, { text: 'three' })).message!;
    expect(third.queued).toBeUndefined();
    expect(f.followUps().at(-1)?.id).toBe(third.id);
  });

  it('a message said while others wait goes after them, even if the task is ready', async () => {
    const f = await fixture();
    const owner = await f.tokenFor('user:owner');
    await f.api.postTaskMessage(owner, f.task.id, { text: 'one' });
    // The view changes without its lifecycle event having been handled yet.
    (await f.store.saveView(f.task.id, f.view({ stage: 'do', actions: DO_ACTIONS, updatedAt: 2 }), undefined, undefined, undefined, { lifecycleEvent: false }));
    await f.api.postTaskMessage(owner, f.task.id, { text: 'two' });
    await f.settled();
    expect(f.followUps().map((message) => message.text)).toEqual(['one', 'two']);
  });

  it('its sender can take a message back before it is delivered; nobody else can', async () => {
    const f = await fixture();
    const owner = await f.tokenFor('user:owner');
    const kept = (await f.api.postTaskMessage(owner, f.task.id, { text: 'wait for me' })).message!;
    await expect(f.api.unsendMessage(await f.tokenFor('user:other'), f.task.id, kept.id)).rejects.toThrow(/only its sender/);
    await expect(f.api.unsendMessage(owner, f.task.id, kept.id)).resolves.toMatchObject({ role: 'do', message: { text: 'wait for me' } });
    await expect(f.api.unsendMessage(owner, f.task.id, kept.id)).rejects.toThrow(/already delivered/);
    (await f.store.saveView(f.task.id, f.view({ stage: 'do', actions: DO_ACTIONS, updatedAt: 2 })));
    await f.settled();
    expect(f.followUps()).toEqual([]);
  });

  it('after Confirm a kept message waits for its sender to Continue, never sent on their behalf', async () => {
    const f = await fixture('pr');
    const owner = await f.tokenFor('user:owner');
    const kept = (await f.api.postTaskMessage(owner, f.task.id, { text: 'and then the docs' })).message!;
    expect(kept.queued).toBe(true);
    (await f.store.saveView(f.task.id, f.view({ stage: 'merge', status: 'waiting', waitingFor: { kind: 'github' }, actions: [], updatedAt: 2 })));
    await f.settled();
    expect(f.followUps()).toEqual([]);
    const view = await f.api.getTaskView(owner, f.task.id);
    expect(view?.actions).toContainEqual(expect.objectContaining({ name: 'followUp', label: 'Continue' }));
    expect(view?.pendingMessages?.[0]?.message.id).toBe(kept.id);
  });

  it('a finished task takes no messages and offers no box', async () => {
    const f = await fixture('cancelled', []);
    (await f.store.saveView(f.task.id, f.view({ status: 'cancelled', updatedAt: 2 })));
    const owner = await f.tokenFor('user:owner');
    expect((await f.api.getTaskView(owner, f.task.id))?.actions.some((action) => action.name === 'followUp')).toBe(false);
    await expect(f.api.postTaskMessage(owner, f.task.id, { text: 'too late' })).rejects.toThrow(/finished/);
  });

  it('messages kept before a restart are delivered by the next one', async () => {
    const f = await fixture();
    const owner = await f.tokenFor('user:owner');
    await f.api.postTaskMessage(owner, f.task.id, { text: 'survives' });
    (await f.store.saveView(f.task.id, f.view({ stage: 'do', actions: DO_ACTIONS, updatedAt: 2 }), undefined, undefined, undefined, { lifecycleEvent: false }));
    const signals: unknown[][] = [];
    const client = { workflow: { getHandle: () => ({ signal: async (...args: unknown[]) => { signals.push(args); } }) } } as any;
    new KarmaxApi({ store: f.store, client, taskQueue: 'test', tokens: new TokenAuthority(f.store), authorization: await AuthorizationService.create(f.store) });
    await f.settled();
    expect(signals.map(([, message]) => (message as { text: string }).text)).toEqual(['survives']);
  });

  it('tells an agent its message waits', () => {
    expect(continuedReply(undefined, true)).toMatch(/^message queued/);
    expect(continuedReply()).toBe('message delivered');
  });
});
