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
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';

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

  it('publishes canonical interface saves and deletes before acknowledging them', async () => {
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
    const project = store.createProject('Widgets', {}, organization.id);
    const bare = path.join(home, 'interface-saves.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    const sshUrl = 'git@github.com:acme/widgets-wiki.git';
    const repository = store.upsertRepository({
      organizationId: organization.id,
      provider: 'github',
      providerId: 'interface-saves',
      owner: 'acme',
      name: 'widgets-wiki',
      sshUrl,
      defaultBranch: 'main',
      private: true,
    });
    store.setProjectWikiRepository(project.id, repository.id);
    const root = ensureProjectWikiRepository(paths().content, project.id);
    execFileSync('git', ['-C', root, 'config', `url.${bare}.insteadOf`, sshUrl]);
    const credentialRequests: string[] = [];
    const githubApp = {
      brokerCredentials: async (requested: typeof repository) => {
        credentialRequests.push(requested.id);
        return { env: {} };
      },
    };
    const tokens = new TokenAuthority();
    const token = tokens.mintPrincipal('user:owner', ['project:read', 'skill:write'],
      project.id, 60_000, organization.id).token;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'tq', tokens,
      contentDir: paths().content, githubApp } as any);

    try {
      await api.saveWikiPageResolved(token, 'project', project.id, {
        path: 'notes/published',
        content: 'Published from the interface.',
        create: true,
      });
      expect(execFileSync('git', ['--git-dir', bare, 'show', 'main:notes/published/SKILL.md'],
        { encoding: 'utf8' })).toBe('Published from the interface.');

      // Two browser requests may arrive together. Their local commit + remote
      // reconciliation transactions must serialize rather than racing Git's
      // shared canonical index or overwriting one another at origin.
      await Promise.all([
        api.saveWikiPageResolved(token, 'project', project.id,
          { path: 'notes/a', content: 'A', create: true }),
        api.saveWikiPageResolved(token, 'project', project.id,
          { path: 'notes/b', content: 'B', create: true }),
      ]);
      expect(execFileSync('git', ['--git-dir', bare, 'show', 'main:notes/a/SKILL.md'],
        { encoding: 'utf8' })).toBe('A');
      expect(execFileSync('git', ['--git-dir', bare, 'show', 'main:notes/b/SKILL.md'],
        { encoding: 'utf8' })).toBe('B');

      await api.deleteWikiPageResolved(token, 'project', project.id, 'notes/published');
      expect(() => execFileSync('git', ['--git-dir', bare, 'show', 'main:notes/published/SKILL.md'],
        { stdio: 'pipe' })).toThrow();
      expect(credentialRequests).toEqual([
        repository.id, repository.id, repository.id, repository.id,
      ]);
    } finally {
      store.close();
    }
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

  it('fast-forwards the canonical wiki after GitHub merges a wiki pull request', async () => {
    const root = ensureProjectWikiRepository(paths().content, 'remote-ahead');
    const bare = path.join(home, 'remote-ahead.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    await setProjectWikiRemote(root, bare, { env: {} });

    // Model GitHub landing a reviewed task branch while the canonical checkout
    // still has its pre-merge main and a stale origin/main tracking ref.
    const github = path.join(home, 'github-merge');
    execFileSync('git', ['clone', '-q', bare, github]);
    execFileSync('git', ['-C', github, 'config', 'user.name', 'GitHub']);
    execFileSync('git', ['-C', github, 'config', 'user.email', 'github@localhost']);
    fs.writeFileSync(path.join(github, 'remote.md'), 'landed on GitHub\n');
    execFileSync('git', ['-C', github, 'add', 'remote.md']);
    execFileSync('git', ['-C', github, 'commit', '-q', '-m', 'Merge wiki pull request']);
    execFileSync('git', ['-C', github, 'push', '-q', 'origin', 'main']);
    const remoteHead = execFileSync('git', ['-C', github, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    await expect(setProjectWikiRemote(root, bare, { env: {} })).resolves.toBeUndefined();
    expect(execFileSync('git', ['-C', root, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(remoteHead);
    expect(fs.readFileSync(path.join(root, 'remote.md'), 'utf8')).toBe('landed on GitHub\n');
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(remoteHead);
  });

  it('merges independent local and remote wiki edits without overwriting either', async () => {
    const root = ensureProjectWikiRepository(paths().content, 'diverged');
    const bare = path.join(home, 'diverged.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    await setProjectWikiRemote(root, bare, { env: {} });

    const github = path.join(home, 'github-diverged');
    execFileSync('git', ['clone', '-q', bare, github]);
    execFileSync('git', ['-C', github, 'config', 'user.name', 'GitHub']);
    execFileSync('git', ['-C', github, 'config', 'user.email', 'github@localhost']);
    fs.writeFileSync(path.join(github, 'remote.md'), 'remote edit\n');
    execFileSync('git', ['-C', github, 'add', 'remote.md']);
    execFileSync('git', ['-C', github, 'commit', '-q', '-m', 'Remote edit']);
    execFileSync('git', ['-C', github, 'push', '-q', 'origin', 'main']);

    fs.writeFileSync(path.join(root, 'local.md'), 'local edit\n');
    execFileSync('git', ['-C', root, 'add', 'local.md']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'Local edit']);

    await expect(setProjectWikiRemote(root, bare, { env: {} })).resolves.toBeUndefined();
    const localHead = execFileSync('git', ['-C', root, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(localHead);
    expect(fs.readFileSync(path.join(root, 'local.md'), 'utf8')).toBe('local edit\n');
    expect(fs.readFileSync(path.join(root, 'remote.md'), 'utf8')).toBe('remote edit\n');
    expect(execFileSync('git', ['-C', root, 'rev-list', '--parents', '-n', '1', 'HEAD'],
      { encoding: 'utf8' }).trim().split(' ')).toHaveLength(3);
  });

  it('aborts a conflicting reconciliation without changing either wiki history', async () => {
    const root = ensureProjectWikiRepository(paths().content, 'conflict');
    fs.writeFileSync(path.join(root, 'shared.md'), 'baseline\n');
    execFileSync('git', ['-C', root, 'add', 'shared.md']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'Baseline']);
    const bare = path.join(home, 'conflict.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
    await setProjectWikiRemote(root, bare, { env: {} });

    const github = path.join(home, 'github-conflict');
    execFileSync('git', ['clone', '-q', bare, github]);
    execFileSync('git', ['-C', github, 'config', 'user.name', 'GitHub']);
    execFileSync('git', ['-C', github, 'config', 'user.email', 'github@localhost']);
    fs.writeFileSync(path.join(github, 'shared.md'), 'remote edit\n');
    execFileSync('git', ['-C', github, 'commit', '-qam', 'Remote edit']);
    execFileSync('git', ['-C', github, 'push', '-q', 'origin', 'main']);
    const remoteHead = execFileSync('git', ['-C', github, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(root, 'shared.md'), 'local edit\n');
    execFileSync('git', ['-C', root, 'commit', '-qam', 'Local edit']);
    const localHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    await expect(setProjectWikiRemote(root, bare, { env: {} })).rejects.toThrow();
    expect(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(localHead);
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()).toBe(remoteHead);
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
    expect(fs.readFileSync(path.join(root, 'shared.md'), 'utf8')).toBe('local edit\n');
  });
});
