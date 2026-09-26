import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { Store } from '../src/store/db.js';
import { openSqlDatabase } from '../src/store/sql.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE, GITHUB_APP_WEBHOOK_SECRET_HANDLE } from '../src/integrations/github-app.js';

describe('shared GitHub installations', () => {
  it('migrates existing connections without changing IDs or repository links, including on restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-shared-migration-'));
    const filename = path.join(dir, 'store.db');
    const db = openSqlDatabase(filename);
    await db.exec(`CREATE TABLE git_connections (
      id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, provider TEXT NOT NULL,
      installationId TEXT NOT NULL, accountLogin TEXT NOT NULL, accountType TEXT,
      createdAt INTEGER NOT NULL, suspendedAt INTEGER, UNIQUE (provider, installationId));
      INSERT INTO git_connections VALUES ('original', 'org_personal', 'github', '42', 'acme', 'User', 123, 456)`);
    await db.close();
    let store = await Store.create(filename);
    try {
      const original = (await store.getGitConnection('original'))!;
      expect(original).toMatchObject({ createdAt: 123, suspendedAt: 456 });
      const repo = await store.upsertRepository({ organizationId: 'org_personal', provider: 'github',
        owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'main', private: true,
        gitConnectionId: original.id });
      const other = await store.createOrganization({ name: 'Second', ownerUserId: 'owner' });
      const second = await store.upsertGitConnection({ ...original, id: undefined, organizationId: other.id });
      expect(second.id).not.toBe(original.id);
      expect((await store.upsertGitConnection({ ...second, id: 'losing-concurrent-candidate' })).id).toBe(second.id);
      await store.close();
      store = await Store.create(filename);
      expect(await store.getGitConnection(original.id)).toEqual(original);
      expect(await store.getGitConnection(second.id)).toEqual(second);
      await store.deleteGitConnection(second.id);
      expect((await store.getRepository(repo.id))?.gitConnectionId).toBe(original.id);
    } finally { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('connects twice and fans out signed repository, push, suspension and deletion webhooks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-shared-service-'));
    const store = await Store.create(':memory:');
    let server: Awaited<ReturnType<Gateway['listen']>> | undefined;
    try {
      const broker = new CredentialBroker(new Vault(dir));
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
        privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
      broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
      broker.registerHandle(GITHUB_APP_WEBHOOK_SECRET_HANDLE, 'hook-secret');
      const organizations = await Promise.all(['First', 'Second'].map(name =>
        store.createOrganization({ name, ownerUserId: 'owner' })));
      let repositories = [{ id: 7, name: 'app', private: true, ssh_url: 'git@github.com:acme/app.git',
        default_branch: 'main', owner: { login: 'acme' } }];
      let failListing = false;
      let delayListings = false;
      let activeListings = 0;
      let maxActiveListings = 0;
      let completedListings = 0;
      const service = await GitHubAppService.create(store, broker, { appId: '123', fetch: (async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/app/installations/42') return Response.json({ id: 42, account: { login: 'acme', type: 'User' } });
        if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
        if (url.pathname === '/installation/repositories') {
          activeListings++;
          maxActiveListings = Math.max(maxActiveListings, activeListings);
          try {
            if (delayListings) await new Promise(resolve => setTimeout(resolve, 30));
            if (failListing) throw new Error('listing unavailable');
            return Response.json({ repositories });
          } finally {
            activeListings--;
            completedListings++;
          }
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch });
      const gateway = await Gateway.create({ store, githubApp: service, broker,
        identity: { session: async () => ({ user: { id: 'owner' } }),
          connectOrganizationNames: () => {}, listUsers: () => [] } as any,
        api: {} as any, client: {} as any, tokens: new TokenAuthority(),
        taskQueue: 'test', staticDir: dir, bus: new KarmaxBus(), contributions: new ContributionRegistry(),
        overlays: new Overlays(), worlds: new WorldRegistry(), agentInfo: { provider: 'mock', reason: 'shared installation' } });
      server = await gateway.listen(await findFreePortFrom(48790));
      const callback = (state: string) => fetch(`${server!.url}/api/github/callback?installation_id=42&state=${state}`, { redirect: 'manual' });
      const connect = async (organizationId: string) => {
        const state = await store.createGithubInstallState(organizationId, 'owner');
        const response = await callback(state);
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toContain(`github=connected&organizationId=${organizationId}`);
        expect((await callback(state)).status).toBe(400);
        return { connection: (await store.listGitConnections(organizationId))[0]!,
          repositories: await store.listRepositories(organizationId) };
      };
      const concurrentStates = await Promise.all([
        store.createGithubInstallState(organizations[0]!.id, 'owner'),
        store.createGithubInstallState(organizations[0]!.id, 'owner'),
      ]);
      const concurrentResponses = await Promise.all(concurrentStates.map(callback));
      expect(concurrentResponses.map(response => response.status),
        (await Promise.all(concurrentResponses.map(response => response.clone().text()))).join('\n')).toEqual([303, 303]);
      expect(await store.listGitConnections(organizations[0]!.id)).toHaveLength(1);
      const first = { connection: (await store.listGitConnections(organizations[0]!.id))[0]!,
        repositories: await store.listRepositories(organizations[0]!.id) };
      const foreign = await store.createOrganization({ name: 'Foreign', ownerUserId: 'someone-else' });
      expect((await callback(await store.createGithubInstallState(foreign.id, 'someone-else'))).status).toBe(400);
      expect(await store.listGitConnections(foreign.id)).toEqual([]);
      expect(await store.listGitConnections(organizations[1]!.id)).toEqual([]);
      const second = await connect(organizations[1]!.id);
      expect(first.connection.id).not.toBe(second.connection.id);
      expect(first.repositories[0]!.id).not.toBe(second.repositories[0]!.id);
      expect((await service.connectInstallation(organizations[0]!.id, '42')).connection.id).toBe(first.connection.id);
      let delivery = 0;
      const deliver = (event: string, body: object, id = String(++delivery)) => {
        const raw = Buffer.from(JSON.stringify({ installation: { id: 42 }, ...body }));
        const signature = `sha256=${crypto.createHmac('sha256', 'hook-secret').update(raw).digest('hex')}`;
        return service.handleWebhook(event, id, raw, signature);
      };
      expect((await deliver('push', { ref: 'refs/heads/main', after: 'revision', repository: { id: 7 } })).vaultPushes)
        .toEqual([first, second].map(({ connection, repositories: repos }) => ({
          organizationId: connection.organizationId, repositoryId: repos[0]!.id, revision: 'revision' })));
      const projects = await Promise.all([first, second].map(async ({ connection, repositories: repos }) => {
        const project = await store.createProject('App', {}, connection.organizationId);
        await store.attachProjectRepository({ projectId: project.id, repositoryId: repos[0]!.id });
        return project;
      }));
      const failed = await deliver('workflow_run', { action: 'completed', repository: { id: 7 },
        workflow_run: { event: 'push', head_repository: { id: 7 }, id: 123, name: 'CI', conclusion: 'failure', head_branch: 'main', head_sha: 'sha' } });
      expect(failed.projectEvents?.map(event => event.projectId)).toEqual(projects.map(project => project.id));
      const tasks = await Promise.all(projects.map(project => store.createTask({ projectId: project.id, title: 'Work',
        workflow: 'software-dev', workflowVersion: '1.8.0', params: { prompt: 'work' } })));
      for (const task of tasks) {
        const result = await deliver('pull_request', { action: 'opened', repository: { id: 7, full_name: 'acme/app' },
          pull_request: { number: 1, state: 'open', html_url: 'https://github.com/acme/app/pull/1',
            head: { repo: { id: 7 }, ref: `karmax/${task.id}`, sha: 'head' }, base: { ref: 'main' } } });
        expect(result.events).toHaveLength(1);
        expect(result.events![0]!.taskId).toBe(task.id);
      }
      for (const action of ['suspend', 'unsuspend', 'deleted']) {
        await deliver('installation', { action });
        for (const connection of [first.connection, second.connection]) {
          if (action === 'unsuspend') expect((await store.getGitConnection(connection.id))?.suspendedAt).toBeUndefined();
          else {
            expect((await store.getGitConnection(connection.id))?.suspendedAt).toBeTypeOf('number');
            await expect(service.repositoryCloneToken((await store.getRepository(
              connection.id === first.connection.id ? first.repositories[0]!.id : second.repositories[0]!.id))!)).rejects.toThrow(/suspended/);
          }
        }
      }
      await deliver('installation', { action: 'created' });
      delayListings = true;
      maxActiveListings = 0;
      completedListings = 0;
      await deliver('installation_repositories', { action: 'added' });
      expect(maxActiveListings).toBe(2);
      expect(completedListings).toBe(2);
      failListing = true;
      completedListings = 0;
      await expect(deliver('installation_repositories', { action: 'removed' }, 'retry')).rejects.toThrow();
      // A failed sibling does not abandon in-flight tenant work before the
      // delivery is released for GitHub's retry.
      expect(completedListings).toBe(2);
      failListing = false;
      delayListings = false;
      repositories = [];
      expect(await deliver('installation_repositories', { action: 'removed' }, 'retry')).toMatchObject({ accepted: true, reconciled: 0 });
      for (const org of organizations) expect(await store.listRepositories(org.id)).toEqual([]);
      expect(await deliver('installation_repositories', { action: 'removed' }, 'retry')).toEqual({ accepted: false });
      await service.disconnectInstallation(second.connection.id);
      expect(await store.getGitConnection(first.connection.id)).toBeDefined();
    } finally { await server?.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
