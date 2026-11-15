import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { GitBrokerCredential } from './git-broker.js';
import type { World, WorldHandle } from './types.js';
import { forgetMirroredTip, mirroredClone } from './git-mirror.js';
import { git } from './git.js';
import { materializeGitCredential } from './git-credential.js';
import { FileAccessError, FileNotFoundError, splitPath, type FileView, type ProjectFiles, type WritePlaces } from './project-files.js';

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
 * Data mounted in a branch view is read-only here (a new version of a data
 * resource is made by a task, or imported in Settings); so are the project's
 * root, a repository's own folder and a data mount's.
 */

export type FileChange =
  /** `source`: a file on this host holding the bytes. `expect`: the version
   * replaced (an editor's save), or null for a file that must not exist yet. */
  | { op: 'write'; path: string; source: string; expect?: string | null }
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
}

export interface FileChangeAuthor { name: string; email: string }

export interface FileChangeResult {
  /** Each commit pushed, in a branch view. */
  commits: Array<{ repository: string; branch: string; commit: string }>;
}

export interface ProjectFileChangesDeps {
  files: ProjectFiles;
  gitCredential: (projectId: string, sshUrl: string) => Promise<GitBrokerCredential>;
  /** A task's world to write into, woken when parked; released after. */
  openWorld?: (taskId: string, handle: WorldHandle) => Promise<{ world: World; release(): Promise<void> }>;
  /** After a push to `sshUrl` (the canonical wiki follows its repository). */
  afterPush?: (projectId: string, place: { sshUrl: string; role: 'development' | 'project-wiki'; branch: string }) => Promise<void>;
}

/** What one batch may carry. */
export const CHANGE_LIMITS = { changes: 2000, files: 5000, bytes: 1024 * 1024 * 1024, file: 512 * 1024 * 1024 } as const;

interface GitPlace { name: string; segments: string[]; role: 'development' | 'project-wiki'; sshUrl: string; branch: string }

/** One index operation inside a checkout. */
type IndexOp =
  | { op: 'write'; path: string; source: string; expect?: string | null }
  | { op: 'delete'; path: string }
  | { op: 'copy'; from: string; to: string }
  | { op: 'mkdir'; path: string };

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
        local.push(change.op === 'copy' || change.op === 'move' ? { op: change.op, from: change.from, to: change.to } : change);
      }
      const result = places.kind === 'world'
        ? await this.applyToWorld(projectId, places, local as LocalChange[])
        : await this.applyToBranches(projectId, places, local as LocalChange[], author, scratch, options);
      // A move from elsewhere removes what it took once it is safely written.
      for (const moved of sources) {
        const more = await this.apply(projectId, moved.view, [{ op: 'delete', path: moved.path }], author, options);
        result.commits.push(...more.commits);
      }
      return result;
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
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
        if ((bytes += file.size) > CHANGE_LIMITS.bytes) { file.stop(); throw new FileAccessError('Too much to copy at once (1 GB).'); }
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

  private async applyToBranches(projectId: string, places: Extract<WritePlaces, { kind: 'branch' }>, changes: LocalChange[],
    author: FileChangeAuthor, scratch: string, options: ApplyOptions): Promise<FileChangeResult> {
    const byRepository = new Map<GitPlace, IndexOp[]>();
    const where = (value: string): { place: GitPlace; inside: string } => {
      const segments = splitPath(value);
      if (places.mounts.some((mount) => startsWith(segments, mount))) throw new FileAccessError('Data is read-only here: change it in a task.');
      const place = places.checkouts.filter((candidate) => startsWith(segments, candidate.segments) && segments.length > candidate.segments.length)
        .sort((a, b) => b.segments.length - a.segments.length)[0];
      if (!place) throw new FileAccessError(segments.length && places.checkouts.some((candidate) => candidate.segments.join('/') === segments.join('/'))
        ? 'A repository’s own folder can’t be changed here.' : 'Only files inside a repository can be changed here.');
      const inside = segments.slice(place.segments.length);
      if (inside.includes('.git')) throw new FileAccessError('Git’s own files can’t be changed.');
      return { place, inside: inside.join('/') };
    };
    const add = (place: GitPlace, op: IndexOp) => { const list = byRepository.get(place) ?? []; list.push(op); byRepository.set(place, list); };
    for (const change of changes) {
      if (change.op === 'copy' || change.op === 'move') {
        const from = where(change.from), to = where(change.to);
        add(to.place, { op: 'copy', from: from.inside, to: to.inside });
        if (change.op === 'move') add(from.place, { op: 'delete', path: from.inside });
      } else if (change.op === 'write') {
        const at = where(change.path);
        add(at.place, { op: 'write', path: at.inside, source: change.source, ...(change.expect !== undefined ? { expect: change.expect } : {}) });
      } else { const at = where((change as { path: string }).path); add(at.place, { op: change.op as 'mkdir' | 'delete', path: at.inside }); }
    }
    // Every repository is allowed before any is changed.
    for (const place of byRepository.keys())
      if (options.mayCommit && !(await options.mayCommit(place.branch)))
        throw new FileAccessError(`Changing ${place.branch} needs permission to land work on it (merge-into:${place.branch}).`);
    const commits: FileChangeResult['commits'] = [];
    let index = 0;
    for (const [place, ops] of byRepository) {
      const commit = await this.commitTo(projectId, place, ops, author, path.join(scratch, `repository-${index++}`));
      if (commit) commits.push({ repository: place.name, branch: place.branch, commit });
    }
    return { commits };
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
          const result = input === undefined ? await git(clone, args, { env: indexEnv, timeoutMs: 10 * 60_000 }) : await gitInput(clone, args, input, indexEnv);
          if (result.code !== 0) throw new Error(firstLine(result.stderr || result.stdout || `git ${args[0]} failed`));
          return result.stdout;
        };
        const tip = (await run(['rev-parse', 'HEAD'])).trim();
        await run(['read-tree', tip]);
        const entries = async (rel: string) => parseIndex(await run(['ls-files', '-s', '-z', '--', `:(literal)${rel}`]))
          .filter((entry) => entry.path === rel || entry.path.startsWith(`${rel}/`));
        for (const op of ops) {
          if (op.op === 'write') {
            const existing = await entries(op.path);
            const file = existing.find((entry) => entry.path === op.path);
            if (!file && existing.length) throw new FileConflictError(`${op.path} is a folder.`);
            if (op.expect === null && file) throw new FileConflictError(`${op.path} already exists.`);
            if (op.expect && file?.object !== op.expect) throw new FileConflictError(`${op.path} changed since you opened it.`);
            if (op.expect && !file) throw new FileConflictError(`${op.path} was deleted since you opened it.`);
            await this.refuseFileOnTheWay(entries, op.path);
            const object = (await run(['hash-object', '-w', '--no-filters', '--', op.source])).trim();
            const mode = file && file.mode === '100755' ? '100755' : '100644';
            await run(['update-index', '--add', '--cacheinfo', `${mode},${object},${op.path}`]);
          } else if (op.op === 'mkdir') {
            if ((await entries(op.path)).some((entry) => entry.path === op.path)) throw new FileConflictError(`${op.path} already exists.`);
            await this.refuseFileOnTheWay(entries, op.path);
            // Git keeps no empty folders: a new one holds an empty .gitkeep.
            const keep = `${op.path}/.gitkeep`;
            if (!(await entries(keep)).length) {
              const empty = (await run(['hash-object', '-w', '--stdin'], '')).trim();
              await run(['update-index', '--add', '--cacheinfo', `100644,${empty},${keep}`]);
            }
          } else if (op.op === 'delete') {
            const gone = await entries(op.path);
            if (!gone.length) throw new FileNotFoundError(`Nothing at ${op.path}`);
            await run(['update-index', '--force-remove', '-z', '--stdin'], gone.map((entry) => `${entry.path}\0`).join(''));
          } else {
            const copied = await entries(op.from);
            if (!copied.length) throw new FileNotFoundError(`Nothing at ${op.from}`);
            if (op.to === op.from || op.to.startsWith(`${op.from}/`)) throw new FileConflictError('A folder can’t go inside itself.');
            if ((await entries(op.to)).length) throw new FileConflictError(`${op.to} already exists.`);
            await this.refuseFileOnTheWay(entries, op.to);
            await run(['update-index', '--add', '-z', '--index-info'], copied.map((entry) =>
              `${entry.mode} ${entry.object}\t${op.to}${entry.path.slice(op.from.length)}\0`).join(''));
          }
        }
        const tree = (await run(['write-tree'])).trim();
        if (tree === (await run(['rev-parse', `${tip}^{tree}`])).trim()) return undefined;
        const identity = { ...indexEnv, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
        const made = await git(clone, ['commit-tree', tree, '-p', tip, '-m', commitMessage(ops)], { env: identity });
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

  /** A file where `rel` needs a folder (`a` when writing `a/b`). */
  private async refuseFileOnTheWay(entries: (rel: string) => Promise<IndexEntry[]>, rel: string): Promise<void> {
    const parts = rel.split('/');
    for (let at = 1; at < parts.length; at++) {
      const prefix = parts.slice(0, at).join('/');
      if ((await entries(prefix)).some((entry) => entry.path === prefix)) throw new FileConflictError(`${prefix} is a file.`);
    }
  }
}

type LocalChange =
  | { op: 'write'; path: string; source: string; expect?: string | null }
  | { op: 'mkdir'; path: string }
  | { op: 'delete'; path: string }
  | { op: 'copy' | 'move'; from: string; to: string };

interface IndexEntry { mode: string; object: string; path: string }

function parseIndex(output: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const record of output.split('\0')) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) \d+\t([\s\S]+)$/.exec(record);
    if (match) entries.push({ mode: match[1]!, object: match[2]!, path: match[3]! });
  }
  return entries;
}

/** `git` with `input` on stdin (index updates), in a scratch clone of our own. */
function gitInput(cwd: string, args: string[], input: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', ...args],
      { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
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
    if (places.mounts.some((mount) => startsWith(segments, mount))) return undefined;
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
