import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { GitHubAppService, GITHUB_APP_CLIENT_SECRET_HANDLE, GITHUB_APP_PRIVATE_KEY_HANDLE,
  type GitHubRepositoryRole } from '../src/integrations/github-app.js';
import { WikiGithubAccess } from '../src/wiki/github-access.js';
import { RepositoryAccessRequests } from '../src/integrations/repository-access.js';

/**
 * A project wiki repository lives in the account of whoever installed the App
 * (andhbhakt.com #8, video-explainers #4: `srajma/…-wiki-…`). Members must reach
 * it on GitHub as they reach the wiki in tavya, at once and without anyone
 * clicking an invitation, and lose it when they lose access in tavya.
 */

const OWNER = 'srajma';
const WIKI = 'andhbhakt.org-wiki-97aac911';

/** GitHub's collaborator and invitation API for one personal repository. */
function fakeGithub(name = WIKI) {
  const collaborators = new Map<string, GitHubRepositoryRole>([[OWNER, 'admin']]);
  const invitations = new Map<number, { login: string; role: GitHubRepositoryRole; expired?: boolean }>();
  const calls: string[] = [];
  const tokenUsers: Record<string, string> = {};
  const refuseAccept = new Set<string>();
  let nextInvitation = 900;
  const invitationName: Record<GitHubRepositoryRole, string> = { pull: 'read', triage: 'triage', push: 'write', maintain: 'maintain', admin: 'admin' };
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const auth = String((init.headers as Record<string, string> | undefined)?.authorization ?? '').replace(/^Bearer /, '');
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/login/oauth/access_token') {
      const code = new URLSearchParams(String(init.body)).get('code')!;
      return Response.json({ access_token: `token-${code}` });
    }
    if (url.pathname === '/user') {
      const login = auth.replace(/^token-/, '');
      tokenUsers[auth] = login;
      return Response.json({ id: 1000 + login.length, login });
    }
    if (url.pathname === '/app/installations/42/access_tokens')
      return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    const repo = `/repos/${OWNER}/${name}`;
    if (url.pathname.startsWith(repo) && auth !== 'installation-token') return Response.json({ message: 'Not Found' }, { status: 404 });
    if (url.pathname === `${repo}/collaborators` && method === 'GET')
      return Response.json(url.searchParams.get('page') === '1' ? [...collaborators].map(([login, role]) => ({ login,
        permissions: Object.fromEntries(['pull', 'triage', 'push', 'maintain', 'admin'].map((name, index) =>
          [name, index <= ['pull', 'triage', 'push', 'maintain', 'admin'].indexOf(role)])) })) : []);
    if (url.pathname === `${repo}/invitations` && method === 'GET')
      return Response.json(url.searchParams.get('page') === '1' ? [...invitations].map(([id, invitation]) =>
        ({ id, invitee: { login: invitation.login }, permissions: invitationName[invitation.role] })) : []);
    const collaborator = url.pathname.match(new RegExp(`^${repo}/collaborators/([^/]+)$`));
    if (collaborator && method === 'PUT') {
      const login = decodeURIComponent(collaborator[1]!);
      const role = JSON.parse(String(init.body)).permission as GitHubRepositoryRole;
      if (login === OWNER) return Response.json({ message: 'Repository owner cannot be a collaborator' }, { status: 422 });
      if (collaborators.has(login)) { collaborators.set(login, role); return new Response(null, { status: 204 }); }
      const id = nextInvitation++;
      invitations.set(id, { login, role });
      return Response.json({ id, permissions: invitationName[role] }, { status: 201 });
    }
    if (collaborator && method === 'DELETE') {
      collaborators.delete(decodeURIComponent(collaborator[1]!));
      return new Response(null, { status: 204 });
    }
    const invitation = url.pathname.match(new RegExp(`^${repo}/invitations/(\\d+)$`));
    if (invitation && method === 'DELETE') {
      invitations.delete(Number(invitation[1]));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/user/repository_invitations' && method === 'GET')
      return Response.json(url.searchParams.get('page') === '1' ? [...invitations]
        .filter(([, pending]) => pending.login === tokenUsers[auth])
        .map(([id, pending]) => ({ id, expired: !!pending.expired, repository: { full_name: `${OWNER}/${name}` } })) : []);
    const accept = url.pathname.match(/^\/user\/repository_invitations\/(\d+)$/);
    if (accept && method === 'PATCH') {
      const pending = invitations.get(Number(accept[1]));
      const login = tokenUsers[auth];
      if (!pending || pending.login !== login || refuseAccept.has(login))
        return Response.json({ message: 'Not Found' }, { status: 404 });
      invitations.delete(Number(accept[1]));
      collaborators.set(login, pending.role);
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }) as typeof fetch;
  return { fetcher, collaborators, invitations, calls, refuseAccept };
}

describe('GitHub access to project wiki repositories follows access in tavya', () => {
  let dir: string;
  let store: Store;
  let github: ReturnType<typeof fakeGithub>;
  let app: GitHubAppService;
  let authorization: AuthorizationService;
  let access: WikiGithubAccess;
  let organizationId: string;
  let projectId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wiki-github-access-'));
    store = await Store.create(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    await broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey, INSTALLATION_SCOPE);
    await broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'client-secret', INSTALLATION_SCOPE);
    github = fakeGithub();
    app = await GitHubAppService.create(store, broker, { appId: '123', clientId: 'Iv1.client', fetch: github.fetcher });
    authorization = await AuthorizationService.create(store);
    const organization = await store.createOrganization({ name: 'andhbhakt', ownerUserId: 'owner' });
    organizationId = organization.id;
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organizationId);
    const project = await store.createProject('andhbhakt.com', {}, organizationId);
    projectId = project.id;
    const connection = await store.upsertGitConnection({ organizationId, provider: 'github',
      installationId: '42', accountLogin: OWNER, accountType: 'User' });
    const wiki = await store.upsertRepository({ organizationId, provider: 'github', providerId: '1423140283',
      owner: OWNER, name: WIKI, sshUrl: `git@github.com:${OWNER}/${WIKI}.git`, defaultBranch: 'main', private: true,
      gitConnectionId: connection.id });
    await store.setProjectWikiRepository(projectId, wiki.id);
    await app.authorizeUser('owner', OWNER);
    access = new WikiGithubAccess({ store, githubApp: app, authorization, debounceMs: 0 });
  });

  afterEach(async () => {
    access.stop();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function join(userId: string, login: string, level: 'developer' | 'viewer') {
    await store.setOrganizationMembership(organizationId, userId, 'member');
    await authorization.replacePrincipalAuthorization('user:owner', `user:${userId}`, organizationId, { level, scope: 'organization' });
    await app.authorizeUser(userId, login);
  }

  it('makes a member who can edit the wiki a collaborator with push, accepting the invitation as them', async () => {
    await join('member', 'dharmaarthamaxxer-damx', 'developer');

    const outcomes = await access.syncProject(projectId);

    expect(outcomes).toContainEqual({ userId: 'member', login: 'dharmaarthamaxxer-damx', state: 'member' });
    expect(outcomes).toContainEqual({ userId: 'owner', login: OWNER, state: 'owner' });
    expect(github.collaborators.get('dharmaarthamaxxer-damx')).toBe('push');
    expect(github.invitations.size).toBe(0);
    // The owner is never invited to their own repository.
    expect(github.calls).not.toContain(`PUT /repos/${OWNER}/${WIKI}/collaborators/${OWNER}`);
    // A second sync changes nothing.
    const before = github.calls.length;
    await access.syncProject(projectId);
    expect(github.calls.slice(before).filter((call) => !call.startsWith('GET'))).toEqual([]);
  });

  it('gives read-only members pull, and changes the role when theirs changes in tavya', async () => {
    await join('reader', 'quiet-reader', 'viewer');
    await access.syncProject(projectId);
    expect(github.collaborators.get('quiet-reader')).toBe('pull');

    await authorization.replacePrincipalAuthorization('user:owner', 'user:reader', organizationId, { level: 'developer', scope: 'organization' });
    await access.syncProject(projectId);
    expect(github.collaborators.get('quiet-reader')).toBe('push');
  });

  it('takes back only the access it gave when a member leaves', async () => {
    await join('member', 'dharmaarthamaxxer-damx', 'developer');
    await join('pending', 'slow-to-accept', 'developer');
    github.refuseAccept.add('slow-to-accept');
    // Added by hand on GitHub: not tavya's to remove, nor to lower.
    github.collaborators.set('friend', 'admin');
    await join('friendly', 'friend', 'developer');
    const outcomes = await access.syncProject(projectId);
    expect(outcomes).toContainEqual(expect.objectContaining({ login: 'slow-to-accept', state: 'invited' }));
    expect([...github.invitations.values()]).toEqual([{ login: 'slow-to-accept', role: 'push' }]);

    for (const userId of ['member', 'pending', 'friendly']) await store.deprovisionOrganizationUser(organizationId, userId);
    await access.syncProject(projectId);

    expect(github.collaborators.has('dharmaarthamaxxer-damx')).toBe(false);
    expect(github.invitations.size).toBe(0);
    expect(github.collaborators.get('friend')).toBe('admin');
    expect(github.collaborators.get(OWNER)).toBe('admin');
    expect(await access.grants('missing')).toEqual({});
  });

  it('restores the role it raised instead of removing someone added by hand', async () => {
    github.collaborators.set('helper', 'pull');
    await join('helper', 'helper', 'developer');
    await access.syncProject(projectId);
    expect(github.collaborators.get('helper')).toBe('push');

    await store.deprovisionOrganizationUser(organizationId, 'helper');
    await access.syncProject(projectId);
    expect(github.collaborators.get('helper')).toBe('pull');
  });

  it('grants a new member at once, following membership changes and newly linked GitHub accounts', async () => {
    const stop = access.watch(app);
    await store.setOrganizationMembership(organizationId, 'member', 'member');
    await authorization.replacePrincipalAuthorization('user:owner', 'user:member', organizationId, { level: 'developer', scope: 'organization' });
    // Not linked to GitHub yet: nothing to grant.
    await expect.poll(() => github.calls.filter((call) => call.startsWith('PUT')).length, { timeout: 2_000 }).toBe(0);

    await app.authorizeUser('member', 'dharmaarthamaxxer-damx');
    await expect.poll(() => github.collaborators.get('dharmaarthamaxxer-damx'), { timeout: 5_000 }).toBe('push');

    await store.deprovisionOrganizationUser(organizationId, 'member');
    await expect.poll(() => github.collaborators.has('dharmaarthamaxxer-damx'), { timeout: 5_000 }).toBe(false);
    stop();
  });

  it('accepts a pending invitation to a repository as the invited person', async () => {
    await join('member', 'dharmaarthamaxxer-damx', 'developer');
    // Invited on GitHub by hand (video-explainers #4), never accepted.
    github.invitations.set(77, { login: 'dharmaarthamaxxer-damx', role: 'push' });
    const account = (await app.listUserAccounts('member'))[0]!;

    await expect(app.acceptPendingRepositoryInvitation('member', account.id, `${OWNER}/elsewhere`)).resolves.toBe(false);
    github.invitations.set(77, { login: 'dharmaarthamaxxer-damx', role: 'push', expired: true });
    await expect(app.acceptPendingRepositoryInvitation('member', account.id, `${OWNER}/${WIKI}`)).resolves.toBe(false);
    github.invitations.set(77, { login: 'dharmaarthamaxxer-damx', role: 'push' });
    await expect(app.acceptPendingRepositoryInvitation('member', account.id, `${OWNER}/${WIKI.toUpperCase()}`)).resolves.toBe(true);
    expect(github.collaborators.get('dharmaarthamaxxer-damx')).toBe('push');
    expect(github.invitations.size).toBe(0);
  });

  it('grants only the person asked for, without taking anyone else\'s access', async () => {
    await join('member', 'dharmaarthamaxxer-damx', 'developer');
    await join('other', 'someone-else', 'developer');
    await access.syncProject(projectId);
    await store.deprovisionOrganizationUser(organizationId, 'other');
    github.collaborators.delete('dharmaarthamaxxer-damx');

    await expect(access.syncProject(projectId, 'member')).resolves.toEqual([
      { userId: 'member', login: 'dharmaarthamaxxer-damx', state: 'member' },
    ]);
    expect(github.collaborators.get('someone-else')).toBe('push');
  });
});

/** A task's creator cannot see one of the project's own repositories
 *  (video-explainers #4: srajma/dam-videos). Its GitHub admins decide. */
describe('Asking a repository\'s GitHub admins for access', () => {
  const REPO = 'dam-videos';
  let dir: string;
  let store: Store;
  let github: ReturnType<typeof fakeGithub>;
  let app: GitHubAppService;
  let requests: RepositoryAccessRequests;
  let retried: string[];
  let organizationId: string;
  let taskId: string;
  let repository: Awaited<ReturnType<Store['upsertRepository']>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repository-access-'));
    store = await Store.create(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    await broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey, INSTALLATION_SCOPE);
    await broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'client-secret', INSTALLATION_SCOPE);
    github = fakeGithub(REPO);
    app = await GitHubAppService.create(store, broker, { appId: '123', clientId: 'Iv1.client', fetch: github.fetcher });
    const organization = await store.createOrganization({ name: 'andhbhakt', ownerUserId: 'owner' });
    organizationId = organization.id;
    for (const userId of ['member', 'maintainer']) await store.setOrganizationMembership(organizationId, userId, 'member');
    const project = await store.createProject('Video - Explainers', {}, organizationId);
    const connection = await store.upsertGitConnection({ organizationId, provider: 'github',
      installationId: '42', accountLogin: OWNER, accountType: 'User' });
    repository = await store.upsertRepository({ organizationId, provider: 'github', providerId: '1424186356',
      owner: OWNER, name: REPO, sshUrl: `git@github.com:${OWNER}/${REPO}.git`, defaultBranch: 'main', private: true,
      gitConnectionId: connection.id });
    taskId = (await store.createTask({ projectId: project.id, title: 'Premium documentary', workflow: 'software-dev',
      workflowVersion: '1.21.0', params: { prompt: 'x' }, createdBy: { kind: 'user', userId: 'member' } })).id;
    await app.authorizeUser('owner', OWNER);
    await app.authorizeUser('member', 'dharmaarthamaxxer-damx');
    // A tavya maintainer whose GitHub account has no say over the repository.
    await app.authorizeUser('maintainer', 'tavya-maintainer');
    retried = [];
    requests = new RepositoryAccessRequests({ store, githubApp: app, retry: async (id) => { retried.push(id); } });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function ask() {
    const account = (await app.listUserAccounts('member'))[0]!;
    return requests.request({ taskId, repository, userId: 'member', accountId: account.id, login: account.login });
  }

  it('asks only the repository\'s GitHub admins, once', async () => {
    const request = await ask();
    expect(request).toMatchObject({ slug: `${OWNER}/${REPO}`, login: 'dharmaarthamaxxer-damx', status: 'pending',
      approvers: [{ userId: 'owner', login: OWNER }], recipients: ['owner'] });
    expect((await ask())!.id).toBe(request!.id);
    expect(await store.listInbox('owner', organizationId)).toContainEqual(expect.objectContaining({
      taskId, kind: 'approval-requested', actionable: true }));
    expect(await store.listInbox('maintainer', organizationId)).toEqual([]);
  });

  it('gives access at once when an admin approves, and retries the task', async () => {
    const request = (await ask())!;
    await expect(requests.resolve({ organizationId, requestId: request.id, userId: 'maintainer', action: 'approve' }))
      .rejects.toMatchObject({ status: 403 });

    await expect(requests.resolve({ organizationId, requestId: request.id, userId: 'owner', action: 'approve' }))
      .resolves.toMatchObject({ status: 'granted', retried: true });
    expect(github.collaborators.get('dharmaarthamaxxer-damx')).toBe('push');
    expect(github.invitations.size).toBe(0);
    expect(retried).toEqual([taskId]);
    expect((await store.listInbox('owner', organizationId)).filter((item) => item.kind === 'approval-requested')).toEqual([]);
    await expect(requests.resolve({ organizationId, requestId: request.id, userId: 'owner', action: 'deny' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('checks the approver is still an admin on GitHub when they decide', async () => {
    const request = (await ask())!;
    github.collaborators.set(OWNER, 'push');
    await expect(requests.resolve({ organizationId, requestId: request.id, userId: 'owner', action: 'approve' }))
      .rejects.toThrow(`Only an admin of ${OWNER}/${REPO} on GitHub can give access to it`);
    expect(github.collaborators.has('dharmaarthamaxxer-damx')).toBe(false);
    expect((await requests.requests(organizationId, { taskId }))[0]).toMatchObject({ status: 'pending' });
  });

  it('records a denial without touching GitHub or the task', async () => {
    const request = (await ask())!;
    await expect(requests.resolve({ organizationId, requestId: request.id, userId: 'owner', action: 'deny' }))
      .resolves.toMatchObject({ status: 'denied', retried: false });
    expect(github.calls.filter((call) => call.startsWith('PUT'))).toEqual([]);
    expect(retried).toEqual([]);
  });

  it('asks nobody when no admin of the repository is in the organization', async () => {
    github.collaborators.clear();
    github.collaborators.set('someone-outside', 'admin');
    await expect(ask()).resolves.toBeUndefined();
  });
});
