import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ReviewAction, TaskView } from '../../src/domain/types.js';
import { ARTIFACT_MIME } from '../../src/store/artifact-mime.js';
import { reviewTargetKey } from '../../src/store/review-artifacts.js';
import { projectFilesFixture, sh } from './project-files-fixture.js';

// The artifact gallery (wiki features/project-files) over the Files fixture:
// tasks in every state attaching files in and out of the repository, some
// saved, and a later commit that changes one attached file and deletes another.

/** A small PNG: a diagonal gradient, so a thumbnail is visibly there. */
export const PNG = png(160, 100, (x, y) => [84 + Math.round(x / 2), 84 + Math.round(y), 212]);

function png(width: number, height: number, color: (x: number, y: number) => number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(color(x, y), y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export const ROOT = '/home/user/w';

export async function artifactGalleryFixture(cleanups: Array<() => Promise<void> | void>) {
  const f = await projectFilesFixture(cleanups, { files: { 'docs/report.md': '# Report\n\nFirst draft.\n', 'docs/old.png': PNG } });
  // Later on main: the report is rewritten, the old screenshot deleted.
  sh(f.site.work, 'rm', '-q', 'docs/old.png');
  fs.writeFileSync(path.join(f.site.work, 'docs/report.md'), '# Report\n\nFinal.\n');
  sh(f.site.work, 'commit', '-qam', 'final report');
  sh(f.site.bare, 'fetch', '-q', f.site.work, '+main:main');

  const world = (workdir?: string) => ({ kind: 'e2b', id: `w-${crypto.randomBytes(3).toString('hex')}`, root: ROOT, branch: 'tavya/x', base: 'main',
    ...(workdir ? { workdir } : {}), repos: [{ name: 'site', repo: `git@github.com:${f.owner}/site.git`, root: `${ROOT}/site`, branch: 'tavya/x', base: 'main' }] });
  const task = async (title: string, status: TaskView['status'], actions: ReviewAction[], workdir?: string) => {
    const created = await f.store.createTask({ projectId: f.project.id, title, workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: title } });
    await f.store.saveView(created.id, { taskId: created.id, title, workflow: 'software-dev', stage: status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'review',
      status, messages: [], actions: [], state: {}, updatedAt: 1, reviewInfo: { actions }, world: world(workdir) } as TaskView);
    return (await f.store.getTask(created.id))!;
  };
  /** A saved copy of `target` as the task attached it at `at`. */
  const save = async (taskId: string, target: string, data: Buffer, at: number) => {
    const name = path.posix.basename(target);
    const id = `review-${crypto.createHash('sha256').update(`${taskId}\0${target}\0${at}`).digest('hex')}`;
    const objectKey = `artifacts/${f.project.organizationId}/${f.project.id}/${taskId}/${id}/x`;
    const mediaType = ARTIFACT_MIME[path.extname(name)] ?? 'application/octet-stream';
    await f.objects.put(objectKey, data);
    await f.store.savePromotedArtifact({ id, organizationId: f.project.organizationId!, projectId: f.project.id, taskId, objectKey,
      sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length, mediaType, name, createdAt: at });
    const key = `review-artifacts:${taskId}`;
    await f.store.kvSet(key, JSON.stringify({ ...JSON.parse((await f.store.kvGet(key)) ?? '{}'), [reviewTargetKey(target)]: id }));
  };
  const open = (target: string, label = path.posix.basename(target)): ReviewAction => ({ kind: 'open', label, target });

  // #1, done: the report (in Git, rewritten since), the deleted screenshot,
  // a screenshot outside every repository (saved, then superseded by #3),
  // one never saved, a web page and a command.
  const first = await task('Write the report', 'done', [open(`${ROOT}/site/docs/report.md`, 'Report'), open(`${ROOT}/site/docs/old.png`),
    open(`${ROOT}/shots/home.png`, 'Home page'), open(`${ROOT}/shots/unsaved.png`), { kind: 'open', label: 'Site', target: 'https://example.com/' },
    { kind: 'run', label: 'Serve', command: 'npm start' }]);
  await save(first.id, `${ROOT}/site/docs/report.md`, Buffer.from('# Report\n\nFirst draft.\n'), 1_000);
  await save(first.id, `${ROOT}/site/docs/old.png`, PNG, 1_001);
  await save(first.id, `${ROOT}/shots/home.png`, PNG, 1_002);
  // #2, cancelled: nothing of it shows.
  const cancelled = await task('Abandoned idea', 'cancelled', [open(`${ROOT}/shots/abandoned.png`)]);
  await save(cancelled.id, `${ROOT}/shots/abandoned.png`, PNG, 5_000);
  // #3, underway in site/: a new screenshot (not saved yet) and a newer home page.
  const active = await task('Redesign the home page', 'waiting', [open('screens/new.png', 'New screen'), open(`${ROOT}/shots/home.png`, 'Home page, redesigned')], `${ROOT}/site`);
  await save(active.id, `${ROOT}/shots/home.png`, PNG, 3_000);
  // #4, done: a source file named from the world root, never saved (it is in Git).
  const source = await task('Answer everything', 'done', [open('site/src/app.ts', 'The answer')]);
  // #5, done: notes it attached but never committed, saved.
  const notes = await task('Take notes', 'done', [open(`${ROOT}/site/notes/never.md`, 'Notes')]);
  await save(notes.id, `${ROOT}/site/notes/never.md`, Buffer.from('# Notes\n'), 2_000);
  return { ...f, tasks: { first, cancelled, active, source, notes } };
}

