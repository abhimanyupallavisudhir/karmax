import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import type { WorldHandle } from '../src/world/types.js';
import { commitMessage } from '../src/world/project-file-changes.js';
import { capsOf, projectFilesFixture, sh } from './helpers/project-files-fixture.js';

// Changing the project's Files (wiki features/project-files): uploads, edits,
// new files and folders, deletes, copies and moves. In a branch view each
// batch is one commit pushed straight to the branch (real bare "GitHub"
// remotes); in a task's view it is written into the task's world (a real
// worktree world).

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(files: Record<string, string> = {}) {
  const f = await projectFilesFixture(cleanups, { files });
  const developer = await f.tokenFor(capsOf('developer') as string[]);
  const bare = path.join(f.remotes, f.owner, 'site.git');
  const post = (route: string, token: string, body: string | Buffer, query = '', type = 'application/json') =>
    fetch(`${f.server.url}/api/projects/${f.project.id}/files/${route}${query ? `?${query}` : ''}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: body as string });
  const change = async (token: string, changes: unknown[], query = '') => {
    const response = await post('changes', token, JSON.stringify({ changes }), query);
    return { status: response.status, body: await response.json() as any };
  };
  const upload = async (token: string, bytes: Buffer | string) =>
    (await (await post('uploads', token, bytes, '', 'application/octet-stream')).json() as any).upload as string;
  const show = (file: string, ref = 'main') => sh(bare, 'show', `${ref}:${file}`);
  const listed = (ref = 'main') => sh(bare, 'ls-tree', '-r', '--name-only', ref).trim().split('\n');
  const plan = async (token: string, items: Array<{ path: string; size: number }>, query = '') =>
    (await post('plan', token, JSON.stringify({ items }), query)).json() as Promise<any>;
  const read = async (file: string, token = developer) => (await f.get(file, token, true)).text();
  return { ...f, developer, bare, change, upload, show, listed, plan, read };
}

it('commits uploads, edits, new folders, copies, moves and deletes straight to the branch', async () => {
  const f = await fixture();
  const before = sh(f.bare, 'rev-parse', 'main').trim();
  // Two uploaded files and a new text file, in one batch: one commit.
  const one = await f.upload(f.developer, 'first upload\n');
  const two = await f.upload(f.developer, Buffer.from([0, 1, 2, 3]));
  const added = await f.change(f.developer, [
    { op: 'write', path: 'site/uploads/one.txt', upload: one },
    { op: 'write', path: 'site/uploads/deep/two.bin', upload: two },
    { op: 'write', path: 'site/notes.md', text: '# Notes\n', expect: null },
  ]);
  expect(added.status).toBe(200);
  expect(added.body.commits).toEqual([{ repository: 'site', branch: 'main', commit: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
  expect(sh(f.bare, 'rev-parse', 'main~1').trim()).toBe(before);
  expect(f.show('uploads/one.txt')).toBe('first upload\n');
  expect(sh(f.bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('Add or update 3 files');
  // Files shows it at once (the 30-second tip window is forgotten after a push).
  const shown = await (await f.get('site/uploads', f.developer)).json();
  expect(shown.entries.map((entry: any) => entry.name)).toEqual(['deep', 'one.txt']);
  expect(shown.writable).toBe(true);
  // A new file that already exists is refused, not overwritten.
  expect((await f.change(f.developer, [{ op: 'write', path: 'site/notes.md', text: 'again', expect: null }])).status).toBe(409);

  // An editor's save: replaces what it opened; a stale save is refused.
  const readme = await (await f.get('site/README.md', f.developer)).json();
  expect((await f.change(f.developer, [{ op: 'write', path: 'site/README.md', text: '# Site, edited\n', expect: readme.version }])).status).toBe(200);
  expect(f.show('README.md')).toBe('# Site, edited\n');
  expect(sh(f.bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('Update README.md');
  const stale = await f.change(f.developer, [{ op: 'write', path: 'site/README.md', text: 'lost', expect: readme.version }]);
  expect(stale).toMatchObject({ status: 409, body: { error: 'README.md changed since you opened it.' } });

  // A new folder holds a .gitkeep; a folder copies whole; a rename is a move.
  expect((await f.change(f.developer, [{ op: 'mkdir', path: 'site/empty' }])).status).toBe(200);
  expect(f.listed()).toContain('empty/.gitkeep');
  expect((await f.change(f.developer, [{ op: 'copy', from: 'site/src', to: 'site/src-copy' }])).status).toBe(200);
  expect(f.show('src-copy/app.ts')).toBe('export const answer = 42;\n');
  expect((await f.change(f.developer, [{ op: 'move', from: 'site/docs/guide.md', to: 'site/docs/handbook.md' }])).status).toBe(200);
  expect(sh(f.bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('Rename guide.md to handbook.md');
  expect(f.listed()).toContain('docs/handbook.md');
  expect(f.listed()).not.toContain('docs/guide.md');
  expect((await f.change(f.developer, [{ op: 'copy', from: 'site/src', to: 'site/src/inner' }])).status).toBe(409);

  // Deleting a folder takes everything in it.
  expect((await f.change(f.developer, [{ op: 'delete', path: 'site/src-copy' }])).status).toBe(200);
  expect(f.listed().some((file) => file.startsWith('src-copy/'))).toBe(false);
  expect((await f.change(f.developer, [{ op: 'delete', path: 'site/no-such' }])).status).toBe(404);
});

it('commits a folder of thousands of files as one commit, quickly (a bot’s data, 2026-11-17)', async () => {
  const f = await fixture();
  const before = sh(f.bare, 'rev-parse', 'main').trim();
  const count = 3000; // over the old 2,000-change and 2,000-staged-file caps
  const uploads: string[] = [];
  for (let at = 0; at < count; at += 50)
    uploads.push(...await Promise.all(Array.from({ length: Math.min(50, count - at) }, (_, i) => f.upload(f.developer, `item ${at + i}\n`))));
  const started = Date.now();
  const result = await f.change(f.developer, uploads.map((upload, i) => ({ op: 'write', path: `site/bot_data/part-${i % 7}/item-${i}.txt`, upload })));
  const took = Date.now() - started;
  expect(result.status).toBe(200);
  expect(sh(f.bare, 'rev-parse', 'main~1').trim()).toBe(before);
  const listed = f.listed();
  expect(listed.filter((file) => file.startsWith('bot_data/'))).toHaveLength(count);
  expect(f.show('bot_data/part-3/item-2999.txt')).toBe('item 2999\n');
  expect(sh(f.bare, 'log', '-1', '--format=%s', 'main').trim()).toBe(`Add or update ${count} files`);
  // The commit is built from one read of the index and one hash-object, not processes per file.
  expect(took).toBeLessThan(30_000);
  // The same rules still hold in a big batch: a file where a folder must go, and an existing new file.
  const one = await f.upload(f.developer, 'x');
  const two = await f.upload(f.developer, 'y');
  expect(await f.change(f.developer, [{ op: 'write', path: 'site/README.md/inner.txt', upload: one }]))
    .toMatchObject({ status: 409, body: { error: 'README.md is a file.' } });
  expect(await f.change(f.developer, [{ op: 'write', path: 'site/bot_data', upload: two }]))
    .toMatchObject({ status: 409, body: { error: 'bot_data is a folder.' } });
});

it('drops a staged upload its uploader gives up on, and only theirs', async () => {
  const f = await fixture();
  const other = (await f.tokens.mintPrincipal('user:bob', capsOf('developer') as string[], f.project.id)).token;
  const drop = (token: string, id: string) => fetch(`${f.server.url}/api/projects/${f.project.id}/files/uploads/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  const kept = await f.upload(f.developer, 'kept\n');
  const dropped = await f.upload(f.developer, 'dropped\n');
  // Someone else cannot drop it (and is not told whether it exists).
  expect((await drop(other, kept)).status).toBe(204);
  expect((await drop(f.developer, dropped)).status).toBe(204);
  expect((await f.change(f.developer, [{ op: 'write', path: 'site/kept.txt', upload: kept }])).status).toBe(200);
  expect(await f.change(f.developer, [{ op: 'write', path: 'site/dropped.txt', upload: dropped }]))
    .toMatchObject({ status: 400, body: { error: 'That upload is gone: upload the file again.' } });
  expect(f.show('kept.txt')).toBe('kept\n');
});

it('refuses what is not a file in a repository, and people who may not land on the branch', async () => {
  const f = await fixture();
  // A viewer reads but may not change (no merge-into).
  const asViewer = await (await f.get('site', f.viewer)).json();
  expect(asViewer.writable).toBe(false);
  expect((await f.change(f.viewer, [{ op: 'write', path: 'site/x.txt', text: 'x' }])).status).toBe(403);
  // The project's root, a repository's own folder, data, Git's own files.
  expect((await (await f.get('', f.developer)).json()).writable).toBe(false);
  expect((await f.change(f.developer, [{ op: 'write', path: 'x.txt', text: 'x' }])).status).toBe(403);
  expect((await f.change(f.developer, [{ op: 'delete', path: 'site' }])).status).toBe(403);
  expect((await f.change(f.developer, [{ op: 'write', path: 'site/data/raw/new.txt', text: 'x' }])).body.error).toMatch(/needs project settings access/);
  expect((await (await f.get('site/data/raw', f.developer)).json()).writable).toBe(false);
  expect((await f.change(f.developer, [{ op: 'write', path: 'site/.git/config', text: 'x' }])).status).toBe(403);
  expect((await f.change(f.developer, [{ op: 'delete', path: '../etc' }])).status).toBe(404);
  // An upload is its uploader's alone.
  const theirs = await f.upload(f.developer, 'mine');
  const bob = (await f.tokens.mintPrincipal('user:bob', capsOf('developer') as string[], f.project.id)).token;
  expect((await f.change(bob, [{ op: 'write', path: 'site/y.txt', upload: theirs }])).body.error).toMatch(/upload the file again/);
  expect(f.listed()).not.toContain('y.txt');
});

it('writes a branch view to the repositories that have the branch', async () => {
  const f = await fixture();
  sh(f.bare, 'branch', 'feature', 'main');
  const feature = await (await fetch(`${f.server.url}/api/projects/${f.project.id}/files?path=site&branch=feature`,
    { headers: { authorization: `Bearer ${f.developer}` } })).json() as any;
  expect(feature.writable).toBe(true);
  expect((await f.change(f.developer, [{ op: 'write', path: 'site/feature.txt', text: 'on feature\n' }], 'branch=feature')).status).toBe(200);
  expect(f.show('feature.txt', 'feature')).toBe('on feature\n');
  expect(f.listed('main')).not.toContain('feature.txt');
  // The wiki has no such branch: it shows its default, read-only.
  const wiki = await (await fetch(`${f.server.url}/api/projects/${f.project.id}/files?path=site-wiki&branch=feature`,
    { headers: { authorization: `Bearer ${f.developer}` } })).json() as any;
  expect(wiki.writable).toBe(false);
  expect((await f.change(f.developer, [{ op: 'write', path: 'site-wiki/x.md', text: 'x' }], 'branch=feature')).body.error).toBe('site-wiki has no branch feature.');
});

it('changes a task’s world in place, and pastes between it and the default view', async () => {
  const f = await fixture();
  // Changing a task's files is editing the task (as its terminal is): a maintainer may.
  f.developer = await f.tokenFor(capsOf('maintainer') as string[]);
  const task = await f.store.createTask({ projectId: f.project.id, title: 'Edit files', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } });
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(f.dir, 'task-worlds')));
  const world = await worlds.create('worktree', { taskId: task.id, repos: [f.site.work], base: 'main' });
  world.handle.meta = { projectId: f.project.id };
  const handle = await f.store.registerWorld(world.handle, f.project.id) as WorldHandle;
  await f.store.setWorldState(handle, 'ready');
  const root = handle.root;
  const query = `task=${task.num}`;
  const get = async (file: string) => (await fetch(`${f.server.url}/api/projects/${f.project.id}/files?path=${encodeURIComponent(file)}&${query}`,
    { headers: { authorization: `Bearer ${f.developer}` } })).json() as Promise<any>;

  const top = await get('');
  expect(top).toMatchObject({ writable: true, view: { mode: 'live' } });
  const readme = await get('README.md');
  expect(readme.version).toMatch(/^\d+-\d+$/);
  const bytes = await f.upload(f.developer, 'uploaded into the world\n');
  expect((await f.change(f.developer, [
    { op: 'write', path: 'uploads/a.txt', upload: bytes },
    { op: 'mkdir', path: 'empty' },
    { op: 'write', path: 'README.md', text: '# Edited in the world\n', expect: readme.version },
    { op: 'copy', from: 'src', to: 'src-copy' },
    { op: 'move', from: 'docs', to: 'handbook' },
    { op: 'delete', path: 'logo.bin' },
  ], query)).status).toBe(200);
  expect(fs.readFileSync(path.join(root, 'uploads/a.txt'), 'utf8')).toBe('uploaded into the world\n');
  expect(fs.statSync(path.join(root, 'empty')).isDirectory()).toBe(true);
  expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('# Edited in the world\n');
  expect(fs.readFileSync(path.join(root, 'src-copy/app.ts'), 'utf8')).toBe('export const answer = 42;\n');
  expect(fs.existsSync(path.join(root, 'handbook/guide.md'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'docs'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'logo.bin'))).toBe(false);
  // Nothing tavya stages is left behind; a stale save, Git's files and .env are refused.
  expect(fs.readdirSync(path.join(root, '.karmax-injection/file-changes'))).toEqual([]);
  expect((await f.change(f.developer, [{ op: 'write', path: 'README.md', text: 'lost', expect: readme.version }], query)).status).toBe(409);
  expect((await f.change(f.developer, [{ op: 'write', path: '.git/config', text: 'x' }], query)).status).toBe(404);
  expect((await f.change(f.developer, [{ op: 'write', path: '.env', text: 'SECRET=1' }], query)).status).toBe(404);
  fs.symlinkSync('/etc', path.join(root, 'out'));
  expect((await f.change(f.developer, [{ op: 'write', path: 'out/x', text: 'x' }], query)).status).toBe(403);

  // Paste across views: the default view's folder into the task, then back.
  expect((await f.change(f.developer, [{ op: 'copy', from: 'site/src', to: 'from-default', fromDefault: true }], query)).status).toBe(200);
  expect(fs.readFileSync(path.join(root, 'from-default/weird name #1.txt'), 'utf8')).toBe('spaces and a hash\n');
  expect((await f.change(f.developer, [{ op: 'move', from: 'uploads', to: 'site/from-task', fromTask: task.num }])).status).toBe(200);
  expect(f.show('from-task/a.txt')).toBe('uploaded into the world\n');
  expect(fs.existsSync(path.join(root, 'uploads'))).toBe(false);

  // Someone who may not edit the task reads it, but changes nothing.
  const viewerRoot = await (await fetch(`${f.server.url}/api/projects/${f.project.id}/files?path=&${query}`,
    { headers: { authorization: `Bearer ${f.viewer}` } })).json() as any;
  expect(viewerRoot.writable).toBe(false);
  expect((await f.change(f.viewer, [{ op: 'delete', path: 'README.md' }], query)).status).toBe(403);
  // A released world is read-only.
  await f.store.setWorldState(handle, 'released');
  expect((await f.change(f.developer, [{ op: 'delete', path: 'README.md' }], query)).body.error).toMatch(/read-only/);
});

it('recommends where each upload belongs: Git, data or a secret', async () => {
  const f = await fixture({ '.gitignore': 'build/\n*.log\n', 'src/.gitignore': 'cache/\n' });
  const maintainer = await f.tokenFor(capsOf('maintainer') as string[]);
  const planned = await f.plan(maintainer, [
    { path: 'site/notes.md', size: 10 },
    { path: 'site/.env', size: 20 },
    { path: 'site/.env.example', size: 20 },
    { path: 'site/certs/server.pem', size: 900 },
    { path: 'site/video.mp4', size: 60 * 1024 * 1024 },
    { path: 'site/app.sqlite', size: 4096 },
    { path: 'site/build/out.js', size: 10 },
    { path: 'site/debug.log', size: 10 },
    { path: 'site/src/cache/x.bin', size: 10 },
    { path: 'site/data/raw/pages/c.txt', size: 3 },
  ]);
  expect(planned.canKeep).toBe(true);
  expect(planned.items.map((item: any) => [item.path, item.keep, item.why ?? '', item.fixed ?? false])).toEqual([
    ['site/notes.md', 'git', '', false],
    ['site/.env', 'secret', 'Holds environment variables', false],
    ['site/.env.example', 'git', '', false],
    ['site/certs/server.pem', 'secret', 'Looks like credentials', false],
    ['site/video.mp4', 'data', 'Over 50 MB', false],
    ['site/app.sqlite', 'data', 'A database', false],
    ['site/build/out.js', 'data', 'Git ignores it', false],
    ['site/debug.log', 'data', 'Git ignores it', false],
    ['site/src/cache/x.bin', 'data', 'Git ignores it', false],
    ['site/data/raw/pages/c.txt', 'data', 'Inside data', true],
  ]);
  // Keeping data or secrets is a settings write: a developer is told, and keeps to Git.
  expect((await f.plan(f.developer, [{ path: 'site/notes.md', size: 1 }])).canKeep).toBe(false);
});

it('keeps an upload as a secret or as new data instead of committing it', async () => {
  const f = await fixture();
  const maintainer = await f.tokenFor(capsOf('maintainer') as string[]);
  const before = sh(f.bare, 'rev-parse', 'main').trim();
  const env = await f.upload(maintainer, 'API_KEY=s3cret\nPORT=8080\n');
  const pem = await f.upload(maintainer, '-----BEGIN KEY-----\nabc\n-----END KEY-----\n');
  const a = await f.upload(maintainer, 'frame a');
  const b = await f.upload(maintainer, 'frame b');
  const model = await f.upload(maintainer, Buffer.alloc(1000, 7));
  const kept = await f.change(maintainer, [
    { op: 'write', path: 'site/.env', upload: env, keep: 'secret' },
    { op: 'write', path: 'site/certs/server.pem', upload: pem, keep: 'secret' },
    { op: 'write', path: 'site/assets/frames/a.txt', upload: a, keep: 'data', dataFolder: 'site/assets/frames' },
    { op: 'write', path: 'site/assets/frames/deep/b.txt', upload: b, keep: 'data', dataFolder: 'site/assets/frames' },
    { op: 'write', path: 'site/models/weights.bin', upload: model, keep: 'data' },
    { op: 'write', path: 'site/readme-2.md', text: 'in Git\n' },
  ]);
  expect(kept.status).toBe(200);
  expect(kept.body.secrets.sort()).toEqual(['site/.env:API_KEY', 'site/.env:PORT', 'site/certs/server.pem'].sort());
  expect(kept.body.data).toEqual([{ name: 'frames', created: true }, { name: 'weights.bin', created: true }]);
  // Only the Git file was committed; nothing secret reached the repository.
  expect(sh(f.bare, 'rev-parse', 'main~1').trim()).toBe(before);
  expect(f.listed()).toContain('readme-2.md');
  expect(f.listed().some((file) => /\.env|server\.pem|frames|weights/.test(file))).toBe(false);
  // Secrets are stored where a world puts them: the .env's variables as its lines.
  const secrets = (await f.store.listResourceAttachments(f.project.id, true)).filter((resource) => resource.driver === 'secret@1');
  expect(secrets.map((secret) => [secret.name, secret.target]).sort()).toEqual([
    ['site/.env:API_KEY', { kind: 'environment', name: 'API_KEY', dotenv: { path: '.env', repository: 'site' } }],
    ['site/.env:PORT', { kind: 'environment', name: 'PORT', dotenv: { path: '.env', repository: 'site' } }],
    ['site/certs/server.pem', { kind: 'path', path: 'certs/server.pem', repository: 'site' }],
  ].sort());
  // Data shows in Files where it was uploaded: a folder of data, and one file of data.
  const frames = await (await f.get('site/assets/frames', maintainer)).json();
  expect(frames).toMatchObject({ source: { kind: 'data', name: 'frames' } });
  expect(frames.entries.map((entry: any) => entry.name)).toEqual(['deep', 'a.txt']);
  expect(await f.read('site/assets/frames/deep/b.txt', maintainer)).toBe('frame b');
  const models = await (await f.get('site/models', maintainer)).json();
  expect(models.entries).toEqual([{ name: 'weights.bin', kind: 'file', mount: 'data', size: 1000 }]);
  expect(Buffer.from(await (await f.get('site/models/weights.bin', maintainer, true)).arrayBuffer()).equals(Buffer.alloc(1000, 7))).toBe(true);
  // Binary is not kept as a secret; a developer keeps nothing outside Git.
  const binary = await f.upload(maintainer, Buffer.from([1, 0, 2]));
  expect((await f.change(maintainer, [{ op: 'write', path: 'site/x.key', upload: binary, keep: 'secret' }])).body.error).toMatch(/only text is kept as a secret/);
  const theirs = await f.upload(f.developer, 'X=1');
  expect((await f.change(f.developer, [{ op: 'write', path: 'site/.env', upload: theirs, keep: 'secret' }])).status).toBe(403);
});

it('replaces, adds and deletes files in data: each batch one new version', async () => {
  const f = await fixture();
  const maintainer = await f.tokenFor(capsOf('maintainer') as string[]);
  const versions = async () => (await f.store.getResourceAttachment(f.data.id))!.currentRevisionId;
  const first = await versions();
  const page = await (await f.get('site/data/raw/pages/a.txt', maintainer)).json();
  expect(page.writable).toBe(true);
  expect((await (await f.get('site/data/raw', f.developer)).json()).writable).toBe(false);
  const added = await f.upload(maintainer, 'gamma\n');
  const result = await f.change(maintainer, [
    { op: 'write', path: 'site/data/raw/pages/a.txt', text: 'alpha, replaced\n', expect: page.version },
    { op: 'write', path: 'site/data/raw/pages/c.txt', upload: added },
    { op: 'delete', path: 'site/data/raw/big.bin' },
    { op: 'move', from: 'site/data/raw/pages/b.csv', to: 'site/data/raw/tables/b.csv' },
  ]);
  expect(result).toMatchObject({ status: 200, body: { commits: [], data: [{ name: 'raw_data' }] } });
  const second = await versions();
  expect(second).not.toBe(first);
  expect((await f.store.getResourceRevision(second!))!.parentRevisionId).toBe(first);
  expect(await f.read('site/data/raw/pages/a.txt', maintainer)).toBe('alpha, replaced\n');
  expect(await f.read('site/data/raw/pages/c.txt', maintainer)).toBe('gamma\n');
  expect(await f.read('site/data/raw/tables/b.csv', maintainer)).toBe('x,y\n1,2\n');
  expect((await (await f.get('site/data/raw', maintainer)).json()).entries.map((entry: any) => entry.name)).toEqual(['pages', 'tables']);
  // A stale save is refused; the resource itself is not removed from here.
  const stale = await f.change(maintainer, [{ op: 'write', path: 'site/data/raw/pages/a.txt', text: 'lost', expect: page.version }]);
  expect(stale).toMatchObject({ status: 409, body: { error: 'a.txt changed since you opened it.' } });
  expect((await f.change(maintainer, [{ op: 'delete', path: 'site/data/raw' }])).body.error).toMatch(/is data: remove or move it in Settings/);
  expect(await versions()).toBe(second);
  // Copying from a repository into data reads it first, then saves one version.
  expect((await f.change(maintainer, [{ op: 'copy', from: 'site/src/app.ts', to: 'site/data/raw/app.ts' }])).status).toBe(200);
  expect(await f.read('site/data/raw/app.ts', maintainer)).toBe('export const answer = 42;\n');
});

it('says what a commit did, as a person would', () => {
  expect(commitMessage([{ op: 'write', path: 'a/b.md' }])).toBe('Update b.md');
  expect(commitMessage([{ op: 'delete', path: 'a/b.md' }])).toBe('Delete b.md');
  expect(commitMessage([{ op: 'mkdir', path: 'a/new' }])).toBe('Create new');
  expect(commitMessage([{ op: 'copy', from: 'a', to: 'b' }, { op: 'delete', path: 'a' }])).toBe('Rename a to b');
  expect(commitMessage([{ op: 'write', path: 'x' }, { op: 'write', path: 'y' }, { op: 'delete', path: 'z' }])).toBe('Add or update 2 files, delete 1 item');
});
