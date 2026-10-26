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
import { ProjectGithubAccess } from '../src/integrations/project-github-access.js';
import { WikiGithubAccess } from '../src/wiki/github-access.js';

/**
 * Every person with access to a project reaches every GitHub repository
 * attached to it, at once and without anyone clicking an invitation: a member
 * who was never invited by hand otherwise cannot open their task's pull
 * request (GitHub answers 404). They lose only what tavya gave when they no
 * longer qualify through any project that uses the repository.
 */

const OWNER = 'srajma';
const CODE = 'dam-videos';
const WIKI = 'andhbhakt.org-wiki-97aac911';
const OTHER = 'dam-shorts';

/** GitHub's collaborator and invitation API for several repositories of one
 * account, personal unless `personal` is turned off. Modelled on what
 * tavya.io's GitHub answered (see tests/wiki-github-access.test.ts). */
function fakeGithub(names: string[]) {
  const state = { personal: true };
  const repos = new Map(names.map((name) => [name, {
    collaborators: new Map<string, GitHubRepositoryRole>([[OWNER, 'admin']]),
    invitations: new Map<number, { login: string; role: GitHubRepositoryRole; expired?: boolean }>(),
  }]));
  const calls: string[] = [];
  const tokenUsers: Record<string, string> = {};
  let nextInvitation = 900;
  const invitationName: Record<GitHubRepositoryRole, string> = { pull: 'read', triage: 'triage', push: 'write', maintain: 'maintain', admin: 'admin' };
  const roles = ['pull', 'triage', 'push', 'maintain', 'admin'];
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
    const accept = url.pathname.match(/^\/user\/repository_invitations\/(\d+)$/);
    if (accept && method === 'PATCH') {
      const login = tokenUsers[auth];
      for (const repo of repos.values()) {
        const pending = repo.invitations.get(Number(accept[1]));
        if (!pending || pending.login !== login) continue;
        repo.invitations.delete(Number(accept[1]));
        repo.collaborators.set(login, pending.role);
        return new Response(null, { status: 204 });
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }
    const match = url.pathname.match(new RegExp(`^/repos/${OWNER}/([^/]+)(/.*)?$`));
    const repo = match ? repos.get(match[1]!) : undefined;
    if (!match || !repo || auth !== 'installation-token') return Response.json({ message: 'Not Found' }, { status: 404 });
    const rest = match[2] ?? '';
    if (rest === '/collaborators' && method === 'GET')
      return Response.json(url.searchParams.get('page') === '1' ? [...repo.collaborators].map(([login, role]) => ({ login,
        permissions: Object.fromEntries(roles.map((name, index) => [name, index <= roles.indexOf(role)])) })) : []);
    if (rest === '/invitations' && method === 'GET')
      return Response.json(url.searchParams.get('page') === '1' ? [...repo.invitations].map(([id, invitation]) =>
        ({ id, invitee: { login: invitation.login }, permissions: invitationName[invitation.role], expired: !!invitation.expired })) : []);
    const collaborator = rest.match(/^\/collaborators\/([^/]+)$/);
    if (collaborator && method === 'PUT') {
      const login = decodeURIComponent(collaborator[1]!);
      const role = JSON.parse(String(init.body)).permission as GitHubRepositoryRole;
      if (login === OWNER) return Response.json({ message: 'Repository owner cannot be a collaborator' }, { status: 422 });
      if (state.personal && role !== 'push')
        return Response.json({ message: 'Validation Failed', errors: `Cannot assign ${login} permission of ${invitationName[role]}` }, { status: 422 });
      if (repo.collaborators.has(login)) { repo.collaborators.set(login, role); return new Response(null, { status: 204 }); }
      const id = nextInvitation++;
      repo.invitations.set(id, { login, role });
      return Response.json({ id, permissions: invitationName[role] }, { status: 201 });
    }
    if (collaborator && method === 'DELETE') {
      repo.collaborators.delete(decodeURIComponent(collaborator[1]!));
      return new Response(null, { status: 204 });
    }
    const invitation = rest.match(/^\/invitations\/(\d+)$/);
    if (invitation && method === 'DELETE') {
      repo.invitations.delete(Number(invitation[1]));
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }) as typeof fetch;
  const role = (name: string, login: string) => repos.get(name)!.collaborators.get(login);
  return { fetcher, repos, calls, state, role };
}

describe('GitHub access to a project\'s repositories follows access in tavya', () => {
  let dir: string;
  let store: Store;
  let github: ReturnType<typeof fakeGithub>;
  let app: GitHubAppService;
  let authorization: AuthorizationService;
  let access: ProjectGithubAccess;
  let organizationId: string;
  let projectId: string;
  let connectionId: string;
  let code: Awaited<ReturnType<Store['upsertRepository']>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-project-github-access-'));
    store = await Store.create(':memory:');
    const broker = new CredentialBroker(new Vault(dir));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    await broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey, INSTALLATION_SCOPE);
    await broker.registerHandle(GITHUB_APP_CLIENT_SECRET_HANDLE, 'client-secret', INSTALLATION_SCOPE);
    github = fakeGithub([CODE, WIKI, OTHER]);
    app = await GitHubAppService.create(store, broker, { appId: '123', clientId: 'Iv1.client', fetch: github.fetcher });
    authorization = await AuthorizationService.create(store);
    const organization = await store.createOrganization({ name: 'andhbhakt', ownerUserId: 'owner' });
    organizationId = organization.id;
    await authorization.bootstrapOrganizationOwner('system:test', 'owner', organizationId);
    projectId = (await store.createProject('Video - Explainers', {}, organizationId)).id;
    connectionId = (await store.upsertGitConnection({ organizationId, provider: 'github',
      installationId: '42', accountLogin: OWNER, accountType: 'User' })).id;
    code = await enroll(CODE, '1424186356');
    await store.attachProjectRepository({ projectId, repositoryId: code.id });
    await store.setProjectWikiRepository(projectId, (await enroll(WIKI, '1423140283')).id);
    await app.authorizeUser('owner', OWNER);
    access = new ProjectGithubAccess({ store, githubApp: app, authorization, debounceMs: 0 });
  });

  afterEach(async () => {
    access.stop();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function enroll(name: string, providerId: string) {
    return store.upsertRepository({ organizationId, provider: 'github', providerId, owner: OWNER, name,
      sshUrl: `git@github.com:${OWNER}/${name}.git`, defaultBranch: 'main', private: true, gitConnectionId: connectionId });
  }

  async function join(userId: string, login: string, level?: 'developer' | 'viewer') {
    await store.setOrganizationMembership(organizationId, userId, 'member');
    if (level) await authorization.replacePrincipalAuthorization('user:owner', `user:${userId}`, organizationId, { level, scope: 'organization' });
    await app.authorizeUser(userId, login);
  }

  /** An organization's repository has every role; a personal account's has only write. */
  async function ownedByOrganization() {
    github.state.personal = false;
    await store.upsertGitConnection({ organizationId, provider: 'github', installationId: '42', accountLogin: OWNER, accountType: 'Organization' });
  }

  it('keeps the name the wiki used', () => {
    expect(WikiGithubAccess).toBe(ProjectGithubAccess);
  });

  it('gives whoever may run tasks push and readers pull on a code repository, accepting the invitation as them', async () => {
    await ownedByOrganization();
    await join('dev', 'dharmaarthamaxxer-damx', 'developer');
    await join('reader', 'quiet-reader', 'viewer');

    const outcomes = await access.syncProject(projectId);

    expect(outcomes).toContainEqual({ userId: 'dev', login: 'dharmaarthamaxxer-damx', state: 'member' });
    expect(outcomes).toContainEqual({ userId: 'owner', login: OWNER, state: 'owner' });
    expect(github.role(CODE, 'dharmaarthamaxxer-damx')).toBe('push');
    expect(github.role(CODE, 'quiet-reader')).toBe('pull');
    // The wiki keeps its own rule (skill:write → push).
    expect(github.role(WIKI, 'dharmaarthamaxxer-damx')).toBe('push');
    expect(github.repos.get(CODE)!.invitations.size).toBe(0);
    expect(github.calls).not.toContain(`PUT /repos/${OWNER}/${CODE}/collaborators/${OWNER}`);
    expect(github.role(CODE, OWNER)).toBe('admin');
    // A second sync changes nothing.
    const before = github.calls.length;
    await access.syncProject(projectId);
    expect(github.calls.slice(before).filter((call) => !call.startsWith('GET'))).toEqual([]);
  });

  it('gives read-only members nothing on a personal account\'s code repository', async () => {
    await join('dev', 'dharmaarthamaxxer-damx', 'developer');
    await join('reader', 'radnyees', 'viewer');

    expect(await access.syncProject(projectId)).not.toContainEqual(expect.objectContaining({ login: 'radnyees' }));
    expect(github.role(CODE, 'dharmaarthamaxxer-damx')).toBe('push');
    expect(github.role(CODE, 'radnyees')).toBeUndefined();
    expect(github.calls.filter((call) => call.startsWith('PUT') && call.endsWith('/radnyees'))).toEqual([]);

    await authorization.replacePrincipalAuthorization('user:owner', 'user:reader', organizationId, { level: 'developer', scope: 'organization' });
    await access.syncProject(projectId);
    expect(github.role(CODE, 'radnyees')).toBe('push');
  });

  it('takes the strongest role over every project that uses a repository, and keeps it while one still qualifies', async () => {
    await ownedByOrganization();
    const second = (await store.createProject('Video - Shorts', {}, organizationId)).id;
    await store.attachProjectRepository({ projectId: second, repositoryId: code.id });
    await join('pat', 'pat-gh');
    await authorization.grant('user:owner', { principalId: 'user:pat', scopeKey: `project:${projectId}`, profileId: 'developer' });
    await authorization.grant('user:owner', { principalId: 'user:pat', scopeKey: `project:${second}`, profileId: 'viewer' });

    await access.syncProject(second);
    expect(github.role(CODE, 'pat-gh')).toBe('push');

    // Leaving the first project: what the second gives remains.
    await authorization.revoke('user:owner', 'user:pat', `project:${projectId}`);
    await access.syncProject(projectId);
    expect(github.role(CODE, 'pat-gh')).toBe('pull');

    await authorization.revoke('user:owner', 'user:pat', `project:${second}`);
    await access.syncProject(projectId);
    expect(github.role(CODE, 'pat-gh')).toBeUndefined();
    expect(await access.grants(code.id)).toEqual({});
  });

  it('takes back only the access it gave when a repository is detached', async () => {
    await ownedByOrganization();
    await join('dev', 'dharmaarthamaxxer-damx', 'developer');
    // Added by hand on GitHub: not tavya's to remove, nor to lower.
    github.repos.get(CODE)!.collaborators.set('friend', 'admin');
    await join('friendly', 'friend', 'developer');
    // Had read by hand; tavya raised it to write.
    github.repos.get(CODE)!.collaborators.set('helper', 'pull');
    await join('helper', 'helper', 'developer');
    await access.syncProject(projectId);
    expect(github.role(CODE, 'helper')).toBe('push');

    await store.detachProjectRepository(projectId, code.id);
    await access.syncProject(projectId);

    expect(github.role(CODE, 'dharmaarthamaxxer-damx')).toBeUndefined();
    expect(github.role(CODE, 'friend')).toBe('admin');
    expect(github.role(CODE, 'helper')).toBe('pull');
    expect(github.role(CODE, OWNER)).toBe('admin');
    expect(await access.grants(code.id)).toEqual({});
    // The wiki is still the project's.
    expect(github.role(WIKI, 'dharmaarthamaxxer-damx')).toBe('push');
    // Nothing left to take back: later syncs no longer visit it.
    const before = github.calls.length;
    await access.syncProject(projectId);
    expect(github.calls.slice(before).filter((call) => call.includes(`/${CODE}/`))).toEqual([]);
  });

  it('keeps access through another project when one project detaches a shared repository', async () => {
    const second = (await store.createProject('Video - Shorts', {}, organizationId)).id;
    await store.attachProjectRepository({ projectId: second, repositoryId: code.id });
    await join('dev', 'dharmaarthamaxxer-damx', 'developer');
    await access.syncProject(projectId);
    expect(github.role(CODE, 'dharmaarthamaxxer-damx')).toBe('push');

    await store.detachProjectRepository(projectId, code.id);
    await access.syncProject(projectId);
    expect(github.role(CODE, 'dharmaarthamaxxer-damx')).toBe('push');
  });

  it('follows repositories being attached and detached, and projects created with them', async () => {
    await join('dev', 'dharmaarthamaxxer-damx', 'developer');
    const stop = access.watch(app);
    const other = await enroll(OTHER, '1424186357');

    await store.attachProjectRepository({ projectId, repositoryId: other.id });
    await expect.poll(() => github.role(OTHER, 'dharmaarthamaxxer-damx'), { timeout: 5_000 }).toBe('push');

    await store.detachProjectRepository(projectId, other.id);
    await expect.poll(() => github.role(OTHER, 'dharmaarthamaxxer-damx'), { timeout: 5_000 }).toBeUndefined();

    // A project created with its repositories (the console's project form).
    const created = await store.createProject('Video - Shorts', {}, organizationId);
    await store.setProjectRepositorySources(created.id, [other.sshUrl]);
    await expect.poll(() => github.role(OTHER, 'dharmaarthamaxxer-damx'), { timeout: 5_000 }).toBe('push');
    stop();
  });

  it('grants a new member on every repository at once when they link GitHub', async () => {
    const stop = access.watch(app);
    await store.setOrganizationMembership(organizationId, 'dev', 'member');
    await authorization.replacePrincipalAuthorization('user:owner', 'user:dev', organizationId, { level: 'developer', scope: 'organization' });
    await app.authorizeUser('dev', 'dharmaarthamaxxer-damx');
    await expect.poll(() => github.role(CODE, 'dharmaarthamaxxer-damx'), { timeout: 5_000 }).toBe('push');
    await expect.poll(() => github.role(WIKI, 'dharmaarthamaxxer-damx'), { timeout: 5_000 }).toBe('push');
    stop();
  });

  it('sweeps projects whose only GitHub repository is a code repository', async () => {
    await store.setProjectWikiRepository(projectId, undefined);
    await join('dev', 'dharmaarthamaxxer-damx', 'developer');
    await access.sweep();
    expect(github.role(CODE, 'dharmaarthamaxxer-damx')).toBe('push');
    expect(github.role(WIKI, 'dharmaarthamaxxer-damx')).toBeUndefined();
  });

  it('grants one repository to only the person asked for', async () => {
    await join('dev', 'dharmaarthamaxxer-damx', 'developer');
    await join('other', 'someone-else', 'developer');

    await expect(access.syncRepository(code.id, 'dev')).resolves.toEqual([
      { userId: 'dev', login: 'dharmaarthamaxxer-damx', state: 'member' },
    ]);
    expect(github.role(CODE, 'someone-else')).toBeUndefined();
    expect(github.role(WIKI, 'dharmaarthamaxxer-damx')).toBeUndefined();
    // Someone outside every project that uses it is given nothing.
    await expect(access.syncRepository((await enroll(OTHER, '1424186357')).id, 'dev')).resolves.toEqual([]);
  });
});
