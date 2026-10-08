import { afterEach, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { AccountErasureService, closedAccountKey } from '../src/privacy/account-erasure.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { GitProfiles, userGitScope } from '../src/autonomy/git-profiles.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Gateway } from '../src/gateway/server.js';
import { WorldRegistry } from '../src/world/registry.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { GitHubAppService, GITHUB_APP_CLIENT_SECRET_HANDLE } from '../src/integrations/github-app.js';
import { INSTALLATION_SCOPE, userScope } from '../src/autonomy/vault-keys.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-erasure-'));
  const store = await Store.create(path.join(dir, 'state.sqlite'));
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const users = [
    { id: 'admin', name: 'Administrator', email: 'admin@example.test', role: 'admin', createdAt: new Date() },
    { id: 'u_1', name: 'Person', email: 'person@example.test', role: 'user', createdAt: new Date() },
    { id: 'uX1', name: 'Other', email: 'other@example.test', role: 'user', createdAt: new Date() },
  ];
  const identity = { listUsers: async () => users, removeUser: vi.fn(async (id: string) => {
    const i = users.findIndex(user => user.id === id); if (i >= 0) users.splice(i, 1);
  }) };
  const service = new AccountErasureService(store, identity, broker, dir);
  const tokens = new TokenAuthority(store);
  cleanup.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const close = async () => service.close('u_1', { fingerprint: (await service.preview('u_1')).fingerprint,
    confirmation: 'CLOSE u_1', exportHandled: true }, 'user:admin');
  return { dir, store, broker, identity, service, tokens, close };
}

it('previews without mutation, requires exact confirmation and rejects a stale inventory', async () => {
  const { store, service, close, identity } = await fixture();
  const preview = await service.preview('u_1');
  expect(preview.case).toBeNull();
  expect(await store.kvGet(closedAccountKey('u_1'))).toBeUndefined();
  await expect(service.close('u_1', { fingerprint: preview.fingerprint, confirmation: 'CLOSE uX1', exportHandled: true }, 'admin')).rejects.toThrow('exact user');
  await store.setOrganizationMembership('org_personal', 'u_1', 'member');
  await expect(service.close('u_1', { fingerprint: preview.fingerprint, confirmation: 'CLOSE u_1', exportHandled: true }, 'admin')).rejects.toThrow('Inventory changed');
  expect(identity.removeUser).not.toHaveBeenCalled();
  expect((await close()).state).toBe('closed');
});

it('blocks sole ownership, live linked work, owned avatars and dependent organization Git', async () => {
  const { store, service, broker, dir, close } = await fixture();
  const org = await store.createOrganization({ name: 'Private fixture', kind: 'personal', ownerUserId: 'u_1' });
  await expect(close()).rejects.toThrow('Transfer ownership');
  await store.setOrganizationMembership(org.id, 'admin', 'owner');
  const project = await store.createProject('Work', {}, org.id);
  const task = await store.createTask({ projectId: project.id, title: 'Still working', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'fixture' }, createdBy: { kind: 'user', userId: 'u_1' } });
  await expect(close()).rejects.toThrow('nonterminal');
  await store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ status: 'done' }), task.id);
  const profiles = new GitProfiles(store, broker, dir, userGitScope('u_1'));
  await profiles.save({ name: 'main', userName: 'Person', userEmail: 'person@example.test', sshKey: 'fixture' });
  await profiles.setDefault('main');
  await new GitProfiles(store, broker, dir, org.id).reuseUserProfile(profiles);
  await expect(close()).rejects.toThrow('Git profiles');
  await new GitProfiles(store, broker, dir, org.id).delete('main');
  expect((await service.preview('u_1')).blockers).toEqual([]);
  await store.db.prepare('INSERT INTO avatars (id,organizationId,projectId,ownerUserId,json,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
    .run('av', org.id, project.id, 'u_1', '{}', Date.now(), Date.now());
  await expect(close()).rejects.toThrow('Avatars');
  expect(await store.kvGet(closedAccountKey('u_1'))).toBeUndefined();
});

it('cleans only personal access/settings and preserves shared work, history and retained records', async () => {
  const { store, broker, dir, service, tokens, identity, close } = await fixture();
  const org = await store.createOrganization({ name: 'Team', ownerUserId: 'admin' });
  await store.setOrganizationMembership(org.id, 'u_1', 'member');
  await store.setOrganizationMembership(org.id, 'uX1', 'member');
  const project = await store.createProject('Shared work', {}, org.id);
  const task = await store.createTask({ projectId: project.id, title: 'Keep this conversation', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'personal text requires manual review' }, createdBy: { kind: 'user', userId: 'u_1' } });
  await store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'done', status: 'done',
    actions: [], state: {}, updatedAt: 1, messages: [{ id: 'personal-message', role: 'user', ts: 1, text: 'Personal information requires targeted review.' }] } as any);
  const before = await store.getTask(task.id);
  for (const id of ['u_1', 'uX1']) {
    await new GitProfiles(store, broker, dir, userGitScope(id)).save({ name: 'main', userName: id, userEmail: `${id}@example.test`, sshKey: 'fixture' });
    await broker.registerHandle(`github-app:user:${id}:account:9:authorization`, 'fixture-token', userScope(id));
    await store.kvSet(`github-app:user:${id}:accounts`, '[{"id":"9"}]');
    await store.kvSet(`hosted:onboarding:${id}:${org.id}`, '{"display":"hidden"}');
    await store.setDeliveryPreferences({ userId: id, organizationId: org.id, browser: true, email: true, slack: false, routine: true });
    await store.setPrincipalGrant(`user:${id}`, 'global', { profileId: 'developer' });
  }
  await store.recordPolicyAcceptance({ userId: 'u_1', email: 'person@example.test', context: 'signup', versions: { terms: 'test' } });
  const human = await tokens.mintPrincipal('user:u_1', ['*']);
  const other = await tokens.mintPrincipal('user:uX1', ['*']);
  const delegation = await tokens.delegateHuman(human.token, { taskId: task.id, projectId: project.id });
  const agent = await tokens.mint({ taskId: task.id, profileId: 'test', principal: 'user:u_1', ceiling: ['*'], grantorCaps: ['*'], delegationId: delegation!.id, projectId: project.id });
  await store.kvSet('account-deletion:u_1', JSON.stringify({ userId: 'u_1', email: 'person@example.test' }));
  await broker.registerHandle('user-owned:unlisted', 'no cleanup step names this handle', userScope('u_1'));
  const record = await close();
  expect(record.state).toBe('closed');
  expect(record.items.every(item => !item.decision)).toBe(true);
  expect(record.items.some(item => item.id === `organization:${org.id}`)).toBe(true);
  expect(record.scope.taskIds).toContain(task.id);
  expect(await store.getTask(task.id)).toEqual({ ...before, subscribers: [] });
  expect(await store.getProject(project.id)).toBeDefined();
  expect((await store.policyAcceptances('u_1'))[0]?.email).toBe('person@example.test');
  expect(await store.organizationMembership(org.id, 'u_1')).toBeUndefined();
  expect(await store.organizationMembership(org.id, 'uX1')).toBeDefined();
  expect(await store.listPrincipalGrants('user:u_1')).toEqual([]);
  expect(await store.listPrincipalGrants('user:uX1')).toHaveLength(1);
  expect((await broker.listHandles()).some(h => h.includes(':u_1:'))).toBe(false);
  expect(await broker.hasHandle('github-app:user:uX1:account:9:authorization')).toBe(true);
  // SS-1: the user's data key is destroyed too, and with it anything left under it.
  expect(await broker.hasHandle('user-owned:unlisted')).toBe(false);
  expect(fs.existsSync(path.join(dir, 'vault', 'keys', `${crypto.createHash('sha256').update('user:u_1').digest('hex')}.json`))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'vault', 'keys', `${crypto.createHash('sha256').update('user:uX1').digest('hex')}.json`))).toBe(true);
  expect(await store.kvGet('github-app:user:u_1:accounts')).toBeUndefined();
  expect(await store.kvGet('github-app:user:uX1:accounts')).toBeDefined();
  expect(await store.kvGet(`hosted:onboarding:u_1:${org.id}`)).toBeUndefined();
  expect(await store.kvGet(`hosted:onboarding:uX1:${org.id}`)).toBeDefined();
  expect(await tokens.verify(human.token)).toBeUndefined();
  expect(await tokens.verify(agent.token)).toBeUndefined();
  expect(await tokens.verify(other.token)).toBeDefined();
  expect((await service.list()).requests).toEqual([]);
  expect(JSON.stringify(record)).not.toContain('person@example.test');
  expect(identity.removeUser).toHaveBeenCalledWith('u_1');
  await expect(store.setOrganizationMembership(org.id, 'u_1', 'member')).rejects.toThrow('closed');
  await expect(store.setPrincipalGrant('user:u_1', 'global', {})).rejects.toThrow('closed');
  expect((await close()).closedAt).toBe(record.closedAt);
});

it('keeps access fenced during failure and resumes idempotently with persisted progress', async () => {
  const { store, identity, broker, dir, tokens, service, close } = await fixture();
  const human = await tokens.mintPrincipal('user:u_1', ['*']);
  const failure = vi.spyOn(broker, 'deleteHandle').mockImplementationOnce(() => { throw new Error('fixture-vault-outage'); });
  await broker.registerHandle('github-app:user:u_1:authorization', 'fixture', userScope('u_1'));
  await expect(close()).rejects.toThrow('cleanup is incomplete');
  expect(await tokens.verify(human.token)).toBeUndefined();
  expect(identity.removeUser).not.toHaveBeenCalled();
  expect((await service.get('u_1'))).toMatchObject({ state: 'closing', retryRequired: true });
  failure.mockRestore();
  // A new service has no in-memory progress. Recovery reads the durable manifest.
  const restarted = new AccountErasureService(store, identity, broker, dir);
  expect((await restarted.close('u_1', { confirmation: 'CLOSE u_1', exportHandled: true }, 'user:admin')).state).toBe('closed');
  expect(await broker.hasHandle('github-app:user:u_1:authorization')).toBe(false);
  expect((await restarted.get('u_1'))?.steps).toEqual(['access-and-preferences', 'personal-credentials', 'identity']);
});

it('removes the departing owner atomically with the fence, even when credential cleanup fails', async () => {
  const { store, broker, close } = await fixture();
  const org = await store.createOrganization({ name: 'Two owners', ownerUserId: 'u_1' });
  await store.setOrganizationMembership(org.id, 'admin', 'owner');
  await broker.registerHandle('github-app:user:u_1:authorization', 'fixture', userScope('u_1'));
  vi.spyOn(broker, 'deleteHandle').mockImplementationOnce(() => { throw new Error('outage'); });
  await expect(close()).rejects.toThrow('cleanup is incomplete');
  expect(await store.kvGet(closedAccountKey('u_1'))).toBeDefined();
  expect(await store.organizationMembership(org.id, 'u_1')).toBeUndefined();
  await expect(store.removeOrganizationMembership(org.id, 'admin')).rejects.toThrow('at least one owner');
});

it('rejects delayed GitHub grants and refreshes after closure without affecting the installation key', async () => {
  const { store, broker, close } = await fixture();
  await broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'fixture-installation-secret', INSTALLATION_SCOPE);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const github = await GitHubAppService.create(store, broker, { clientId: 'fixture', fetch: (async () => {
    entered(); await pending;
    return Response.json({ id: 42, login: 'fixture-user' });
  }) as typeof fetch });
  const adopt = github.adoptUserAuthorization('u_1', '42', { accessToken: 'fixture-oauth' });
  const rejection = expect(adopt).rejects.toThrow('closed');
  await started;
  await close();
  release();
  await rejection;
  expect(await broker.hasHandle('github-app:user:u_1:account:42:authorization')).toBe(false);
  expect(await broker.hasHandle(GITHUB_APP_CLIENT_SECRET_HANDLE)).toBe(true);
  await expect(github.userAccessToken('u_1')).rejects.toThrow('closed');
});

it('denies verification and delegation across authority instances after a durable closure fence', async () => {
  const { store, tokens } = await fixture();
  const human = await tokens.mintPrincipal('user:u_1', ['*']);
  const delegated = await tokens.delegateHuman(human.token, { taskId: 'task-fixture' });
  await store.kvSet(closedAccountKey('u_1'), '{}');
  expect(await tokens.verify(human.token)).toBeUndefined();
  expect(await new TokenAuthority(store).verify(human.token)).toBeUndefined();
  await expect(tokens.deriveHumanDelegation(delegated!.id, { taskId: 'child' })).rejects.toThrow('invalid');
});

it('cannot declare completion with unreviewed items, stale decisions or undated retention', async () => {
  const { service, close } = await fixture();
  let record = await close();
  const finish = () => service.complete('u_1', record.revision, 'REVIEWED u_1', 'user:admin');
  await expect(finish()).rejects.toThrow('Every review item');
  const decide = (patch: any) => service.decide('u_1', { revision: record.revision, itemId: 'legal-records', outcome: 'retained',
    evidence: 'Keep scoped invoice references for the documented statutory period.', ...patch }, 'user:admin');
  await expect(decide({})).rejects.toThrow('future');
  await expect(decide({ reviewAt: Date.now() - 1 })).rejects.toThrow('future');
  await expect(decide({ reviewAt: Date.now() + 86_400_000, revision: -1 })).rejects.toThrow('Case changed');
  for (const item of record.items) {
    record = await service.decide('u_1', { revision: record.revision, itemId: item.id, outcome: 'retained',
      evidence: `Fixture review of ${item.id}; scoped reason and evidence reference #123.`, reviewAt: Date.now() + 86_400_000 }, 'user:admin');
  }
  expect((await finish()).state).toBe('review-complete');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86_400_000);
  record = (await service.get('u_1'))!;
  await expect(finish()).rejects.toThrow('overdue');
});

it('protects HTTP inventory, closure and case export with unscoped installation authority', async () => {
  const { store, broker, tokens, identity } = await fixture();
  const gateway = await Gateway.create({ store, broker, tokens, identity: { ...identity,
    connectOrganizationNames: () => {}, session: async () => null } as any,
    authorization: await AuthorizationService.create(store), api: {} as any, client: {} as any,
    worlds: new WorldRegistry(), bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), taskQueue: 'test', staticDir: path.resolve('web'), agentInfo: { provider: 'mock', reason: 'fixture' } });
  const server = await gateway.listen(await findFreePortFrom(48990));
  cleanup.push(() => server.close());
  const admin = (await tokens.mintPrincipal('user:admin', ['user:read', 'user:write'])).token;
  const reader = (await tokens.mintPrincipal('user:uX1', ['user:read'])).token;
  const scoped = (await tokens.mint({ taskId: 'fixture', profileId: 'god', principal: 'system:fixture', ceiling: ['*'], grantorCaps: ['*'], organizationId: 'org_personal' })).token;
  const request = (token: string, suffix = '/u_1/erasure', body?: any, method?: string) => fetch(`${server.url}/api/users${suffix}`, {
    method: method ?? (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  expect((await request(reader)).status).toBe(403);
  expect((await request(scoped)).status).toBe(403);
  expect((await request(admin, '/u_1', undefined, 'DELETE')).status).toBe(409);
  const preview = await (await request(admin)).json() as any;
  expect((await request(admin, '/admin/erasure', { action: 'close', confirmation: 'CLOSE admin', exportHandled: true })).status).toBe(400);
  expect((await request(admin, '/u_1/erasure', { action: 'close', fingerprint: preview.fingerprint, confirmation: 'CLOSE u_1', exportHandled: true })).status).toBe(200);
  expect((await request(reader, '/u_1/erasure/export')).status).toBe(403);
  const exported = await request(admin, '/u_1/erasure/export');
  expect(exported.status).toBe(200);
  expect(await exported.json()).toMatchObject({ format: 'karmax-erasure-suppression', case: { state: 'closed' } });
  const cases = await (await request(admin, '/erasure-cases')).json() as any;
  expect(cases.cases).toHaveLength(1);
});

// CI-38i: the paths the suite above leaves out.

it('refuses malformed ids and unknown users before reading anything', async () => {
  const { service } = await fixture();
  for (const id of ['../u_1', 'u 1', '', 'a:b'])
    await expect(service.preview(id)).rejects.toMatchObject({ message: 'invalid user id', status: 400 });
  await expect(service.preview('nobody')).rejects.toMatchObject({ message: 'user not found', status: 404 });
});

it('keeps a continuing installation administrator', async () => {
  const { service, store, identity } = await fixture();
  const closeAdmin = async () => service.close('admin', { fingerprint: (await service.preview('admin')).fingerprint,
    confirmation: 'CLOSE admin', exportHandled: true }, 'user:admin');
  await expect(closeAdmin()).rejects.toThrow('Create another installation administrator');
  // A second administrator whose own account is already closed does not count.
  const users = await identity.listUsers();
  users.push({ id: 'admin2', name: 'Second', email: 'second@example.test', role: 'admin', createdAt: new Date() });
  await store.kvSet(closedAccountKey('admin2'), '{}');
  expect((await service.preview('admin')).blockers).toContain('Create another installation administrator before closing the last administrator.');
  await store.kvDelete(closedAccountKey('admin2'));
  expect((await closeAdmin()).state).toBe('closed');
  expect(identity.removeUser).toHaveBeenCalledWith('admin');
});

it('blocks closure on live work linked only by subscription, a vote or a delegation', async () => {
  const { store, service, close } = await fixture();
  const org = await store.createOrganization({ name: 'Links', ownerUserId: 'admin' });
  await store.setOrganizationMembership(org.id, 'u_1', 'member');
  await store.setOrganizationMembership(org.id, 'uX1', 'member');
  const project = await store.createProject('Linked', {}, org.id);
  const task = (title: string) => store.createTask({ projectId: project.id, title, workflow: 'just-do', workflowVersion: '1',
    params: { prompt: 'fixture' }, createdBy: { kind: 'user', userId: 'uX1' } });
  const subscribed = await task('Subscribed');
  const voted = await task('Voted');
  const delegated = await task('Delegated');
  const unrelated = await task('Unrelated');
  await store.subscribeTask(subscribed.id, { kind: 'user', userId: 'u_1' });
  await store.db.prepare('INSERT INTO confirmation_votes (taskId, cycle, userId, votedAt) VALUES (?,?,?,?)').run(voted.id, 1, 'u_1', Date.now());
  const tokens = new TokenAuthority(store);
  await tokens.delegateHuman((await tokens.mintPrincipal('user:u_1', ['*'])).token, { taskId: delegated.id, projectId: project.id });
  const preview = await service.preview('u_1');
  expect(preview.relatedTaskIds).toEqual([subscribed.id, voted.id, delegated.id].sort());
  expect(preview.relatedTaskIds).not.toContain(unrelated.id);
  expect(preview.organizations).toEqual([{ id: org.id, kind: 'team', role: 'member' }]);
  await expect(close()).rejects.toThrow(`Resolve linked nonterminal tasks before closure: ${preview.activeTasks.join(', ')}`);
  for (const { id } of [subscribed, voted, delegated])
    await store.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ status: 'cancelled' }), id);
  const record = await close();
  // The linked organization still gets its own review item.
  expect(record.items.map((item) => item.id)).toContain(`organization:${org.id}`);
  expect(await store.getTask(unrelated.id)).toBeDefined();
});

it('fences the account but will not report it closed without the credential broker', async () => {
  const { store, identity, broker, dir, tokens } = await fixture();
  const human = await tokens.mintPrincipal('user:u_1', ['*']);
  const brokerless = new AccountErasureService(store, identity, undefined, dir);
  const preview = await brokerless.preview('u_1');
  const error = await brokerless.close('u_1', { fingerprint: preview.fingerprint, confirmation: 'CLOSE u_1', exportHandled: true }, 'user:admin')
    .catch((e) => e);
  expect(error).toMatchObject({ status: 503, message: expect.stringContaining('cleanup is incomplete at personal-credentials') });
  expect(await brokerless.get('u_1')).toMatchObject({ state: 'closing', retryRequired: true, failedStep: 'personal-credentials',
    steps: ['access-and-preferences'] });
  expect(await tokens.verify(human.token)).toBeUndefined();
  expect(identity.removeUser).not.toHaveBeenCalled();
  const record = await new AccountErasureService(store, identity, broker, dir).close('u_1', { confirmation: 'CLOSE u_1', exportHandled: true }, 'user:admin');
  expect(record).toMatchObject({ state: 'closed', retryRequired: false });
  expect(record.failedStep).toBeUndefined();
});

it('requires both confirmations', async () => {
  const { service } = await fixture();
  const { fingerprint } = await service.preview('u_1');
  for (const input of [{ fingerprint, confirmation: 'CLOSE u_1' }, { fingerprint, confirmation: 'close u_1', exportHandled: true },
    { fingerprint, confirmation: 'CLOSE u_1', exportHandled: 'yes' as any }])
    await expect(service.close('u_1', input, 'user:admin')).rejects.toMatchObject({ status: 400 });
  expect(await service.get('u_1')).toBeUndefined();
});

it('validates every review decision and reopens a completed review when one changes', async () => {
  const { service, close } = await fixture();
  await expect(service.decide('u_1', { revision: 1, itemId: 'response', outcome: 'erased', evidence: 'x'.repeat(20) }, 'user:admin'))
    .rejects.toThrow('Close the account successfully');
  let record = await close();
  const decide = (patch: Record<string, unknown>) => service.decide('u_1', { revision: record.revision, itemId: 'response',
    outcome: 'not-applicable', evidence: 'Response sent through the ticket system, ref 42.', ...patch } as any, 'user:admin');
  for (const patch of [{ outcome: 'deleted' }, { evidence: '   short evidence   ' }, { evidence: 'x'.repeat(4001) }, { evidence: 42 }])
    await expect(decide(patch)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('20–4000 characters') });
  await expect(decide({ itemId: 'backups', outcome: 'erased' })).rejects.toThrow('future review/expiry date');
  await expect(decide({ reviewAt: Date.now() + 1.5 })).rejects.toThrow('reviewAt must be a future epoch-millisecond date');
  await expect(decide({ itemId: 'no-such-item' })).rejects.toMatchObject({ status: 400, message: 'Unknown review item' });
  record = await decide({ evidence: '  Response sent through the ticket system, ref 42.  ' });
  expect(record.items.find((item) => item.id === 'response')!.decision).toMatchObject({ outcome: 'not-applicable',
    evidence: 'Response sent through the ticket system, ref 42.', by: 'user:admin' });
  expect(record.items.find((item) => item.id === 'response')!.decision!.reviewAt).toBeUndefined();

  const complete = (confirmation = 'REVIEWED u_1', revision = record.revision) => service.complete('u_1', revision, confirmation, 'user:admin');
  for (const item of record.items.filter((item) => !item.decision))
    record = await service.decide('u_1', { revision: record.revision, itemId: item.id, outcome: 'erased',
      evidence: `Removed per runbook step for ${item.id}.`, reviewAt: Date.now() + 86_400_000 }, 'user:admin');
  await expect(complete('REVIEWED uX1')).rejects.toMatchObject({ status: 400 });
  await expect(complete(undefined, record.revision - 1)).rejects.toThrow('Case changed');
  record = await complete();
  expect(record).toMatchObject({ state: 'review-complete', reviewedAt: expect.any(Number) });
  // Revising a decision afterwards reopens the review rather than leaving a stale completion.
  record = await decide({ outcome: 'redacted', evidence: 'Redacted the reply draft after re-review, ref 43.' });
  expect(record.state).toBe('closed');
  expect(record.reviewedAt).toBeUndefined();
});

it('does not let a slow concurrent retry undo a later review', async () => {
  const { store, identity, broker, dir, close } = await fixture();
  vi.spyOn(broker, 'deleteHandle').mockImplementationOnce(() => { throw new Error('outage'); });
  await broker.registerHandle('github-app:user:u_1:authorization', 'fixture', userScope('u_1'));
  await expect(close()).rejects.toThrow('cleanup is incomplete');
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  identity.removeUser.mockImplementationOnce(async () => { entered(); await held; });
  const retry = () => new AccountErasureService(store, identity, broker, dir).close('u_1', { confirmation: 'CLOSE u_1', exportHandled: true }, 'user:admin');
  const slow = retry();
  await inside;
  const fast = await retry();
  expect(fast.state).toBe('closed');
  const service = new AccountErasureService(store, identity, broker, dir);
  let reviewed = fast;
  for (const item of fast.items)
    reviewed = await service.decide('u_1', { revision: reviewed.revision, itemId: item.id, outcome: 'erased',
      evidence: `Removed per runbook step for ${item.id}.`, reviewAt: Date.now() + 86_400_000 }, 'user:admin');
  reviewed = await service.complete('u_1', reviewed.revision, 'REVIEWED u_1', 'user:admin');
  release();
  const late = await slow;
  expect(late).toMatchObject({ state: 'review-complete', closedAt: fast.closedAt, reviewedAt: reviewed.reviewedAt });
  expect(late.items).toEqual(reviewed.items);
  expect((await service.get('u_1'))!.steps).toEqual(['access-and-preferences', 'personal-credentials', 'identity']);
});
