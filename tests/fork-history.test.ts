import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { sessionCapabilities } from '../src/auth/app-grants.js';

/**
 * A forked agent remembers its source's conversation up to the fork, so the
 * fork's page shows that part above its own (`GET /api/tasks/:id/fork-history`):
 * each task of the lineage the reader may read, oldest first, cut where the next
 * forked from it.
 */
async function fixture() {
  const store = (await Store.create(':memory:'));
  (await store.claimPersonalOrganization('owner'));
  (await store.setOrganizationMembership('org_personal', 'dev', 'member'));
  const origin = (await store.createProject('Origin'));
  const work = (await store.createProject('Work'));
  const authorization = (await AuthorizationService.create(store));
  for (const project of [origin, work])
    (await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' }));
  (await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(work.id), profileId: 'developer' }));
  const tokens = new TokenAuthority(store);
  const token = async (userId: string, projectId: string) => (await tokens.mintPrincipal(`user:${userId}`,
    (await sessionCapabilities(authorization, userId, undefined, { projectId, organizationId: 'org_personal' })), projectId, undefined, 'org_personal')).token;
  const client = { workflow: { getHandle: () => ({ query: async () => undefined }), start: async () => ({}) } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const T = Date.now() - 60 * 60_000;
  const task = async (projectId: string, title: string, params: Record<string, unknown>, messages: { id: string; role: 'user' | 'agent'; text: string; ts: number }[]) => {
    const record = (await store.createTask({ projectId, title, workflow: 'software-dev', workflowVersion: '1.27.0',
      createdBy: { kind: 'user', userId: 'owner' }, params: { prompt: messages[0]?.text ?? title, ...params } }));
    (await store.saveView(record.id, { taskId: record.id, title, workflow: 'software-dev', stage: 'done', status: 'done', messages, state: {} } as any));
    return record;
  };
  const step = (taskId: string, ts: number, title: string, role = 'do') => store.appendEvent({ type: 'agent.activity', taskId, ts,
    payload: { role, turnId: `turn-${ts}`, attempt: 1, id: `cmd-${ts}`, kind: 'command', phase: 'completed', title } });
  return { store, api, token, origin, work, T, task, step };
}

describe('GET /api/tasks/:id/fork-history', () => {
  it("shows every task of a fork lineage up to where the next forked, oldest first", async () => {
    const f = (await fixture());
    const { T } = f;
    const source = (await f.task(f.origin.id, 'Source', {}, [
      { id: 'm0', role: 'user', text: 'Pick a codeword.', ts: T },
      { id: 'a1', role: 'agent', text: 'Heron.', ts: T + 1_000 },
      { id: 'u2', role: 'user', text: 'Said after the fork.', ts: T + 9_000 },
    ]));
    (await f.step(source.id, T + 500, 'echo before'));
    (await f.step(source.id, T + 9_500, 'echo after'));
    (await f.step(source.id, T + 600, 'a reviewer step', 'confirm'));
    const fork = (await f.task(f.work.id, 'Fork', { 'agent:do': { resumeFrom: { taskId: source.id, role: 'do' } } }, [
      { id: 'm0', role: 'user', text: 'Continue.', ts: T + 3_000 },
      { id: 'a1', role: 'agent', text: 'Continuing.', ts: T + 4_000 },
      { id: 'u2', role: 'user', text: 'Said after the second fork.', ts: T + 8_000 },
    ]));
    (await f.store.appendEvent({ type: 'session.forked', taskId: fork.id, ts: T + 3_000, payload: { from: { taskId: source.id, role: 'do' }, role: 'do', native: true } }));
    const second = (await f.task(f.work.id, 'Second fork', { 'agent:do': { resumeFrom: { taskId: fork.id } } }, [
      { id: 'm0', role: 'user', text: 'Once more.', ts: T + 6_000 },
    ]));
    (await f.store.appendEvent({ type: 'session.forked', taskId: second.id, ts: T + 6_000, payload: { from: { taskId: fork.id }, role: 'do', native: true } }));

    const history = await f.api.taskForkHistory((await f.token('owner', f.work.id)), second.id);
    expect(history.map((segment) => [segment.taskId, segment.title, segment.role, segment.until]))
      .toEqual([[source.id, 'Source', 'do', T + 3_000], [fork.id, 'Fork', 'do', T + 6_000]]);
    expect(history[0]!.messages.map((m) => m.text)).toEqual(['Pick a codeword.', 'Heron.']);
    expect(history[0]!.events.map((e) => e.payload.title)).toEqual(['echo before']);
    expect(history[1]!.messages.map((m) => m.text)).toEqual(['Continue.', 'Continuing.']);
    expect(await f.api.taskForkHistory((await f.token('owner', f.origin.id)), source.id)).toEqual([]);

    // Someone who may read only the forks sees them, not the source behind them.
    const dev = await f.api.taskForkHistory((await f.token('dev', f.work.id)), second.id);
    expect(dev.map((segment) => segment.taskId)).toEqual([fork.id]);
    (await f.store.close());
  });

  it('cuts a fork that has not run yet where it was made, and shows nothing of one that failed', async () => {
    const f = (await fixture());
    const { T } = f;
    const source = (await f.task(f.work.id, 'Source', {}, [
      { id: 'm0', role: 'user', text: 'Before.', ts: T },
      { id: 'a1', role: 'agent', text: 'Long after.', ts: Date.now() + 60_000 },
    ]));
    const pending = (await f.task(f.work.id, 'Pending', { 'agent:do': { resumeFrom: { taskId: source.id } } }, []));
    const history = await f.api.taskForkHistory((await f.token('owner', f.work.id)), pending.id);
    expect(history.map((segment) => segment.messages.map((m) => m.text))).toEqual([['Before.']]);
    expect(history[0]!.until).toBe(pending.createdAt);

    const failed = (await f.task(f.work.id, 'Failed', { 'agent:do': { resumeFrom: { taskId: source.id } } }, []));
    (await f.store.appendEvent({ type: 'session.fork-failed', taskId: failed.id, ts: T + 10, payload: { from: { taskId: source.id }, role: 'do', reason: 'source-not-authorized' } }));
    expect(await f.api.taskForkHistory((await f.token('owner', f.work.id)), failed.id)).toEqual([]);
    (await f.store.close());
  });
});
