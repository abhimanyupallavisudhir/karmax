import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { resourceSecretHandle } from '../src/domain/resource-drivers.js';
import { INSTALLATION_SCOPE } from '../src/autonomy/vault-keys.js';
import { ensureIdentity, git, gitOrThrow } from '../src/world/git.js';
import { dotenvFile, parseDotenv, renderDotenv } from '../src/domain/dotenv.js';
import type { ResourceTarget } from '../src/domain/types.js';
import { capsOf, cliFixture } from './helpers/cli-fixture.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('.env files', () => {
  it('render values that read back unchanged', () => {
    const values = [
      { name: 'PLAIN', value: 'postgres://u@db:5432/app' },
      { name: 'SPACED', value: 'two words # not a comment' },
      { name: 'DOLLAR', value: 'pa$$word' },
      { name: 'QUOTES', value: `it's "quoted" \\ here` },
      { name: 'PEM', value: '-----BEGIN KEY-----\nabc\n-----END KEY-----' },
    ];
    expect(parseDotenv(renderDotenv(values))).toEqual(values);
    expect(renderDotenv([{ name: 'A', value: 'b' }])).toBe('A=b\n');
    expect(parseDotenv('export A="x\ny"\n# c\nB=1 # trailing\nEMPTY=\nC=\'$lit\'')).toEqual([
      { name: 'A', value: 'x\ny' }, { name: 'B', value: '1' }, { name: 'C', value: '$lit' }]);
    expect(['.env', 'apps/web/.env.local', '.env.production'].every(dotenvFile)).toBe(true);
    expect(['.env.example', '.envrc', 'config.json', 'my.env'].some(dotenvFile)).toBe(false);
  });
});

async function repository(dir: string, name: string): Promise<string> {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
  await ensureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  await git(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

async function worldFixture(names: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repo-env-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repos: string[] = [];
  for (const name of names) repos.push(await repository(dir, name));
  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const project = await store.createProject('Fleet', { repos });
  const task = await store.createTask({ projectId: project.id, title: 'Work', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'work' } });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const resources = new ProjectResourceService(store, worlds,
    new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
  let count = 0;
  const secret = async (name: string, target: ResourceTarget, value: string) => {
    const id = `resource_secret_${++count}`;
    await broker.registerHandle(resourceSecretHandle(id), value, INSTALLATION_SCOPE);
    return store.createResourceAttachment({ id, organizationId: project.organizationId!, projectId: project.id, name,
      driver: 'secret@1', target, access: 'read', isolation: 'fork', source: {},
      credentialHandles: [resourceSecretHandle(id)], publish: 'discard' });
  };
  const open = async () => {
    const world = await worlds.create('worktree', { taskId: task.id, repos, base: 'main' });
    cleanups.push(() => world.destroy());
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    return world;
  };
  return { dir, repos, store, project, task, broker, resources, secret, open };
}

describe('repository .env files in a world', () => {
  it('writes each repository its own .env, exports only unscoped variables, and keeps the files out of Git', async () => {
    const f = await worldFixture(['api', 'web']);
    await f.secret('api/.env:DATABASE_URL', { kind: 'environment', name: 'DATABASE_URL', dotenv: { path: '.env', repository: 'api' } }, 'postgres://api');
    await f.secret('api/.env:PORT', { kind: 'environment', name: 'PORT', dotenv: { path: '.env', repository: 'api' } }, '4000');
    await f.secret('web/apps/site/.env.local:DATABASE_URL', { kind: 'environment', name: 'DATABASE_URL', dotenv: { path: 'apps/site/.env.local', repository: 'web' } }, "it's web");
    await f.secret('SHARED', { kind: 'environment', name: 'SHARED' }, 'everywhere');
    await f.secret('sa.json', { kind: 'path', path: 'config/sa.json', repository: 'web' }, '{"key":"web"}');
    await f.secret('ELSEWHERE', { kind: 'environment', name: 'ELSEWHERE', dotenv: { path: '.env', repository: 'worker' } }, 'x');

    const world = await f.open();
    expect(await world.readFile('api/.env')).toBe('DATABASE_URL=postgres://api\nPORT=4000\n');
    expect(await world.readFile('web/apps/site/.env.local')).toBe(`DATABASE_URL="it's web"\n`);
    expect(await world.readFile('web/config/sa.json')).toBe('{"key":"web"}');
    expect((await world.exec('stat', ['-c', '%a', 'api/.env'])).stdout.trim()).toBe('600');
    for (const repo of ['api', 'web'])
      expect((await world.exec('git', ['status', '--porcelain'], { cwd: path.join(world.handle.root, repo) })).stdout.trim()).toBe('');
    expect(world.handle.meta?.ephemeralPaths).toEqual(expect.arrayContaining(['api/.env', 'web/apps/site/.env.local', 'web/config/sa.json']));
    expect(JSON.stringify(world.handle)).not.toContain('postgres://api');

    const env = await f.resources.environmentFor(world.handle);
    expect(env).toEqual({ SHARED: 'everywhere' });
    // A repository this world has no checkout of is skipped, not fatal.
    const warnings = await f.store.eventsOfType(f.task.id, 'world.warning');
    expect(warnings.map((event) => (event.payload as { warning: string }).warning).join('\n')).toContain('ELSEWHERE');

    // A changed value rewrites only its file; an agent's edit to another survives.
    await world.writeFile('web/apps/site/.env.local', 'DATABASE_URL=edited-by-agent\n');
    await f.broker.registerHandle(resourceSecretHandle('resource_secret_2'), '5000', INSTALLATION_SCOPE);
    await f.resources.refresh(world);
    expect(await world.readFile('api/.env')).toBe('DATABASE_URL=postgres://api\nPORT=5000\n');
    expect(await world.readFile('web/apps/site/.env.local')).toBe('DATABASE_URL=edited-by-agent\n');

    // A variable added later joins its file at the next refresh.
    await f.secret('REDIS_URL', { kind: 'environment', name: 'REDIS_URL', dotenv: { path: '.env', repository: 'api' } }, 'redis://api');
    world.handle = (await f.store.currentWorld(f.task.id)) as typeof world.handle;
    await f.resources.refresh(world);
    expect(await world.readFile('api/.env')).toBe('DATABASE_URL=postgres://api\nPORT=5000\nREDIS_URL=redis://api\n');

    await f.resources.scrubSecrets(world.handle, world);
    for (const file of ['api/.env', 'web/apps/site/.env.local', 'web/config/sa.json'])
      expect((await world.exec('test', ['-e', file])).code).toBe(1);
  });

  it('places a repository location at the root of a single-checkout world', async () => {
    const f = await worldFixture(['solo']);
    await f.secret('TOKEN', { kind: 'environment', name: 'TOKEN', dotenv: { path: '.env', repository: 'solo' } }, 't');
    const world = await f.open();
    expect(await world.readFile('.env')).toBe('TOKEN=t\n');
    expect((await world.exec('git', ['status', '--porcelain'])).stdout.trim()).toBe('');
  });

  it('refuses malformed locations', async () => {
    const f = await worldFixture(['solo']);
    await expect(f.secret('A', { kind: 'environment', name: 'A', dotenv: { path: '../.env', repository: 'solo' } }, 'v')).rejects.toThrow(/world-relative/);
    await expect(f.secret('B', { kind: 'path', path: 'x', repository: '../up' }, 'v')).rejects.toThrow(/invalid repository/);
  });
});

describe('the secrets API and the tavya CLI', () => {
  it('keeps each repository its own values for a name, and suggests what each .env.example lists', async () => {
    const f = await cliFixture(cleanups);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repo-env-api-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const api = await repository(dir, 'api');
    const web = await repository(dir, 'web');
    fs.writeFileSync(path.join(api, '.env.example'), 'DATABASE_URL=\nPORT=3000\n');
    fs.writeFileSync(path.join(web, '.env.example'), 'DATABASE_URL=\nSHARED=\n');
    const project = await f.store.createProject('Fleet', { repos: [api, web] });
    const token = (await f.tokens.mintPrincipal('user:alice', capsOf('maintainer'), project.id)).token;
    const base = `/api/projects/${project.id}/secrets`;
    const post = async (body: unknown) => {
      const response = await f.post(base, body, token);
      return { status: response.status, body: await response.json() as any };
    };
    const list = async () => (await fetch(`${f.server.url}${base}`, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>;

    expect((await post({ env: 'DATABASE_URL=postgres://api\nPORT=4000\n', repository: 'api' })).status).toBe(200);
    expect((await post({ env: 'DATABASE_URL=postgres://web\n', file: 'web/.env' })).status).toBe(200);
    expect((await post({ name: 'SHARED', value: 'everywhere' })).status).toBe(200);
    expect((await post({ name: 'sa.json', value: '{}', file: 'web/config/sa.json' })).status).toBe(200);
    // The same name again in the same place is an update, not another secret.
    expect((await post({ env: 'DATABASE_URL=postgres://api-2\n', file: '.env', repository: 'api' })).status).toBe(200);
    expect((await post({ env: 'A=b', file: 'notes.txt', repository: 'api' })).body.error).toMatch(/\.env file/);
    expect((await post({ env: 'A=b', repository: 'nope' })).body.error).toMatch(/no repository named "nope"/);

    const listed = await list();
    const where = (secret: any) => secret.dotenv ? `${secret.variable}@${secret.dotenv.repository}/${secret.dotenv.path}`
      : secret.file ? `file@${secret.repository}/${secret.file}` : `${secret.variable}@env`;
    expect(listed.secrets.map(where).sort()).toEqual(['DATABASE_URL@api/.env', 'DATABASE_URL@web/.env', 'PORT@api/.env',
      'SHARED@env', 'file@web/config/sa.json']);
    expect(listed.repositories).toEqual(['api', 'web']);
    // Every name is declared where its .env.example wants it.
    expect(listed.suggested).toEqual([]);
    const apiUrl = listed.secrets.find((secret: any) => secret.dotenv?.repository === 'api' && secret.variable === 'DATABASE_URL');
    await fetch(`${f.server.url}${base}/${apiUrl.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    expect((await list()).suggested).toEqual([{ name: 'DATABASE_URL', repository: 'api' }]);
  });

  it('writes .env files into a cloned workspace and imports a file into its own repository', async () => {
    const f = await cliFixture(cleanups);
    await f.post(`/api/projects/${f.project.id}/secrets`, { env: 'DATABASE_URL=postgres://site\n', repository: 'site' });
    const manifest = await (await fetch(`${f.server.url}/api/projects/${f.project.id}/workspace`,
      { headers: { authorization: `Bearer ${f.maintainer}` } })).json() as any;
    expect(manifest.secrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'site/.env:DATABASE_URL', variable: 'DATABASE_URL', dotenv: 'site/.env' }),
      expect.objectContaining({ name: 'sa.json', file: 'site/config/sa.json' })]));
    // Older CLIs neither export a .env line nor write its bare value over the file.
    const values = await (await f.post(`/api/projects/${f.project.id}/secrets/values`, {})).json() as any;
    expect(values.secrets.find((secret: any) => secret.name === 'site/.env:DATABASE_URL')).toEqual(
      { id: expect.any(String), name: 'site/.env:DATABASE_URL', value: 'postgres://site' });

    expect((await f.tavya(f.laptop, ['clone', f.project.id, 'ws'])).code).toBe(0);
    const ws = path.join(f.laptop, 'ws');
    expect(fs.readFileSync(path.join(ws, 'site', '.env'), 'utf8')).toBe('DATABASE_URL=postgres://site\n');
    expect(fs.statSync(path.join(ws, 'site', '.env')).mode & 0o777).toBe(0o600);
    const run = await f.tavya(path.join(ws, 'site'), ['run', '--', process.execPath, '-e',
      'process.stdout.write(`${process.env.API_KEY}|${process.env.DATABASE_URL ?? "unset"}`)']);
    expect(run.stdout).toBe('s3cret|unset');

    // A file imported from the workspace keeps its place; stdin has none.
    fs.mkdirSync(path.join(ws, 'site', 'apps', 'web'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'site', 'apps', 'web', '.env.local'), 'NEXT_PUBLIC_URL=https://example.test\n');
    const imported = await f.tavya(path.join(ws, 'site', 'apps', 'web'), ['secrets', 'import', '.env.local']);
    expect(imported.code, imported.stderr).toBe(0);
    expect(imported.stdout).toContain('into site/apps/web/.env.local');
    const piped = await f.tavya(ws, ['secrets', 'import', '-'], { input: 'GLOBAL_FLAG=on\n' });
    expect(piped.code, piped.stderr).toBe(0);
    const listed = await f.tavya(ws, ['secrets', 'list']);
    expect(listed.stdout).toMatch(/:NEXT_PUBLIC_URL\s+in site\/apps\/web\/\.env\.local/);
    expect(listed.stdout).toMatch(/GLOBAL_FLAG\s+env GLOBAL_FLAG/);
    const pulled = await f.tavya(ws, ['pull']);
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(fs.readFileSync(path.join(ws, 'site', 'apps', 'web', '.env.local'), 'utf8')).toBe('NEXT_PUBLIC_URL=https://example.test\n');
    expect((await gitOrThrow(path.join(ws, 'site'), ['status', '--porcelain'])).trim()).toBe('');
  });
});
