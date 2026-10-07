import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { AuthorizationGrantError, AuthorizationService, organizationScope, projectScope } from '../src/platform/authorization.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import type { AuthorizationSelection } from '../src/domain/types.js';

/**
 * Giving a task a vault credential you cannot grant is an authorization gap,
 * exactly like choosing a level you do not hold (SPEC §8.2): it is refused with
 * whom to summon, and is never silently dropped. Summoning routes only to people
 * who can grant the credential, and approving adds it to the task.
 */
async function fixture() {
  const store = await Store.create(':memory:');
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const project = await store.createProject('Site', {}, organization.id);
  const authorization = await AuthorizationService.create(store);
  await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
  for (const userId of ['admin', 'maint', 'dev']) await store.setOrganizationMembership(organization.id, userId, 'member');
  await authorization.grant('system:test', { principalId: 'user:admin', scopeKey: organizationScope(organization.id), profileId: 'administrator' });
  await authorization.grant('system:test', { principalId: 'user:maint', scopeKey: projectScope(project.id), profileId: 'maintainer' });
  await authorization.grant('system:test', { principalId: 'user:dev', scopeKey: projectScope(project.id), profileId: 'developer' });
  const tokens = new TokenAuthority(store);
  const client = { workflow: {
    getHandle: () => ({ executeUpdate: async () => undefined, query: async () => { throw new Error('no live query'); },
      describe: async () => ({ runId: 'run', status: { name: 'RUNNING' } }), signal: async () => undefined }),
    start: async () => ({}),
  } } as any;
  const api = new KarmaxApi({ store, client, taskQueue: 'test', tokens, authorization });
  const human = async (userId: string, extra: string[] = []) => (await tokens.mintPrincipal(`user:${userId}`,
    [...await authorization.capabilities(`user:${userId}`, project.id, organization.id), ...extra],
    project.id, undefined, organization.id)).token;
  const vault = new VaultItems(store, undefined, undefined, organization.id);
  const login = await vault.save({ type: 'login', label: 'Stripe dashboard', domains: ['stripe.com'] });
  const cap = `use-credential:item:${login.id}`;
  const developer: AuthorizationSelection = { level: 'developer', scope: 'projects', projectIds: [project.id] };
  return { store, organization, project, authorization, api, human, login, cap, developer };
}

const grants = (task: { params: Record<string, unknown> }) =>
  ((task.params._authorization as { capabilities: string[] }).capabilities).filter((cap) => cap.startsWith('use-credential:'));

describe('giving a task a credential you cannot grant', () => {
  it('is refused with the gap and whom to summon instead of silently dropped', async () => {
    const f = await fixture();
    const refusal = await f.api.createTask(await f.human('dev'), { projectId: f.project.id, workflow: 'just-do', prompt: 'pay',
      authorization: f.developer, credentialGrants: [f.cap] }).catch((error) => error);
    expect(refusal).toBeInstanceOf(AuthorizationGrantError);
    expect(refusal).toMatchObject({ status: 403, code: 'authorization_grant_denied',
      gap: { summon: '@admins', missingCapabilities: [f.cap], credentialGrants: [f.cap] } });
    expect(refusal.message).toMatch(/Stripe dashboard/);
    expect(await f.store.listTasks(f.project.id)).toEqual([]);
  });

  it('is refused even when the task names no authorization level', async () => {
    const f = await fixture();
    const refusal = await f.api.createTask(await f.human('dev'), { projectId: f.project.id, workflow: 'just-do', prompt: 'pay',
      credentialGrants: [f.cap] }).catch((error) => error);
    expect(refusal).toMatchObject({ code: 'authorization_grant_denied', gap: { credentialGrants: [f.cap] } });
  });

  it('attaches credentials the creator can grant without asking', async () => {
    const f = await fixture();
    const own = await f.api.createTask(await f.human('dev', [f.cap]), { projectId: f.project.id, workflow: 'just-do',
      prompt: 'pay', draft: true, authorization: f.developer, credentialGrants: [f.cap] });
    expect(grants(own)).toEqual([f.cap]);
    const administered = await f.api.createTask(await f.human('admin'), { projectId: f.project.id, workflow: 'just-do',
      prompt: 'pay', draft: true, authorization: f.developer, credentialGrants: [f.cap] });
    expect(grants(administered)).toEqual([f.cap]);
  });

  it('runs without it only when the creator accepts the limit', async () => {
    const f = await fixture();
    const task = await f.api.createTask(await f.human('dev'), { projectId: f.project.id, workflow: 'just-do', prompt: 'pay',
      draft: true, authorization: f.developer, credentialGrants: [f.cap], acceptAttenuation: true });
    expect(grants(task)).toEqual([]);
    expect(task.params._authorization).toMatchObject({ missingCredentialGrants: [f.cap], attenuationAccepted: true });
    await f.api.queueTask(await f.human('dev'), task.id);
  });

  it('keeps a draft that asked for it from starting until someone grants it', async () => {
    const f = await fixture();
    const dev = await f.human('dev');
    const draft = await f.api.createTask(dev, { projectId: f.project.id, workflow: 'just-do', prompt: 'pay',
      draft: true, allowAttenuation: true, authorization: f.developer, credentialGrants: [f.cap] });
    expect(draft.params._authorization).toMatchObject({ missingCredentialGrants: [f.cap], attenuationAccepted: false });
    await expect(f.api.queueTask(dev, draft.id)).rejects.toMatchObject({ code: 'authorization_grant_denied',
      gap: { credentialGrants: [f.cap] } });
  });

  it('summons only people who can grant the credential, and approval adds it and queues the task', async () => {
    const f = await fixture();
    const dev = await f.human('dev');
    const targets = await f.api.authorizationEscalationTargets(dev, { projectId: f.project.id, authorization: f.developer,
      credentialGrants: [f.cap] });
    expect(targets).toMatchObject({ summon: '@admins', missingCapabilities: [f.cap],
      credentials: [{ capability: f.cap, label: 'Stripe dashboard' }] });
    expect(targets.users.map((user) => user.id).sort()).toEqual(['admin', 'owner']);

    const draft = await f.api.createTask(dev, { projectId: f.project.id, workflow: 'just-do', prompt: 'pay',
      draft: true, allowAttenuation: true, authorization: f.developer, credentialGrants: [f.cap] });
    await expect(f.api.requestAuthorization(dev, { projectId: f.project.id, target: { kind: 'task', taskId: draft.id },
      authorization: f.developer, credentialGrants: [f.cap], audience: ['user:maint'] })).rejects.toThrow(/cannot grant/);
    const request = await f.api.requestAuthorization(dev, { projectId: f.project.id,
      target: { kind: 'task', taskId: draft.id, queueAfterApproval: true },
      authorization: f.developer, credentialGrants: [f.cap], audience: ['@admins'] });
    expect(request).toMatchObject({ credentialGrants: [f.cap], missingCapabilities: [f.cap] });
    expect([...request.recipients].sort()).toEqual(['admin', 'owner']);

    const resolved = await f.api.resolveAuthorizationRequest(await f.human('admin'), {
      organizationId: f.organization.id, requestId: request.id, action: 'approve' });
    expect(resolved).toMatchObject({ status: 'granted', queued: true });
    const task = (await f.store.getTask(draft.id))!;
    expect(grants(task)).toEqual([f.cap]);
    expect((task.params._authorization as any).missingCredentialGrants).toBeUndefined();
    expect(task.params.draft).toBe(false);
  });

  it('is refused the same way when editing a task’s credentials', async () => {
    const f = await fixture();
    const dev = await f.human('dev');
    const draft = await f.api.createTask(dev, { projectId: f.project.id, workflow: 'just-do', prompt: 'pay', draft: true,
      authorization: f.developer });
    const refusal = await f.api.setTaskAuthorization(dev, draft.id, f.developer, [f.cap]).catch((error) => error);
    expect(refusal).toMatchObject({ code: 'authorization_grant_denied', gap: { summon: '@admins', credentialGrants: [f.cap] } });
    // A draft may keep the request for later, still refusing to start.
    const kept = await f.api.setTaskAuthorization(dev, draft.id, f.developer, [f.cap], undefined, { allowAttenuation: true });
    expect(kept.params._authorization).toMatchObject({ missingCredentialGrants: [f.cap] });
    await expect(f.api.queueTask(dev, draft.id)).rejects.toMatchObject({ code: 'authorization_grant_denied' });
  });

  it('is refused for another agent of the task, naming that agent', async () => {
    const f = await fixture();
    const refusal = await f.api.createTask(await f.human('dev'), { projectId: f.project.id, workflow: 'just-do', prompt: 'pay',
      authorization: f.developer, params: { 'agent:agent-2': { provider: 'mock', authority: { credentialGrants: [f.cap] } } } })
      .catch((error) => error);
    expect(refusal).toMatchObject({ code: 'authorization_grant_denied', participant: 'agent-2',
      gap: { credentialGrants: [f.cap] } });
  });

  it('still narrows inherited default credentials to the creator without asking', async () => {
    const f = await fixture();
    await f.store.setSettings(`organization:${f.organization.id}`, 'vault', { credentialGrants: [f.cap] });
    const task = await f.api.createTask(await f.human('dev'), { projectId: f.project.id, workflow: 'just-do', prompt: 'pay', draft: true });
    expect(grants(task)).toEqual([]);
  });
});
