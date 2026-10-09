import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gitOrThrow } from '../src/world/git.js';
import { planImport, githubRepository } from '../src/cli/commands/import.js';
import { capsOf, cliFixture, files } from './helpers/cli-fixture.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('clones a task as its cloud world, runs a command there, and pushes edited data back into that world', async () => {
  const f = await cliFixture(cleanups);
  const { task, world, num } = await f.cloudTask('Clean the data');
  fs.writeFileSync(path.join(world.handle.root, 'data', 'from-agent.txt'), 'the agent wrote this');

  const ref = `${f.project.id}#${num}`;
  const cloned = await f.tavya(f.laptop, ['clone', ref, 'task-ws']);
  expect(cloned.code, cloned.stderr).toBe(0);
  const ws = path.join(f.laptop, 'task-ws');
  expect((await gitOrThrow(path.join(ws, 'site'), ['branch', '--show-current']))).toBe(world.handle.branch);
  // The data is the version the world started from.
  expect(files(path.join(ws, 'site', 'data'))).toEqual(files(path.join(world.handle.root, 'data')).filter((file) => file !== 'from-agent.txt'));

  // `exec` runs one command in the world, streaming its output and exit code.
  const listed = await f.tavya(ws, ['exec', '--', 'sh', '-c', 'cat data/from-agent.txt; exit 3']);
  expect(listed.stdout).toContain('the agent wrote this');
  expect(listed.code).toBe(3);

  // Edit the data on the laptop and push: it replaces the world's private copy exactly.
  fs.writeFileSync(path.join(ws, 'site', 'data', 'laptop.txt'), 'edited on a laptop');
  fs.rmSync(path.join(ws, 'site', 'data', 'pages', '1.txt'));
  const pushed = await f.tavya(ws, ['push', '--json']);
  expect(pushed.code, pushed.stderr).toBe(0);
  expect(JSON.parse(pushed.stdout)).toMatchObject({ resources: { raw_data: 'pushed' }, imported: { resources: [f.data.id], parked: true } });
  expect(files(path.join(world.handle.root, 'data'))).toEqual(files(path.join(ws, 'site', 'data')));
  expect(fs.existsSync(path.join(world.handle.root, 'data', 'from-agent.txt'))).toBe(false);
  // The project's version is unchanged: the task publishes at Confirm.
  expect((await f.store.getResourceAttachment(f.data.id))?.currentRevisionId).toBe(f.first.id);
  expect((await f.store.eventsSince(task.id, 0)).some((event) => event.type === 'world.resource-imported')).toBe(true);

  // A Viewer may read the task, but not push into it or run commands in it.
  const viewer = await f.tavya(ws, ['exec', '--', 'true'], { token: f.viewer });
  expect(viewer.code).not.toBe(0);
  expect(viewer.stderr).toContain('task:edit');
});

it('lends the organization\'s GitHub access to Git only when the organization allows it', async () => {
  const repositoryCredential = vi.fn(async (_repository: unknown, access: 'read' | 'write') => ({ token: `ghs_${access}`, expiresAt: Date.now() + 3_600_000 }));
  const f = await cliFixture(cleanups, { githubApp: { repositoryCredential } as any });
  const ask = (token?: string) => f.tavya(path.join(f.laptop, 'ws', 'site'), ['git-credential', 'get'],
    { input: 'protocol=https\nhost=github.com\npath=acme/site.git\n\n', ...(token ? { token } : {}) });
  // Off by default: the helper answers nothing.
  expect((await f.tavya(f.laptop, ['clone', f.project.id, 'ws'])).code).toBe(0);
  const off = await ask();
  expect(off.stdout).toBe('');
  expect(off.stderr).toContain('does not lend its GitHub access');
  expect(repositoryCredential).not.toHaveBeenCalled();

  // Only an administrator (organization:edit) may turn it on.
  const toggle = (token: string) => fetch(`${f.server.url}/api/organizations/${f.project.organizationId}/cli-git-credentials`, { method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  expect((await toggle(f.maintainer)).status).toBe(403);
  const admin = (await f.tokens.mintPrincipal('user:carol', capsOf('administrator'), undefined, 3_600_000, f.project.organizationId)).token;
  expect((await toggle(admin)).status).toBe(200);

  const write = await ask();
  expect(write.stdout).toContain('username=x-access-token\npassword=ghs_write\n');
  const read = await ask(f.viewer);
  expect(read.stdout).toContain('password=ghs_read');
  expect(repositoryCredential.mock.calls.map(([, access]) => access)).toEqual(['write', 'read']);
  // Another host or a repository outside the project gets no answer.
  expect((await f.tavya(path.join(f.laptop, 'ws', 'site'), ['git-credential', 'get'],
    { input: 'protocol=https\nhost=github.com\npath=someone/else.git\n\n' })).stdout).toBe('');

  // With the setting on, a workspace can clone through tavya with no GitHub access of its own.
  const via = await f.tavya(f.laptop, ['clone', f.project.id, 'via', '--git-via-tavya']);
  expect(via.code, via.stderr).toBe(0);
  const config = fs.readFileSync(path.join(f.laptop, 'via', 'site', '.git', 'config'), 'utf8');
  expect(config).toMatch(/\[credential "https:\/\/github\.com"\][^[]*helper = !.*git-credential/);
  expect(config).toContain('url = https://github.com/acme/site.git');
});

it('imports a local checkout: links the repository, its .env as secrets, secret files and data', async () => {
  const f = await cliFixture(cleanups);
  const checkout = path.join(f.laptop, 'site');
  await gitOrThrow(f.laptop, ['clone', '-q', 'git@github.com:acme/site.git', checkout], { env: { GIT_CONFIG_GLOBAL: f.gitconfig } });
  fs.writeFileSync(path.join(checkout, '.env'), 'STRIPE_KEY=sk_test_1\nDEBUG=1\n');
  fs.mkdirSync(path.join(checkout, 'secrets'));
  fs.writeFileSync(path.join(checkout, 'secrets', 'credentials.json'), '{"client":"x"}');
  fs.mkdirSync(path.join(checkout, 'data', 'raw'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'data', 'raw', 'a.csv'), 'id\n1\n');
  expect(planImport(checkout, ['.env', 'secrets/credentials.json', 'data/raw/a.csv', 'node_modules/x/index.js', '.env.example'])).toEqual({
    environmentFiles: ['.env'], secretFiles: ['secrets/credentials.json'], data: [{ path: 'data', shape: 'directory', bytes: 5, access: 'read' }],
    leftOut: [{ path: '.env.example', bytes: 0 }] });
  expect(githubRepository('https://github.com/acme/site.git')).toEqual({ owner: 'acme', name: 'site' });

  const without = await f.tavya(checkout, ['import', '--name', 'Site Builder']);
  expect(without.code).toBe(2);
  expect(without.stderr).toContain('--yes');
  const imported = await f.tavya(checkout, ['import', '--yes', '--name', 'Site Builder', '--json']);
  expect(imported.code, imported.stderr).toBe(0);
  const result = JSON.parse(imported.stdout);
  expect(result.project.id).toBe(f.project.id);
  expect(result.secrets).toEqual(expect.arrayContaining(['STRIPE_KEY', 'DEBUG', 'credentials.json']));
  expect(result.data).toEqual(['data']);
  // The data is now the project's version: a fresh clone gets exactly it.
  expect((await f.tavya(f.laptop, ['clone', f.project.id, 'fresh'])).code).toBe(0);
  expect(files(path.join(f.laptop, 'fresh', 'site', 'data'))).toEqual(['raw/a.csv']);
  expect(fs.readFileSync(path.join(f.laptop, 'fresh', 'site', 'secrets', 'credentials.json'), 'utf8')).toBe('{"client":"x"}');
  const env = await f.tavya(path.join(f.laptop, 'fresh'), ['env', '--json']);
  expect(JSON.parse(env.stdout)).toMatchObject({ STRIPE_KEY: 'sk_test_1', DEBUG: '1', API_KEY: 's3cret' });
});
