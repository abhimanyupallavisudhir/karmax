import { describe, it, expect } from 'vitest';
import { storeBackends } from './helpers/store-backends.js';

/**
 * `for:<person>` reads the inbox's live asks: what a task needs from that person
 * now (review, input, approval, assignment), plus mentions they have not read.
 * Routine updates never count, and an ask stops counting once it is discharged.
 */
describe.each(storeBackends)('attention asks ($name)', ({ open }) => {
  it('lists live asks and unread mentions per organization, not updates or answered asks', async () => {
    const store = await open();
    const organization = await store.createOrganization({ name: 'Team', ownerUserId: 'owner' });
    const other = await store.createOrganization({ name: 'Elsewhere', ownerUserId: 'owner' });
    const project = await store.createProject('App', {}, organization.id);
    const foreign = await store.createProject('Other', {}, other.id);
    const make = async (projectId: string, title: string) => {
      const task = await store.createTask({ projectId, title, workflow: 'software-dev', workflowVersion: '1.0.0',
        params: { prompt: title }, createdBy: { kind: 'user', userId: 'owner' } });
      return task;
    };
    const view = async (taskId: string, patch: Record<string, unknown>) => {
      const next = { taskId, title: taskId, workflow: 'software-dev', stage: 'do', status: 'active', messages: [], actions: [],
        state: {}, updatedAt: Date.now(), ...patch } as any;
      await store.saveView(taskId, next, undefined, undefined, undefined, { lifecycleEvent: false });
      await store.appendEvent({ taskId, type: 'view.updated', ts: Date.now(),
        payload: { stage: next.stage, status: next.status, waitingFor: next.waitingFor?.kind ?? null } });
    };
    const review = await make(project.id, 'Review me');
    const mention = await make(project.id, 'Mentions me');
    const elsewhere = await make(foreign.id, 'Other org');
    await view(review.id, { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } });
    await store.appendEvent({ taskId: mention.id, type: 'task.mentioned', ts: Date.now(),
      payload: { principal: { kind: 'user', userId: 'owner' } } });
    await view(elsewhere.id, { stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } });

    const asks = await store.attentionAsks('owner', organization.id);
    expect(Object.fromEntries([...asks].map(([id, ask]) => [id, ask.kinds]))).toEqual({ [review.id]: ['review-requested'], [mention.id]: ['mentioned'] });
    // When each ask arrived, so a list of what needs this person leads with the newest.
    expect(asks.get(mention.id)!.at).toBeGreaterThanOrEqual(asks.get(review.id)!.at);
    expect([...(await store.attentionAsks('owner', other.id)).keys()]).toEqual([elsewhere.id]);

    // (A task with no reviewers routes its review to its creator.)
    // Reading a mention settles it; answering a review discharges it.
    const mentionRow = (await store.listInbox('owner', organization.id)).find((item) => item.taskId === mention.id)!;
    await store.markInbox('owner', mentionRow.id, false);
    await view(review.id, { stage: 'do', status: 'active' });
    expect((await store.attentionAsks('owner', organization.id)).size).toBe(0);
  });

  /** #613: the Agent answered its owner, then waited on a bigger machine. Its
   * reply was an @mention ask, so the task stayed on For you after it was read. */
  it('a reply that asks nothing counts until read; a mention that asks counts until answered', async () => {
    const store = await open();
    const organization = await store.createOrganization({ name: 'Team', ownerUserId: 'owner' });
    const project = await store.createProject('App', {}, organization.id);
    const make = (title: string) => store.createTask({ projectId: project.id, title, workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: title }, createdBy: { kind: 'user', userId: 'owner' } });
    const replied = await make('Replied to me');
    const asked = await make('Asked me');
    await store.appendEvent({ taskId: replied.id, type: 'task.mentioned', ts: Date.now(),
      payload: { recipients: ['user:owner'], by: 'agent:do', text: 'Moving to a bigger machine.', ask: false } });
    await store.appendEvent({ taskId: asked.id, type: 'task.mentioned', ts: Date.now(),
      payload: { recipients: ['user:owner'], by: 'agent:do', text: 'Which URL style?' } });

    const kinds = async () => Object.fromEntries([...(await store.attentionAsks('owner', organization.id))].map(([id, ask]) => [id, ask.kinds]));
    expect(await kinds()).toEqual({ [replied.id]: ['mentioned'], [asked.id]: ['mentioned'] });
    for (const item of await store.listInbox('owner', organization.id)) await store.markInbox('owner', item.id, false);
    expect(await kinds()).toEqual({ [asked.id]: ['mentioned'] });
    await store.dischargeMentions(asked.id, 'owner');
    expect(await kinds()).toEqual({});

    // A later reply is news again; a reply never demotes an ask to news.
    await store.appendEvent({ taskId: replied.id, type: 'task.mentioned', ts: Date.now(),
      payload: { recipients: ['user:owner'], by: 'agent:do', text: 'Back. Tests pass.', ask: false } });
    await store.appendEvent({ taskId: asked.id, type: 'task.mentioned', ts: Date.now(),
      payload: { recipients: ['user:owner'], by: 'agent:do', text: 'Which URL style?' } });
    await store.appendEvent({ taskId: asked.id, type: 'task.mentioned', ts: Date.now(),
      payload: { recipients: ['user:owner'], by: 'agent:do', text: 'Waiting on CI.', ask: false } });
    for (const item of await store.listInbox('owner', organization.id)) await store.markInbox('owner', item.id, false);
    expect(await kinds()).toEqual({ [asked.id]: ['mentioned'] });
    // An ask on the task supersedes a reply that asked nothing.
    await store.appendEvent({ taskId: replied.id, type: 'task.mentioned', ts: Date.now(),
      payload: { recipients: ['user:owner'], by: 'agent:do', text: 'Done.', ask: false } });
    await store.saveView(replied.id, { taskId: replied.id, title: 'r', workflow: 'software-dev', stage: 'review', status: 'waiting',
      waitingFor: { kind: 'human' }, messages: [], actions: [], state: {}, updatedAt: Date.now() } as any, undefined, undefined, undefined, { lifecycleEvent: false });
    await store.appendEvent({ taskId: replied.id, type: 'view.updated', ts: Date.now(),
      payload: { stage: 'review', status: 'waiting', waitingFor: 'human' } });
    expect((await store.listInbox('owner', organization.id)).filter((item) => item.taskId === replied.id).map((item) => item.kind))
      .toEqual(['review-requested']);
  });

  /** A second reply made the row unread again but kept the first reply's time,
   * so it stayed below asks that came in between (For me and the bell). */
  it('a later reply arrives when it is sent, not when the first one was', async () => {
    const store = await open();
    const organization = await store.createOrganization({ name: 'Team', ownerUserId: 'owner' });
    const project = await store.createProject('App', {}, organization.id);
    const task = await store.createTask({ projectId: project.id, title: 'Replies', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'r' }, createdBy: { kind: 'user', userId: 'owner' } });
    const reply = (ts: number, text: string) => store.appendEvent({ taskId: task.id, type: 'task.mentioned', ts,
      payload: { recipients: ['user:owner'], by: 'agent:do', text, ask: false } });
    await reply(1_000, 'First.');
    for (const item of await store.listInbox('owner', organization.id)) await store.markInbox('owner', item.id, false);
    await reply(9_000, 'Second.');
    expect((await store.attentionAsks('owner', organization.id)).get(task.id)!.at).toBe(9_000);
    const [row] = (await store.listInbox('owner', organization.id)).filter((item) => item.taskId === task.id);
    expect(row).toMatchObject({ kind: 'mentioned', unread: true, createdAt: 9_000 });
  });

  it('narrows a task read to the candidates and every draft', async () => {
    const store = await open();
    const organization = await store.createOrganization({ name: 'Team', ownerUserId: 'owner' });
    const project = await store.createProject('App', {}, organization.id);
    const make = (title: string, params: Record<string, unknown> = {}) => store.createTask({ projectId: project.id, title,
      workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: title, ...params }, createdBy: { kind: 'user', userId: 'owner' } });
    const asked = await make('asked');
    await make('busy');
    const draft = await make('draft', { draft: true });
    const read = async (candidateIds?: string[]) => {
      const out: string[] = [];
      for await (const page of store.taskReadPages(project.id, { candidateIds })) out.push(...page.map((task) => task.title));
      return out.sort();
    };
    expect(await read([asked.id])).toEqual(['asked', 'draft']);
    expect(await read([])).toEqual(['draft']);
    expect(await read()).toEqual(['asked', 'busy', 'draft']);
    expect(draft.params.draft).toBe(true);
  });

  it('names the people of an organization by name and email', async () => {
    const store = await open();
    const organization = await store.createOrganization({ name: 'Team', ownerUserId: 'owner' });
    await store.setOrganizationMembership(organization.id, 'ana', 'member');
    await store.setOrganizationMembership(organization.id, 'guest', 'member');
    store.connectUserNames(() => [
      { id: 'owner', name: 'Olu', email: 'olu@example.com' },
      { id: 'ana', name: 'Ana Lima', email: 'ana@example.com' },
      { id: 'guest', name: 'Gus', email: 'gus@example.com' },
      { id: 'stranger', name: 'Stan', email: 'stan@example.com' },
    ]);
    const people = await store.organizationPeople(organization.id);
    expect(people.map((person) => person.id).sort()).toEqual(['ana', 'guest', 'owner']);
    expect(people.find((person) => person.id === 'ana')).toEqual({ id: 'ana', name: 'Ana Lima', email: 'ana@example.com' });
  });
});
