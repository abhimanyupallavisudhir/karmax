import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gitOrThrow } from '../src/world/git.js';
import crypto from 'node:crypto';
import { capsOf, cliFixture, files } from './helpers/cli-fixture.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const write = (file: string, content: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const json = (run: { code: number; stdout: string; stderr: string }) => { expect(run.code, run.stderr).toBe(0); return JSON.parse(run.stdout); };

/** A GitHub App stand-in: creating a repository makes a bare remote behind `url.insteadOf`. */
async function withGitHub() {
  let f!: Awaited<ReturnType<typeof cliFixture>>;
  const createRepository = vi.fn(async (connectionId: string, _userId: string, input: { name: string; defaultBranch?: string }) => {
    await gitOrThrow(f.dir, ['init', '-q', '--bare', path.join(f.remotes, 'acme', `${input.name}.git`)]);
    return f.store.upsertRepository({ organizationId: f.project.organizationId!, provider: 'github', providerId: `new-${input.name}`,
      owner: 'acme', name: input.name, sshUrl: `git@github.com:acme/${input.name}.git`, defaultBranch: input.defaultBranch ?? 'main',
      private: true, gitConnectionId: connectionId });
  });
  const reconcile = vi.fn(async () => []);
  f = await cliFixture(cleanups, { githubApp: { configured: () => true, createRepository, reconcile,
    status: async () => ({ configured: true, userAuthorized: false, oauthConfigured: false }),
    permissionStatus: async () => ({ ready: true }), fileContents: async () => undefined } as any });
  await f.store.upsertGitConnection({ organizationId: f.project.organizationId!, provider: 'github', installationId: '7',
    accountLogin: 'acme', accountType: 'Organization' });
  // acme/api is on GitHub and connected to the organization, but in no project yet.
  const seed = path.join(f.dir, 'seed-api');
  await gitOrThrow(f.dir, ['init', '-q', '-b', 'main', seed]);
  write(path.join(seed, '.gitignore'), '.env\nsecrets/\n*.sqlite\nlogs/\n');
  await gitOrThrow(seed, ['add', '-A']);
  await f.commit(seed, ['commit', '-q', '-m', 'api']);
  await gitOrThrow(f.dir, ['clone', '-q', '--bare', seed, path.join(f.remotes, 'acme', 'api.git')]);
  await f.store.upsertRepository({ organizationId: f.project.organizationId!, provider: 'github', providerId: '3', owner: 'acme',
    name: 'api', sshUrl: 'git@github.com:acme/api.git', defaultBranch: 'main', private: true });
  // A signed-in person across the organization: creating a GitHub repository needs a
  // verified human, which a CLI login is (this fixture has no sign-in service to mint one).
  await f.store.setOrganizationMembership(f.project.organizationId!, 'alice', 'owner');
  const { token, record } = await f.tokens.mintPrincipal('user:alice', capsOf('administrator'), undefined, 3_600_000, f.project.organizationId);
  await f.store.putScopedToken(crypto.createHash('sha256').update(token).digest('hex'), record.id, { ...record,
    actor: { kind: 'autonomous', principal: 'user:alice' }, humanSubject: { kind: 'user', userId: 'alice', presence: 'delegated' } } as any,
  record.expiresAt);
  const tavya = (cwd: string, args: string[]) => f.tavya(cwd, args, { token });
  return { f, createRepository, reconcile, tavya };
}

it('imports a folder of repositories: creates the missing GitHub repository, pushes, keeps what Git ignores, and becomes the workspace', async () => {
  const { f, createRepository, tavya } = await withGitHub();
  const env = { env: { GIT_CONFIG_GLOBAL: f.gitconfig } };
  const mono = path.join(f.laptop, 'mono');
  // api: a clone with an unpushed commit; its .env, a secret file, a database, and logs.
  await gitOrThrow(f.laptop, ['clone', '-q', 'git@github.com:acme/api.git', path.join(mono, 'api')], env);
  write(path.join(mono, 'api', 'server.js'), 'listen()\n');
  await gitOrThrow(path.join(mono, 'api'), ['add', '-A'], env);
  await f.commit(path.join(mono, 'api'), ['commit', '-q', '-m', 'server']);
  write(path.join(mono, 'api', '.env'), 'PORT=3000\nSHARED=same\n');
  write(path.join(mono, 'api', 'secrets', 'credentials.json'), '{"api":1}');
  write(path.join(mono, 'api', 'app.sqlite'), 'SQLite format 3');
  write(path.join(mono, 'api', 'logs', 'today.log'), 'noise');
  // web: never pushed anywhere.
  await gitOrThrow(f.laptop, ['init', '-q', '-b', 'main', path.join(mono, 'web')], env);
  write(path.join(mono, 'web', '.gitignore'), '.env\ncredentials.json\ncache/\n');
  write(path.join(mono, 'web', 'index.html'), '<h1>web</h1>\n');
  await gitOrThrow(path.join(mono, 'web'), ['add', '-A'], env);
  await f.commit(path.join(mono, 'web'), ['commit', '-q', '-m', 'web']);
  write(path.join(mono, 'web', '.env'), 'PORT=4000\nSHARED=same\n');
  write(path.join(mono, 'web', 'credentials.json'), '{"web":1}');
  write(path.join(mono, 'web', 'cache', 'blob.bin'), 'cached');
  // Beside the repositories: a dataset and a note.
  write(path.join(mono, 'datasets', 'train.csv'), 'x,y\n1,2\n');
  write(path.join(mono, 'notes.txt'), 'todo');

  // The plan, with nothing changed yet.
  const plan = json(await tavya(mono, ['import', '--dry-run', '--json', '--name', 'Mono', '--data', 'web/cache']));
  expect(plan).toMatchObject({ project: 'Mono', newProject: true });
  expect(plan.repositories).toEqual([
    { folder: 'api', repository: 'acme/api', create: false, push: 'push 1 commit on main', uncommitted: 0 },
    { folder: 'web', repository: 'acme/web', create: true, push: 'push main', uncommitted: 0 }]);
  // The two .env files disagree on PORT, so each is kept as a file where it is.
  expect(plan.secrets).toEqual(expect.arrayContaining([{ path: 'api/.env', as: 'file' }, { path: 'web/.env', as: 'file' },
    { path: 'api/secrets/credentials.json', as: 'file' }, { path: 'web/credentials.json', as: 'file' }]));
  expect(plan.data.map((entry: { path: string; access: string }) => [entry.path, entry.access]).sort()).toEqual(
    [['api/app.sqlite', 'write'], ['datasets', 'read'], ['web/cache', 'read']]);
  expect(plan.leftOut.map((entry: { path: string }) => entry.path).sort()).toEqual(['api/logs/', 'notes.txt']);
  expect(createRepository).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(mono, '.tavya'))).toBe(false);

  const imported = json(await tavya(mono, ['import', '--yes', '--json', '--name', 'Mono', '--data', 'web/cache']));
  expect(createRepository).toHaveBeenCalledTimes(1);
  expect(createRepository.mock.calls[0]![2]).toMatchObject({ name: 'web', private: true, autoInit: false, defaultBranch: 'main' });
  expect(imported.repositories).toEqual({ api: 'pushed, linked', web: 'created, pushed, linked' });
  expect(imported.data.sort()).toEqual(['api/app.sqlite', 'datasets', 'web/cache']);
  expect(imported.secrets.sort()).toEqual(['.env', 'credentials.json', 'web/.env', 'web/credentials.json']);
  // GitHub has both branches, and web's new origin is set.
  expect(await gitOrThrow(f.dir, ['--git-dir', path.join(f.remotes, 'acme', 'web.git'), 'log', '--format=%s', 'main'])).toBe('web');
  expect(await gitOrThrow(f.dir, ['--git-dir', path.join(f.remotes, 'acme', 'api.git'), 'log', '--format=%s', 'main'])).toBe('server\napi');
  expect(await gitOrThrow(path.join(mono, 'web'), ['config', '--get', 'remote.origin.url'])).toBe('git@github.com:acme/web.git');
  expect((await gitOrThrow(path.join(mono, 'web'), ['status', '--porcelain']))).toBe('');

  // The folder is the workspace: everything is up to date, and an edit pushes.
  const status = json(await tavya(mono, ['status', '--json']));
  expect(status.repositories).toMatchObject({ api: { branch: 'main', ahead: 0, behind: 0 }, web: { branch: 'main', ahead: 0, behind: 0 } });
  expect(Object.values(status.resources)).toEqual([{ localChanges: 0, newerOnServer: false }, { localChanges: 0, newerOnServer: false },
    { localChanges: 0, newerOnServer: false }]);
  write(path.join(mono, 'datasets', 'train.csv'), 'x,y\n1,2\n3,4\n');
  expect(json(await tavya(mono, ['push', '--json'])).resources).toEqual({ datasets: 'pushed' });

  // Anyone can now clone the same layout, with the data and secret files.
  const fresh = path.join(f.laptop, 'fresh');
  expect((await tavya(f.laptop, ['clone', imported.project.id, 'fresh'])).code).toBe(0);
  expect(fs.readFileSync(path.join(fresh, 'datasets', 'train.csv'), 'utf8')).toBe('x,y\n1,2\n3,4\n');
  expect(files(path.join(fresh, 'web', 'cache'))).toEqual(['blob.bin']);
  expect(fs.readFileSync(path.join(fresh, 'api', 'app.sqlite'), 'utf8')).toBe('SQLite format 3');
  expect(fs.readFileSync(path.join(fresh, 'api', '.env'), 'utf8')).toBe('PORT=3000\nSHARED=same\n');
  expect(fs.readFileSync(path.join(fresh, 'web', '.env'), 'utf8')).toBe('PORT=4000\nSHARED=same\n');
  expect(fs.readFileSync(path.join(fresh, 'web', 'credentials.json'), 'utf8')).toBe('{"web":1}');
  expect(fs.readFileSync(path.join(fresh, 'api', 'secrets', 'credentials.json'), 'utf8')).toBe('{"api":1}');
  expect(fs.existsSync(path.join(fresh, 'notes.txt'))).toBe(false);

  // Importing again changes nothing that is already there.
  const again = json(await tavya(mono, ['import', '--yes', '--json']));
  expect(createRepository).toHaveBeenCalledTimes(1);
  expect(again).toMatchObject({ repositories: {}, secrets: [], kept: [], data: [] });
  // Nor does importing from inside it.
  const inside = await tavya(path.join(mono, 'api'), ['import', '--yes']);
  expect(inside.code).toBe(2);
  expect(inside.stderr).toContain('is inside the workspace');
});

it('refuses what it cannot import before changing anything', async () => {
  const { f, reconcile, tavya } = await withGitHub();
  const env = { env: { GIT_CONFIG_GLOBAL: f.gitconfig } };
  const empty = path.join(f.laptop, 'empty');
  fs.mkdirSync(empty);
  const none = await tavya(empty, ['import', '--yes']);
  expect(none.code).toBe(2);
  expect(none.stderr).toContain('no Git repositories');

  const elsewhere = path.join(f.laptop, 'elsewhere');
  await gitOrThrow(f.laptop, ['init', '-q', '-b', 'main', elsewhere], env);
  await f.commit(elsewhere, ['commit', '-q', '--allow-empty', '-m', 'x']);
  await gitOrThrow(elsewhere, ['remote', 'add', 'origin', 'git@gitlab.com:acme/elsewhere.git']);
  expect((await tavya(elsewhere, ['import', '--yes'])).stderr).toContain('is not on GitHub');

  await gitOrThrow(elsewhere, ['remote', 'set-url', 'origin', 'git@github.com:someone/private.git']);
  const unconnected = await tavya(elsewhere, ['import', '--yes']);
  expect(unconnected.code).toBe(5);
  expect(unconnected.stderr).toContain('github.com/someone/private is not connected');
  // It asked GitHub for repositories granted since tavya last looked.
  expect(reconcile).toHaveBeenCalled();

  const site = path.join(f.laptop, 'site');
  await gitOrThrow(f.laptop, ['init', '-q', '-b', 'main', site], env);
  await f.commit(site, ['commit', '-q', '--allow-empty', '-m', 'x']);
  const taken = await tavya(site, ['import', '--yes']);
  expect(taken.code).toBe(4);
  expect(taken.stderr).toContain('github.com/acme/site already exists');
  expect(fs.existsSync(path.join(site, '.tavya'))).toBe(false);
});

it('turns an imported checkout into its workspace, then adds and untracks ignored files', async () => {
  const f = await cliFixture(cleanups);
  const checkout = path.join(f.laptop, 'site');
  await gitOrThrow(f.laptop, ['clone', '-q', 'git@github.com:acme/site.git', checkout], { env: { GIT_CONFIG_GLOBAL: f.gitconfig } });
  write(path.join(checkout, 'data', 'a.csv'), 'id\n1\n');
  const imported = await f.tavya(checkout, ['import', '--yes', '--name', 'Site Builder']);
  expect(imported.code, imported.stderr).toBe(0);
  expect(imported.stdout).toContain('This folder is now its workspace');

  // The checkout is the workspace root; the wiki has no place inside it and is not cloned there.
  const status = await f.tavya(checkout, ['status']);
  expect(status.stdout).toMatch(/site-wiki\s+not in this folder/);
  expect(status.stdout).toMatch(/raw_data\s+up to date/);
  expect(json(await f.tavya(checkout, ['pull', '--json'])).repositories).toMatchObject({ site: 'updated', 'site-wiki': 'not in this folder (tavya clone has the full layout)' });
  expect(fs.existsSync(path.join(checkout, 'site-wiki'))).toBe(false);
  expect(await gitOrThrow(checkout, ['status', '--porcelain'])).toBe('');

  // add: a folder Git does not track becomes data now (and stays out of git status); a file, a secret.
  write(path.join(checkout, 'models', 'm.bin'), 'weights');
  write(path.join(checkout, 'config', 'local.json'), '{"local":true}');
  const tracked = await f.tavya(checkout, ['add', 'README.md']);
  expect(tracked.code).toBe(2);
  expect(tracked.stderr).toContain('tracked by Git');
  const added = json(await f.tavya(path.join(checkout, 'config'), ['add', '../models', '--secret', 'local.json', '--json']));
  expect(added.added).toEqual(['site/models', 'site/config/local.json']);
  expect(await gitOrThrow(checkout, ['status', '--porcelain'])).toBe('');
  expect(json(await f.tavya(checkout, ['status', '--json'])).resources).toMatchObject({ models: { localChanges: 0, newerOnServer: false } });
  expect((await f.tavya(f.laptop, ['clone', f.project.id, 'fresh'])).code).toBe(0);
  expect(fs.readFileSync(path.join(f.laptop, 'fresh', 'site', 'models', 'm.bin'), 'utf8')).toBe('weights');
  expect(fs.readFileSync(path.join(f.laptop, 'fresh', 'site', 'config', 'local.json'), 'utf8')).toBe('{"local":true}');

  // untrack: the project forgets it; the files stay here.
  expect((await f.tavya(checkout, ['untrack', 'models'])).code).toBe(2);
  const untracked = json(await f.tavya(checkout, ['untrack', 'models', 'config/local.json', '--yes', '--json']));
  expect(untracked.untracked).toEqual(['site/models', 'site/config/local.json']);
  const after = json(await f.tavya(checkout, ['status', '--json']));
  expect(Object.keys(after.resources)).toEqual(['raw_data']);
  expect(fs.existsSync(path.join(checkout, 'models', 'm.bin'))).toBe(true);
  const secrets = json(await f.tavya(checkout, ['secrets', 'list', '--json']));
  expect(secrets.secrets.map((secret: { name: string }) => secret.name)).not.toContain('local.json');

  // projects and open name the project the way clone takes it.
  const listed = json(await f.tavya(f.laptop, ['projects', '--json']));
  expect(listed.map((project: { ref: string }) => project.ref)).toContain(`${listed[0].ref.split('/')[0]}/site-builder`);
  const opened = json(await f.tavya(checkout, ['open', '--json']));
  expect(opened.url).toMatch(/\/site-builder$/);
});
