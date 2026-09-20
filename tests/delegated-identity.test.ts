import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { allows } from '../src/platform/capabilities.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { actorPrincipal, identityAuditDetail, requireHumanSubject, requireInteractiveHuman,
  resolveCallerIdentity } from '../src/platform/identity.js';

describe('delegated human identity authority', () => {
  let store: Store;
  let tokens: TokenAuthority;

  beforeEach(async () => {
    store = (await Store.create(':memory:'));
    tokens = new TokenAuthority(store);
  });
  afterEach(async () => {
    vi.useRealTimers();
    (await store.close());
  });

  it('keeps Developer denied while Maintainer explicitly carries repository:write', async () => {
    const authorization = (await AuthorizationService.create(store));
    expect(allows((await authorization.profile('developer'))!.capabilities, 'repository:write')).toBe(false);
    expect(allows((await authorization.profile('maintainer'))!.capabilities, 'repository:write')).toBe(true);
  });

  it('mints an agent actor with a verified human subject and pinned external identity', async () => {
    const human = (await tokens.mintPrincipal('user:alice', ['repository:write'], 'p1', 60_000, 'o1'));
    const delegation = (await tokens.delegateHuman(human.token, {
      taskId: 't1', projectId: 'p1', organizationId: 'o1',
      externalIdentities: { githubAccountId: '42' },
    }))!;
    const agent = (await tokens.mint({
      taskId: 't1', profileId: 'do', role: 'do', principal: 'user:alice', projectId: 'p1', organizationId: 'o1',
      ceiling: ['repository:write'], grantorCaps: ['repository:write'], delegationId: delegation.id,
    }));

    const identity = resolveCallerIdentity(agent.record);
    expect(identity).toMatchObject({
      actor: { kind: 'task-agent', taskId: 't1', profileId: 'do', role: 'do' },
      humanSubject: { kind: 'user', userId: 'alice', presence: 'delegated' },
      externalIdentities: { githubAccountId: '42' },
    });
    expect(requireHumanSubject(identity).userId).toBe('alice');
    expect(() => requireInteractiveHuman(identity)).toThrow(expect.objectContaining({
      message: expect.stringMatching(/interactive human session/i), status: 401,
    }));
    expect(actorPrincipal(identity.actor)).toBe('task-agent:t1:do');
    expect(identityAuditDetail(identity)).toMatchObject({ humanSubject: { userId: 'alice' } });
  });

  it('never infers delegation from a generic principal and rejects user/account substitution', async () => {
    const undelegated = (await tokens.mint({ taskId: 't0', profileId: 'do', principal: 'user:alice',
      ceiling: ['repository:write'], grantorCaps: ['repository:write'] }));
    expect(undelegated.record.humanSubject).toBeUndefined();
    expect(() => requireHumanSubject(resolveCallerIdentity(undelegated.record))).toThrow(/verified human subject/i);

    const human = (await tokens.mintPrincipal('user:alice', ['repository:write'], 'p1', 60_000, 'o1'));
    const root = (await tokens.delegateHuman(human.token, { taskId: 't1', projectId: 'p1', organizationId: 'o1',
      externalIdentities: { githubAccountId: '42' } }))!;
    const agent = (await tokens.mint({ taskId: 't1', profileId: 'do', principal: 'user:alice', projectId: 'p1', organizationId: 'o1',
      ceiling: ['repository:write'], grantorCaps: ['repository:write'], delegationId: root.id }));

    await expect((async () => (await tokens.delegateHuman(agent.token, { taskId: 't2', projectId: 'p1', organizationId: 'o1',
      externalIdentities: { githubAccountId: '99' } })))()).rejects.toThrow(/cannot substitute/i);
    await expect((async () => (await tokens.delegateHuman(agent.token, { taskId: 't2', projectId: 'p2', organizationId: 'o1',
      externalIdentities: { githubAccountId: '42' } })))()).rejects.toThrow(/scoped to project p1/i);
    await expect((async () => (await tokens.delegateHuman(agent.token, { taskId: 't2', projectId: 'p1', organizationId: 'o2',
      externalIdentities: { githubAccountId: '42' } })))()).rejects.toThrow(/scoped to organization o1/i);
    await expect((async () => (await tokens.mint({ taskId: 'forged', profileId: 'do', principal: 'user:bob', projectId: 'p1', organizationId: 'o1',
      ceiling: ['repository:write'], grantorCaps: ['repository:write'], delegationId: root.id })))()).rejects.toThrow(/task-mismatched/i);

    const bobHuman = (await tokens.mintPrincipal('user:bob', ['repository:write'], 'p1', 60_000, 'o1'));
    const bobDelegation = (await tokens.delegateHuman(bobHuman.token, {
      taskId: 'bob-parent', projectId: 'p1', organizationId: 'o1',
    }))!;
    const bobParent = (await tokens.mint({ taskId: 'bob-parent', profileId: 'do', principal: 'user:bob',
      projectId: 'p1', organizationId: 'o1', ceiling: ['repository:write'], grantorCaps: ['repository:write'],
      delegationId: bobDelegation.id }));
    const aliceChild = (await tokens.deriveHumanDelegation(root.id, {
      taskId: 'alice-child', projectId: 'p1', organizationId: 'o1',
    }));
    await expect((async () => (await tokens.mint({ taskId: 'alice-child', profileId: 'do', principal: 'task:bob-parent',
      projectId: 'p1', organizationId: 'o1', ceiling: ['repository:write'], grantorCaps: ['repository:write'],
      parentTokenId: bobParent.record.id, delegationId: aliceChild.id })))()).rejects.toThrow(/does not descend/i);
  });

  it('widens only an interactive human after durable authorization has been verified', async () => {
    const human = (await tokens.mintPrincipal('user:alice', ['task:create'], 'p1', 60_000, 'o1'));
    await expect((async () => (await tokens.delegateHuman(human.token, {
      taskId: 'admin-task', organizationId: 'o1',
    })))()).rejects.toThrow(/scoped to project p1/i);

    const delegation = (await tokens.delegateAuthorizedInteractiveHuman(human.token, {
      taskId: 'admin-task', organizationId: 'o1',
    }))!;
    const agent = (await tokens.mint({
      taskId: 'admin-task', profileId: 'do', role: 'do', principal: 'user:alice', organizationId: 'o1',
      ceiling: ['task:read'], grantorCaps: ['task:read'], delegationId: delegation.id,
    }));
    expect(agent.record.humanSubject).toMatchObject({ userId: 'alice', presence: 'delegated' });

    await expect((async () => (await tokens.delegateAuthorizedInteractiveHuman(agent.token, {
      taskId: 'forged-child', organizationId: 'o1',
    })))()).rejects.toThrow(/requires an interactive human/i);
  });

  it('attenuates derived tokens and invalidates them with parent revocation or delegation expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const human = (await tokens.mintPrincipal('user:alice', ['repository:write'], 'p1', 60_000, 'o1'));
    const root = (await tokens.delegateHuman(human.token, { taskId: 't1', projectId: 'p1', organizationId: 'o1', ttlMs: 5_000 }))!;
    const parent = (await tokens.mint({ taskId: 't1', profileId: 'do', role: 'do', principal: 'user:alice',
      projectId: 'p1', organizationId: 'o1', ceiling: ['repository:write'], grantorCaps: ['repository:write'],
      delegationId: root.id, ttlMs: 5_000 }));
    const childDelegation = (await tokens.deriveHumanDelegation(root.id, {
      taskId: 't2', projectId: 'p1', organizationId: 'o1', ttlMs: 10_000,
    }));
    expect(childDelegation.expiresAt).toBe(root.expiresAt);
    const child = (await tokens.mint({ taskId: 't2', profileId: 'do', role: 'do', principal: 'task:t1',
      projectId: 'p1', organizationId: 'o1', ceiling: ['repository:*', 'settings:write'],
      grantorCaps: ['*'], parentTokenId: parent.record.id, delegationId: childDelegation.id, ttlMs: 10_000 }));
    expect(child.record.caps).toEqual(['repository:write']);
    expect(child.record.humanSubject?.userId).toBe('alice');

    (await tokens.revoke(parent.token));
    expect((await tokens.verify(child.token))).toBeUndefined();

    const replacement = (await tokens.mint({ taskId: 't1', profileId: 'do', principal: 'user:alice', projectId: 'p1', organizationId: 'o1',
      ceiling: ['repository:write'], grantorCaps: ['repository:write'], delegationId: root.id, ttlMs: 10_000 }));
    expect((await tokens.verify(replacement.token))).toBeDefined();
    vi.advanceTimersByTime(5_001);
    expect((await tokens.verify(replacement.token))).toBeUndefined();
  });

  it('preserves ordinary interactive browser identity', async () => {
    const human = (await tokens.mintPrincipal('user:alice', ['repository:write']));
    const identity = resolveCallerIdentity(human.record, 'alice');
    expect(requireInteractiveHuman(identity)).toMatchObject({ userId: 'alice', presence: 'interactive' });
    expect(resolveCallerIdentity(human.record, 'bob').humanSubject).toBeUndefined();
  });
});
