import { afterEach, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capsOf, projectFilesFixture, sh } from './helpers/project-files-fixture.js';
import { changeNoticeFor } from '../src/gateway/change-notices.js';
import { ManifestTooLargeError, ProjectFiles } from '../src/world/project-files.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';

// Offline files, read-only (wiki features/offline-files): what the apps need
// from the server to keep pinned files and folders on a device. A folder's
// manifest (every file under it, with a version), one call that checks many
// pins at once, and files/raw only for the version the device asked for.
// Real Git remotes and real restic data, as the Files page reads them.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Reply = { status: number; headers: Headers; json(): Promise<any>; text(): Promise<string> };

async function setup() {
  const f = await projectFilesFixture(cleanups);
  const manifest = (filePath: string, token = f.viewer, query = ''): Promise<Reply> =>
    fetch(`${f.server.url}/api/projects/${f.project.id}/files/manifest?path=${encodeURIComponent(filePath)}${query}`, { headers: { authorization: `Bearer ${token}` } });
  const check = (pins: unknown[], token = f.viewer): Promise<Reply> => fetch(`${f.server.url}/api/offline-files/check`,
    { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ pins }) });
  const stat = async (filePath: string) => (await f.get(filePath, f.viewer)).json();
  // A commit on origin, and the host's mirror told its tip moved (as a push webhook would).
  const commit = async (files: Record<string, string | null>, branch = 'main') => {
    for (const [file, content] of Object.entries(files)) {
      const at = path.join(f.site.work, file);
      if (content === null) fs.rmSync(at);
      else { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, content); }
    }
    sh(f.site.work, 'add', '-A');
    sh(f.site.work, 'commit', '-qm', 'change');
    sh(f.site.work, 'push', '-q', f.site.bare, `HEAD:${branch}`);
    const { readMirrored } = await import('../src/world/git-mirror.js');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-offline-tip-'));
    try { await readMirrored(`git@github.com:${f.owner}/site.git`, {}, { branch, scratch }, async () => undefined); }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  };
  return { ...f, manifest, check, stat, commit };
}

const byPath = (files: Array<{ path: string; size: number; version: string }>) => Object.fromEntries(files.map((file) => [file.path, file]));

it('lists every file under a folder with the version Files and files/raw give it, across repositories and data', async () => {
  const f = await setup();
  const reply = await f.manifest('site');
  expect(reply.status).toBe(200);
  expect(reply.headers.get('cache-control')).toMatch(/no-cache/);
  const site = await reply.json();
  expect(site).toMatchObject({ path: 'site', kind: 'directory', revision: expect.stringMatching(/^[0-9a-f]{40}$/) });
  // Files only: a symlink is not kept offline; data mounted inside the repository is.
  expect(site.files.map((file: any) => file.path)).toEqual(['data/raw/big.bin', 'data/raw/pages/a.txt', 'data/raw/pages/b.csv',
    'docs/guide.md', 'logo.bin', 'README.md', 'src/app.ts', 'src/weird name #1.txt']);
  expect(site.bytes).toBe(site.files.reduce((sum: number, file: any) => sum + file.size, 0));
  const files = byPath(site.files);
  for (const name of ['README.md', 'src/weird name #1.txt', 'data/raw/pages/b.csv', 'data/raw/big.bin']) {
    const facts = await f.stat(`site/${name}`);
    expect(files[name]).toEqual({ path: name, size: facts.size, version: facts.version, ...(name.startsWith('data/') ? { data: true } : {}) });
    // files/raw's ETag is that same version.
    const raw = await f.get(`site/${name}`, f.viewer, true);
    expect(raw.headers.get('etag')).toBe(`"${facts.version}"`);
    await raw.text();
  }
  // A Git file's version is its blob id, which a device can check its download against.
  const readme = await (await f.get('site/README.md', f.viewer, true)).text();
  expect(files['README.md']!.version).toBe(crypto.createHash('sha1').update(`blob ${Buffer.byteLength(readme)}\0${readme}`).digest('hex'));

  // The project root spans both repositories (and the wiki); a file is a manifest of itself.
  const root = await (await f.manifest('')).json();
  expect(root.files.map((file: any) => file.path)).toEqual(expect.arrayContaining(['site-wiki/SPEC.md', 'site/README.md', 'site/data/raw/big.bin']));
  const one = await (await f.manifest('site/README.md')).json();
  expect(one).toEqual({ path: 'site/README.md', kind: 'file', revision: files['README.md']!.version,
    files: [{ path: '', size: files['README.md']!.size, version: files['README.md']!.version }], bytes: files['README.md']!.size });
  const data = await (await f.manifest('site/data/raw/pages')).json();
  expect(data.files.map((file: any) => file.path)).toEqual(['a.txt', 'b.csv']);

  // Nothing there; a task's world (ephemeral) is not kept offline; a symlink is not a file to keep.
  expect((await f.manifest('site/nope')).status).toBe(404);
  expect((await f.manifest('site/link-to-app')).status).toBe(404);
  expect((await f.manifest('site', f.viewer, '&task=1')).status).toBe(404);
});

it('refuses a folder with too many files to keep', async () => {
  const f = await setup();
  const reader = new ProjectFiles({ store: f.store, workspaces: { project: async () => ({ repositories: [{ name: 'site', role: 'development',
    sshUrl: `git@github.com:${f.owner}/site.git`, branch: 'main' }], resources: [] }) as any }, gitCredential: async () => ({}) });
  await expect(reader.manifest(f.project.id, 'site', { data: true, maxFiles: 3 })).rejects.toBeInstanceOf(ManifestTooLargeError);
  expect((await reader.manifest(f.project.id, 'site/src', { data: true, maxFiles: 3 })).files).toHaveLength(2);
});

it('keeps a file’s version across commits and data versions that did not change it, and moves the folder’s revision', async () => {
  const f = await setup();
  const before = await (await f.manifest('site')).json();
  const docsBefore = await (await f.manifest('site/docs')).json();
  await f.commit({ 'src/app.ts': 'export const answer = 43;\n', 'src/new.ts': 'new\n' });
  const after = await (await f.manifest('site')).json();
  expect(after.revision).not.toBe(before.revision);
  const [was, now] = [byPath(before.files), byPath(after.files)];
  expect(now['src/app.ts']!.version).not.toBe(was['src/app.ts']!.version);
  expect(now['src/new.ts']).toBeDefined();
  expect(now['README.md']).toEqual(was['README.md']);
  // A folder the commit did not touch keeps its revision.
  expect((await (await f.manifest('site/docs')).json()).revision).toBe(docsBefore.revision);

  // A new data version: a.txt and big.bin unchanged, b.csv changed. Each file's
  // version is its content's, so a new snapshot alone downloads nothing again.
  await f.resources.importFiles(f.data.id, [
    { path: 'pages/a.txt', data: Buffer.from('alpha\n') },
    { path: 'pages/b.csv', data: Buffer.from('x,y\n3,4\n') },
    { path: 'big.bin', data: f.corpus[2]!.data },
  ]);
  const data = byPath((await (await f.manifest('site/data/raw')).json()).files);
  expect(data['pages/a.txt']!.version).toBe(now['data/raw/pages/a.txt']!.version);
  expect(data['big.bin']!.version).toBe(now['data/raw/big.bin']!.version);
  expect(data['pages/b.csv']!.version).not.toBe(now['data/raw/pages/b.csv']!.version);
  expect((await f.stat('site/data/raw/big.bin')).version).toBe(now['data/raw/big.bin']!.version);
  const latest = await (await f.manifest('site')).json();
  expect(latest.revision).not.toBe(after.revision);
});

it('serves files/raw only for the version asked for (If-Match)', async () => {
  const f = await setup();
  const { version } = await f.stat('site/src/app.ts');
  const same = await f.get('site/src/app.ts', f.viewer, true, { 'if-match': `"${version}"` });
  expect(same.status).toBe(200);
  expect(await same.text()).toBe('export const answer = 42;\n');
  await f.commit({ 'src/app.ts': 'changed\n' });
  const moved = await f.get('site/src/app.ts', f.viewer, true, { 'if-match': `"${version}"` });
  expect(moved.status).toBe(412);
  const data = await f.stat('site/data/raw/pages/a.txt');
  expect((await f.get('site/data/raw/pages/a.txt', f.viewer, true, { 'if-match': `"${data.version}"` })).status).toBe(200);
  expect((await f.get('site/data/raw/pages/a.txt', f.viewer, true, { 'if-match': '"0000"' })).status).toBe(412);
});

it('checks many pins in one call: current, changed, gone, and no longer yours', async () => {
  const f = await setup();
  const site = await (await f.manifest('site')).json();
  const docs = await (await f.manifest('site/docs')).json();
  const app = await f.stat('site/src/app.ts');
  const guide = await f.stat('site/docs/guide.md');
  const pages = await (await f.manifest('site/data/raw/pages')).json();
  const pins = [
    { projectId: f.project.id, path: 'site', revision: site.revision },
    { projectId: f.project.id, path: 'site/docs', revision: docs.revision },
    { projectId: f.project.id, path: 'site/src/app.ts', revision: app.version },
    { projectId: f.project.id, path: 'site/docs/guide.md', revision: guide.version },
    { projectId: f.project.id, path: 'site/data/raw/pages', revision: pages.revision },
    { projectId: 'proj_nothing_here', path: 'x', revision: 'y' },
  ];
  const first = await f.check(pins);
  expect(first.status).toBe(200);
  const answer = await first.json();
  expect(answer.checkedAt).toEqual(expect.any(Number));
  expect(answer.results.map((result: any) => result.status)).toEqual(['current', 'current', 'current', 'current', 'current', 'missing']);

  await f.commit({ 'src/app.ts': 'changed\n', 'docs/guide.md': null });
  const second = (await (await f.check(pins)).json()).results;
  expect(second[0]).toMatchObject({ status: 'changed', kind: 'directory', revision: expect.not.stringMatching(site.revision) });
  // The folder lost its only file: nothing is there any more.
  expect(second[1]).toEqual({ status: 'missing' });
  expect(second[2]).toEqual({ status: 'changed', kind: 'file', revision: (await f.stat('site/src/app.ts')).version, size: 8 });
  expect(second[3]).toEqual({ status: 'missing' });
  expect(second[4]).toEqual({ status: 'current' });

  // Access lost: without repository:read every pin of the project is refused;
  // without project:settings:read only the data ones.
  const none = (await (await f.check(pins, await f.tokenFor(['project:read']))).json()).results;
  expect(none.slice(0, 5).map((result: any) => result.status)).toEqual(['forbidden', 'forbidden', 'forbidden', 'forbidden', 'forbidden']);
  const noData = (await (await f.check(pins, await f.tokenFor(['project:read', 'repository:read']))).json()).results;
  expect(noData[2].status).toBe('changed');
  expect(noData[4].status).toBe('forbidden');

  // A branch view's pins are checked against that branch.
  sh(f.site.work, 'checkout', '-qb', 'feature');
  await f.commit({ 'FEATURE.md': 'only here\n' }, 'feature');
  const feature = await (await f.manifest('site', f.viewer, '&branch=feature')).json();
  expect(feature.files.some((file: any) => file.path === 'FEATURE.md')).toBe(true);
  const branchPins = [{ projectId: f.project.id, branch: 'feature', path: 'site', revision: feature.revision },
    { projectId: f.project.id, branch: 'feature', path: 'site/FEATURE.md', revision: byPath(feature.files)['FEATURE.md']!.version }];
  expect((await (await f.check(branchPins)).json()).results.map((result: any) => result.status)).toEqual(['current', 'current']);

  // Malformed requests.
  const bad = await fetch(`${f.server.url}/api/offline-files/check`, { method: 'POST', headers: { authorization: `Bearer ${f.viewer}`, 'content-type': 'application/json' }, body: '{}' });
  expect(bad.status).toBe(400);
  expect((await f.check(Array.from({ length: 2001 }, () => pins[0]))).status).toBe(400);
});

it('is a read: checking pins tells no other connection that anything changed', () => {
  expect(changeNoticeFor({ method: 'POST', path: '/api/offline-files/check', status: 200, capability: 'none', scope: {}, userId: 'u1' })).toBeUndefined();
});

it('is in the platform API catalog, for agents and the CLI', async () => {
  const text = JSON.stringify(PLATFORM_API_CATALOG);
  expect(text).toContain('GET /api/projects/:projectId/files/manifest');
  expect(text).toContain('POST /api/offline-files/check');
  expect(text).toMatch(/If-Match/);
  // Readers have it: a viewer can keep files offline.
  expect(capsOf('viewer')).toContain('repository:read');
});
