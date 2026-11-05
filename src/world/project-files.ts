import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Store } from '../store/db.js';
import type { WorkspaceManifest, WorkspaceService } from './workspace.js';
import type { ProjectResourceService } from './resources.js';
import type { GitBrokerCredential } from './git-broker.js';
import { readMirrored } from './git-mirror.js';
import { catBlob, git } from './git.js';
import { materializeGitCredential } from './git-credential.js';
import { RESTIC_ENGINE, ROOT_PART, storedRef, type Repository as ResticRepository, type SnapshotEntry } from './restic-engine.js';

/**
 * The project as a file tree (wiki features/project-files): the layout a
 * task's world has and `tavya clone` assembles (WorkspaceService): a folder per
 * repository at the branch tasks start from, the project wiki, and each data
 * resource's current version where it is mounted, over whatever the repository
 * has there. Paths are relative to that root, `/`-separated, as in the address
 * bar. Everything is read on the host: Git from the broker's mirror cache,
 * data with restic from the resource's repository. Nothing here writes.
 */

export type FileKind = 'directory' | 'file' | 'symlink' | 'submodule';

export interface FileEntry {
  name: string;
  kind: FileKind;
  size?: number;
  /** What mounts here: a repository's checkout, the project wiki, or a data resource. */
  mount?: 'repository' | 'wiki' | 'data';
}

/** Where a path's content comes from. */
export type FileSource =
  | { kind: 'project' }
  | { kind: 'repository'; name: string; role: 'development' | 'project-wiki'; branch: string; commit: string }
  | { kind: 'data'; id: string; name: string; revisionId?: string; access: 'read' | 'write' };

export interface FileNode {
  path: string;
  kind: FileKind;
  source: FileSource;
  /** A directory's entries, folders first, then by name. */
  entries?: FileEntry[];
  size?: number;
  /** A symlink's target, as written; a submodule's commit. */
  target?: string;
  /** Changes whenever the content does (an ETag). */
  version?: string;
}

export interface OpenedFile { node: FileNode; size: number; stream: Readable; done: Promise<void>; stop: () => void }

export class FileNotFoundError extends Error {}
export class FileAccessError extends Error {}

export interface ProjectFilesDeps {
  store: Store;
  workspaces: Pick<WorkspaceService, 'project'>;
  resources?: ProjectResourceService;
  /** The credential the host reads a project repository with. */
  gitCredential: (projectId: string, sshUrl: string) => Promise<GitBrokerCredential>;
}

/** How long a branch tip origin advertised is trusted before asking again. */
const TIP_MAX_AGE_MS = 30_000;
/** Snapshot listings never change: kept by snapshot and directory. */
const LISTING_CACHE = 500;

type Mount = WorkspaceManifest['resources'][number] & { segments: string[] };

export class ProjectFiles {
  private readonly listings = new Map<string, SnapshotEntry[]>();

  constructor(private readonly deps: ProjectFilesDeps) {}

  /** What is at `relative`: a directory with its entries, or a file's facts.
   * `data: false` (no right to read the project's data) still shows where
   * data is mounted, but refuses its contents. */
  async stat(projectId: string, relative: string, options: { data: boolean }): Promise<FileNode> {
    const at = await this.locate(projectId, relative, options);
    return at.stat();
  }

  /** A file's bytes. `consume` runs while the source is held open (a Git
   * mirror stays borrowed until it settles). */
  async open<T>(projectId: string, relative: string, options: { data: boolean }, consume: (file: OpenedFile) => Promise<T>): Promise<T> {
    const at = await this.locate(projectId, relative, options);
    return at.open(consume);
  }

  private async locate(projectId: string, relative: string, options: { data: boolean }): Promise<{
    stat: () => Promise<FileNode>; open: <T>(consume: (file: OpenedFile) => Promise<T>) => Promise<T> }> {
    const segments = splitPath(relative);
    const manifest = await this.deps.workspaces.project(projectId);
    const mounts: Mount[] = manifest.resources.map((resource) => ({ ...resource, segments: splitPath(resource.path) }))
      .filter((mount) => mount.segments.length > 0);
    const mount = mounts.filter((candidate) => startsWith(segments, candidate.segments))
      .sort((a, b) => b.segments.length - a.segments.length)[0];
    const display = segments.join('/');
    if (mount) {
      if (!options.data) throw new FileAccessError(`Viewing data needs access to project settings (project:settings:read).`);
      const inside = segments.slice(mount.segments.length);
      return {
        stat: () => this.dataStat(mount, inside, display, mounts, segments),
        open: (consume) => this.dataOpen(mount, inside, display, consume),
      };
    }
    const overlay = (directory: string[]) => overlayEntries(mounts, directory);
    if (!segments.length) {
      return {
        stat: async () => ({ path: '', kind: 'directory', source: { kind: 'project' },
          entries: sortEntries(merge(manifest.repositories.map((repository): FileEntry => ({ name: repository.name, kind: 'directory',
            mount: repository.role === 'project-wiki' ? 'wiki' : 'repository' })), overlay([]))) }),
        open: () => { throw new FileAccessError('This is a folder.'); },
      };
    }
    const repository = manifest.repositories.find((candidate) => candidate.name === segments[0]);
    if (!repository) {
      const virtual = overlay(segments);
      if (virtual.length) return { stat: async () => ({ path: display, kind: 'directory', source: { kind: 'project' }, entries: sortEntries(virtual) }),
        open: () => { throw new FileAccessError('This is a folder.'); } };
      throw new FileNotFoundError(`Nothing at ${display}`);
    }
    const inside = segments.slice(1);
    return {
      stat: () => this.gitStat(projectId, repository, inside, display, overlay(segments)),
      open: (consume) => this.gitOpen(projectId, repository, inside, display, consume),
    };
  }

  // ── repositories ──────────────────────────────────────────────────────────

  private async withRepository<T>(projectId: string, repository: WorkspaceManifest['repositories'][number],
    read: (mirror: string, commit: string, source: FileSource) => Promise<T>): Promise<T> {
    const credential = await this.deps.gitCredential(projectId, repository.sshUrl);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-files-'));
    try {
      const { env } = materializeGitCredential(scratch, credential);
      return await readMirrored(repository.sshUrl, env, { branch: repository.branch, scratch, scope: credential.mirrorScope, maxAgeMs: TIP_MAX_AGE_MS },
        (mirror, commit, branch) => read(mirror, commit, { kind: 'repository', name: repository.name, role: repository.role, branch, commit }));
    } catch (error) {
      if (error instanceof FileNotFoundError || error instanceof FileAccessError) throw error;
      throw new Error(`Couldn’t read ${repository.name}: ${firstLine(error)}`);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  private gitStat(projectId: string, repository: WorkspaceManifest['repositories'][number], inside: string[], display: string,
    overlay: FileEntry[]): Promise<FileNode> {
    return this.withRepository(projectId, repository, async (mirror, commit, source) => {
      const directory = async (tree: string, version?: string): Promise<FileNode> => ({ path: display, kind: 'directory', source,
        entries: sortEntries(merge(await listTree(mirror, tree), overlay)), ...(version ? { version } : {}) });
      if (!inside.length) return directory(commit, `${commit}:`);
      const entry = await treeEntry(mirror, commit, inside.join('/'));
      if (!entry) {
        // A folder only a data mount below it makes (data/raw with no data/ in Git).
        if (overlay.length) return { path: display, kind: 'directory', source, entries: sortEntries(overlay) };
        throw new FileNotFoundError(`Nothing at ${display}`);
      }
      if (entry.kind === 'directory') return directory(`${commit}:${inside.join('/')}`, entry.object);
      if (entry.kind === 'submodule') return { path: display, kind: 'submodule', source, target: entry.object };
      if (entry.kind === 'symlink') {
        const target = await git(mirror, ['cat-file', 'blob', entry.object]);
        return { path: display, kind: 'symlink', source, target: target.stdout, version: entry.object };
      }
      return { path: display, kind: 'file', source, size: entry.size ?? 0, version: entry.object };
    });
  }

  private gitOpen<T>(projectId: string, repository: WorkspaceManifest['repositories'][number], inside: string[], display: string,
    consume: (file: OpenedFile) => Promise<T>): Promise<T> {
    return this.withRepository(projectId, repository, async (mirror, commit, source) => {
      const entry = inside.length ? await treeEntry(mirror, commit, inside.join('/')) : undefined;
      if (!entry) throw new FileNotFoundError(`Nothing at ${display}`);
      if (entry.kind !== 'file') throw new FileAccessError(`${display} is not a file.`);
      const blob = catBlob(mirror, entry.object);
      return consume({ node: { path: display, kind: 'file', source, size: entry.size ?? 0, version: entry.object },
        size: entry.size ?? 0, ...blob });
    });
  }

  // ── data ──────────────────────────────────────────────────────────────────

  /** The resource's repository and the snapshot holding `inside` (an on-demand
   * version keeps each top-level folder in its own), or none yet. */
  private async dataVersion(mount: Mount): Promise<{ repository: ResticRepository; source: FileSource;
    snapshotOf: (inside: string[]) => string | undefined; parts?: Record<string, { snapshot: string }> } | undefined> {
    if (!this.deps.resources) throw new Error('Project data is unavailable on this server.');
    const attachment = await this.deps.store.getResourceAttachment(mount.id);
    if (!attachment) throw new FileNotFoundError(`Nothing at ${mount.path}`);
    const source: FileSource = { kind: 'data', id: mount.id, name: mount.name, access: mount.access,
      ...(mount.revisionId ? { revisionId: mount.revisionId } : {}) };
    const revision = mount.revisionId ? await this.deps.store.getResourceRevision(mount.revisionId) : undefined;
    if (!revision) return undefined;
    if (revision.engine !== RESTIC_ENGINE) throw new FileAccessError(`${mount.name} is still being converted to the current storage format; try again in an hour.`);
    const ref = storedRef(revision);
    const repository = this.deps.resources.restic.of(attachment, revision);
    if (ref.snapshot) return { repository, source, snapshotOf: () => ref.snapshot };
    const parts = ref.parts ?? {};
    return { repository, source, parts,
      snapshotOf: (inside) => inside.length ? (parts[inside[0]!] && inside[0] !== ROOT_PART ? parts[inside[0]!]!.snapshot : parts[ROOT_PART]?.snapshot) : undefined };
  }

  private async listing(repository: ResticRepository, snapshot: string, directory: string): Promise<SnapshotEntry[]> {
    const key = `${repository.name}\n${snapshot}\n${directory}`;
    const cached = this.listings.get(key);
    if (cached) { this.listings.delete(key); this.listings.set(key, cached); return cached; }
    const entries = await this.deps.resources!.restic.entries(repository, snapshot, directory);
    if (this.listings.size >= LISTING_CACHE) this.listings.delete(this.listings.keys().next().value!);
    this.listings.set(key, entries);
    return entries;
  }

  /** The single file a file-shaped resource's snapshot holds. */
  private async onlyFile(repository: ResticRepository, snapshot: string): Promise<SnapshotEntry | undefined> {
    return (await this.listing(repository, snapshot, '')).find((entry) => entry.type === 'file');
  }

  private async dataStat(mount: Mount, inside: string[], display: string, mounts: Mount[], segments: string[]): Promise<FileNode> {
    const version = await this.dataVersion(mount);
    const source: FileSource = version?.source ?? { kind: 'data', id: mount.id, name: mount.name, access: mount.access };
    const nested = overlayEntries(mounts.filter((other) => other !== mount), segments);
    if (mount.shape === 'file') {
      if (inside.length) throw new FileNotFoundError(`Nothing at ${display}`);
      const file = version ? await this.onlyFile(version.repository, version.snapshotOf([])!) : undefined;
      return { path: display, kind: 'file', source, size: file?.size ?? 0, ...(version ? { version: tag(version.snapshotOf([])!, '') } : {}) };
    }
    if (!version) {
      if (inside.length) throw new FileNotFoundError(`Nothing at ${display}`);
      return { path: display, kind: 'directory', source, entries: sortEntries(nested) };
    }
    const asEntry = (entry: SnapshotEntry): FileEntry => ({ name: entry.name,
      kind: entry.type === 'dir' ? 'directory' : entry.type === 'symlink' ? 'symlink' : 'file', ...(entry.size !== undefined ? { size: entry.size } : {}) });
    if (!inside.length && version.parts) {
      const folders = Object.keys(version.parts).filter((name) => name !== ROOT_PART).map((name): FileEntry => ({ name, kind: 'directory' }));
      const loose = version.parts[ROOT_PART] ? (await this.listing(version.repository, version.parts[ROOT_PART].snapshot, '')).map(asEntry) : [];
      return { path: display, kind: 'directory', source, entries: sortEntries(merge([...folders, ...loose], nested)), version: tag(Object.values(version.parts).map((part) => part.snapshot).join(','), '') };
    }
    const snapshot = version.snapshotOf(inside)!;
    if (!snapshot) throw new FileNotFoundError(`Nothing at ${display}`);
    const directory = async (dir: string): Promise<FileNode> => ({ path: display, kind: 'directory', source,
      entries: sortEntries(merge((await this.listing(version.repository, snapshot, dir)).map(asEntry), nested)), version: tag(snapshot, dir) });
    if (!inside.length) return directory('');
    const parent = inside.slice(0, -1).join('/');
    const entry = (await this.listing(version.repository, snapshot, parent)).find((candidate) => candidate.name === inside.at(-1));
    if (!entry) {
      if (nested.length) return { path: display, kind: 'directory', source, entries: sortEntries(nested) };
      throw new FileNotFoundError(`Nothing at ${display}`);
    }
    if (entry.type === 'dir') return directory(inside.join('/'));
    if (entry.type === 'symlink') return { path: display, kind: 'symlink', source, target: entry.linkTarget ?? '' };
    return { path: display, kind: 'file', source, size: entry.size ?? 0, version: tag(snapshot, inside.join('/')) };
  }

  private async dataOpen<T>(mount: Mount, inside: string[], display: string, consume: (file: OpenedFile) => Promise<T>): Promise<T> {
    const node = await this.dataStat(mount, inside, display, [], splitPath(mount.path).concat(inside));
    if (node.kind !== 'file') throw new FileAccessError(`${display} is not a file.`);
    const version = (await this.dataVersion(mount))!;
    if (!version) throw new FileNotFoundError(`Nothing at ${display}`);
    const snapshot = version.snapshotOf(mount.shape === 'file' ? [] : inside)!;
    const file = mount.shape === 'file' ? (await this.onlyFile(version.repository, snapshot))!.name : inside.join('/');
    const opened = await this.deps.resources!.restic.open(version.repository, snapshot, file);
    return consume({ node, size: node.size ?? 0, ...opened });
  }
}

/** `a//b/` → ['a', 'b']; `..` and `.` are refused, not resolved. */
export function splitPath(value: string): string[] {
  const segments = String(value ?? '').replace(/\\/g, '/').split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..' || segment.includes('\0'))) throw new FileNotFoundError('That path leaves the project.');
  return segments;
}

function startsWith(segments: string[], prefix: string[]): boolean {
  return prefix.length <= segments.length && prefix.every((segment, index) => segments[index] === segment);
}

/** What data mounts add to `directory`: the mount itself, or the folder on the way to one. */
function overlayEntries(mounts: Mount[], directory: string[]): FileEntry[] {
  const entries = new Map<string, FileEntry>();
  for (const mount of mounts) {
    if (mount.segments.length <= directory.length || !startsWith(mount.segments, directory)) continue;
    const name = mount.segments[directory.length]!;
    if (mount.segments.length === directory.length + 1)
      entries.set(name, { name, kind: mount.shape === 'file' ? 'file' : 'directory', mount: 'data',
        ...(mount.shape === 'file' && mount.bytes !== undefined ? { size: mount.bytes } : {}) });
    else if (!entries.has(name)) entries.set(name, { name, kind: 'directory' });
  }
  return [...entries.values()];
}

/** A mount replaces what its folder has under the same name, as it does in a world. */
function merge(base: FileEntry[], overlay: FileEntry[]): FileEntry[] {
  const byName = new Map(base.map((entry) => [entry.name, entry]));
  for (const entry of overlay) {
    const existing = byName.get(entry.name);
    if (entry.mount || !existing || existing.kind !== 'directory') byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function sortEntries(entries: FileEntry[]): FileEntry[] {
  const rank = (entry: FileEntry) => (entry.kind === 'directory' || entry.kind === 'submodule' ? 0 : 1);
  return entries.sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1));
}

function tag(snapshot: string, file: string): string {
  return crypto.createHash('sha256').update(`${snapshot}\n${file}`).digest('hex').slice(0, 40);
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n').map((line) => line.trim()).find(Boolean) ?? 'unknown error';
}

interface TreeEntry { name: string; kind: FileKind; object: string; size?: number }

function parseTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split('\0')) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match) continue;
    const [, mode, type, object, size, name] = match;
    const kind: FileKind = type === 'tree' ? 'directory' : type === 'commit' ? 'submodule' : mode === '120000' ? 'symlink' : 'file';
    entries.push({ name: name!, kind, object: object!, ...(size !== '-' && kind === 'file' ? { size: Number(size) } : {}) });
  }
  return entries;
}

async function listTree(mirror: string, tree: string): Promise<FileEntry[]> {
  const listed = await git(mirror, ['ls-tree', '-z', '-l', tree]);
  if (listed.code !== 0) throw new Error(listed.stderr || listed.stdout || 'git ls-tree failed');
  return parseTree(listed.stdout).map((entry) => ({ name: entry.name, kind: entry.kind, ...(entry.size !== undefined ? { size: entry.size } : {}) }));
}

/** The entry at `file` of `commit`, or none. */
async function treeEntry(mirror: string, commit: string, file: string): Promise<TreeEntry | undefined> {
  const listed = await git(mirror, ['--literal-pathspecs', 'ls-tree', '-z', '-l', commit, '--', file]);
  if (listed.code !== 0) throw new Error(listed.stderr || listed.stdout || 'git ls-tree failed');
  const entry = parseTree(listed.stdout)[0];
  return entry && entry.name === file ? { ...entry, name: path.posix.basename(file) } : undefined;
}
