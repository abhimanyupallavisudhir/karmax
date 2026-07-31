import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE } from '../src/integrations/github-app.js';
import { ensureProjectWikiRepository, setProjectWikiRemote } from '../src/wiki/repository.js';
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

  it('re-wires an existing wiki with an installation token, not the user OAuth token', async () => {
    const store = new Store(':memory:');
    const broker = new CredentialBroker(new Vault(home));
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = store.createProject('Widgets', {}, organization.id);
    const connection = store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '42', accountLogin: 'owner-login', accountType: 'User' });

    // A previous run fully provisioned the wiki; no repository deploy-key row
    // is required for the fast path.
    const repository = store.upsertRepository({ organizationId: organization.id, provider: 'github',
      providerId: '999', owner: 'owner-login', name: 'widgets-wiki-deadbeef',
      sshUrl: 'git@github.com:owner-login/widgets-wiki-deadbeef.git', defaultBranch: 'main',
      private: true, gitConnectionId: connection.id });
    store.setProjectWikiRepository(project.id, repository.id);

    // Point the repository's GitHub SSH URL at a local bare repo so the real
    // push stays entirely offline while exercising the real Git operation.
    const root = ensureProjectWikiRepository(paths().content, project.id);
    const bare = path.join(home, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    execFileSync('git', ['-C', root, 'config', `url.${bare}.insteadOf`, repository.sshUrl]);

    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' } });
    broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey);
    // The operator's user OAuth token has expired. The App installation can
    // still mint its own short-lived token.
    const githubCalls: Array<{ path: string; method: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const pathname = new URL(String(input)).pathname;
      githubCalls.push({ path: pathname, method: init.method ?? 'GET' });
      if (pathname === '/app/installations/42/access_tokens')
        return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
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

    expect(githubCalls).toEqual([{ path: '/app/installations/42/access_tokens', method: 'POST' }]);
    expect((gateway as any).wikiRemotesReady.has(project.id)).toBe(true);
    // The wiki was really pushed without re-running repository creation.
    expect(execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim())
      .toMatch(/^[0-9a-f]{40}$/);

    (gateway as any).fanout.close();
    store.close();
  });

  it('keeps the stable SSH-shaped remote and never persists the HTTPS token', async () => {
    const root = ensureProjectWikiRepository(paths().content, 'token-remote');
    const bare = path.join(home, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    const remote = 'git@github.com:acme/wiki.git';
    execFileSync('git', ['-C', root, 'config', `url.${bare}.insteadOf`, remote]);
    await setProjectWikiRemote(root, remote, { httpsToken: 'short-lived-secret' });
    const stored = execFileSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
    expect(stored).toBe(remote);
    expect(stored).not.toContain('short-lived-secret');
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'],
      { encoding: 'utf8' }).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
