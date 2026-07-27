import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitHubAppService, repositoryKeyHandle } from '../src/integrations/github-app.js';
import { ensureProjectWikiRepository } from '../src/wiki/repository.js';
import { paths } from '../src/config/paths.js';
import { Gateway } from '../src/gateway/server.js';

describe('project wiki remote provisioning', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.KARMAX_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wiki-remote-'));
    process.env.KARMAX_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.KARMAX_HOME;
    else process.env.KARMAX_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('re-wires an already-provisioned wiki remote without any GitHub API call', async () => {
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(home));
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = store.createProject('Widgets', {}, organization.id);
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'owner-login', accountType: 'User' });

    // A previous run fully provisioned the wiki: durable repository record +
    // isolated deploy keys, whose write key lives in the broker.
    const repository = store.upsertRepository({ organizationId: organization.id, provider: 'github',
      providerId: '999', owner: 'owner-login', name: 'widgets-wiki-deadbeef',
      sshUrl: 'git@github.com:owner-login/widgets-wiki-deadbeef.git', defaultBranch: 'main',
      private: true, gitConnectionId: connection.id });
    const writeHandle = repositoryKeyHandle(repository.id, 'write');
    broker.registerHandle(writeHandle, 'PRIVATE-DEPLOY-KEY');
    store.setRepositoryDeployKeys({ repositoryId: repository.id, cloneKeyId: '1', writeKeyId: '2',
      cloneHandle: repositoryKeyHandle(repository.id, 'clone'), writeHandle });
    store.setProjectWikiRepository(project.id, repository.id);

    // Point the repository's GitHub SSH URL at a local bare repo so the real
    // deploy-key push stays entirely offline — the fast path must reach it
    // using only the stored deploy key, never a network round-trip to GitHub.
    const root = ensureProjectWikiRepository(paths().content, project.id);
    const bare = path.join(home, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    execFileSync('git', ['-C', root, 'config', `url.${bare}.insteadOf`, repository.sshUrl]);

    // The operator's user OAuth token has since expired: every REST call 401s.
    // (It also stands in for a token that was simply revoked.)
    const githubCalls: Array<{ path: string; method: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      githubCalls.push({ path: new URL(String(input)).pathname, method: init.method ?? 'GET' });
      return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    };
    broker.registerHandle('github-app:user:owner:authorization', JSON.stringify({ accessToken: 'expired-token' }));
    const githubApp = new GitHubAppService(store, broker,
      { appId: '123', clientId: 'Iv1.client', fetch: fakeFetch as typeof fetch });

    const gateway = new Gateway({ store, githubApp } as any);
    await (gateway as any).ensureProjectWiki(project);
    // The remote wiring is scheduled fire-and-forget; wait for it to settle.
    for (let i = 0; i < 100 && !(gateway as any).wikiRemotesReady.has(project.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));

    // The bug: startup re-ran GitHub provisioning against the expired operator
    // token, producing a "Bad credentials" 401 for a wiki that was already set
    // up. The fix wires the local remote from the stored write deploy key alone.
    expect(githubCalls).toEqual([]);
    expect((gateway as any).wikiRemotesReady.has(project.id)).toBe(true);
    // The wiki was really pushed to its remote using the deploy key alone.
    expect(execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim())
      .toMatch(/^[0-9a-f]{40}$/);

    (gateway as any).fanout.close();
    store.close();
  });
});
