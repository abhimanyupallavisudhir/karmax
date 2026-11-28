import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { assemblePrompt } from '../src/agent/prompt.js';
import type { AgentProfile, TaskInput } from '../src/domain/types.js';
import { coordinatorSetting, normalizeCoordinatorSetting, coordinatorCheckIn, coordinatorRetryMinutes, wakeIntervalText,
  DEFAULT_COORDINATOR_WAKE_HOURS, coordinatorRolePrompt, rolePromptMarkerFor, rolePromptHash, untouchedRolePrompt, refreshedRolePrompt,
  coordinatorTurnPrompt, ROLE_PROMPT_PARAM, COORDINATOR_ROLE_VERSION } from '../src/domain/coordinator.js';
import { storeBackends } from './helpers/store-backends.js';

/**
 * A permanent co-ordinator (wiki features/coordinator): a task that runs its
 * project like an autonomous firm's CEO, never finishes, is woken again within
 * its interval whenever it stops, and whose failure is a critical ask. The
 * workflow half is in tests/pipeline-coordinator.test.ts.
 */
describe('the co-ordinator setting', () => {
  it('takes true or { wakeHours } in hours, decimals included, 24 by default', () => {
    expect(normalizeCoordinatorSetting(true)).toEqual({ wakeHours: 24 });
    expect(normalizeCoordinatorSetting({})).toEqual({ wakeHours: DEFAULT_COORDINATOR_WAKE_HOURS });
    expect(normalizeCoordinatorSetting({ wakeHours: 1.5 })).toEqual({ wakeHours: 1.5 });
    expect(normalizeCoordinatorSetting({ wakeHours: '0.25' })).toEqual({ wakeHours: 0.25 });
    expect(normalizeCoordinatorSetting(undefined)).toBeNull();
    expect(normalizeCoordinatorSetting(false)).toBeNull();
  });

  it('refuses an interval that is not a number of hours from a minute to a year', () => {
    for (const wakeHours of [0, -1, 0.001, 9000, 'soon', Number.NaN, Infinity])
      expect(() => normalizeCoordinatorSetting({ wakeHours })).toThrow(/wakeHours/);
    expect(() => normalizeCoordinatorSetting('yes')).toThrow(/coordinator must be/);
  });

  it('reads stored params leniently: a bad stored interval falls back to the default', () => {
    expect(coordinatorSetting({ coordinator: { wakeHours: 6 } })).toEqual({ wakeHours: 6 });
    expect(coordinatorSetting({ coordinator: { wakeHours: 'x' } })).toEqual({ wakeHours: 24 });
    expect(coordinatorSetting({})).toBeUndefined();
    expect(coordinatorSetting(undefined)).toBeUndefined();
  });

  it('says its interval in words', () => {
    expect(wakeIntervalText(24)).toBe('24 hours');
    expect(wakeIntervalText(1)).toBe('1 hour');
    expect(wakeIntervalText(0.5)).toBe('30 minutes');
    expect(coordinatorCheckIn({ wakeHours: 2.5 })).toContain('it has been 2.5 hours since you stopped');
  });
});

describe('the co-ordinator retry backoff', () => {
  it('starts at 15 minutes and doubles with each failure in a row, up to a week', () => {
    expect([1, 2, 3, 4, 5].map(coordinatorRetryMinutes)).toEqual([15, 30, 60, 120, 240]);
    expect(coordinatorRetryMinutes(0)).toBe(15);
    expect(coordinatorRetryMinutes(11)).toBe(7 * 24 * 60);
    expect(coordinatorRetryMinutes(2_000)).toBe(7 * 24 * 60);
  });
});

describe('the co-ordinator brief', () => {
  const profile: AgentProfile = { id: 'profile_do', role: 'do', name: 'Do', provider: 'mock' };
  const world = { id: 'world', kind: 'memory' as const, root: '/world', workdir: '/world', branch: 'task', base: 'main', target: 'main' };
  const task = (extra: Partial<TaskInput>): TaskInput => ({
    taskId: 'task', projectId: 'project', title: 'Run the firm', prompt: 'Grow the product', project: {}, ...extra });

  it('tells its Do agent only what the platform keeps current: rest, wake within its interval, asking, its PRs', () => {
    const prompt = assemblePrompt({ profile, role: 'do', task: task({ coordinator: { wakeHours: 6 } }), world });
    expect(prompt).toContain('# Permanent co-ordinator');
    expect(prompt).toContain('wakes you again within 6 hours to check in');
    expect(prompt).toContain('This task never finishes');
    expect(prompt).toContain('use escalate_to_human (or pause with needs_input)');
    expect(prompt).toContain('open_pr() one for every branch with new work; neither ends this task.');
    // The role and judgment are its prompt, which people see and edit.
    expect(prompt).not.toContain('So don\'t make changes yourself.');
    expect(prompt).toContain('Grow the product');
  });

  it('keeps the interval in the hidden part, so an edited prompt still hears an interval change', () => {
    // Someone replaced the role text with their own words.
    const edited = task({ prompt: 'Only ever look after the docs.', coordinator: { wakeHours: 6 } });
    expect(assemblePrompt({ profile, role: 'do', task: edited, world })).toContain('within 6 hours');
    // The interval is edited while it runs: the next turn's brief says the new one.
    const later = assemblePrompt({ profile, role: 'do', task: { ...edited, coordinator: { wakeHours: 0.5 } }, world });
    expect(later).toContain('within 30 minutes');
    expect(later).not.toContain('within 6 hours');
    expect(later).toContain('Only ever look after the docs.');
  });

  it('has a role prompt: run the firm through tasks, forever, never shipping changes itself', () => {
    const role = coordinatorRolePrompt('project');
    expect(role).toContain('this project\'s CEO');
    expect(role).toContain('create_task');
    expect(role).toContain('Your purpose is to run for as long as the project exists, without stopping');
    expect(role).toContain('So don\'t make changes yourself.');
    expect(role).toContain('merged, deployed or this task restarted');
    expect(role).toContain('put every such change in a task you create, and steer it from here');
    expect(role).toContain('project wiki');
    // Fixed text only: nothing the platform must keep current.
    expect(role).not.toMatch(/\d+ hours?|tavya/);
    expect(coordinatorRolePrompt('organization')).toContain('this organization\'s CEO');
    expect(coordinatorRolePrompt('autonomous-organization')).toContain('"autonomous": true');
    expect(coordinatorRolePrompt('organization')).not.toContain('"autonomous": true');
  });

  it('marks a prompt as the role text only while it is that text, untouched', () => {
    const role = coordinatorRolePrompt('project');
    const marker = rolePromptMarkerFor(role)!;
    expect(marker).toEqual({ kind: 'project', version: COORDINATOR_ROLE_VERSION, hash: rolePromptHash(role) });
    expect(rolePromptMarkerFor(`${role}\nAlso: be frugal.`)).toBeUndefined();
    expect(rolePromptMarkerFor('Grow the product')).toBeUndefined();
    expect(untouchedRolePrompt({ prompt: role, [ROLE_PROMPT_PARAM]: marker })).toBe(true);
    expect(untouchedRolePrompt({ prompt: `${role}!`, [ROLE_PROMPT_PARAM]: marker })).toBe(false);
  });

  it('takes newer role text for a prompt nobody edited, never for one someone did', () => {
    // An older version of the role text, stored as it was made.
    const old = 'You are this project\'s CEO. (An older wording.)';
    const stale = { prompt: old, [ROLE_PROMPT_PARAM]: { kind: 'project', version: COORDINATOR_ROLE_VERSION - 1, hash: rolePromptHash(old) } };
    expect(refreshedRolePrompt(stale)).toEqual({ prompt: coordinatorRolePrompt('project'),
      marker: { kind: 'project', version: COORDINATOR_ROLE_VERSION, hash: rolePromptHash(coordinatorRolePrompt('project')) } });
    expect(refreshedRolePrompt({ ...stale, prompt: `${old} Mine now.` })).toBeUndefined();
    const current = coordinatorRolePrompt('project');
    expect(refreshedRolePrompt({ prompt: current, [ROLE_PROMPT_PARAM]: rolePromptMarkerFor(current) })).toBeUndefined();
  });

  it('reads, on each turn, the role prompt as stored now; one started before it, the role then what it started with', () => {
    const role = coordinatorRolePrompt('project');
    expect(coordinatorTurnPrompt({ prompt: role, [ROLE_PROMPT_PARAM]: rolePromptMarkerFor(role) }, 'the older role text')).toBe(role);
    // Edited before it started: what it started with, always.
    expect(coordinatorTurnPrompt({ prompt: 'Mine' }, 'Mine')).toBe('Mine');
    const legacy = { prompt: role, [ROLE_PROMPT_PARAM]: { ...rolePromptMarkerFor(role)!, outsideConversation: true } };
    expect(coordinatorTurnPrompt(legacy, 'Plan the launch')).toBe(`${role}\n\nPlan the launch`);
    expect(coordinatorTurnPrompt(legacy, '')).toBe(role);
  });

  it('is told to no other task, and to none of its other agents', () => {
    expect(assemblePrompt({ profile, role: 'do', task: task({}), world })).not.toContain('# Permanent co-ordinator');
    expect(assemblePrompt({ profile: { ...profile, role: 'responder' }, role: 'responder', task: task({ coordinator: { wakeHours: 6 } }), world }))
      .not.toContain('# Permanent co-ordinator');
  });
});

const PUBLISHED = { lifecycleEvent: false };

describe.each(storeBackends)('a co-ordinator failing ($name)', ({ open }) => {
  async function fixture(params: Record<string, unknown>) {
    const store = (await open());
    const organization = (await store.createOrganization({ name: 'Firm', ownerUserId: 'owner' }));
    const project = (await store.createProject('Firm', {}, organization.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Run the firm', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'run it', ...params }, createdBy: { kind: 'user', userId: 'owner' } }));
    const publish = async (patch: Record<string, unknown>) => {
      const next = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
        messages: [], actions: [], state: {}, updatedAt: Date.now(), ...patch } as any;
      (await store.saveView(task.id, next, undefined, undefined, undefined, PUBLISHED));
      (await store.appendEvent({ taskId: task.id, type: 'view.updated', ts: Date.now(), payload: {
        stage: next.stage, status: next.status, waitingFor: next.waitingFor?.kind ?? null } }));
    };
    const inbox = async () => (await store.listInbox('owner', organization.id));
    return { store, task, publish, inbox };
  }

  it('asks its creator at critical urgency when its run fails', async () => {
    const f = (await fixture({ coordinator: { wakeHours: 24 } }));
    (await f.publish({ stage: 'failed', status: 'failed', error: 'workflow failed: boom' }));
    const items = (await f.inbox());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ taskId: f.task.id, kind: 'escalated', urgency: 'critical', actionable: true });
  });

  it('asks at critical urgency when it is stuck on a stage it could not get past', async () => {
    const f = (await fixture({ coordinator: { wakeHours: 24 } }));
    (await f.publish({ stage: 'do', status: 'blocked', waitingFor: { kind: 'human', reason: 'error', audience: ['@creator'] } }));
    expect((await f.inbox())[0]).toMatchObject({ kind: 'escalated', urgency: 'critical' });
  });

  it('leaves an ordinary task\'s failure as quiet news', async () => {
    const f = (await fixture({}));
    (await f.publish({ stage: 'failed', status: 'failed' }));
    expect((await f.inbox()).filter((item) => item.actionable)).toEqual([]);
  });

  it('lists failed co-ordinators with when they failed and their failures in a row, for the revival sweep', async () => {
    const f = (await fixture({ coordinator: { wakeHours: 2 } }));
    expect((await f.store.failedCoordinators())).toEqual([]);
    const before = Date.now();
    (await f.publish({ stage: 'failed', status: 'failed', state: { coordinatorFailures: 3 } }));
    const failed = (await f.store.failedCoordinators());
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: f.task.id, failures: 3 });
    expect(failed[0]!.failedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('making a permanent co-ordinator', () => {
  async function fixture(config: Record<string, unknown> = {}) {
    const { Store } = await import('../src/store/db.js');
    const { AuthorizationService, projectScope } = await import('../src/platform/authorization.js');
    const { KarmaxApi } = await import('../src/platform/api.js');
    const { TokenAuthority } = await import('../src/platform/tokens.js');
    const store = await Store.create(':memory:');
    await store.claimPersonalOrganization('owner');
    const project = await store.createProject('Firm', config as any);
    const authorization = await AuthorizationService.create(store);
    await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' });
    const tokens = new TokenAuthority(store);
    const owner = (await tokens.mintPrincipal('user:owner', await authorization.capabilities('user:owner', project.id, 'org_personal'),
      project.id, undefined, 'org_personal')).token;
    const started: any[] = [];
    const updates: any[] = [];
    const client = { workflow: {
      getHandle: () => ({ query: async () => [], signal: async () => undefined,
        executeUpdate: async (_name: string, opts: { args: unknown[] }) => { updates.push(opts.args[0]); return { applied: Object.keys(opts.args[0] as object) }; } }),
      start: async (_type: string, opts: { args: unknown[] }) => { started.push(opts.args[0]); return { firstExecutionRunId: `run-${started.length}` }; },
    } } as any;
    const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
    return { store, project, api, owner, started, updates };
  }

  it('starts its run knowing it is one, its work always landing branch by branch', async () => {
    const f = await fixture({ multiPr: false });
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run the firm',
      params: { coordinator: { wakeHours: '1.5' }, multiPr: false } });
    expect(task.params.coordinator).toEqual({ wakeHours: 1.5 });
    // Its params say what it does, whatever was sent.
    expect(task.params.multiPr).toBe(true);
    expect(f.started).toHaveLength(1);
    expect(f.started[0].coordinator).toEqual({ wakeHours: 1.5 });
    expect(f.started[0].project.multiPr).toBe(true);
    // An ordinary task is none of that.
    await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Fix a bug', params: { multiPr: false } });
    expect(f.started[1].coordinator).toBeUndefined();
    expect(f.started[1].project.multiPr).toBeFalsy();
  });

  it('starts with its role as its prompt when given none, marked as the untouched role text', async () => {
    const f = await fixture();
    const role = coordinatorRolePrompt('project');
    const draft = await f.api.createTask(f.owner, { projectId: f.project.id, draft: true, params: { coordinator: { wakeHours: 24 } } });
    expect(draft.params.prompt).toBe(role);
    expect(draft.params[ROLE_PROMPT_PARAM]).toEqual(rolePromptMarkerFor(role));
    expect(draft.title).toBe('Permanent co-ordinator');
    // Started at once: its first message is the role.
    await f.api.createTask(f.owner, { projectId: f.project.id, params: { coordinator: true } });
    expect(f.started[0].prompt).toBe(role);
    // Given a prompt, it is the person's, unmarked; a caller cannot mark it either.
    const own = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run the shop', draft: true,
      params: { coordinator: true, [ROLE_PROMPT_PARAM]: { kind: 'project', version: 1, hash: rolePromptHash('Run the shop') } } });
    expect(own.params.prompt).toBe('Run the shop');
    expect(own.params[ROLE_PROMPT_PARAM]).toBeUndefined();
    // An ordinary task never gets one.
    const plain = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: role, draft: true });
    expect(plain.params[ROLE_PROMPT_PARAM]).toBeUndefined();
  });

  it('loses the mark when someone edits the prompt, and gets it back on Reset to default', async () => {
    const f = await fixture();
    const role = coordinatorRolePrompt('project');
    const draft = await f.api.createTask(f.owner, { projectId: f.project.id, draft: true, params: { coordinator: true } });
    const edited = await f.api.updateArmedParams(f.owner, draft.id, { prompt: `${role}\n\nBe frugal.` });
    expect(edited.params[ROLE_PROMPT_PARAM]).toBeUndefined();
    // Another field saved with the edited prompt keeps it the person's.
    const saved = await f.api.updateArmedParams(f.owner, draft.id, { coordinator: { wakeHours: 6 } });
    expect(saved.params.prompt).toBe(`${role}\n\nBe frugal.`);
    expect(saved.params[ROLE_PROMPT_PARAM]).toBeUndefined();
    const reset = await f.api.updateArmedParams(f.owner, draft.id, { prompt: role });
    expect(reset.params[ROLE_PROMPT_PARAM]).toEqual(rolePromptMarkerFor(role));
    // A full-form save of the untouched draft keeps the mark.
    const full = await f.api.updateArmedParams(f.owner, draft.id, { prompt: role, coordinator: { wakeHours: 6 } }, { replace: true });
    expect(full.params[ROLE_PROMPT_PARAM]).toEqual(rolePromptMarkerFor(role));
  });

  it('refreshes at boot the role prompts nobody edited, started or not, and never an edited one', async () => {
    const f = await fixture();
    const { refreshCoordinatorPrompts, ROLE_PROMPT_MIGRATION_KEY } = await import('../src/platform/ceo.js');
    await f.store.kvSet(ROLE_PROMPT_MIGRATION_KEY, '1');
    const old = 'You are this project\'s CEO. (The previous wording.)';
    const stale = { prompt: old, [ROLE_PROMPT_PARAM]: { kind: 'project', version: COORDINATOR_ROLE_VERSION - 1, hash: rolePromptHash(old) } };
    const make = (params: Record<string, unknown>) => f.store.createTask({ projectId: f.project.id, title: 'CEO', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: '', coordinator: { wakeHours: 24 }, ...params }, createdBy: { kind: 'user', userId: 'owner' } });
    const draft = await make({ ...stale, draft: true });
    const running = await make({ ...stale, draft: false });
    const edited = await make({ ...stale, prompt: `${old} Plus mine.`, draft: true });
    const keepMessage = () => { throw new Error('nothing to move'); };
    expect(await refreshCoordinatorPrompts(f.store, { keepMessage })).toEqual({ migrated: 0, refreshed: 2 });
    const role = coordinatorRolePrompt('project');
    for (const id of [draft.id, running.id]) {
      const task = (await f.store.getTask(id))!;
      expect(task.params.prompt).toBe(role);
      expect(task.params[ROLE_PROMPT_PARAM]).toEqual(rolePromptMarkerFor(role));
    }
    expect((await f.store.getTask(edited.id))!.params.prompt).toBe(`${old} Plus mine.`);
    // Up to date: nothing more to do.
    expect(await refreshCoordinatorPrompts(f.store, { keepMessage })).toEqual({ migrated: 0, refreshed: 0 });
  });

  it('gives co-ordinators from before the role prompt theirs once, keeping what each was told', async () => {
    const f = await fixture();
    const { refreshCoordinatorPrompts, CEO_PRINCIPAL, untouchedCeoDraft } = await import('../src/platform/ceo.js');
    const { CEO_KEY } = await import('../src/domain/coordinator.js');
    const { parsePending, pendingMessagesKey } = await import('../src/platform/pending-messages.js');
    const make = (params: Record<string, unknown>, projectId = f.project.id) => f.store.createTask({ projectId, title: 'CEO', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: '', coordinator: { wakeHours: 24 }, ...params }, createdBy: { kind: 'user', userId: 'owner' } });
    const blankDraft = await make({ prompt: '', draft: true });
    // A form-made co-ordinator someone wrote: their prompt, the role above it.
    const writtenDraft = await make({ prompt: 'Plan the launch', draft: true });
    const startedBlank = await make({ prompt: '', draft: false });
    const startedAsked = await make({ prompt: 'Plan the launch', draft: false });
    // The project's CEO, its old Ask written in: the role becomes its prompt, the Ask its first message.
    const ceo = await make({ prompt: 'Plan the launch\n\nAlso hire a designer', draft: true,
      _authorization: { principal: CEO_PRINCIPAL, capabilities: [] } });
    await f.store.kvSet(CEO_KEY(f.project.id), ceo.id);
    // Another project's CEO, waiting for approval of the asker's Ask: it is the asker's.
    const other = await f.store.createProject('Shop', {} as any);
    const asked = await make({ prompt: 'Open the shop', draft: true, _awaitingApproval: 'authreq_1',
      _authorization: { principal: CEO_PRINCIPAL, capabilities: [] } }, other.id);
    await f.store.kvSet(CEO_KEY(other.id), asked.id);
    await f.store.kvSet('authorization:requests:org_personal', JSON.stringify([{ id: 'authreq_1', type: 'authorization', organizationId: 'org_personal',
      projectId: other.id, target: { kind: 'task', taskId: asked.id, queueAfterApproval: true }, requestedBy: 'user:asker', status: 'pending',
      authorization: {}, capabilities: [], missingCapabilities: [], audience: [], recipients: [], reason: 'Start the CEO', createdAt: 1 }]));
    f.store.connectUserNames(() => [{ id: 'asker', name: 'Asha Asker' }]);
    const keepMessage = (taskId: string, message: { text: string }, userId: string | undefined) => f.api.keepMessageFromPerson(taskId, message, userId);
    expect((await refreshCoordinatorPrompts(f.store, { keepMessage })).migrated).toBe(6);
    const role = coordinatorRolePrompt('project');
    const read = async (id: string) => (await f.store.getTask(id))!.params;
    const queued = async (id: string) => parsePending(await f.store.kvGet(pendingMessagesKey(id)));
    expect(await read(blankDraft.id)).toMatchObject({ prompt: role, [ROLE_PROMPT_PARAM]: rolePromptMarkerFor(role) });
    expect((await read(writtenDraft.id)).prompt).toBe(`${role}\n\nPlan the launch`);
    expect((await read(writtenDraft.id))[ROLE_PROMPT_PARAM]).toBeUndefined();
    expect(await queued(writtenDraft.id)).toEqual([]);
    // The CEO: the default role, untouched (so it keeps up with the role text), and one message, the creator's.
    expect(await read(ceo.id)).toMatchObject({ prompt: role, [ROLE_PROMPT_PARAM]: rolePromptMarkerFor(role) });
    const [moved, ...more] = await queued(ceo.id);
    expect(more).toEqual([]);
    expect(moved).toMatchObject({ role: 'do', by: 'user:owner', message: { role: 'user', text: 'Plan the launch\n\nAlso hire a designer', author: 'user:owner' } });
    // Left a message, it is no longer the draft the platform made: autonomy keeps it.
    expect(await untouchedCeoDraft(f.store, (await f.store.getTask(ceo.id))!)).toBe(false);
    // Awaiting approval: the asker's, by name, and it still waits for that approval.
    const [ask] = await queued(asked.id);
    expect(ask).toMatchObject({ by: 'user:asker', message: { text: 'Open the shop', author: 'user:asker', authorLabel: 'Asha Asker' } });
    expect(await read(asked.id)).toMatchObject({ prompt: role, [ROLE_PROMPT_PARAM]: rolePromptMarkerFor(role), _awaitingApproval: 'authreq_1' });
    // Started: the role is shown, and its turns read what they read before.
    for (const [task, started] of [[startedBlank, ''], [startedAsked, 'Plan the launch']] as const) {
      const params = await read(task.id);
      expect(params).toMatchObject({ prompt: role, [ROLE_PROMPT_PARAM]: { ...rolePromptMarkerFor(role), outsideConversation: true } });
      expect(coordinatorTurnPrompt(params, started)).toBe(started ? `${role}\n\n${started}` : role);
    }
    // Once only.
    expect(await refreshCoordinatorPrompts(f.store, { keepMessage })).toEqual({ migrated: 0, refreshed: 0 });
    expect(await queued(ceo.id)).toHaveLength(1);
  });

  it('refuses an interval out of range, a repeatable co-ordinator and another workflow', async () => {
    const f = await fixture();
    await expect(f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run', draft: true,
      params: { coordinator: { wakeHours: 0 } } })).rejects.toThrow(/wakeHours/);
    await expect(f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run', draft: true,
      params: { coordinator: { wakeHours: 24 }, repeatable: true } })).rejects.toThrow(/repeatable/);
    await expect(f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run', draft: true, workflow: 'merge-only',
      params: { coordinator: { wakeHours: 24 } } })).rejects.toThrow(/Software dev/);
    // Unticked, the setting is simply absent.
    const plain = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run', draft: true, params: { coordinator: false } });
    expect(plain.params.coordinator).toBeUndefined();
  });

  async function failedCoordinator(f: Awaited<ReturnType<typeof fixture>>, failures: number) {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run the firm', draft: true,
      params: { coordinator: { wakeHours: 2 } } });
    const worldPath = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-world-'));
    await f.store.saveView(task.id, { taskId: task.id, title: task.title, workflow: 'software-dev', stage: 'failed', status: 'failed',
      error: 'workflow failed: boom', worldPath, branch: `tavya/${task.id}`, base: 'main', messages: [], actions: [],
      state: { failedFrom: 'do', coordinatorFailures: failures }, updatedAt: 7 } as any);
    return { task, worldPath, failedAt: Date.now() };
  }

  it('restarts a co-ordinator whose run failed after its backoff, and only then', async () => {
    const f = await fixture();
    const { task, worldPath, failedAt } = await failedCoordinator(f, 1);
    expect(await f.api.reviveFailedCoordinators(failedAt + 14 * 60_000)).toEqual([]);
    expect(f.started).toHaveLength(0);
    expect(await f.api.reviveFailedCoordinators(failedAt + 15 * 60_000 + 1_000)).toEqual([task.id]);
    expect(f.started).toHaveLength(1);
    expect(f.started[0].coordinator).toEqual({ wakeHours: 2, failures: 1 });
    expect(f.started[0].recovery.world.root).toBe(worldPath);
    expect((await f.store.eventsOfType(task.id, 'coordinator.revived'))).toHaveLength(1);
  });

  it('waits longer the more times in a row it has failed', async () => {
    const f = await fixture();
    const { task, failedAt } = await failedCoordinator(f, 3);
    expect(await f.api.reviveFailedCoordinators(failedAt + 59 * 60_000)).toEqual([]);
    expect(await f.api.reviveFailedCoordinators(failedAt + 60 * 60_000 + 1_000)).toEqual([task.id]);
    expect(f.started[0].coordinator.failures).toBe(3);
  });

  it('backs off when it cannot even be restarted', async () => {
    const fs = await import('node:fs');
    const f = await fixture();
    const { task, worldPath, failedAt } = await failedCoordinator(f, 1);
    fs.rmSync(worldPath, { recursive: true });
    expect(await f.api.reviveFailedCoordinators(failedAt + 16 * 60_000)).toEqual([]);
    expect((await f.store.eventsOfType(task.id, 'coordinator.revival-failed'))).toHaveLength(1);
    // Its failure count stands at 1 and one attempt failed: 30 minutes from that attempt.
    await f.api.reviveFailedCoordinators(failedAt + 40 * 60_000);
    expect((await f.store.eventsOfType(task.id, 'coordinator.revival-failed'))).toHaveLength(1);
    await f.api.reviveFailedCoordinators(failedAt + 47 * 60_000);
    expect((await f.store.eventsOfType(task.id, 'coordinator.revival-failed'))).toHaveLength(2);
  });

  it('changes a running co-ordinator\'s interval through its workflow and its params', async () => {
    const f = await fixture();
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run the firm', params: { coordinator: { wakeHours: 24 } } });
    const result = await f.api.updateParams(f.owner, task.id, { coordinator: { wakeHours: '0.5' } });
    expect(result.applied).toContain('coordinator');
    expect(f.updates).toEqual([{ coordinator: { wakeHours: 0.5 } }]);
    expect((await f.store.getTask(task.id))!.params.coordinator).toEqual({ wakeHours: 0.5 });
  });

  it('refuses a bad interval, stopping being one, and an ordinary task', async () => {
    const f = await fixture();
    const task = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Run the firm', params: { coordinator: { wakeHours: 24 } } });
    await expect(f.api.updateParams(f.owner, task.id, { coordinator: { wakeHours: 0 } })).rejects.toThrow(/wakeHours/);
    await expect(f.api.updateParams(f.owner, task.id, { coordinator: false })).rejects.toThrow(/stays one/);
    const plain = await f.api.createTask(f.owner, { projectId: f.project.id, prompt: 'Fix a bug' });
    await expect(f.api.updateParams(f.owner, plain.id, { coordinator: { wakeHours: 2 } })).rejects.toThrow(/queued as a permanent co-ordinator/);
    expect(f.updates).toEqual([]);
    expect((await f.store.getTask(task.id))!.params.coordinator).toEqual({ wakeHours: 24 });
  });

  it('changes a failed co-ordinator\'s interval without its finished workflow', async () => {
    const f = await fixture();
    const { task } = await failedCoordinator(f, 1);
    await f.api.updateParams(f.owner, task.id, { coordinator: { wakeHours: 6 } });
    expect(f.updates).toEqual([]);
    expect((await f.store.getTask(task.id))!.params.coordinator).toEqual({ wakeHours: 6 });
  });
});
