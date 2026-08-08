import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';
import { MANIFESTS } from '../src/contrib/manifests.js';
// Derived, not hard-coded: the pinned type moves every time a workflow ships a
// new replay version, and a literal here just makes an unrelated PR red.
const bundledVersion = (name: string) => MANIFESTS.find((m) => m.name === name)!.version;
import type { TaskView } from '../src/domain/types.js';
import { QRY_ACCOUNT_TASK_LEASES, QRY_AGENT_QUEUE } from '../src/coordinators/names.js';
import { PermissionRequests } from '../src/platform/permission-requests.js';

function fixture() {
  const store = new Store(':memory:');
  store.claimPersonalOrganization('test');
  const project = store.createProject('Transitions', { repos: ['/tmp'], defaultBase: 'main', defaultTarget: 'main' });
  const tokens = new TokenAuthority();
  const token = tokens.mintPrincipal('user:test', ['*'], project.id).token;
  const starts: Array<{ type: string; options: any }> = [];
  const terminated: string[] = [];
  const signalled: Array<{ id: string; signal: string; args: unknown[] }> = [];
  const hiddenTurnIds = ['hidden-account-turn'];
  const client = {
    workflow: {
      getHandle(id: string) {
        return {
          async terminate(reason: string) { terminated.push(`${id}:${reason}`); },
          async signal(signal: string, ...args: unknown[]) { signalled.push({ id, signal, args }); },
          async executeUpdate(_name: string, options: { args: [string] }) {
            return { workflow: options.args[0] };
          },
          async query(name: string) {
            if (name === QRY_AGENT_QUEUE)
              return { queue: [{ taskId: task.id, turnId: 'hidden-agent-turn' }], current: [] };
            if (name === QRY_ACCOUNT_TASK_LEASES) return hiddenTurnIds;
            throw new Error('no live query');
          },
        };
      },
      async signalWithStart(_type: string, options: any) {
        signalled.push({ id: options.workflowId, signal: options.signal, args: options.signalArgs });
      },
      async start(type: string, options: any) {
        starts.push({ type, options });
        return {};
      },
    },
  } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens });
  const task = store.createTask({
    projectId: project.id,
    title: 'Move me',
    workflow: 'software-dev',
    workflowVersion: '1.4.0',
    params: { prompt: 'work', base: 'main', target: 'main' },
  });
  const view: TaskView = {
    taskId: task.id,
    title: task.title,
    workflow: task.workflow,
    stage: 'do',
    status: 'active',
    messages: [{ id: 'm0', role: 'user', text: 'work', ts: 0 }],
    actions: [],
    state: { turnsSeen: 1 },
    base: 'main',
    targetBranch: 'main',
    updatedAt: 1,
  };
  store.saveView(task.id, view);
  return { store, project, tokens, token, api, task, view, starts, terminated, signalled };
}

describe('task stage transitions', () => {
  it('advertises human hold, destructive Draft, and reversible Done before Jayadratha', async () => {
    const f = fixture();
    const view = await f.api.getTaskView(f.token, f.task.id);
    expect(view?.stageTransitions?.map((move) => move.target)).toEqual(['human', 'draft', 'done']);

    f.store.claimAttempt(f.task.id);
    const committed = await f.api.getTaskView(f.token, f.task.id);
    expect(committed?.stageTransitions?.map((move) => move.target)).toEqual(['human', 'done']);
  });

  it('stops activity for manual Done and restores the exact origin on the latest workflow', async () => {
    const f = fixture();
    const done = await f.api.moveTaskStage(f.token, f.task.id, 'done');
    expect(done).toMatchObject({
      stage: 'done',
      status: 'done',
      state: { manuallyDoneFrom: 'do' },
      stageTransitions: [{ target: 'do' }],
    });
    expect(f.terminated[0]).toMatch(/marked done manually/);

    const restored = await f.api.moveTaskStage(f.token, f.task.id, 'do');
    expect(f.starts).toHaveLength(1);
    expect(f.starts[0]!.type).toBe(`softwareDev@${bundledVersion('software-dev')}`);
    expect(f.starts[0]!.options.args[0].recovery).toMatchObject({ resumeStage: 'do', messages: f.view.messages });
    expect(restored).toMatchObject({ stage: 'do', status: 'active' });
  });

  it('restores cancellation to its remembered stage and supports a cross-cutting human hold', async () => {
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'cancelled',
      status: 'cancelled',
      state: { ...f.view.state, cancelled: true, cancelledFrom: 'review' },
    });
    const cancelled = await f.api.getTaskView(f.token, f.task.id);
    expect(cancelled?.stageTransitions?.map((move) => move.target)).toEqual(['review', 'draft', 'done']);

    const restored = await f.api.moveTaskStage(f.token, f.task.id, 'review');
    expect(restored).toMatchObject({ stage: 'review', status: 'active' });
    expect(f.starts[0]!.options.args[0].recovery).toMatchObject({ resumeStage: 'review' });

    const held = await f.api.moveTaskStage(f.token, f.task.id, 'human');
    expect(held).toMatchObject({
      stage: 'review',
      status: 'waiting',
      waitingFor: { kind: 'human' },
    });
    expect(held.stageTransitions?.map((move) => move.target)).toEqual(['review', 'draft', 'done']);
    expect(f.terminated).toHaveLength(1);

    const doneFromHold = await f.api.moveTaskStage(f.token, f.task.id, 'done');
    expect(doneFromHold.state.manuallyDoneFrom).toBe('human');
    expect(doneFromHold.stageTransitions?.map((move) => move.target)).toEqual(['human']);
    const restoredHold = await f.api.moveTaskStage(f.token, f.task.id, 'human');
    expect(restoredHold).toMatchObject({ stage: 'review', status: 'waiting', waitingFor: { kind: 'human' } });
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'review', pausedForHuman: true });
  });

  it('lets an agent escalate its own task to a chosen human team and notifies only that audience', async () => {
    const f = fixture();
    for (const userId of ['designer', 'developer'])
      f.store.setOrganizationMembership('org_personal', userId, 'member');
    const design = f.store.createTeam({ organizationId: 'org_personal', name: 'Design' });
    f.store.setTeamMembership(design.id, 'designer');
    f.store.setProjectMembership(f.project.id, { kind: 'team', teamId: design.id }, 'member');
    f.store.setProjectMembership(f.project.id, { kind: 'user', userId: 'developer' }, 'member');
    const agentToken = f.tokens.mint({
      taskId: f.task.id,
      profileId: 'do',
      role: 'do',
      principal: `task-agent:${f.task.id}:do`,
      projectId: f.project.id,
      ceiling: ['task:escalate'],
      grantorCaps: ['task:escalate'],
    }).token;

    expect(f.api.humanEscalationTargets(agentToken)).toMatchObject({
      taskId: f.task.id,
      users: expect.arrayContaining([{ id: 'designer', selector: 'user:designer' }]),
      teams: [expect.objectContaining({ id: design.id, name: 'Design', selector: '@team:design' })],
    });
    const held = await f.api.escalateToHuman(agentToken, {
      audience: ['@team:design'],
      message: 'Please choose the final interaction pattern.',
    });

    expect(held).toMatchObject({
      stage: 'do',
      status: 'waiting',
      waitingFor: {
        kind: 'human',
        audience: ['@team:design'],
        detail: 'Please choose the final interaction pattern.',
      },
      state: { humanPauseOrigin: 'do' },
    });
    expect(f.terminated.at(-1)).toContain('Escalated to @team:design');
    expect(f.store.eventsSince(f.task.id, 0)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'task.escalated',
        payload: expect.objectContaining({
          audience: ['@team:design'],
          detail: 'Please choose the final interaction pattern.',
          requestedBy: `task-agent:${f.task.id}:do`,
        }),
      }),
    ]));
    expect(f.store.listInbox('designer', 'org_personal')).toEqual([
      expect.objectContaining({ taskId: f.task.id, kind: 'escalated', actionable: true, unread: true }),
    ]);
    expect(f.store.listInbox('developer', 'org_personal')).toEqual([]);
  });

  it('rejects an escalation to a missing audience and prevents an agent escalating another task', async () => {
    const f = fixture();
    const agentToken = f.tokens.mint({
      taskId: f.task.id,
      profileId: 'do',
      role: 'do',
      principal: `task-agent:${f.task.id}:do`,
      projectId: f.project.id,
      ceiling: ['task:escalate'],
      grantorCaps: ['task:escalate'],
    }).token;

    await expect(f.api.escalateToHuman(agentToken, {
      audience: ['@team:missing'],
      message: 'I need a decision.',
    })).rejects.toThrow(/does not resolve to a human/i);

    const other = f.store.createTask({
      projectId: f.project.id,
      title: 'Other',
      workflow: 'software-dev',
      workflowVersion: '1.9.0',
      params: { prompt: 'other' },
    });
    f.store.saveView(other.id, { ...f.view, taskId: other.id, title: other.title });
    await expect(f.api.escalateToHuman(agentToken, {
      taskId: other.id,
      audience: ['@creator'],
      message: 'Stop this other task.',
    })).rejects.toThrow(/only escalate its own task/i);
  });

  it('routes an exact permission elevation to selected humans and only a capable recipient may approve', async () => {
    const f = fixture();
    f.store.setOrganizationMembership('org_personal', 'outsider', 'member');
    const agentToken = f.tokens.mint({
      taskId: f.task.id,
      profileId: 'do',
      role: 'do',
      principal: `task-agent:${f.task.id}:do`,
      projectId: f.project.id,
      organizationId: 'org_personal',
      ceiling: ['task:escalate'],
      grantorCaps: ['task:escalate'],
    }).token;

    const requested = await f.api.requestPermission(agentToken, {
      capabilities: ['settings:read'],
      audience: ['@owners'],
      reason: 'Inspect the outbound email configuration.',
    });
    expect(requested).toMatchObject({
      status: 'needs_approval',
      capabilities: ['settings:read'],
      audience: ['@owners'],
    });
    expect(f.terminated.at(-1)).toContain('Waiting for permission approval');
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'do',
      pausedForHuman: true,
    });
    expect(f.store.getTask(f.task.id)!.lastView).toMatchObject({
      stage: 'do',
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@owners'] },
    });
    expect(f.store.listInbox('test', 'org_personal')).toEqual([
      expect.objectContaining({ taskId: f.task.id, kind: 'approval-requested', actionable: true }),
    ]);
    expect(f.store.listInbox('outsider', 'org_personal')).toEqual([]);

    const outsider = f.tokens.mintPrincipal(
      'user:outsider',
      ['task:read', 'settings:read'],
      f.project.id,
      undefined,
      'org_personal',
    ).token;
    await expect(f.api.resolvePermissionRequest(outsider, {
      organizationId: 'org_personal',
      requestId: requested.requestId!,
      action: 'approve',
    })).rejects.toThrow(/not routed to you/i);

    const resolved = await f.api.resolvePermissionRequest(f.token, {
      organizationId: 'org_personal',
      requestId: requested.requestId!,
      action: 'approve',
    });
    expect(resolved).toMatchObject({ status: 'granted', resume: { resumed: true } });
    expect(f.signalled.at(-1)).toMatchObject({ id: f.task.id, args: [expect.any(Object), 'do'] });
    expect(new PermissionRequests(f.store, 'org_personal').extensionCaps(f.task.id, 'do'))
      .toEqual(['settings:read']);
    expect(new PermissionRequests(f.store, 'org_personal').extensionCaps(f.task.id, 'merge'))
      .toEqual([]);
    // The approval was answered, so it stops being an ask sitting in the inbox.
    expect(f.store.listInbox('test', 'org_personal')).toEqual([]);

    f.store.setOrganizationMembership('org_personal', 'reviewer', 'member');
    const second = await f.api.requestPermission(agentToken, {
      capabilities: ['settings:write'],
      audience: ['user:reviewer'],
      reason: 'Configure outbound email.',
    });
    const reviewer = f.tokens.mintPrincipal(
      'user:reviewer',
      ['task:read'],
      f.project.id,
      undefined,
      'org_personal',
    ).token;
    await expect(f.api.resolvePermissionRequest(reviewer, {
      organizationId: 'org_personal',
      requestId: second.requestId!,
      action: 'approve',
    })).rejects.toThrow(/cannot grant settings:write/i);
    await expect(f.api.resolvePermissionRequest(reviewer, {
      organizationId: 'org_personal',
      requestId: second.requestId!,
      action: 'deny',
    })).resolves.toMatchObject({ status: 'denied' });
  });

  it('parks and resumes the requesting Merge role so the next turn receives the grant', async () => {
    const f = fixture();
    f.store.saveView(f.task.id, { ...f.view, stage: 'merge' });
    const agentToken = f.tokens.mint({
      taskId: f.task.id,
      profileId: 'merge-default',
      role: 'merge',
      principal: `task-agent:${f.task.id}:merge-default`,
      projectId: f.project.id,
      organizationId: 'org_personal',
      ceiling: ['task:escalate'],
      grantorCaps: ['task:escalate'],
    }).token;

    const requested = await f.api.requestPermission(agentToken, {
      capabilities: ['task:git:import'],
      audience: ['@owners'],
      reason: 'Refresh the protected target before resolving conflicts.',
    });
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'merge',
      pausedForHuman: true,
    });

    await expect(f.api.resolvePermissionRequest(f.token, {
      organizationId: 'org_personal',
      requestId: requested.requestId!,
      action: 'approve',
    })).resolves.toMatchObject({ status: 'granted', role: 'merge', resume: { resumed: true } });
    expect(new PermissionRequests(f.store, 'org_personal').extensionCaps(f.task.id, 'merge'))
      .toEqual(['task:git:import']);
    expect(f.signalled.at(-1)).toMatchObject({ id: f.task.id, args: [expect.any(Object), 'merge'] });
  });

  it('treats follow-up and Confirm as input that releases a human hold', async () => {
    const follow = fixture();
    follow.store.saveView(follow.task.id, {
      ...follow.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'followUp', kind: 'signal', label: 'Send follow-up', enabled: true }],
      state: { ...follow.view.state, humanPauseOrigin: 'review' },
      stage: 'review',
    });

    const message = await follow.api.signalTask(follow.token, follow.task.id, 'followUp', 'Please revise this.', 'do');
    expect(message?.text).toBe('Please revise this.');
    expect(follow.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'do' });
    expect(follow.starts.at(-1)!.options.args[0].recovery.messages.at(-1)).toMatchObject({ text: 'Please revise this.' });
    expect(follow.signalled).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringContaining('agent-queue'), signal: 'cancelAgentSlot', args: [{ taskId: follow.task.id, turnId: 'hidden-agent-turn' }] }),
      expect.objectContaining({ id: expect.stringContaining('account-coordinator'), signal: 'cancelAccountLease', args: [{ taskId: follow.task.id, turnId: 'hidden-account-turn' }] }),
    ]));

    const confirm = fixture();
    confirm.store.saveView(confirm.task.id, {
      ...confirm.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm', enabled: true }],
      state: { ...confirm.view.state, humanPauseOrigin: 'review' },
      stage: 'review',
    });
    await confirm.api.signalTask(confirm.token, confirm.task.id, 'confirm');
    expect(confirm.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'pr' });
  });

  it.each(['1.16.0', '1.17.0', '1.18.0', '1.19.0', '1.20.0'])('upgrades a %s task at its successful Review boundary into participant Landing', async (version) => {
    const f = fixture();
    f.store.setTaskWorkflowVersion(f.task.id, version);
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'review',
      status: 'waiting',
      prs: [{ repo: 'repo', slug: 'owner/repo', number: 52, url: 'https://github.test/owner/repo/pull/52', state: 'open', headSha: 'abc123' }],
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm PR', enabled: true }],
    });

    await f.api.signalTask(f.token, f.task.id, 'confirm');

    expect(f.terminated.at(-1)).toMatch(/upgrading to per-participant provider\/fallback Landing/);
    expect(f.starts.at(-1)!.type).toBe(`softwareDev@${bundledVersion('software-dev')}`);
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'merge',
      prs: [{ slug: 'owner/repo', number: 52, headSha: 'abc123' }],
    });
    expect(f.store.getTask(f.task.id)?.workflowVersion).toBe(bundledVersion('software-dev'));
    expect(f.store.eventsSince(f.task.id, 0)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'task.confirmation-voted',
        payload: expect.objectContaining({ githubMergeIntentAuthorized: true }),
      }),
    ]));
    expect(f.signalled.some((item) => item.id === f.task.id && item.signal === 'confirm')).toBe(false);
  });

  it.each(['1.16.0', '1.17.0', '1.18.0', '1.19.0', '1.20.0'])('upgrades a blocked authorized %s Landing retry and resumes its Do session', async (version) => {
    const f = fixture();
    f.store.setTaskWorkflowVersion(f.task.id, version);
    f.store.kvSet(`session:${f.task.id}:do`, 'codex-session-existing');
    f.store.kvSet(`sessionmeta:${f.task.id}:do`, JSON.stringify({ home: '/profiles/codex' }));
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'escalated',
      status: 'blocked',
      error: 'could not push task branch: non-fast-forward',
      prs: [{ repo: 'repo', slug: 'owner/repo', number: 52, url: 'https://github.test/owner/repo/pull/52', state: 'open', headSha: 'reviewed-head' }],
      landing: {
        authorization: 'authorized',
        validation: 'failed',
        provider: 'ejected',
        authorizedHeads: { 'owner/repo#52': 'reviewed-head' },
      },
    });

    const message = await f.api.signalTask(f.token, f.task.id, 'retry');

    expect(message?.text).toMatch(/same Do conversation/);
    expect(f.terminated.at(-1)).toMatch(/same-Do protocol/);
    expect(f.starts.at(-1)!.type).toBe(`softwareDev@${bundledVersion('software-dev')}`);
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'do',
      session: 'codex-session-existing',
      sessionHome: '/profiles/codex',
      repairValidationPending: true,
      landing: {
        authorization: 'authorized',
        validation: 'failed',
        provider: 'ejected',
        authorizedHeads: { 'owner/repo#52': 'reviewed-head' },
      },
      prs: [{ number: 52, headSha: 'reviewed-head' }],
    });
    expect(f.store.getTask(f.task.id)?.workflowVersion).toBe(bundledVersion('software-dev'));
  });

  it.each(['1.16.0', '1.17.0', '1.18.0', '1.19.0', '1.20.0'])('upgrades a %s exceptional Landing confirmation into participant Landing', async (version) => {
    const f = fixture();
    f.store.setTaskWorkflowVersion(f.task.id, version);
    f.store.kvSet(`session:${f.task.id}:do`, 'codex-session-existing');
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      prs: [{ repo: 'repo', slug: 'owner/repo', number: 52, url: 'https://github.test/owner/repo/pull/52', state: 'open', headSha: 'current-head' }],
      waitingFor: { kind: 'human', audience: ['@creator'], detail: 'Confirm to authorize another automated repair attempt.' },
      actions: [{ name: 'confirm', kind: 'signal', label: 'Confirm PR', enabled: true }],
      landing: {
        authorization: 'authorized',
        validation: 'failed',
        provider: 'ejected',
        repairAttempts: 5,
        authorizedHeads: { 'owner/repo#52': 'reviewed-head' },
      },
    });

    await f.api.signalTask(f.token, f.task.id, 'confirm');

    expect(f.terminated.at(-1)).toMatch(/upgrading to per-participant provider\/fallback Landing/);
    expect(f.starts.at(-1)!.type).toBe(`softwareDev@${bundledVersion('software-dev')}`);
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'merge',
      session: 'codex-session-existing',
      prs: [{ number: 52, headSha: 'current-head' }],
      landing: {
        authorization: 'authorized',
        repairAttempts: 0,
        authorizedHeads: { 'owner/repo#52': 'reviewed-head' },
      },
    });
    expect(f.store.getTask(f.task.id)?.workflowVersion).toBe(bundledVersion('software-dev'));
    expect(f.signalled.some((item) => item.id === f.task.id && item.signal === 'confirm')).toBe(false);
  });

  it('lets the selected human open a PR from a Do-stage input wait', async () => {
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      actions: [{ name: 'openPr', kind: 'signal', label: 'Open PR', enabled: true }],
      state: { ...f.view.state, humanPauseOrigin: 'do' },
      stage: 'do',
    });

    await f.api.signalTask(f.token, f.task.id, 'openPr');
    expect(f.signalled.at(-1)).toMatchObject({ id: f.task.id, signal: 'openPr' });
  });

  it('resumes a held Do task when Goal mode supplies autonomous direction', async () => {
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      workflowOptions: ['software-dev', 'goal'],
      workflowSwitchable: true,
      state: { ...f.view.state, humanPauseOrigin: 'do' },
    });

    await f.api.changeWorkflow(f.token, f.task.id, 'goal');

    expect(f.starts.at(-1)!.type).toBe(`goal@${bundledVersion('goal')}`);
    expect(f.starts.at(-1)!.options.args[0]).toMatchObject({ recovery: { resumeStage: 'do' } });
    expect(f.starts.at(-1)!.options.args[0].recovery.messages.at(-1).text).toMatch(/continue autonomously/i);
    expect(f.store.getTask(f.task.id)?.workflow).toBe('goal');
  });

  it('offers held Merge input only on the Merge conversation', async () => {
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      transcripts: [
        { role: 'do', label: 'Do agent', messages: f.view.messages },
        { role: 'merge', label: 'Merge agent', messages: [{ id: 'merge-1', role: 'agent', text: 'conflict', ts: 1 }] },
      ],
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true }],
      state: { ...f.view.state, humanPauseOrigin: 'merge' },
    });

    const held = await f.api.getTaskView(f.token, f.task.id);
    expect(held?.actions.map((action) => action.name)).toEqual(['followUp', 'cancel']);
    expect(held?.actions[0]?.roles).toEqual(['merge']);
    await expect(f.api.signalTask(f.token, f.task.id, 'followUp', 'wrong agent', 'do'))
      .rejects.toThrow(/waiting on the merge agent/i);
  });

  it('falls back to the Do conversation when the held stage never ran an agent', async () => {
    // Task #350 was paused during `merge` while still queued for its slot, so the
    // merge agent had never run and there was no merge transcript. The hold then
    // resolved to no conversation at all: `followUp` was filtered out and nothing
    // spliced back, leaving a task with 13 hours of Do context and no way to say
    // anything to it — Cancel was the only action. Do always exists once a task
    // has worked, and it owns the context the follow-up is about.
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      waitingFor: { kind: 'human', audience: ['@creator'] },
      transcripts: [{ role: 'do', label: 'Do agent', messages: f.view.messages }],
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true }],
      state: { ...f.view.state, humanPauseOrigin: 'merge' },
    });

    const held = await f.api.getTaskView(f.token, f.task.id);
    expect(held?.actions.map((action) => action.name)).toEqual(['followUp', 'cancel']);
    expect(held?.actions[0]?.roles).toEqual(['do']);
    await expect(f.api.signalTask(f.token, f.task.id, 'followUp', 'redirect this', 'do'))
      .resolves.toBeDefined();
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({ resumeStage: 'do' });
  });

  it('offers an explicit Merge-to-Do repair transition and preserves the PR checkpoint', async () => {
    const f = fixture();
    const prs = [{ repo: 'app', slug: 'acme/app', number: 7, url: 'https://github.test/acme/app/pull/7',
      state: 'open' as const, headSha: 'reviewed-head' }];
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'merge',
      status: 'waiting',
      waitingFor: { kind: 'github', detail: 'policy blocked' },
      prs,
      landing: {
        authorization: 'authorized',
        validation: 'pending',
        provider: 'queued',
        authorizedHeads: { 'acme/app#7': 'reviewed-head' },
      },
    });

    const merge = await f.api.getTaskView(f.token, f.task.id);
    expect(merge?.stageTransitions?.map((move) => move.target)).toEqual(['human', 'do', 'draft', 'done']);
    await f.api.moveTaskStage(f.token, f.task.id, 'do');
    expect(f.starts.at(-1)!.options.args[0].recovery).toMatchObject({
      resumeStage: 'do',
      prs,
      repairValidationPending: true,
      landing: {
        authorization: 'authorized',
        validation: 'failed',
        provider: 'ejected',
        authorizedHeads: { 'acme/app#7': 'reviewed-head' },
      },
    });
  });

  it('does not advertise a lossy human hold from the internal Resolve frame', async () => {
    const f = fixture();
    f.store.saveView(f.task.id, {
      ...f.view,
      stage: 'resolve',
      status: 'active',
      transcripts: [
        { role: 'do', label: 'Do agent', messages: f.view.messages },
        { role: 'resolve', label: 'Resolve agent', messages: [{ id: 'resolve-1', role: 'agent', text: 'repairing', ts: 1 }] },
      ],
    });

    const resolving = await f.api.getTaskView(f.token, f.task.id);
    expect(resolving?.stageTransitions?.map((move) => move.target)).toEqual(['draft', 'done']);
  });

  it('moves a draft to Done and back without starting an execution', async () => {
    const f = fixture();
    f.store.updateTaskParams(f.task.id, { ...f.task.params, draft: true });
    const done = await f.api.moveTaskStage(f.token, f.task.id, 'done');
    expect(done.state.manuallyDoneFrom).toBe('draft');
    expect(f.starts).toHaveLength(0);

    const draft = await f.api.moveTaskStage(f.token, f.task.id, 'draft');
    expect(draft).toMatchObject({ stage: 'setup', state: { draft: true } });
    expect(f.store.getTask(f.task.id)?.params.draft).toBe(true);
  });

  it('makes destructive Draft reset a one-shot input to the next Setup', async () => {
    const f = fixture();
    const draft = await f.api.moveTaskStage(f.token, f.task.id, 'draft');
    expect(draft.state.draft).toBe(true);
    expect(f.store.getTask(f.task.id)?.params._discardProgress).toBe(true);

    await f.api.moveTaskStage(f.token, f.task.id, 'do');
    expect(f.starts[0]!.options.args[0].discardProgress).toBe(true);
    expect(f.store.getTask(f.task.id)?.params._discardProgress).toBeUndefined();
  });
});
