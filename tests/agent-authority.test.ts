import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { assembleTaskInput } from '../src/platform/params.js';
import { manifest } from '../src/contrib/manifests.js';
import { agentSpecsByParticipant, normalizeAgentAuthority, participantAuthorization } from '../src/platform/agent-authority.js';
import type { AuthorizationSelection } from '../src/domain/types.js';

/**
 * Per-agent authority (wiki planned/collaboration-model): every agent other than
 * the main one may carry `authority` in its spec. The platform attenuates it
 * against whoever set it — exactly like the task's own authorization — and stores
 * it as `params._agentAuthorization[<participant>]`.
 */
async function fixture() {
  const store = await Store.create(':memory:');
  await store.claimPersonalOrganization('owner');
  await store.setOrganizationMembership('org_personal', 'dev', 'member');
  const project = await store.createProject('Agents');
  const other = await store.createProject('Elsewhere');
  const authorization = await AuthorizationService.create(store);
  await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(project.id), profileId: 'maintainer' });
  await authorization.grant('system:test', { principalId: 'user:owner', scopeKey: projectScope(other.id), profileId: 'maintainer' });
  await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
  const tokens = new TokenAuthority(store);
  const tokenFor = async (userId: string, extra: string[] = []) => (await tokens.mintPrincipal(
    `user:${userId}`, [...(await authorization.capabilities(`user:${userId}`, project.id, 'org_personal')), ...extra],
    project.id, undefined, 'org_personal',
  )).token;
  const updates: unknown[] = [];
  const client = { workflow: {
    getHandle: () => ({ executeUpdate: async (_name: string, opts: { args: unknown[] }) => {
      updates.push(opts.args[0]);
      return { applied: Object.keys(opts.args[0] as object) };
    }, query: async () => [] }),
    start: async () => ({}),
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const viewer: AuthorizationSelection = { level: 'viewer', scope: 'projects', projectIds: [project.id] };
  const maintainer: AuthorizationSelection = { level: 'maintainer', scope: 'projects', projectIds: [project.id] };
  return { store, project, other, authorization, tokens, tokenFor, api, viewer, maintainer, updates };
}

const responderAgent = (authority?: unknown) => ({ kind: 'agent', provider: 'mock', ...(authority ? { authority } : {}) });
const entries = (task: { params: Record<string, unknown> }) => (task.params._agentAuthorization ?? {}) as Record<string, any>;

describe('agent authority specs', () => {
  it('keys every non-main agent by participant', () => {
    const specs = agentSpecsByParticipant({
      responder: responderAgent({ authorization: { level: 'viewer', scope: 'organization' } }),
      confirm: { layers: [{ kind: 'human' }, { kind: 'agent', provider: 'mock' }, { kind: 'agent', provider: 'codex' }] },
      'agent:agent-3': { provider: 'claude' },
      'agent:do': { provider: 'claude' },
    });
    expect([...specs.keys()]).toEqual(['responder', 'confirm', 'confirm-2', 'agent-3']);
    expect(specs.get('confirm-2')).toMatchObject({ provider: 'codex' });
  });

  it('validates authority values', () => {
    expect(normalizeAgentAuthority({ authorization: { level: 'viewer', scope: 'projects', projectIds: ['p', 'p'] },
      paymentPolicy: { cardIds: ['c'], budget: 500, currency: 'USD' } }))
      .toEqual({ authorization: { level: 'viewer', scope: 'projects', projectIds: ['p'] }, paymentPolicy: { cardIds: ['c'], budget: 500, currency: 'usd' } });
    expect(() => normalizeAgentAuthority({ capabilities: ['*'] })).toThrow(/unknown/);
    expect(() => normalizeAgentAuthority({ credentialGrants: ['task:create'] })).toThrow(/use-credential/);
    expect(() => normalizeAgentAuthority({ paymentPolicy: { budget: -1 } })).toThrow(/budget/);
  });

  it('keeps authority and Avatar selection through task assembly', () => {
    const input = assembleTaskInput(manifest('software-dev')!, {
      prompt: 'x',
      responder: { kind: 'agent', provider: 'mock', avatarId: 'av_1', authority: { authorization: { level: 'viewer', scope: 'organization' } } },
      confirm: { layers: [{ kind: 'agent', provider: 'mock', avatarId: 'av_2', authority: { credentialGrants: ['use-credential:item:a'] } }] },
    }, { taskId: 't', projectId: 'p', title: 'x', project: {} });
    expect(input.responder).toMatchObject({ avatarId: 'av_1', authority: { authorization: { level: 'viewer' } } });
    expect(input.confirm?.layers?.[0]).toMatchObject({ avatarId: 'av_2', authority: { credentialGrants: ['use-credential:item:a'] } });
  });
});

describe('per-agent authorization', () => {
  it('attenuates each agent’s authority against its creator and stores it per participant', async () => {
    const f = await fixture();
    try {
      const task = await f.api.createTask(await f.tokenFor('owner'), { projectId: f.project.id, draft: true, params: {
        prompt: 'Two agents',
        responder: responderAgent({ authorization: f.viewer }),
        confirm: { layers: [{ kind: 'agent', provider: 'mock' }, { kind: 'agent', provider: 'mock', authority: { authorization: f.maintainer } }] },
      } });
      const stored = entries(task);
      expect(Object.keys(stored).sort()).toEqual(['confirm-2', 'responder']);
      expect(stored.responder).toMatchObject({ level: 'viewer', principal: 'user:owner', profileAttenuated: false,
        requested: { authorization: f.viewer } });
      expect(stored.responder.capabilities).toContain('task:read');
      expect(stored.responder.capabilities).not.toContain('task:create');
      expect(stored['confirm-2']).toMatchObject({ level: 'maintainer', profileAttenuated: false });
      expect(stored['confirm-2'].capabilities).toContain('review:approve');
      expect(stored.responder.delegationId).toBeTruthy();
      // The task's own authorization is untouched by its agents.
      expect((task.params._authorization as any).level).toBe('developer');
    } finally { await f.store.close(); }
  });

  it('refuses an agent authority beyond its creator unless the draft keeps it or the creator accepts the limit', async () => {
    const f = await fixture();
    try {
      const token = await f.tokenFor('dev');
      const params = { prompt: 'Too much', responder: responderAgent({ authorization: f.maintainer }) };
      const refused = await f.api.createTask(token, { projectId: f.project.id, params }).catch((error) => error);
      expect(refused).toMatchObject({ code: 'authorization_grant_denied', participant: 'responder' });
      expect(await f.store.listTasks(f.project.id)).toEqual([]);
      const draft = await f.api.createTask(token, { projectId: f.project.id, draft: true, allowAttenuation: true, params });
      expect(entries(draft).responder).toMatchObject({ profileAttenuated: true, attenuationAccepted: false });
      expect(entries(draft).responder.capabilities).not.toContain('review:approve');
      await expect(f.api.queueTask(token, draft.id)).rejects.toMatchObject({ code: 'authorization_grant_denied', participant: 'responder' });
      // Accepting the limit for that agent lets the draft run with the attenuated package.
      const accepted = await f.api.setAgentAuthority(token, draft.id, 'responder', { authorization: f.maintainer }, { acceptAttenuation: true });
      expect(entries(accepted).responder).toMatchObject({ profileAttenuated: true, attenuationAccepted: true });
      await f.api.queueTask(token, draft.id);
      expect(entries((await f.store.getTask(draft.id))!).responder.attenuationAccepted).toBe(true);
    } finally { await f.store.close(); }
  });

  it('routes an agent’s authorization gap to someone who can grant it and queues on approval', async () => {
    const f = await fixture();
    try {
      const dev = await f.tokenFor('dev');
      const draft = await f.api.createTask(dev, { projectId: f.project.id, draft: true, allowAttenuation: true,
        params: { prompt: 'Ask', responder: responderAgent({ authorization: f.maintainer, paymentPolicy: { budget: 100 } }) } });
      const request = await f.api.requestAuthorization(dev, { projectId: f.project.id,
        target: { kind: 'task', taskId: draft.id, participant: 'responder', queueAfterApproval: true },
        authorization: f.maintainer, audience: ['user:owner'] });
      expect(request.target).toMatchObject({ participant: 'responder' });
      // The task's own authorization request is a separate one.
      const resolved = await f.api.resolveAuthorizationRequest(await f.tokenFor('owner'), {
        organizationId: 'org_personal', requestId: request.id, action: 'approve' });
      expect(resolved).toMatchObject({ status: 'granted', queued: true });
      const task = (await f.store.getTask(draft.id))!;
      expect(entries(task).responder).toMatchObject({ level: 'maintainer', profileAttenuated: false,
        principal: 'user:owner', paymentPolicy: { budget: 100 } });
      expect(entries(task).responder.capabilities).toContain('review:approve');
      expect((task.params._authorization as any).level).toBe('developer');
      expect(task.params.draft).toBe(false);
    } finally { await f.store.close(); }
  });

  it('accepts a limited agent authority per agent on create', async () => {
    const f = await fixture();
    try {
      const task = await f.api.createTask(await f.tokenFor('dev'), { projectId: f.project.id, draft: true,
        acceptAttenuation: ['responder'],
        params: { prompt: 'x', responder: responderAgent({ authorization: f.maintainer }) } });
      expect(entries(task).responder).toMatchObject({ profileAttenuated: true, attenuationAccepted: true });
    } finally { await f.store.close(); }
  });

  it('never takes platform metadata from a params bag and keeps it across full-form saves', async () => {
    const f = await fixture();
    try {
      const token = await f.tokenFor('owner');
      const forged = { responder: { capabilities: ['*'], requested: {} } };
      const task = await f.api.createTask(token, { projectId: f.project.id, draft: true,
        params: { prompt: 'x', _agentAuthorization: forged, responder: responderAgent({ authorization: f.viewer }) } });
      expect(entries(task).responder.capabilities).not.toContain('*');
      const before = entries(task).responder;
      // An unchanged agent keeps its entry (and delegation) across auto-saves.
      const saved = await f.api.updateArmedParams(token, task.id, { prompt: 'y', _agentAuthorization: forged,
        responder: responderAgent({ authorization: f.viewer }) }, { replace: true, keepArmed: false });
      expect(entries(saved).responder).toEqual(before);
      // A changed one is recomputed; a removed one is dropped.
      const changed = await f.api.updateArmedParams(token, task.id, { prompt: 'y',
        responder: responderAgent({ authorization: f.maintainer }) }, { replace: true, keepArmed: false });
      expect(entries(changed).responder.level).toBe('maintainer');
      const removed = await f.api.updateArmedParams(token, task.id, { prompt: 'y', responder: { kind: 'human' } },
        { replace: true, keepArmed: false });
      expect(entries(removed)).toEqual({});
    } finally { await f.store.close(); }
  });

  it('sets and clears the authority of an agent called into a running task', async () => {
    const f = await fixture();
    try {
      const token = await f.tokenFor('owner');
      const task = await f.api.createTask(token, { projectId: f.project.id, params: { prompt: 'Running' } });
      expect(task.params.draft).toBe(false);
      const set = await f.api.setAgentAuthority(token, task.id, 'agent-1', { authorization: f.viewer,
        paymentPolicy: { budget: 300, currency: 'usd' } });
      expect(entries(set)['agent-1']).toMatchObject({ level: 'viewer', paymentPolicy: { budget: 300, currency: 'usd' } });
      await expect(f.api.setAgentAuthority(token, task.id, 'do', { authorization: f.viewer })).rejects.toThrow(/main agent/);
      await expect(f.api.setAgentAuthority(token, task.id, 'agent-x', { authorization: f.viewer })).rejects.toThrow(/participant/);
      const cleared = await f.api.setAgentAuthority(token, task.id, 'agent-1', undefined);
      expect(entries(cleared)).toEqual({});
    } finally { await f.store.close(); }
  });

  it('applies an in-flight route change’s authority once the workflow accepts it', async () => {
    const f = await fixture();
    try {
      const token = await f.tokenFor('owner');
      const task = await f.api.createTask(token, { projectId: f.project.id, params: { prompt: 'Running' } });
      await f.api.updateParams(token, task.id, { responder: responderAgent({ authorization: f.viewer }) });
      expect(entries((await f.store.getTask(task.id))!).responder).toMatchObject({ level: 'viewer' });
      const dev = await f.tokenFor('dev');
      const own = await f.api.createTask(dev, { projectId: f.project.id, params: { prompt: 'Mine' } });
      const updates = f.updates.length;
      await expect(f.api.updateParams(dev, own.id, { responder: responderAgent({ authorization: f.maintainer }) }))
        .rejects.toMatchObject({ code: 'authorization_grant_denied', participant: 'responder' });
      // Refused before the workflow ever saw the route.
      expect(f.updates.length).toBe(updates);
      expect(entries((await f.store.getTask(own.id))!)).toEqual({});
    } finally { await f.store.close(); }
  });

  it('snapshots default agent authority attenuated to the creator without refusing', async () => {
    const f = await fixture();
    try {
      await f.store.setSettings('organization:org_personal', '__common__', {
        responder: responderAgent({ authorization: { level: 'maintainer', scope: 'organization' } }) });
      const task = await f.api.createTask(await f.tokenFor('dev'), { projectId: f.project.id, params: { prompt: 'Defaults' } });
      expect(entries(task).responder).toMatchObject({ profileAttenuated: true, attenuationAccepted: true });
      expect(entries(task).responder.capabilities).not.toContain('review:approve');
    } finally { await f.store.close(); }
  });

  it('adds only credential grants the creator holds and refuses authority on the main agent', async () => {
    const f = await fixture();
    try {
      const token = await f.tokenFor('dev', ['use-credential:item:mine']);
      const task = await f.api.createTask(token, { projectId: f.project.id, draft: true, params: { prompt: 'Vault',
        'agent:agent-2': { provider: 'mock', authority: { credentialGrants: ['use-credential:item:mine', 'use-credential:item:theirs'] } } } });
      const caps = entries(task)['agent-2'].capabilities;
      expect(caps).toContain('use-credential:item:mine');
      expect(caps).not.toContain('use-credential:item:theirs');
      // Omitted authorization inherits the task's level.
      expect(entries(task)['agent-2'].level).toBe('developer');
      await expect(f.api.createTask(token, { projectId: f.project.id, draft: true, params: { prompt: 'x',
        'agent:do': { provider: 'mock', authority: { authorization: f.viewer } } } })).rejects.toThrow(/main agent/);
    } finally { await f.store.close(); }
  });

  it('uses the organization or project authorization default when a task names none', async () => {
    const f = await fixture();
    try {
      await f.store.setSettings('organization:org_personal', 'authorization', { level: 'viewer', scope: 'projects' });
      const task = await f.api.createTask(await f.tokenFor('owner'), { projectId: f.project.id, draft: true, params: { prompt: 'x' } });
      expect(task.params._authorization).toMatchObject({ level: 'viewer', projectIds: [f.project.id] });
      await f.store.setSettings(f.project.id, 'authorization', { level: 'maintainer', scope: 'projects' });
      const project = await f.api.createTask(await f.tokenFor('owner'), { projectId: f.project.id, draft: true, params: { prompt: 'x' } });
      expect(project.params._authorization).toMatchObject({ level: 'maintainer' });
      // A default the creator cannot grant is attenuated, never widened.
      const limited = await f.api.createTask(await f.tokenFor('dev'), { projectId: f.project.id, draft: true, params: { prompt: 'x' } });
      expect((limited.params._authorization as any).capabilities).not.toContain('review:approve');
      await expect(f.store.setSettings(f.project.id, 'authorization', { level: 'viewer', scope: 'everywhere' })).rejects.toThrow(/authorization/);
    } finally { await f.store.close(); }
  });

  it('reads a participant’s stored authorization for its turns', () => {
    const params = { _agentAuthorization: { responder: { capabilities: ['task:read'], requested: {} } } };
    expect(participantAuthorization(params, 'responder')?.capabilities).toEqual(['task:read']);
    expect(participantAuthorization(params, 'do')).toBeUndefined();
    expect(participantAuthorization(params, 'confirm')).toBeUndefined();
  });
});
