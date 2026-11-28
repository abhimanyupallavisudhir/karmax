import { afterEach, expect, it } from 'vitest';
import path from 'node:path';
import { offlineCopyName } from '../src/world/project-file-changes.js';
import { capsOf, projectFilesFixture, sh } from './helpers/project-files-fixture.js';

// Offline edits reaching tavya (wiki features/offline-files § Offline edits):
// a write with `merge` and `expect` = the version the device started from.
// Still that version → saved as is. Changed meanwhile → three-way merged on
// the server with the resources' line merge (base = that version, theirs =
// now, ours = the edit): clean → committed; a conflict, binary, a deleted file
// or a base tavya no longer has → the edit kept beside it under a name saying
// whose and when. Real bare "GitHub" remotes and real restic data.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// 2026-11-28 13:05 UTC, written on a device an hour east of UTC.
const AT = Date.UTC(2026, 10, 28, 13, 5);
const MERGE = { device: 'Pixel 8', at: AT, tz: 60 };

async function fixture() {
  const f = await projectFilesFixture(cleanups, { files: { 'notes.md': 'one\ntwo\nthree\nfour\nfive\n', 'log.txt': 'start\n' } });
  const developer = await f.tokenFor(capsOf('developer') as string[]);
  const maintainer = await f.tokenFor(capsOf('maintainer') as string[]);
  const bare = path.join(f.remotes, f.owner, 'site.git');
  const change = async (token: string, changes: unknown[], query = '') => {
    const response = await fetch(`${f.server.url}/api/projects/${f.project.id}/files/changes${query ? `?${query}` : ''}`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });
    return { status: response.status, body: await response.json() as any };
  };
  const version = async (file: string, token = developer) => (await (await f.get(file, token)).json()).version as string;
  const read = async (file: string, token = developer) => (await f.get(file, token, true)).text();
  const show = (file: string) => sh(bare, 'show', `main:${file}`);
  const listed = () => sh(bare, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n');
  return { ...f, developer, maintainer, bare, change, version, read, show, listed };
}

it('names the kept copy by device and the edit’s local time, beside the file', () => {
  expect(offlineCopyName('site/docs/guide.md', MERGE)).toBe('site/docs/guide (offline edit, Pixel 8 2026-11-28 14.05).md');
  expect(offlineCopyName('site/.env.example', { at: AT })).toBe('site/.env (offline edit 2026-11-28 13.05).example');
  expect(offlineCopyName('site/Makefile', { device: 'a/b\nc', at: AT, tz: -300 })).toBe('site/Makefile (offline edit, a b c 2026-11-28 08.05)');
  expect(offlineCopyName('site/notes.md', MERGE, 2)).toBe('site/notes (offline edit, Pixel 8 2026-11-28 14.05) 2.md');
});

it('saves an edit of the version it started from, and merges one that changed meanwhile, as the person', async () => {
  const f = await fixture();
  const base = await f.version('site/notes.md');
  // Nobody changed it: saved as it is.
  const saved = await f.change(f.developer, [{ op: 'write', path: 'site/log.txt', text: 'start\nmine\n', expect: await f.version('site/log.txt'), merge: MERGE }]);
  expect(saved).toMatchObject({ status: 200, body: { merge: { result: 'saved', path: 'site/log.txt' } } });
  expect(f.show('log.txt')).toBe('start\nmine\n');
  const author = sh(f.bare, 'log', '-1', '--format=%an <%ae>', 'main').trim();

  // Someone changes the first line; the device, offline, changed the last.
  expect((await f.change(f.maintainer, [{ op: 'write', path: 'site/notes.md', text: 'ONE\ntwo\nthree\nfour\nfive\n', expect: base }])).status).toBe(200);
  const merged = await f.change(f.developer, [{ op: 'write', path: 'site/notes.md', text: 'one\ntwo\nthree\nfour\nFIVE\n', expect: base, merge: MERGE }]);
  expect(merged).toMatchObject({ status: 200, body: { merge: { result: 'merged', path: 'site/notes.md' }, commits: [{ repository: 'site', branch: 'main' }] } });
  expect(f.show('notes.md')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
  expect(sh(f.bare, 'log', '-1', '--format=%an <%ae>', 'main').trim()).toBe(author);
  expect(f.listed().filter((file) => file.includes('offline edit'))).toEqual([]);

  // Both appended to a log: theirs first, then the device's (the resources' rule).
  const log = await f.version('site/log.txt');
  expect((await f.change(f.maintainer, [{ op: 'write', path: 'site/log.txt', text: 'start\nmine\ntheirs\n', expect: log }])).status).toBe(200);
  const appended = await f.change(f.developer, [{ op: 'write', path: 'site/log.txt', text: 'start\nmine\nfrom the phone\n', expect: log, merge: MERGE }]);
  expect(appended.body.merge).toEqual({ result: 'merged', path: 'site/log.txt' });
  expect(f.show('log.txt')).toBe('start\nmine\ntheirs\nfrom the phone\n');
});

it('keeps both when the line merge conflicts or the file became binary, never overwriting', async () => {
  const f = await fixture();
  const base = await f.version('site/notes.md');
  expect((await f.change(f.maintainer, [{ op: 'write', path: 'site/notes.md', text: 'one\nTWO (theirs)\nthree\nfour\nfive\n', expect: base }])).status).toBe(200);
  const kept = await f.change(f.developer, [{ op: 'write', path: 'site/notes.md', text: 'one\ntwo (mine)\nthree\nfour\nfive\n', expect: base, merge: MERGE }]);
  expect(kept).toMatchObject({ status: 200, body: { merge: { result: 'kept', why: 'conflict', path: 'site/notes (offline edit, Pixel 8 2026-11-28 14.05).md' } } });
  expect(f.show('notes.md')).toBe('one\nTWO (theirs)\nthree\nfour\nfive\n');
  expect(f.show('notes (offline edit, Pixel 8 2026-11-28 14.05).md')).toBe('one\ntwo (mine)\nthree\nfour\nfive\n');
  // The same again (a second device, the same minute): a free name, never the first copy.
  const again = await f.change(f.developer, [{ op: 'write', path: 'site/notes.md', text: 'one\ntwo (again)\nthree\nfour\nfive\n', expect: base, merge: MERGE }]);
  expect(again.body.merge).toEqual({ result: 'kept', why: 'conflict', path: 'site/notes (offline edit, Pixel 8 2026-11-28 14.05) 2.md' });
  expect(f.show('notes (offline edit, Pixel 8 2026-11-28 14.05).md')).toBe('one\ntwo (mine)\nthree\nfour\nfive\n');

  // Someone replaced the text with bytes: nothing to merge line by line.
  const guide = await f.version('site/docs/guide.md');
  const bytes = await (await fetch(`${f.server.url}/api/projects/${f.project.id}/files/uploads`, { method: 'POST',
    headers: { authorization: `Bearer ${f.maintainer}`, 'content-type': 'application/octet-stream' }, body: Buffer.from([0, 1, 2, 0]) })).json() as any;
  expect((await f.change(f.maintainer, [{ op: 'write', path: 'site/docs/guide.md', upload: bytes.upload, expect: guide }])).status).toBe(200);
  const binary = await f.change(f.developer, [{ op: 'write', path: 'site/docs/guide.md', text: '## Guide, edited\n', expect: guide, merge: MERGE }]);
  expect(binary.body.merge).toEqual({ result: 'kept', why: 'binary', path: 'site/docs/guide (offline edit, Pixel 8 2026-11-28 14.05).md' });
  expect(f.show('docs/guide (offline edit, Pixel 8 2026-11-28 14.05).md')).toBe('## Guide, edited\n');
});

it('re-creates an edit of a file deleted meanwhile under the kept name, and refuses who may not write', async () => {
  const f = await fixture();
  const base = await f.version('site/notes.md');
  expect((await f.change(f.maintainer, [{ op: 'delete', path: 'site/notes.md' }])).status).toBe(200);
  const deleted = await f.change(f.developer, [{ op: 'write', path: 'site/notes.md', text: 'still wanted\n', expect: base, merge: MERGE }]);
  expect(deleted.body.merge).toEqual({ result: 'kept', why: 'deleted', path: 'site/notes (offline edit, Pixel 8 2026-11-28 14.05).md' });
  expect(f.listed()).not.toContain('notes.md');
  expect(f.show('notes (offline edit, Pixel 8 2026-11-28 14.05).md')).toBe('still wanted\n');

  // No right to write: refused, nothing written (the device keeps it queued).
  const tip = sh(f.bare, 'rev-parse', 'main').trim();
  const log = await f.version('site/log.txt');
  expect(await f.change(f.viewer, [{ op: 'write', path: 'site/log.txt', text: 'viewer\n', expect: log, merge: MERGE }])).toMatchObject({ status: 403 });
  expect(sh(f.bare, 'rev-parse', 'main').trim()).toBe(tip);

  // A merge is one write of the default or a branch view, from the version it started from.
  expect((await f.change(f.developer, [{ op: 'write', path: 'site/log.txt', text: 'x', merge: MERGE }])).status).toBe(400);
  expect((await f.change(f.developer, [{ op: 'write', path: 'site/log.txt', text: 'x', expect: log, merge: MERGE },
    { op: 'delete', path: 'site/README.md' }])).status).toBe(400);
  expect((await f.change(f.developer, [{ op: 'write', path: 'site/log.txt', text: 'x', expect: log, merge: MERGE }], 'task=1')).status).toBeGreaterThanOrEqual(400);
  expect(sh(f.bare, 'rev-parse', 'main').trim()).toBe(tip);
});

it('merges data files the same way, from the data version the device started from', async () => {
  const f = await fixture();
  const where = 'site/data/raw/pages/a.txt';
  const first = await f.version(where, f.maintainer);
  expect((await f.change(f.maintainer, [{ op: 'write', path: where, text: 'one\ntwo\nthree\nfour\nfive\n', expect: first }])).status).toBe(200);
  const base = await f.version(where, f.maintainer);
  // An edit elsewhere in the data leaves a.txt's version alone: saved as it is.
  expect((await f.change(f.maintainer, [{ op: 'write', path: 'site/data/raw/pages/b.csv', text: 'x,y\n3,4\n' }])).status).toBe(200);
  expect(await f.version(where, f.maintainer)).toBe(base);

  // Changed meanwhile: merged with the version found among the data's earlier ones.
  expect((await f.change(f.maintainer, [{ op: 'write', path: where, text: 'ONE\ntwo\nthree\nfour\nfive\n', expect: base }])).status).toBe(200);
  const merged = await f.change(f.maintainer, [{ op: 'write', path: where, text: 'one\ntwo\nthree\nfour\nFIVE\n', expect: base, merge: MERGE }]);
  expect(merged).toMatchObject({ status: 200, body: { merge: { result: 'merged', path: where }, commits: [], data: [{ name: 'raw_data' }] } });
  expect(await f.read(where, f.maintainer)).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');

  // A conflict keeps both, in the data.
  const conflict = await f.change(f.maintainer, [{ op: 'write', path: where, text: 'uno\ntwo\nthree\nfour\nfive\n', expect: base, merge: MERGE }]);
  expect(conflict.body.merge).toEqual({ result: 'kept', why: 'conflict', path: 'site/data/raw/pages/a (offline edit, Pixel 8 2026-11-28 14.05).txt' });
  expect(await f.read(where, f.maintainer)).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
  expect(await f.read('site/data/raw/pages/a (offline edit, Pixel 8 2026-11-28 14.05).txt', f.maintainer)).toBe('uno\ntwo\nthree\nfour\nfive\n');

  // A version tavya no longer has (or never had): nothing to merge from, so both are kept.
  const unknown = await f.change(f.maintainer, [{ op: 'write', path: where, text: 'lost base\n', expect: 'f'.repeat(64), merge: { at: AT } }]);
  expect(unknown.body.merge).toEqual({ result: 'kept', why: 'base', path: 'site/data/raw/pages/a (offline edit 2026-11-28 13.05).txt' });
  // Data needs project settings access, as every data edit does.
  expect((await f.change(f.developer, [{ op: 'write', path: where, text: 'x', expect: base, merge: MERGE }])).status).toBe(403);
});
