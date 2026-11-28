import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { GitBrokerCredential } from './git-broker.js';
import type { World, WorldHandle } from './types.js';
import { forgetMirroredTip, mirroredClone } from './git-mirror.js';
import { git, gitWithInput } from './git.js';
import { materializeGitCredential } from './git-credential.js';
import { exampleEnvironmentFile, likelySecret, sqliteDatabase } from '../domain/ignored-files.js';
import { dotenvFile } from '../domain/dotenv.js';
import { mergeCopies } from './resource-file-merge.js';
import { FileAccessError, FileNotFoundError, splitPath, type DataPlace, type FileView, type ProjectFiles, type WritePlaces } from './project-files.js';

/**
 * Changing the project's Files (wiki features/project-files): what the file
 * manager writes. One batch of changes, applied to the view it was made in:
 *
 * - a task's world: written there, whatever its agent sees (a parked world is
 *   woken; a released one is read-only);
 * - a branch (the default view's, or another): one commit per repository the
 *   batch touches, pushed straight to that branch, built in a scratch index
 *   over the host's mirror (no checkout, so a large repository costs what the
 *   change does). A push that loses a race with another is rebuilt on the new
 *   tip once; an edit of a file someone changed since it was opened is refused
 *   (`expect`), never silently overwritten.
 *
 * - data mounted there: each resource the batch touches gets ONE new version
 *   (its current one restored on this host, changed, saved with restic; up to
 *   DATA_EDIT_MAX, beyond which a task changes it).
 *
 * An upload may instead be kept as data (a new resource where it lands) or as
 * a secret (a .env's variables become lines of that file in its repository;
 * another file is kept whole), as `planUploads` recommends. The project's
 * root and a repository's own folder are not changed here, nor is a data
 * resource removed (Settings does that).
 */

export type FileChange =
  /** `source`: a file on this host holding the bytes. `expect`: the version
   * replaced (an editor's save), or null for a file that must not exist yet. */
  | { op: 'write'; path: string; source: string; expect?: string | null;
    /** An upload kept out of Git: as data (in `dataFolder`, a new folder of
     * data, when given), or as a secret. Branch views only. */
    keep?: 'data' | 'secret'; dataFolder?: string }
  | { op: 'mkdir'; path: string }
  | { op: 'delete'; path: string }
  /** From this view, or `fromView` (a paste from another view or the default). */
  | { op: 'copy' | 'move'; from: string; to: string; fromView?: FileView };

export class FileConflictError extends Error {}

export interface ApplyOptions {
  /** May the caller read the project's data (a paste from it)? */
  data: boolean;
  /** May the caller land work on `branch` (a branch view's commit)? */
  mayCommit?: (branch: string) => Promise<boolean>;
  /** May the caller change the project's data and secrets (project:settings:write)? */
  mayKeep?: () => Promise<boolean>;
}

export interface FileChangeAuthor { name: string; email: string }

export interface FileChangeResult {
  /** Each commit pushed, in a branch view. */
  commits: Array<{ repository: string; branch: string; commit: string }>;
  /** Each data resource given a new version, or made. */
  data?: Array<{ name: string; created?: true }>;
  /** Secrets stored (their names). */
  secrets?: string[];
}

/** Where a kept file goes, inside its repository's folder. */
export interface KeptPlace { repository: string; path: string }

/** The project's data and secrets, as the Files page changes them. */
export interface FileKeeping {
  /** The resource's current version, if it has one. */
  version(attachmentId: string): Promise<string | undefined>;
  /** The resource's current version into `target` (refusing one over `maxBytes`). */
  restore(attachmentId: string, target: string, maxBytes: number): Promise<{ revisionId?: string }>;
  /** `source` (a folder, or a file-shaped resource's one file) as its new current version, if it is still `baseRevisionId`. */
  save(attachmentId: string, source: string, baseRevisionId: string | undefined): Promise<void>;
  /** A new data resource at `place`: `source` is its folder, or its one file. */
  create(projectId: string, place: KeptPlace, shape: 'directory' | 'file', source: string): Promise<string>;
  /** `source` kept as a secret at `place` (a .env: each variable). Returns the names stored. */
  secret(projectId: string, place: KeptPlace, source: string): Promise<string[]>;
}

/** Restoring more than this to change one file takes too long here. */
export const DATA_EDIT_MAX = 2 * 1024 ** 3;

export interface ProjectFileChangesDeps {
  files: ProjectFiles;
  gitCredential: (projectId: string, sshUrl: string) => Promise<GitBrokerCredential>;
  /** A task's world to write into, woken when parked; released after. */
  openWorld?: (taskId: string, handle: WorldHandle) => Promise<{ world: World; release(): Promise<void> }>;
  /** After a push to `sshUrl` (the canonical wiki follows its repository). */
  afterPush?: (projectId: string, place: { sshUrl: string; role: 'development' | 'project-wiki'; branch: string }) => Promise<void>;
  /** Data and secrets; without it they are read-only here. */
  keeping?: FileKeeping;
}

/** What one batch may carry: twice the console's upload round (10,000 files,
 * 1 GB; web/app.js UPLOAD_ROUND), which uploads anything bigger in rounds. */
export const CHANGE_LIMITS = { changes: 20_000, files: 20_000, bytes: 2 * 1024 * 1024 * 1024, file: 512 * 1024 * 1024 } as const;

interface GitPlace { name: string; segments: string[]; role: 'development' | 'project-wiki'; sshUrl: string; branch: string }

/** One change inside a data resource's folder (paths relative to it). */
type DataOp =
  | { op: 'write'; path: string; source: string }
  | { op: 'delete' | 'mkdir'; path: string }
  | { op: 'copy' | 'move'; from: string; to: string };

/** One index operation inside a checkout. */
type IndexOp =
  | { op: 'write'; path: string; source: string; expect?: string | null }
  | { op: 'delete'; path: string }
  | { op: 'copy'; from: string; to: string }
  | { op: 'mkdir'; path: string };

/** Where an upload is best kept (the file manager's recommendation). */
export type Keep = 'git' | 'data' | 'secret';
export interface UploadPlan {
  path: string;
  keep: Keep;
  /** Why, when it is not Git (shown on hover). */
  why?: string;
  /** Already in data: nothing else is possible. */
  fixed?: true;
}

/** Files at least this large are better kept as data: GitHub refuses 100 MB and warns from 50. */
export const LARGE_FILE_BYTES = 50 * 1024 * 1024;

/** The recommendation for one file, from its name, size and whether Git ignores it. Pure. */
export function planUpload(path: string, size: number, facts: { inData: boolean; ignored: boolean }): UploadPlan {
  const name = path.split('/').pop() ?? path;
  if (facts.inData) return { path, keep: 'data', why: 'Inside data', fixed: true };
  if (likelySecret(name) && !exampleEnvironmentFile(name)) return { path, keep: 'secret', why: dotenvFile(name) ? 'Holds environment variables' : 'Looks like credentials' };
  if (facts.ignored) return { path, keep: 'data', why: 'Git ignores it' };
  if (size >= LARGE_FILE_BYTES) return { path, keep: 'data', why: 'Over 50 MB' };
  if (sqliteDatabase(name)) return { path, keep: 'data', why: 'A database' };
  return { path, keep: 'git' };
}

/** Where an edit made offline came from, for the name of a copy kept beside
 * the file: the device's name, when it was made (ms) and the device's offset
 * from UTC then (minutes east). */
export interface OfflineEditOrigin { device?: string; at?: number; tz?: number }

/** What became of an edit made offline (`merge` on a write). */
export interface OfflineEditResult {
  /** saved: nobody had changed the file; merged: combined line by line with
   * what changed meanwhile; kept: written beside it, at `path`. */
  result: 'saved' | 'merged' | 'kept';
  path: string;
  /** Why it was kept: the line merge conflicts, a copy is not text, the file
   * is gone (or is a folder now), or tavya no longer has the version it started from. */
  why?: 'conflict' | 'binary' | 'deleted' | 'base';
}

/** The most an offline edit's merge reads of each copy (the console edits ≤ 2 MiB). */
export const OFFLINE_MERGE_MAX_BYTES = 16 * 1024 * 1024;

/** `notes (offline edit, Pixel 8 2026-11-28 14.05).md` beside `notes.md`, in
 * the edit's local time; `n` > 1 for the next free name. Pure. */
export function offlineCopyName(where: string, origin: OfflineEditOrigin, n = 1): string {
  const segments = where.split('/');
  const name = segments.pop() ?? where;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const tz = Number.isFinite(origin.tz) ? Math.max(-14 * 60, Math.min(14 * 60, Math.round(origin.tz!))) : 0;
  const local = new Date((Number.isFinite(origin.at) ? origin.at! : Date.now()) + tz * 60_000);
  const two = (value: number) => String(value).padStart(2, '0');
  const when = `${local.getUTCFullYear()}-${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())} ${two(local.getUTCHours())}.${two(local.getUTCMinutes())}`;
  const device = String(origin.device ?? '').replace(/[\u0000-\u001f\u007f/\\()]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return [...segments, `${stem} (offline edit${device ? `, ${device}` : ''} ${when})${n > 1 ? ` ${n}` : ''}${ext}`].join('/');
}

export class ProjectFileChanges {
  constructor(private readonly deps: ProjectFileChangesDeps) {}

  /** Apply `changes` to `view`; throws FileNotFoundError / FileAccessError /
   * FileConflictError for the caller's mistakes, Error when a source fails. */
  async apply(projectId: string, view: FileView, changes: FileChange[], author: FileChangeAuthor,
    options: ApplyOptions): Promise<FileChangeResult> {
    if (!changes.length) return { commits: [] };
    if (changes.length > CHANGE_LIMITS.changes) throw new FileAccessError(`At most ${CHANGE_LIMITS.changes} changes at once.`);
    const places = await this.deps.files.writePlaces(projectId, view);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-file-changes-'));
    try {
      // What a paste brings from elsewhere is read first, onto this host.
      const local: Array<Exclude<FileChange, { fromView?: FileView }> | FileChange> = [];
      const sources: Array<{ view: FileView; path: string }> = [];
      for (const change of changes) {
        if ((change.op === 'copy' || change.op === 'move') && (change.fromView && !sameView(change.fromView, view) || !sameSource(places, change.from, change.to))) {
          const fromView = change.fromView ?? view;
          const files = await this.materialize(projectId, fromView, change.from, scratch, options);
          for (const file of files) local.push(file.kind === 'directory'
            ? { op: 'mkdir', path: joinPath(change.to, file.rel) }
            : { op: 'write', path: joinPath(change.to, file.rel), source: file.source, expect: null });
          if (change.op === 'move') sources.push({ view: fromView, path: change.from });
          continue;
        }
        if (change.op === 'write' && change.keep && places.kind === 'world') throw new FileAccessError('In a task, an upload is a file of its world.');
        local.push(change.op === 'copy' || change.op === 'move' ? { op: change.op, from: change.from, to: change.to } : change);
      }
      const result = places.kind === 'world'
        ? await this.applyToWorld(projectId, places, local as LocalChange[])
        : await this.applyToBranches(projectId, view, places, local as LocalChange[], author, scratch, options);
      // A move from elsewhere removes what it took once it is safely written.
      for (const moved of sources) {
        const more = await this.apply(projectId, moved.view, [{ op: 'delete', path: moved.path }], author, options);
        result.commits.push(...more.commits);
      }
      return result;
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  /** An edit made offline (wiki features/offline-files § Offline edits):
   * `change.expect` is the version the device started from. Still that
   * version: saved as it is. Changed meanwhile: merged line by line with the
   * resources' merge (base = that version, theirs = now, ours = the edit) and
   * saved over what is there now; when that conflicts, a copy is not text, the
   * file is gone or its base is no longer on tavya, the edit is written beside
   * it (`offlineCopyName`) and both are kept. Never overwrites anything. */
  async applyOffline(projectId: string, view: FileView, change: Extract<FileChange, { op: 'write' }>, origin: OfflineEditOrigin,
    author: FileChangeAuthor, options: ApplyOptions): Promise<FileChangeResult & { merge: OfflineEditResult }> {
    if (view.kind === 'task') throw new FileAccessError('Offline edits are of the default or a branch view.');
    if (typeof change.expect !== 'string' || change.keep) throw new FileAccessError('An offline edit names the version it started from.');
    const where = splitPath(change.path).join('/');
    const write = (at: string, source: string, expect: string | null) => this.apply(projectId, view, [{ op: 'write', path: at, source, expect }], author, options);
    try { return { ...await write(where, change.source, change.expect), merge: { result: 'saved', path: where } }; }
    catch (error) { if (!(error instanceof FileConflictError)) throw error; }
    const keep = async (why: NonNullable<OfflineEditResult['why']>) => {
      for (let n = 1; ; n++) {
        const at = offlineCopyName(where, origin, n);
        try { return { ...await write(at, change.source, null), merge: { result: 'kept' as const, path: at, why } }; }
        catch (error) { if (!(error instanceof FileConflictError) || n >= 50) throw error; }
      }
    };
    const read = { data: options.data, view };
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = await this.deps.files.stat(projectId, where, read).catch((error) => { if (error instanceof FileNotFoundError) return undefined; throw error; });
      if (!now || now.kind !== 'file' || !now.version) return keep('deleted');
      const base = await this.deps.files.versionBytes(projectId, where, change.expect, read, OFFLINE_MERGE_MAX_BYTES);
      if (!base) return keep('base');
      if ((now.size ?? 0) > OFFLINE_MERGE_MAX_BYTES) return keep('binary');
      const theirs = await this.deps.files.open(projectId, where, read, async (file) => {
        const chunks: Buffer[] = [];
        for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
        await file.done;
        return { bytes: Buffer.concat(chunks), version: file.node.version ?? now.version };
      });
      const merged = await mergeCopies({ base, theirs: theirs.bytes, mine: fs.readFileSync(change.source), name: where });
      if (merged.status !== 'merged') return keep(merged.status);
      const source = `${change.source}.merged`;
      fs.writeFileSync(source, merged.content);
      try { return { ...await write(where, source, theirs.version!), merge: { result: 'merged', path: where } }; }
      catch (error) { if (!(error instanceof FileConflictError)) throw error; /* changed again meanwhile: once more */ }
      finally { fs.rmSync(source, { force: true }); }
    }
    return keep('conflict');
  }

  /** Where each upload (`path` where it lands, `size`) is best kept, in a
   * branch view: in Git, as data, or as a secret (`planUpload`). */
  async plan(projectId: string, view: FileView, items: Array<{ path: string; size: number }>): Promise<UploadPlan[]> {
    const places = await this.deps.files.writePlaces(projectId, view);
    if (places.kind === 'world') return items.map((item) => ({ path: item.path, keep: 'git' }));
    const valid = items.filter((item) => { try { return splitPath(item.path).length > 0; } catch { return false; } });
    const ignored = await this.deps.files.gitIgnored(projectId, view, valid.map((item) => item.path)).catch(() => new Set<string>());
    return valid.map((item) => {
      const segments = splitPath(item.path);
      const inData = places.mounts.some((mount) => startsWith(segments, mount.segments));
      return planUpload(segments.join('/'), Number(item.size) || 0, { inData, ignored: ignored.has(item.path) });
    });
  }

  /** `from` (a file or a whole folder) of `view` as files on this host. */
  private async materialize(projectId: string, view: FileView, from: string, scratch: string, options: ApplyOptions)
    : Promise<Array<{ rel: string; kind: 'file' | 'directory'; source: string }>> {
    const out: Array<{ rel: string; kind: 'file' | 'directory'; source: string }> = [];
    let bytes = 0;
    const visit = async (where: string, rel: string): Promise<void> => {
      const node = await this.deps.files.stat(projectId, where, { data: options.data, view });
      if (node.kind === 'directory') {
        if (rel) out.push({ rel, kind: 'directory', source: '' });
        for (const entry of node.entries ?? []) await visit(joinPath(where, entry.name), joinPath(rel, entry.name));
        return;
      }
      if (node.kind !== 'file') return; // links and submodules are not copied between sources
      if (out.length >= CHANGE_LIMITS.files) throw new FileAccessError(`At most ${CHANGE_LIMITS.files} files at once.`);
      const target = path.join(scratch, 'paste', String(out.length));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await this.deps.files.open(projectId, where, { data: options.data, view }, async (file) => {
        if ((bytes += file.size) > CHANGE_LIMITS.bytes) { file.stop(); throw new FileAccessError('Too much to copy at once (2 GB).'); }
        const sink = fs.createWriteStream(target);
        await new Promise<void>((resolve, reject) => {
          file.stream.on('error', reject);
          sink.on('error', reject);
          sink.on('finish', resolve);
          file.stream.pipe(sink);
        });
        await file.done;
      });
      out.push({ rel, kind: 'file', source: target });
    };
    await visit(splitPath(from).join('/'), '');
    return out;
  }

  // ── a task's world ────────────────────────────────────────────────────────

  private async applyToWorld(projectId: string, places: Extract<WritePlaces, { kind: 'world' }>, changes: LocalChange[]): Promise<FileChangeResult> {
    if (!this.deps.openWorld) throw new FileAccessError('Task files can’t be changed on this server.');
    const guard = (value: string) => {
      const segments = splitPath(value);
      if (!segments.length) throw new FileAccessError('Choose a file or folder.');
      if (places.hidden(segments.join('/'))) throw new FileNotFoundError(`Nothing at ${segments.join('/')}`);
      return segments.join('/');
    };
    const ops: Array<Record<string, unknown>> = [];
    const uploads: Array<{ rel: string; source: string }> = [];
    const staging = `.karmax-injection/file-changes/${crypto.randomBytes(8).toString('hex')}`;
    for (const change of changes) {
      if (change.op === 'write') {
        const size = fs.statSync(change.source).size;
        if (size > CHANGE_LIMITS.file) throw new FileAccessError('Files over 512 MB can’t be uploaded here.');
        const tmp = `${staging}/${uploads.length}`;
        uploads.push({ rel: tmp, source: change.source });
        ops.push({ op: 'write', path: guard(change.path), tmp, ...(change.expect !== undefined ? { expect: change.expect } : {}) });
      } else if (change.op === 'copy' || change.op === 'move') ops.push({ op: change.op, from: guard(change.from), to: guard(change.to) });
      else ops.push({ op: change.op, path: guard((change as { path: string }).path) });
    }
    const access = await this.deps.openWorld(places.taskId, places.handle);
    try {
      const world = access.world;
      for (const upload of uploads) {
        const content = await fs.promises.readFile(upload.source);
        if (world.writeFileBuffer) await world.writeFileBuffer(upload.rel, content);
        else await world.writeFile(upload.rel, content.toString('utf8'));
      }
      const root = places.handle.root;
      const run = await world.exec('node', ['-e', WORLD_CHANGES, JSON.stringify([root, staging, ops])], { cwd: root });
      let answer: { ok?: true; error?: string; conflict?: true; missing?: true } = {};
      try { answer = JSON.parse(run.stdout); } catch { /* reported below */ }
      if (answer.ok) return { commits: [] };
      const message = answer.error || run.stderr.trim() || 'Couldn’t change the task’s files.';
      if (answer.conflict) throw new FileConflictError(message);
      if (answer.missing) throw new FileNotFoundError(message);
      throw new FileAccessError(message);
    } finally { await access.release(); }
  }

  // ── branches ──────────────────────────────────────────────────────────────

  private async applyToBranches(projectId: string, view: FileView, places: Extract<WritePlaces, { kind: 'branch' }>, changes: LocalChange[],
    author: FileChangeAuthor, scratch: string, options: ApplyOptions): Promise<FileChangeResult> {
    const byRepository = new Map<GitPlace, IndexOp[]>();
    const byData = new Map<DataPlace, DataOp[]>();
    const created = new Map<string, { place: GitPlace; inside: string; files: Array<{ rel: string; source: string }>; shape: 'directory' | 'file' }>();
    const secrets: Array<{ place: GitPlace; inside: string; source: string }> = [];
    const where = (value: string): { kind: 'git'; place: GitPlace; inside: string } | { kind: 'data'; mount: DataPlace; inside: string } => {
      const segments = splitPath(value);
      const mount = places.mounts.filter((candidate) => startsWith(segments, candidate.segments)).sort((a, b) => b.segments.length - a.segments.length)[0];
      if (mount) return { kind: 'data', mount, inside: segments.slice(mount.segments.length).join('/') };
      const place = places.checkouts.filter((candidate) => startsWith(segments, candidate.segments) && segments.length > candidate.segments.length)
        .sort((a, b) => b.segments.length - a.segments.length)[0];
      if (!place) throw new FileAccessError(segments.length && places.checkouts.some((candidate) => candidate.segments.join('/') === segments.join('/'))
        ? 'A repository’s own folder can’t be changed here.' : 'Only files inside a repository can be changed here.');
      const inside = segments.slice(place.segments.length);
      if (inside.includes('.git')) throw new FileAccessError('Git’s own files can’t be changed.');
      return { kind: 'git', place, inside: inside.join('/') };
    };
    const add = (place: GitPlace, op: IndexOp) => { const list = byRepository.get(place) ?? []; list.push(op); byRepository.set(place, list); };
    const addData = (mount: DataPlace, op: DataOp) => {
      // A data resource itself (its folder, or its one file) is removed or moved in Settings; a file resource is only replaced.
      const touches = 'path' in op ? [op.path] : [op.from, op.to];
      const allowed = mount.shape === 'file' ? op.op === 'write' && op.path === '' : touches.every(Boolean);
      if (!allowed) throw new FileAccessError(`${mount.name} is data: remove or move it in Settings.`);
      const list = byData.get(mount) ?? []; list.push(op); byData.set(mount, list);
    };
    for (const change of changes) {
      if (change.op === 'copy' || change.op === 'move') {
        const from = where(change.from), to = where(change.to);
        if (from.kind === 'data' && to.kind === 'data' && from.mount === to.mount) {
          addData(to.mount, { op: change.op, from: from.inside, to: to.inside });
          continue;
        }
        if (from.kind !== 'git' || to.kind !== 'git') throw new FileAccessError('Copy between data and a repository from another view.');
        add(to.place, { op: 'copy', from: from.inside, to: to.inside });
        if (change.op === 'move') add(from.place, { op: 'delete', path: from.inside });
        continue;
      }
      const at = where((change as { path: string }).path);
      if (change.op === 'write' && change.keep && at.kind === 'git') {
        if (change.keep === 'secret') { secrets.push({ place: at.place, inside: at.inside, source: change.source }); continue; }
        // A new folder of data, or a file of data on its own.
        const folder = change.dataFolder ? where(change.dataFolder) : undefined;
        if (folder && (folder.kind !== 'git' || folder.place !== at.place || !at.inside.startsWith(`${folder.inside}/`)))
          throw new FileAccessError(`${change.path} is not in ${change.dataFolder}.`);
        const key = folder ? `${at.place.name}\n${folder.inside}` : `${at.place.name}\n${at.inside}`;
        const group = created.get(key) ?? { place: at.place, inside: folder ? folder.inside : at.inside, files: [], shape: folder ? 'directory' as const : 'file' as const };
        group.files.push({ rel: folder ? at.inside.slice(folder.inside.length + 1) : '', source: change.source });
        created.set(key, group);
        continue;
      }
      if (at.kind === 'data') {
        if (change.op === 'write') {
          // An editor's save checks the version it opened, as in Git.
          if (change.expect !== undefined) await this.checkDataVersion(projectId, view, change.path, change.expect, options);
          addData(at.mount, { op: 'write', path: at.inside, source: change.source });
        } else addData(at.mount, { op: change.op, path: at.inside } as DataOp);
        continue;
      }
      if (change.op === 'write') add(at.place, { op: 'write', path: at.inside, source: change.source, ...(change.expect !== undefined ? { expect: change.expect } : {}) });
      else add(at.place, { op: change.op as 'mkdir' | 'delete', path: at.inside });
    }
    // Everything is allowed before anything is changed.
    for (const place of byRepository.keys())
      if (options.mayCommit && !(await options.mayCommit(place.branch)))
        throw new FileAccessError(`Changing ${place.branch} needs permission to land work on it (merge-into:${place.branch}).`);
    if (byData.size || created.size || secrets.length) {
      if (!this.deps.keeping) throw new FileAccessError('Data and secrets can’t be changed on this server.');
      if (options.mayKeep && !(await options.mayKeep())) throw new FileAccessError('Changing the project’s data and secrets needs project settings access (project:settings:write).');
    }
    const result: FileChangeResult = { commits: [] };
    // Secrets first: nothing that holds them ever reaches Git.
    for (const secret of secrets)
      (result.secrets ??= []).push(...await this.deps.keeping!.secret(projectId, { repository: secret.place.name, path: secret.inside }, secret.source));
    let index = 0;
    for (const group of created.values()) {
      const dir = path.join(scratch, `new-data-${index++}`);
      let source: string;
      if (group.shape === 'file') { fs.mkdirSync(dir, { recursive: true }); source = path.join(dir, path.posix.basename(group.inside)); fs.copyFileSync(group.files[0]!.source, source); }
      else {
        source = dir;
        for (const file of group.files) { const target = path.join(dir, ...file.rel.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file.source, target); }
      }
      const name = await this.deps.keeping!.create(projectId, { repository: group.place.name, path: group.inside }, group.shape, source);
      (result.data ??= []).push({ name, created: true });
    }
    for (const [mount, ops] of byData) {
      await this.changeData(mount, ops, path.join(scratch, `data-${index++}`));
      (result.data ??= []).push({ name: mount.name });
    }
    for (const [place, ops] of byRepository) {
      const commit = await this.commitTo(projectId, place, ops, author, path.join(scratch, `repository-${index++}`));
      if (commit) result.commits.push({ repository: place.name, branch: place.branch, commit });
    }
    return result;
  }

  private async checkDataVersion(projectId: string, view: FileView, where: string, expect: string | null, options: ApplyOptions): Promise<void> {
    const current = await this.deps.files.stat(projectId, where, { data: options.data, view })
      .catch((error) => { if (error instanceof FileNotFoundError) return undefined; throw error; });
    if (expect === null && current) throw new FileConflictError(`${where.split('/').pop()} already exists.`);
    if (expect && !current) throw new FileConflictError(`${where.split('/').pop()} was deleted since you opened it.`);
    if (expect && current?.version !== expect) throw new FileConflictError(`${where.split('/').pop()} changed since you opened it.`);
  }

  /** One new version of a data resource: its current one, changed, saved. */
  private async changeData(mount: DataPlace, ops: DataOp[], scratch: string): Promise<void> {
    const keeping = this.deps.keeping!;
    const root = path.join(scratch, 'data');
    fs.mkdirSync(root, { recursive: true });
    if (mount.shape === 'file') {
      // A one-file resource is replaced whole: only which version it replaces matters.
      const write = ops.at(-1) as Extract<DataOp, { op: 'write' }>;
      const revisionId = await keeping.version(mount.id);
      const file = path.join(root, mount.segments.at(-1)!);
      fs.copyFileSync(write.source, file);
      await keeping.save(mount.id, file, revisionId);
      return;
    }
    const { revisionId } = await keeping.restore(mount.id, root, DATA_EDIT_MAX);
    const staging = `.karmax-injection/file-changes/${crypto.randomBytes(8).toString('hex')}`;
    const steps: Array<Record<string, unknown>> = [];
    for (const [at, op] of ops.entries()) {
      if (op.op === 'write') {
        const tmp = `${staging}/${at}`;
        fs.mkdirSync(path.join(root, staging), { recursive: true });
        fs.copyFileSync(op.source, path.join(root, tmp));
        steps.push({ op: 'write', path: op.path, tmp });
      } else steps.push(op);
    }
    // The same rules as a task's world: never through a link out of the folder.
    const run = await runNode(WORLD_CHANGES, JSON.stringify([root, staging, steps]), root);
    fs.rmSync(path.join(root, '.karmax-injection'), { recursive: true, force: true });
    let answer: { ok?: true; error?: string; conflict?: true; missing?: true } = {};
    try { answer = JSON.parse(run.stdout); } catch { /* reported below */ }
    if (!answer.ok) {
      const message = `${mount.name}: ${answer.error || run.stderr.trim() || 'couldn’t change it'}`;
      throw answer.conflict ? new FileConflictError(message) : answer.missing ? new FileNotFoundError(message) : new FileAccessError(message);
    }
    await keeping.save(mount.id, root, revisionId);
  }

  /** One commit of `ops` on `place`'s branch, pushed; rebuilt once on a newer tip. */
  private async commitTo(projectId: string, place: GitPlace, ops: IndexOp[], author: FileChangeAuthor, scratch: string): Promise<string | undefined> {
    const credential = await this.deps.gitCredential(projectId, place.sshUrl);
    for (let attempt = 0; ; attempt++) {
      const dir = `${scratch}-${attempt}`;
      fs.mkdirSync(dir, { recursive: true });
      const { env } = materializeGitCredential(dir, credential);
      let cloned;
      try {
        cloned = await mirroredClone(place.sshUrl, path.join(dir, 'clone'), env, { branch: place.branch, scratch: dir, scope: credential.mirrorScope });
      } catch (error) {
        if (/Remote branch .* not found/.test(String((error as Error)?.message))) throw new FileAccessError(`${place.name} has no branch ${place.branch}.`);
        throw new Error(`Couldn’t read ${place.name}: ${firstLine(error)}`);
      }
      try {
        const clone = cloned.clone;
        const indexEnv = { ...env, GIT_INDEX_FILE: path.join(dir, 'index') };
        const run = async (args: string[], input?: string) => {
          const result = input === undefined ? await git(clone, args, { env: indexEnv, timeoutMs: 10 * 60_000 }) : await gitWithInput(clone, args, input, indexEnv);
          if (result.code !== 0) throw new Error(firstLine(result.stderr || result.stdout || `git ${args[0]} failed`));
          return result.stdout;
        };
        const tip = (await run(['rev-parse', 'HEAD'])).trim();
        await run(['read-tree', tip]);
        // The branch's tree, read once and changed in memory: a batch of
        // thousands of files costs a few git processes, not several per file.
        const tree = new IndexModel(parseIndex(await run(['ls-files', '-s', '-z'])));
        const writes: Array<{ path: string; source: string; mode: string }> = [];
        let empty = '';
        for (const op of ops) {
          if (op.op === 'write') {
            const file = tree.get(op.path);
            if (!file && tree.isFolder(op.path)) throw new FileConflictError(`${op.path} is a folder.`);
            if (op.expect === null && file) throw new FileConflictError(`${op.path} already exists.`);
            if (op.expect && file?.object !== op.expect) throw new FileConflictError(`${op.path} changed since you opened it.`);
            if (op.expect && !file) throw new FileConflictError(`${op.path} was deleted since you opened it.`);
            tree.refuseFileOnTheWay(op.path);
            const mode = file && file.mode === '100755' ? '100755' : '100644';
            // Hashed below, all at once; until then the entry names its source.
            tree.set({ mode, object: '', path: op.path });
            writes.push({ path: op.path, source: op.source, mode });
          } else if (op.op === 'mkdir') {
            if (tree.get(op.path)) throw new FileConflictError(`${op.path} already exists.`);
            tree.refuseFileOnTheWay(op.path);
            // Git keeps no empty folders: a new one holds an empty .gitkeep.
            const keep = `${op.path}/.gitkeep`;
            if (!tree.under(keep).length) {
              empty ||= (await run(['hash-object', '-w', '--stdin'], '')).trim();
              tree.set({ mode: '100644', object: empty, path: keep });
            }
          } else if (op.op === 'delete') {
            const gone = tree.under(op.path);
            if (!gone.length) throw new FileNotFoundError(`Nothing at ${op.path}`);
            for (const entry of gone) tree.remove(entry.path);
            for (let at = writes.length - 1; at >= 0; at--) if (writes[at]!.path === op.path || writes[at]!.path.startsWith(`${op.path}/`)) writes.splice(at, 1);
          } else {
            const copied = tree.under(op.from);
            if (!copied.length) throw new FileNotFoundError(`Nothing at ${op.from}`);
            if (op.to === op.from || op.to.startsWith(`${op.from}/`)) throw new FileConflictError('A folder can’t go inside itself.');
            if (tree.under(op.to).length) throw new FileConflictError(`${op.to} already exists.`);
            tree.refuseFileOnTheWay(op.to);
            for (const entry of copied) {
              const to = `${op.to}${entry.path.slice(op.from.length)}`;
              tree.set({ ...entry, path: to });
              // A copy of a file written earlier in this batch is that file.
              let pending: (typeof writes)[number] | undefined;
              for (const write of writes) if (write.path === entry.path) pending = write;
              if (pending) writes.push({ ...pending, path: to });
            }
          }
        }
        // Every written file's bytes, in one process; a path written twice keeps its last.
        const last = new Map(writes.map((write) => [write.path, write]));
        if (last.size) {
          const sources = [...last.values()];
          const objects = (await run(['hash-object', '-w', '--no-filters', '--stdin-paths'], `${sources.map((write) => write.source).join('\n')}\n`)).trim().split('\n');
          if (objects.length !== sources.length) throw new Error('git hash-object answered for fewer files than it was given');
          sources.forEach((write, at) => tree.set({ mode: write.mode, object: objects[at]!, path: write.path }));
        }
        // The index becomes the tree in memory: removals first, then what changed.
        const zero = '0'.repeat(tip.length);
        const lines = [...tree.removed().map((rel) => `0 ${zero}\t${rel}\0`), ...tree.changed().map((entry) => `${entry.mode} ${entry.object}\t${entry.path}\0`)];
        if (lines.length) await run(['update-index', '--add', '-z', '--index-info'], lines.join(''));
        const written = (await run(['write-tree'])).trim();
        if (written === (await run(['rev-parse', `${tip}^{tree}`])).trim()) return undefined;
        const identity = { ...indexEnv, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
        const made = await git(clone, ['commit-tree', written, '-p', tip, '-m', commitMessage(ops)], { env: identity });
        if (made.code !== 0) throw new Error(firstLine(made.stderr || made.stdout));
        const commit = made.stdout.trim();
        const pushed = await git(clone, ['push', '--porcelain', 'origin', `${commit}:refs/heads/${place.branch}`], { env, timeoutMs: 10 * 60_000 });
        forgetMirroredTip(place.sshUrl, credential.mirrorScope, place.branch);
        if (pushed.code !== 0) {
          const output = `${pushed.stderr}\n${pushed.stdout}`;
          if (attempt === 0 && /non-fast-forward|fetch first|\[rejected\]|stale info/i.test(output)) continue;
          throw new FileAccessError(`${place.name}: ${pushRefusal(output)}`);
        }
        await this.deps.afterPush?.(projectId, place).catch((error) => console.warn('[files] after push:', firstLine(error)));
        return commit;
      } finally {
        fs.rmSync(path.join(dir, 'clone'), { recursive: true, force: true });
        await cloned.release();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

type LocalChange =
  | { op: 'write'; path: string; source: string; expect?: string | null; keep?: 'data' | 'secret'; dataFolder?: string }
  | { op: 'mkdir'; path: string }
  | { op: 'delete'; path: string }
  | { op: 'copy' | 'move'; from: string; to: string };

interface IndexEntry { mode: string; object: string; path: string }

/** A branch's index in memory: files by path, and which paths are folders. */
class IndexModel {
  private readonly files = new Map<string, IndexEntry>();
  private readonly original = new Map<string, IndexEntry>();
  private folders: Set<string> | undefined;
  constructor(entries: IndexEntry[]) {
    for (const entry of entries) { this.files.set(entry.path, entry); this.original.set(entry.path, entry); }
  }
  get(rel: string): IndexEntry | undefined { return this.files.get(rel); }
  set(entry: IndexEntry): void {
    this.files.set(entry.path, entry);
    if (this.folders) for (const folder of parentsOf(entry.path)) this.folders.add(folder);
  }
  remove(rel: string): void { this.files.delete(rel); this.folders = undefined; }
  isFolder(rel: string): boolean {
    if (!this.folders) { this.folders = new Set(); for (const file of this.files.keys()) for (const folder of parentsOf(file)) this.folders.add(folder); }
    return this.folders.has(rel);
  }
  /** The file at `rel`, or every file under the folder `rel`. */
  under(rel: string): IndexEntry[] {
    const file = this.files.get(rel);
    if (file) return [file];
    if (!this.isFolder(rel)) return [];
    return [...this.files.values()].filter((entry) => entry.path.startsWith(`${rel}/`));
  }
  /** A file where `rel` needs a folder (`a` when writing `a/b`). */
  refuseFileOnTheWay(rel: string): void {
    for (const folder of parentsOf(rel)) if (this.files.has(folder)) throw new FileConflictError(`${folder} is a file.`);
  }
  removed(): string[] { return [...this.original.keys()].filter((rel) => !this.files.has(rel)); }
  changed(): IndexEntry[] {
    return [...this.files.values()].filter((entry) => {
      const was = this.original.get(entry.path);
      return !was || was.mode !== entry.mode || was.object !== entry.object;
    });
  }
}

/** `a` and `a/b` for `a/b/c`. */
function parentsOf(rel: string): string[] {
  const parts = rel.split('/');
  return parts.slice(1).map((_, at) => parts.slice(0, at + 1).join('/'));
}

function parseIndex(output: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const record of output.split('\0')) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) \d+\t([\s\S]+)$/.exec(record);
    if (match) entries.push({ mode: match[1]!, object: match[2]!, path: match[3]! });
  }
  return entries;
}

/** `node -e script arg` on this host, in `cwd`. */
function runNode(script: string, arg: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, arg], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** What the commit says it did, as GitHub's web editor would. */
export function commitMessage(ops: Array<{ op: string; path?: string; from?: string; to?: string }>): string {
  const name = (value = '') => value.split('/').pop() || value;
  const writes = ops.filter((op) => op.op === 'write'), deletes = ops.filter((op) => op.op === 'delete'),
    copies = ops.filter((op) => op.op === 'copy'), folders = ops.filter((op) => op.op === 'mkdir');
  // A move is a copy and a delete of where it came from.
  const moves = copies.filter((copy) => deletes.some((op) => op.path === copy.from));
  if (ops.length === 1 && writes.length === 1) return `Update ${name(writes[0]!.path)}`;
  if (moves.length === 1 && ops.length === 2) return `Rename ${name(moves[0]!.from)} to ${name(moves[0]!.to)}`;
  if (ops.length === 1 && deletes.length === 1) return `Delete ${name(deletes[0]!.path)}`;
  if (ops.length === 1 && folders.length === 1) return `Create ${name(folders[0]!.path)}`;
  if (ops.length === 1 && copies.length === 1) return `Copy ${name(copies[0]!.from)} to ${name(copies[0]!.to)}`;
  const parts: string[] = [];
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
  if (writes.length) parts.push(`add or update ${count(writes.length, 'file')}`);
  if (moves.length) parts.push(`move ${count(moves.length, 'item')}`);
  if (copies.length - moves.length) parts.push(`copy ${count(copies.length - moves.length, 'item')}`);
  if (deletes.length - moves.length) parts.push(`delete ${count(deletes.length - moves.length, 'item')}`);
  if (folders.length) parts.push(`create ${count(folders.length, 'folder')}`);
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pushRefusal(output: string): string {
  const remote = output.split('\n').map((line) => line.replace(/^remote:\s*/, '').trim())
    .find((line) => /protected|denied|permission|declined|GH\d+|not allowed|requires/i.test(line));
  return remote ? `the branch refused the change (${remote})` : firstLine(output);
}

function sameView(a: FileView, b: FileView): boolean {
  return a.kind === b.kind && (a.kind !== 'branch' || a.name === (b as { name: string }).name)
    && (a.kind !== 'task' || a.taskId === (b as { taskId: string }).taskId);
}

/** Whether a copy within one view stays in one source (a world, or one repository). */
function sameSource(places: WritePlaces, from: string, to: string): boolean {
  if (places.kind === 'world') return true;
  const owner = (value: string) => {
    let segments: string[];
    try { segments = splitPath(value); } catch { return undefined; }
    const mount = places.mounts.filter((candidate) => startsWith(segments, candidate.segments)).sort((a, b) => b.segments.length - a.segments.length)[0];
    if (mount) return mount;
    return places.checkouts.filter((candidate) => startsWith(segments, candidate.segments)).sort((a, b) => b.segments.length - a.segments.length)[0];
  };
  const source = owner(from);
  return Boolean(source && source === owner(to));
}

function startsWith(segments: string[], prefix: string[]): boolean {
  return prefix.length <= segments.length && prefix.every((segment, index) => segments[index] === segment);
}

function joinPath(...values: string[]): string {
  return values.flatMap((value) => value.split('/')).filter(Boolean).join('/');
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n').map((line) => line.trim()).find(Boolean) ?? 'unknown error';
}

/** Runs in the world: the batch, in order, stopping at the first refusal.
 * Never through a link out of the world root, never into tavya's own folder
 * or Git's; a write replaces a file only when `expect` (its version when it
 * was opened, `<mtime>-<size>`) still holds, or creates one when it is null. */
const WORLD_CHANGES = `const fs = require('node:fs'), path = require('node:path');
const [root, staging, ops] = JSON.parse(process.argv[1]);
const out = (value) => { try { fs.rmSync(path.join(root, staging), { recursive: true, force: true }); } catch {} process.stdout.write(JSON.stringify(value)); process.exit(0); };
const realRoot = fs.realpathSync(root);
const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
const hidden = new Set(['.karmax-injection', '.git']);
const refuse = (error, extra = {}) => out({ error, ...extra });
// The place of rel: its real parent folder inside the world, and its name there.
const place = (rel, makeParent) => {
  const segments = rel.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..' || hidden.has(s))) refuse('That path can’t be changed.');
  const parentRel = segments.slice(0, -1).join('/');
  const parent = path.join(root, parentRel);
  if (makeParent) {
    let at = root;
    for (const s of segments.slice(0, -1)) {
      at = path.join(at, s);
      let st; try { st = fs.lstatSync(at); } catch { st = null; }
      if (!st) { fs.mkdirSync(at); continue; }
      if (st.isSymbolicLink()) { const real = fs.realpathSync(at); if (!inside(real) || !fs.statSync(real).isDirectory()) refuse(parentRel + ' isn’t a folder.'); continue; }
      if (!st.isDirectory()) refuse(path.relative(root, at) + ' is a file.', { conflict: true });
    }
  }
  let realParent; try { realParent = fs.realpathSync(parent); } catch { refuse('Nothing at ' + (parentRel || '/'), { missing: true }); }
  if (!inside(realParent)) refuse('That path leads out of the task’s files.');
  return path.join(realParent, segments.at(-1));
};
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const version = (st) => Math.floor(st.mtimeMs) + '-' + st.size;
for (const op of ops) {
  if (op.op === 'write') {
    const target = place(op.path, true);
    let st; try { st = fs.lstatSync(target); } catch { st = null; }
    if (st && st.isDirectory()) refuse(op.path + ' is a folder.', { conflict: true });
    if (op.expect === null && st) refuse(op.path + ' already exists.', { conflict: true });
    if (op.expect && !st) refuse(op.path + ' was deleted since you opened it.', { conflict: true });
    if (op.expect && st && version(st) !== op.expect) refuse(op.path + ' changed since you opened it.', { conflict: true });
    const tmp = path.join(root, op.tmp);
    const mode = st && st.isFile() ? st.mode & 0o777 : null;
    if (st && st.isSymbolicLink()) fs.rmSync(target);
    try { fs.renameSync(tmp, target); } catch { fs.copyFileSync(tmp, target); fs.rmSync(tmp, { force: true }); }
    if (mode !== null) fs.chmodSync(target, mode);
  } else if (op.op === 'mkdir') {
    const target = place(op.path, true);
    if (exists(target)) refuse(op.path + ' already exists.', { conflict: true });
    fs.mkdirSync(target);
  } else if (op.op === 'delete') {
    const target = place(op.path, false);
    if (!exists(target)) refuse('Nothing at ' + op.path, { missing: true });
    fs.rmSync(target, { recursive: true, force: true });
  } else if (op.op === 'copy' || op.op === 'move') {
    const from = place(op.from, false);
    if (!exists(from)) refuse('Nothing at ' + op.from, { missing: true });
    if (op.to === op.from || op.to.startsWith(op.from + '/')) refuse('A folder can’t go inside itself.', { conflict: true });
    const to = place(op.to, true);
    if (exists(to)) refuse(op.to + ' already exists.', { conflict: true });
    if (op.op === 'move') { try { fs.renameSync(from, to); continue; } catch (error) { if (error.code !== 'EXDEV') refuse(String(error.message)); } }
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
    if (op.op === 'move') fs.rmSync(from, { recursive: true, force: true });
  } else refuse('Unknown change.');
}
out({ ok: true });`;
