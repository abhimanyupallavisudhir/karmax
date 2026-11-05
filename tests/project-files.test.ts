import { afterEach, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitPath } from '../src/world/project-files.js';
import { projectFilesFixture, sh } from './helpers/project-files-fixture.js';

// The project Files page's API (wiki features/project-files): the project laid
// out as a task's world, read on the host from real Git remotes (through the
// broker's mirror cache) and real restic resource repositories.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const fixture = () => projectFilesFixture(cleanups);

it('lays the project out as a world: repositories, the wiki, and data where it is mounted', async () => {
  const f = await fixture();
  const root = await (await f.get('', f.viewer)).json();
  expect(root).toMatchObject({ path: '', kind: 'directory', source: { kind: 'project' },
    entries: [{ name: 'site', kind: 'directory', mount: 'repository' }, { name: 'site-wiki', kind: 'directory', mount: 'wiki' }] });

  const site = await (await f.get('site', f.viewer)).json();
  expect(site.source).toMatchObject({ kind: 'repository', name: 'site', branch: 'main', commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
  // Folders first; a data mount's folder appears though Git has no data/.
  expect(site.entries.map((entry: any) => [entry.name, entry.kind])).toEqual([
    ['data', 'directory'], ['docs', 'directory'], ['src', 'directory'],
    ['link-to-app', 'symlink'], ['logo.bin', 'file'], ['README.md', 'file']]);
  expect(site.entries.find((entry: any) => entry.name === 'README.md').size).toBe(40);

  const data = await (await f.get('site/data', f.viewer)).json();
  expect(data.entries).toEqual([{ name: 'raw', kind: 'directory', mount: 'data' }]);
  const raw = await (await f.get('site/data/raw', f.viewer)).json();
  expect(raw).toMatchObject({ kind: 'directory', source: { kind: 'data', id: f.data.id, name: 'raw_data', access: 'write' } });
  expect(raw.entries.map((entry: any) => [entry.name, entry.kind, entry.size])).toEqual([['pages', 'directory', undefined], ['big.bin', 'file', 300_000]]);
  const pages = await (await f.get('site/data/raw/pages', f.viewer)).json();
  expect(pages.entries.map((entry: any) => entry.name)).toEqual(['a.txt', 'b.csv']);

  const wiki = await (await f.get('site-wiki', f.viewer)).json();
  expect(wiki.source).toMatchObject({ kind: 'repository', role: 'project-wiki' });
  expect(wiki.entries.map((entry: any) => entry.name)).toEqual(['SPEC.md']);
});

it('reads files from Git and from data, as text, binary, ranges and 304s', async () => {
  const f = await fixture();
  const stat = await (await f.get('site/src/weird name #1.txt', f.viewer)).json();
  expect(stat).toMatchObject({ kind: 'file', size: 18, version: expect.stringMatching(/^[0-9a-f]{40}$/) });
  const text = await f.get('site/src/weird name #1.txt', f.viewer, true);
  expect(text.status).toBe(200);
  expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(text.headers.get('content-security-policy')).toContain('sandbox');
  expect(await text.text()).toBe('spaces and a hash\n');

  const binary = await f.get('site/logo.bin', f.viewer, true);
  expect(binary.headers.get('content-type')).toBe('application/octet-stream');
  expect(Buffer.from(await binary.arrayBuffer()).equals(f.binary)).toBe(true);

  // Byte ranges (media seeking) and the version as ETag.
  const ranged = await f.get('site/logo.bin', f.viewer, true, { range: 'bytes=100-199' });
  expect(ranged.status).toBe(206);
  expect(ranged.headers.get('content-range')).toBe(`bytes 100-199/${f.binary.length}`);
  expect(Buffer.from(await ranged.arrayBuffer()).equals(f.binary.subarray(100, 200))).toBe(true);
  const unchanged = await f.get('site/README.md', f.viewer, true, { 'if-none-match': `"${(await (await f.get('site/README.md', f.viewer)).json()).version}"` });
  expect(unchanged.status).toBe(304);

  const download = await f.get('site/README.md', f.viewer, true, {});
  expect(download.headers.get('content-disposition')).toMatch(/^inline/);
  const saved = await fetch(`${f.server.url}/api/projects/${f.project.id}/files/raw?path=site/README.md&download=1`, { headers: { authorization: `Bearer ${f.viewer}` } });
  expect(saved.headers.get('content-disposition')).toMatch(/^attachment; filename="README.md"/);

  // A symlink names its target; a folder is not a file.
  expect(await (await f.get('site/link-to-app', f.viewer)).json()).toMatchObject({ kind: 'symlink', target: 'src/app.ts' });
  expect((await f.get('site/src', f.viewer, true)).status).toBe(403);

  // Data: listed and read with restic, byte for byte.
  const csv = await f.get('site/data/raw/pages/b.csv', f.viewer, true);
  expect(await csv.text()).toBe('x,y\n1,2\n');
  const big = await f.get('site/data/raw/big.bin', f.viewer, true);
  expect(big.headers.get('content-length')).toBe('300000');
  const bytes = Buffer.from(await big.arrayBuffer());
  expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(crypto.createHash('sha256').update(f.corpus[2]!.data).digest('hex'));
  const tail = await f.get('site/data/raw/big.bin', f.viewer, true, { range: 'bytes=-10' });
  expect(Buffer.from(await tail.arrayBuffer()).equals(f.corpus[2]!.data.subarray(-10))).toBe(true);
});

it('refuses what is not there or not yours to read', async () => {
  const f = await fixture();
  expect((await f.get('site/nope.txt', f.viewer)).status).toBe(404);
  expect((await f.get('elsewhere', f.viewer)).status).toBe(404);
  expect((await f.get('site/../site-wiki', f.viewer)).status).toBe(404);
  expect((await f.get('site/data/raw/pages/zzz.txt', f.viewer)).status).toBe(404);
  // Without repository:read nothing; without project:settings:read the data's
  // mount shows but its contents do not.
  expect((await f.get('', await f.tokenFor(['project:read']))).status).toBe(403);
  const noData = await f.tokenFor(['project:read', 'repository:read']);
  expect((await (await f.get('site/data', noData)).json()).entries).toEqual([{ name: 'raw', kind: 'directory', mount: 'data' }]);
  const refused = await f.get('site/data/raw', noData);
  expect(refused.status).toBe(403);
  expect((await refused.json()).error).toMatch(/project settings/);
  expect((await f.get('site/data/raw/pages/a.txt', noData, true)).status).toBe(403);
});

it('sees a new commit on origin once its tip is no longer trusted', async () => {
  const f = await fixture();
  expect((await (await f.get('site', f.viewer)).json()).entries.some((entry: any) => entry.name === 'NEW.md')).toBe(false);
  fs.writeFileSync(path.join(f.site.work, 'NEW.md'), 'new\n');
  sh(f.site.work, 'add', '-A');
  sh(f.site.work, 'commit', '-qm', 'new');
  sh(f.site.work, 'push', '-q', f.site.bare, 'main');
  const { ProjectFiles } = await import('../src/world/project-files.js');
  // The gateway trusts a tip for 30 s; a fresh reader asks origin again.
  const reader = new ProjectFiles({ store: f.store, workspaces: { project: async () => ({ repositories: [{ name: 'site', role: 'development', sshUrl: `git@github.com:${f.owner}/site.git`, branch: 'main' }], resources: [] }) as any },
    gitCredential: async () => ({}) });
  const fresh = await reader.stat(f.project.id, 'site', { data: true });
  // Within the window the cached tip (shared by every reader of the mirror) is used...
  expect(fresh.entries!.some((entry) => entry.name === 'NEW.md')).toBe(false);
  const { readMirrored } = await import('../src/world/git-mirror.js');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-files-read-'));
  cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
  // ...and a read that does not accept a cached tip fetches the new one.
  const listed = await readMirrored(`git@github.com:${f.owner}/site.git`, {}, { branch: 'main', scratch },
    async (mirror, commit) => (await import('node:child_process')).execFileSync('git', ['ls-tree', '--name-only', commit], { cwd: mirror, encoding: 'utf8' }));
  expect(listed.split('\n')).toContain('NEW.md');
  expect((await reader.stat(f.project.id, 'site', { data: true })).entries!.some((entry) => entry.name === 'NEW.md')).toBe(true);
});

it('splits paths without resolving them', () => {
  expect(splitPath('/a//b/./c/')).toEqual(['a', 'b', 'c']);
  expect(() => splitPath('a/../b')).toThrow(/leaves the project/);
});

it('shares a fixed snapshot of a folder or file by public link, when the organization allows it', async () => {
  const f = await fixture();
  const { capsOf } = await import('./helpers/project-files-fixture.js');
  const maintainer = await f.tokenFor(capsOf('maintainer') as string[]);
  const developer = await f.tokenFor(capsOf('developer') as string[]);
  type Reply = { status: number; headers: Headers; json(): Promise<any>; text(): Promise<string> };
  const shares = (filePath: string, token: string, method = 'GET'): Promise<Reply> => fetch(`${f.server.url}/api/projects/${f.project.id}/file-shares?path=${encodeURIComponent(filePath)}`,
    { method, headers: { authorization: `Bearer ${token}` } });
  const pub = (id: string, filePath = '', raw = false): Promise<Reply> => fetch(`${f.server.url}/api/shared-files/${id}${raw ? '/raw' : ''}?path=${encodeURIComponent(filePath)}`);

  // Off until the organization turns public links on (the conversations setting).
  expect(await (await shares('site/src', maintainer)).json()).toMatchObject({ enabled: false, canShare: true, url: null,
    settings: { scope: 'organization', canManage: false } });
  expect((await shares('site/src', maintainer, 'POST')).status).toBe(403);
  await f.store.kvSet(`conversation-sharing:organization:${f.project.organizationId}`, 'enabled');
  // Sharing project files is its own capability: Project maintainers and up.
  expect((await shares('site/src', developer, 'POST')).status).toBe(403);
  expect((await (await shares('site/src', developer)).json()).canShare).toBe(false);
  const made = await (await shares('site/src', maintainer, 'POST')).json();
  expect(made).toMatchObject({ enabled: true, kind: 'directory', url: expect.stringMatching(/^\/share\/files\/[A-Za-z0-9_-]{43}$/) });
  const id = made.url.split('/').pop();
  // Sharing again gives the same link.
  expect((await (await shares('site/src', maintainer, 'POST')).json()).url).toBe(made.url);

  // Anyone can read it, without signing in, relative to what was shared.
  const folder = await (await pub(id)).json();
  expect(folder).toMatchObject({ path: '', kind: 'directory', source: { kind: 'repository', branch: 'main' }, shared: { kind: 'directory' } });
  expect(folder.entries.map((entry: any) => entry.name)).toEqual(['app.ts', 'weird name #1.txt']);
  expect(await (await pub(id, 'app.ts', true)).text()).toBe('export const answer = 42;\n');
  expect((await pub(id, '../README.md')).status).toBe(404);
  expect((await pub(id, 'nope')).status).toBe(404);
  const page = await fetch(`${f.server.url}${made.url}/app.ts`);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(await page.text()).toContain(`data-share="${id}"`);

  // A snapshot: a later commit does not reach it, while Files shows it.
  fs.writeFileSync(path.join(f.site.work, 'src/app.ts'), 'export const answer = 43;\n');
  sh(f.site.work, 'commit', '-qam', 'change');
  sh(f.site.work, 'push', '-q', f.site.bare, 'main');
  const { readMirrored } = await import('../src/world/git-mirror.js');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-files-read-'));
  cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
  await readMirrored(`git@github.com:${f.owner}/site.git`, {}, { branch: 'main', scratch }, async () => undefined);
  expect(await (await f.get('site/src/app.ts', f.viewer, true)).text()).toBe('export const answer = 43;\n');
  expect(await (await pub(id, 'app.ts', true)).text()).toBe('export const answer = 42;\n');

  // A file of data, pinned to its version, and a shared file takes no path.
  const csv = await (await shares('site/data/raw/pages/b.csv', maintainer, 'POST')).json();
  const csvId = csv.url.split('/').pop();
  await f.resources.importFiles(f.data.id, [{ path: 'pages/b.csv', data: Buffer.from('x,y\n9,9\n') }]);
  expect(await (await f.get('site/data/raw/pages/b.csv', f.viewer, true)).text()).toBe('x,y\n9,9\n');
  expect(await (await pub(csvId)).json()).toMatchObject({ path: 'b.csv', kind: 'file', source: { kind: 'data', name: 'raw_data', id: '' } });
  expect(await (await pub(csvId, '', true)).text()).toBe('x,y\n1,2\n');
  expect((await pub(csvId, 'x')).status).toBe(404);

  // Everyone who reads Files sees the project's links; revoking ends one.
  expect(((await (await fetch(`${f.server.url}/api/projects/${f.project.id}/file-shares`, { headers: { authorization: `Bearer ${f.viewer}` } })).json()) as any)
    .shares.map((share: any) => share.path).sort()).toEqual(['site/data/raw/pages/b.csv', 'site/src']);
  expect((await shares('site/src', developer, 'DELETE')).status).toBe(403);
  expect((await shares('site/src', maintainer, 'DELETE')).status).toBe(200);
  expect((await pub(id)).status).toBe(404);
  expect((await fetch(`${f.server.url}${made.url}`)).status).toBe(404);
  // Turning links off hides the rest until they are on again.
  await f.store.kvSet(`conversation-sharing:project:${f.project.id}`, 'disabled');
  expect((await pub(csvId)).status).toBe(404);
  await f.store.kvDelete(`conversation-sharing:project:${f.project.id}`);
  expect((await pub(csvId)).status).toBe(200);
});
