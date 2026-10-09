import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gitOrThrow } from '../src/world/git.js';
import { parseRef } from '../src/cli/refs.js';
import { githubSshAliases } from '../src/cli/commands/sync.js';
import { cliFixture, files } from './helpers/cli-fixture.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = () => cliFixture(cleanups);

it('clones a project as its world: repositories and wiki, data, secret files; status, run, setup', async () => {
  const f = await fixture();
  const cloned = await f.tavya(f.laptop, ['clone', f.project.id, 'ws']);
  expect(cloned.code, cloned.stderr).toBe(0);
  expect(cloned.stdout).toContain('cd ws/site');
  const ws = path.join(f.laptop, 'ws');
  expect(fs.readFileSync(path.join(ws, 'site', 'README.md'), 'utf8')).toBe('# site\n');
  expect(fs.existsSync(path.join(ws, 'site-wiki', '.git'))).toBe(true);
  for (const file of f.corpus) expect(fs.readFileSync(path.join(ws, 'site', 'data', file.path)).equals(file.data)).toBe(true);
  const secretFile = path.join(ws, 'site', 'config', 'sa.json');
  expect(fs.readFileSync(secretFile, 'utf8')).toBe('{"key":"x"}');
  expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
  const excluded = fs.readFileSync(path.join(ws, 'site', '.git', 'info', 'exclude'), 'utf8');
  expect(excluded).toContain('/data');
  expect(excluded).toContain('/config/sa.json');
  // Nothing tavya wrote shows up as a change in the repository.
  const status = await f.tavya(path.join(ws, 'site'), ['status', '--json']);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ repositories: { site: { branch: 'main', uncommitted: 0 } },
    resources: { raw_data: { localChanges: 0, newerOnServer: false } } });

  const run = await f.tavya(path.join(ws, 'site'), ['run', '--', process.execPath, '-e', 'process.stdout.write(process.env.API_KEY ?? "missing")']);
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toBe('s3cret');
  const env = await f.tavya(ws, ['env', '--format', 'shell']);
  expect(env.stdout.trim()).toBe("export API_KEY=s3cret");
  const exitCode = await f.tavya(ws, ['run', '--', process.execPath, '-e', 'process.exit(7)']);
  expect(exitCode.code).toBe(7);

  const setup = await f.tavya(ws, ['setup']);
  expect(setup.code, setup.stderr).toBe(0);
  expect(fs.readFileSync(path.join(ws, 'site', 'installed.txt'), 'utf8').trim()).toBe('installed');

  // A Viewer can clone the code and data, but not read secret values.
  const viewer = await f.tavya(f.laptop, ['clone', f.project.id, 'viewer-ws'], { token: f.viewer });
  expect(viewer.code, viewer.stderr).toBe(0);
  expect(viewer.stderr).toContain('secret files not written');
  expect(fs.existsSync(path.join(f.laptop, 'viewer-ws', 'site', 'config', 'sa.json'))).toBe(false);
  expect((await f.tavya(path.join(f.laptop, 'viewer-ws'), ['run', '--', 'true'], { token: f.viewer })).code).toBe(1);
});

it('pushes commits and data, pulls them into another workspace, and refuses a stale data push unless overwriting', async () => {
  const f = await fixture();
  expect((await f.tavya(f.laptop, ['clone', f.project.id, 'one'])).code).toBe(0);
  expect((await f.tavya(f.laptop, ['clone', f.project.id, 'two'])).code).toBe(0);
  const one = path.join(f.laptop, 'one'); const two = path.join(f.laptop, 'two');

  fs.writeFileSync(path.join(one, 'site', 'data', 'pages', 'new.txt'), 'from laptop one');
  fs.rmSync(path.join(one, 'site', 'data', 'pages', '0.txt'));
  fs.writeFileSync(path.join(one, 'site', 'CHANGELOG.md'), 'change\n');
  await gitOrThrow(path.join(one, 'site'), ['add', '-A']);
  await gitOrThrow(path.join(one, 'site'), ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'from one']);
  const diff = await f.tavya(one, ['diff']);
  expect(diff.stdout).toContain('+ pages/new.txt');
  expect(diff.stdout).toContain('- pages/0.txt');
  const pushed = await f.tavya(one, ['push', '--json']);
  expect(pushed.code, pushed.stderr).toBe(0);
  expect(JSON.parse(pushed.stdout)).toMatchObject({ repositories: { site: 'pushed' }, resources: { raw_data: 'pushed' } });
  const attachment = await f.store.getResourceAttachment(f.data.id);
  const revision = await f.store.getResourceRevision(attachment!.currentRevisionId!);
  expect(revision?.metadata).toMatchObject({ workspace: true });
  expect((await f.tavya(one, ['push', '--json'])).stdout).toContain('{');

  // Laptop two: status sees the newer version; pull brings code and data.
  expect(JSON.parse((await f.tavya(two, ['status', '--json'])).stdout).resources.raw_data.newerOnServer).toBe(true);
  const pulled = await f.tavya(two, ['pull', '--json']);
  expect(pulled.code, pulled.stderr).toBe(0);
  expect(JSON.parse(pulled.stdout)).toMatchObject({ repositories: { site: 'updated' }, resources: { raw_data: 'pulled' } });
  expect(fs.readFileSync(path.join(two, 'site', 'CHANGELOG.md'), 'utf8')).toBe('change\n');
  expect(files(path.join(two, 'site', 'data'))).toEqual(files(path.join(one, 'site', 'data')));
  expect(fs.existsSync(path.join(two, 'site', 'data', 'pages', '0.txt'))).toBe(false);

  // Two edits from the same version: the second push is refused, then overwrites on request.
  fs.writeFileSync(path.join(one, 'site', 'data', 'pages', 'one.txt'), 'one');
  fs.writeFileSync(path.join(two, 'site', 'data', 'pages', 'two.txt'), 'two');
  expect((await f.tavya(one, ['push'])).code).toBe(0);
  const refused = await f.tavya(two, ['push']);
  expect(refused.code).toBe(4);
  expect(refused.stderr).toContain('changed on the server since you pulled it');
  // Pull will not discard the local edit either.
  const blocked = await f.tavya(two, ['pull', '--json']);
  expect(JSON.parse(blocked.stdout).resources.raw_data).toBe('skipped');
  expect(fs.existsSync(path.join(two, 'site', 'data', 'pages', 'two.txt'))).toBe(true);
  const overwritten = await f.tavya(two, ['push', '--overwrite']);
  expect(overwritten.code, overwritten.stderr).toBe(0);
  expect((await f.tavya(one, ['pull', '--force'])).code).toBe(0);
  expect(fs.existsSync(path.join(one, 'site', 'data', 'pages', 'two.txt'))).toBe(true);
  expect(fs.existsSync(path.join(one, 'site', 'data', 'pages', 'one.txt'))).toBe(false);
});

it('parses console URLs and short references', () => {
  expect(parseRef('https://tavya.io/acme/site-builder/tasks/12')).toEqual({ server: 'https://tavya.io', organization: 'acme', project: 'site-builder', task: '12' });
  expect(parseRef('https://tavya.io/acme/site-builder')).toEqual({ server: 'https://tavya.io', organization: 'acme', project: 'site-builder' });
  expect(parseRef('acme/site#3')).toEqual({ organization: 'acme', project: 'site', task: '3' });
  expect(parseRef('site#3')).toEqual({ project: 'site', task: '3' });
  expect(parseRef('#3')).toEqual({ task: '3' });
  expect(parseRef('task_abc')).toEqual({ task: 'task_abc' });
  expect(parseRef('proj_x')).toEqual({ project: 'proj_x' });
});

it('suggests the SSH host alias of the account that can read the repository when GitHub refuses the default key', async () => {
  const f = await fixture();
  // A laptop whose github.com key belongs to another account; acme's key sits behind an alias.
  const home = path.join(f.dir, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host github.com\n  IdentityFile ~/.ssh/id_manyu\n\nHost acme.github.com\n  HostName github.com\n  IdentityFile ~/.ssh/id_acme\n');
  // GitHub over SSH: only the alias's key can read acme's repositories.
  const ssh = path.join(f.dir, 'github-ssh.sh');
  fs.writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\ncase "$*" in *git@acme.github.com*) cd '${f.remotes}' && exec sh -c "$last";; esac\n`
    + 'echo "ERROR: Repository not found." >&2\nexit 1\n', { mode: 0o755 });
  const gitconfig = path.join(f.dir, 'gitconfig-ssh');
  fs.writeFileSync(gitconfig, '[user]\n\tname = Laptop\n\temail = laptop@example.com\n');
  const env = { HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_SSH_COMMAND: ssh };
  const refused = await f.tavya(f.laptop, ['clone', f.project.id, 'ws'], { env });
  expect(refused.code).not.toBe(0);
  const suggestion = 'git config --global url."git@acme.github.com:acme/".insteadOf "git@github.com:acme/"';
  expect(refused.stderr).toContain(suggestion);

  // Running the suggestion is all it takes.
  await gitOrThrow(f.laptop, ['config', '--file', gitconfig, 'url.git@acme.github.com:acme/.insteadOf', 'git@github.com:acme/']);
  const cloned = await f.tavya(f.laptop, ['clone', f.project.id, 'ws2'], { env });
  expect(cloned.code, cloned.stderr).toBe(0);
  expect(fs.readFileSync(path.join(f.laptop, 'ws2', 'site', 'README.md'), 'utf8')).toBe('# site\n');
});

it('reads github.com host aliases from an OpenSSH config', () => {
  expect(githubSshAliases([
    '# personal', 'Host github.com', '  IdentityFile ~/.ssh/id_a',
    'Host srajma.github.com gh-srajma', '  HostName github.com', '  User git',
    'Host *.internal', '  HostName github.com',
    'Host Work', '  hostname = "GitHub.com"',
    'Host gitlab', '  HostName gitlab.com',
    'Match host other', '  HostName github.com',
  ].join('\n'))).toEqual(['srajma.github.com', 'gh-srajma', 'Work']);
  expect(githubSshAliases('')).toEqual([]);
});
