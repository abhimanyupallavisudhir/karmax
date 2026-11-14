import { isHostedRepository, repositoryBrokerCredentials } from './hosted-git.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { Store } from '../store/db.js';
import type { WorldCheckpoint } from '../domain/types.js';
import type { WorkspaceManifest, WorkspaceService } from './workspace.js';
import type { ProjectResourceService } from './resources.js';
import type { GitBrokerCredential } from './git-broker.js';
import type { ManifestEntry } from './checkpoint-chunks.js';
import type { World, WorldHandle } from './types.js';
import { isRemoteWorldKind, worldRepos, worldRepoSource, worldWorkingRelativePath } from './types.js';
import { MirroredCommitMissing, readMirrored } from './git-mirror.js';
import { catBlob, git } from './git.js';
import { materializeGitCredential } from './git-credential.js';
import { sameRepository } from './repository-identity.js';
import { RESTIC_ENGINE, ROOT_PART, storedRef, type Repository as ResticRepository, type SnapshotEntry } from './restic-engine.js';

/**
 * The project as a file tree (wiki features/project-files): the layout a
 * task's world has and `tavya clone` assembles (WorkspaceService): a folder per
 * repository, the project wiki, and each data resource where it is mounted,
 * over whatever the repository has there. Paths are relative to that root,
 * `/`-separated, as in the address bar.
 *
 * What it shows (`FileView`): the branches tasks start from (default), another
 * branch of each repository, or a task's world. A task's world is read live
 * while it runs, and otherwise from its last save (each checkout's commit plus
 * the uncommitted files its checkpoint holds, and the data it had), so looking
 * never wakes a sandbox. Everything else is read on the host: Git from the
 * broker's mirror cache, data with restic. Nothing here writes.
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
  | { kind: 'repository'; name: string; role: 'development' | 'project-wiki'; branch: string; commit: string; changed?: true }
  | { kind: 'data'; id: string; name: string; revisionId?: string; access: 'read' | 'write' }
  | { kind: 'world' };

/** What a node was read from: a branch, or a task's world live or as last saved. */
export type FileViewInfo =
  | { kind: 'branch'; name: string }
  | { kind: 'task'; id: string; num?: number; title: string; mode: 'live' | 'saved' | 'published'; savedAt?: number };

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
  view?: FileViewInfo;
}

/** A snapshot of the tree (a public link): the commit of each repository it
 * spans, by its SSH URL, and the version of each data resource (null: none
 * yet). Repositories and data it does not name are not part of it. */
export interface FilePins { repositories: Record<string, string>; data: Record<string, string | null> }

export type FileView = { kind: 'default' } | { kind: 'branch'; name: string } | { kind: 'task'; taskId: string };

export interface FileReadOptions { data: boolean; pins?: FilePins; view?: FileView }

export interface OpenedFile { node: FileNode; size: number; stream: Readable; done: Promise<void>; stop: () => void }

/** Where a path stands in its repository's branch tasks start from (`repositoryPresence`). */
export type RepositoryPresence = { state: 'present'; size?: number } | { state: 'deleted' | 'untracked' };

export class FileNotFoundError extends Error {}
export class FileAccessError extends Error {}

/** A task's saved uncommitted files: the reader WorldCheckpointService gives. */
export interface SavedCheckpointFiles {
  savedFiles(checkpoint: WorldCheckpoint): Promise<{ files: ManifestEntry[]; read(entry: ManifestEntry): AsyncIterable<Buffer> }>;
}

export interface ProjectFilesDeps {
  store: Store;
  workspaces: Pick<WorkspaceService, 'project'>;
  resources?: ProjectResourceService;
  /** The credential the host reads a project repository with. */
  gitCredential: (projectId: string, sshUrl: string) => Promise<GitBrokerCredential>;
  /** Saved task worlds; without it a task shows its branch on GitHub. */
  checkpoints?: SavedCheckpointFiles;
  /** A running task world, borrowed (never resumed from a park); released after. */
  openWorld?: (taskId: string, handle: WorldHandle) => Promise<{ world: World; release(): Promise<void> }>;
}

/** The credential the host reads a project's repository (or its wiki) with:
 * tavya's own for a repository it hosts, else the organization's GitHub App;
 * hosted refuses without it; a self-host reads
 * with the host's own Git setup, as its worlds are provisioned. */
export function projectRepositoryCredential(store: Store, options: { hosted?: boolean;
  githubApp?: { brokerCredentials(repository: import('../domain/types.js').Repository): Promise<GitBrokerCredential> } }) {
  return async (projectId: string, sshUrl: string): Promise<GitBrokerCredential> => {
    const repositories = [...(await store.listProjectRepositories(projectId)).map((linked) => linked.repository),
      ...[(await store.projectWiki(projectId))?.repository].filter((wiki): wiki is NonNullable<typeof wiki> => Boolean(wiki))];
    const repository = repositories.find((candidate) => safeSame(candidate.sshUrl, sshUrl));
    if (repository && (isHostedRepository(repository) || (options.githubApp && repository.gitConnectionId)))
      return repositoryBrokerCredentials(repository, options.githubApp);
    if (options.hosted) throw new Error('Connect GitHub in organization settings, then try again.');
    return {};
  };
}

/** How long a branch tip origin advertised is trusted before asking again. */
const TIP_MAX_AGE_MS = 30_000;
/** Snapshot listings never change: kept by snapshot and directory. */
const LISTING_CACHE = 500;
/** A live file larger than this is not read through a provider that cannot stream. */
const LIVE_UNSTREAMED_MAX = 100 * 1024 * 1024;
/** What a live world never shows: tavya's own state (tokens, jobs) and Git internals. */
const HIDDEN_NAMES = new Set(['.karmax-injection', '.git']);

type Mount = WorkspaceManifest['resources'][number] & { segments: string[] };

/** A task's saved changes on top of one checkout's commit (or the world root). */
interface Overlay { files: Map<string, ManifestEntry>; read(entry: ManifestEntry): AsyncIterable<Buffer> }

interface Checkout {
  name: string;
  /** Where it sits; [] = the root itself. */
  segments: string[];
  role: 'development' | 'project-wiki';
  sshUrl: string;
  branch: string;
  /** Read instead when `branch` is not on origin (a branch view, an unpublished task). */
  fallbackBranch?: string;
  commit?: string;
  overlay?: Overlay;
}

interface Layout { checkouts: Checkout[]; mounts: Mount[]; rootOverlay?: Overlay; view?: FileViewInfo }

interface Located { stat: () => Promise<FileNode>; open: <T>(consume: (file: OpenedFile) => Promise<T>) => Promise<T> }

export class ProjectFiles {
  private readonly listings = new Map<string, SnapshotEntry[]>();
  private readonly saved = new Map<string, Promise<{ files: ManifestEntry[]; read(entry: ManifestEntry): AsyncIterable<Buffer> }>>();

  constructor(private readonly deps: ProjectFilesDeps) {}

  /** What is at `relative`: a directory with its entries, or a file's facts.
   * `data: false` (no right to read the project's data) still shows where
   * data is mounted, but refuses its contents. */
  async stat(projectId: string, relative: string, options: FileReadOptions): Promise<FileNode> {
    return (await this.locate(projectId, relative, options)).stat();
  }

  /** A file's bytes. `consume` runs while the source is held open (a Git
   * mirror stays borrowed, a live world open, until it settles). */
  async open<T>(projectId: string, relative: string, options: FileReadOptions, consume: (file: OpenedFile) => Promise<T>): Promise<T> {
    return (await this.locate(projectId, relative, options)).open(consume);
  }

  /** Pin what `relative` spans now (each repository's commit, each data
   * resource's version) and check it is there: what a public link shows. */
  async snapshot(projectId: string, relative: string, options: { data: boolean }): Promise<{ pins: FilePins; node: FileNode }> {
    const segments = splitPath(relative);
    const layout = await this.projectLayout(projectId, {});
    const pins: FilePins = { repositories: {}, data: {} };
    for (const checkout of layout.checkouts) {
      if (segments.length && segments[0] !== checkout.name) continue;
      pins.repositories[checkout.sshUrl] = await this.withRepository(projectId, checkout, async (_mirror, commit) => commit);
    }
    for (const mount of layout.mounts) {
      if (!startsWith(segments, mount.segments) && !startsWith(mount.segments, segments)) continue;
      if (!options.data) { if (startsWith(segments, mount.segments)) throw new FileAccessError('Sharing data needs access to project settings (project:settings:read).'); continue; }
      pins.data[mount.id] = mount.revisionId ?? null;
    }
    return { pins, node: await this.stat(projectId, relative, { data: options.data, pins }) };
  }

  /** Where each of `paths` stands in the repositories tasks start from:
   * there now (`present`, a file, with its size), once there and since
   * removed (`deleted`), or never committed (`untracked`). A path in no
   * repository (the world root, a data mount) is left out, and so is a
   * repository that cannot be read now. For the artifact gallery. */
  async repositoryPresence(projectId: string, paths: string[]): Promise<Map<string, RepositoryPresence>> {
    const layout = await this.projectLayout(projectId, {});
    const result = new Map<string, RepositoryPresence>();
    await Promise.all(layout.checkouts.map(async (checkout) => {
      const inside = new Map<string, string>();
      for (const wanted of paths) {
        let segments: string[];
        try { segments = splitPath(wanted); } catch { continue; }
        if (segments.length <= checkout.segments.length || !startsWith(segments, checkout.segments)) continue;
        if (layout.mounts.some((mount) => startsWith(segments, mount.segments))) continue;
        inside.set(segments.slice(checkout.segments.length).join('/'), wanted);
      }
      if (!inside.size) return;
      try {
        await this.withRepository(projectId, checkout, async (mirror, commit) => {
          const files = [...inside.keys()];
          const missing = new Set(files);
          for (let at = 0; at < files.length; at += 200) {
            const listed = await git(mirror, ['--literal-pathspecs', 'ls-tree', '-z', '-l', commit, '--', ...files.slice(at, at + 200)]);
            if (listed.code !== 0) throw new Error(listed.stderr || listed.stdout || 'git ls-tree failed');
            for (const entry of parseTree(listed.stdout)) {
              if (!inside.has(entry.name)) continue;
              missing.delete(entry.name);
              result.set(inside.get(entry.name)!, entry.kind === 'file' ? { state: 'present', ...(entry.size !== undefined ? { size: entry.size } : {}) } : { state: 'deleted' });
            }
          }
          // What history once had and the tip has not was deleted; the rest never reached it.
          const absent = [...missing];
          const deleted = new Set<string>();
          for (let at = 0; at < absent.length; at += 200) {
            const logged = await git(mirror, ['--literal-pathspecs', 'log', '--no-renames', '--diff-filter=D', '--format=', '--name-only', '-z',
              commit, '--', ...absent.slice(at, at + 200)]);
            if (logged.code !== 0) throw new Error(logged.stderr || logged.stdout || 'git log failed');
            for (const name of logged.stdout.split(/[\0\n]/)) if (name) deleted.add(name);
          }
          for (const file of absent) result.set(inside.get(file)!, { state: deleted.has(file) ? 'deleted' : 'untracked' });
        });
      } catch { /* unreadable now: its paths stay unknown */ }
    }));
    return result;
  }

  /** Branches each repository has, for the view picker. */
  async branches(projectId: string): Promise<Array<{ name: string; role: 'development' | 'project-wiki'; default: string; branches: string[] }>> {
    const layout = await this.projectLayout(projectId, {});
    return Promise.all(layout.checkouts.map(async (checkout) => {
      const credential = await this.deps.gitCredential(projectId, checkout.sshUrl);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-files-'));
      try {
        const { env } = materializeGitCredential(scratch, credential);
        const listed = await git(scratch, ['ls-remote', '--heads', checkout.sshUrl], { env, timeoutMs: 60_000 });
        if (listed.code !== 0) throw new Error(firstLine(listed.stderr || listed.stdout));
        const branches = listed.stdout.split('\n').map((line) => line.split('\trefs/heads/')[1]).filter((name): name is string => Boolean(name)).sort();
        return { name: checkout.name, role: checkout.role, default: checkout.branch, branches };
      } catch (error) {
        throw new Error(`Couldn’t list the branches of ${checkout.name}: ${firstLine(error)}`);
      } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    }));
  }

  /** Write one checkout of a task's saved world (the wiki's, by role) into
   * `target`: its commit, then the saved uncommitted files. False when the
   * task has no saved world to read this way. Never wakes a sandbox. */
  async copySavedCheckout(taskId: string, role: 'project-wiki', target: string): Promise<boolean> {
    const task = await this.deps.store.getTask(taskId);
    if (!task) return false;
    const layout = await this.taskLayout(task.projectId, taskId, { live: false });
    const checkout = layout && 'checkouts' in layout ? layout.checkouts.find((candidate) => candidate.role === role) : undefined;
    if (!checkout) return false;
    await this.withRepository(task.projectId, checkout, async (mirror, commit) => {
      await archive(mirror, commit, target);
    });
    for (const [file, entry] of checkout.overlay?.files ?? []) {
      const destination = path.join(target, file);
      if (!destination.startsWith(path.resolve(target) + path.sep)) continue;
      if ('deleted' in entry) { fs.rmSync(destination, { force: true }); continue; }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.rmSync(destination, { force: true });
      if ('link' in entry) { fs.symlinkSync(entry.link, destination); continue; }
      const chunks: Buffer[] = [];
      for await (const chunk of checkout.overlay!.read(entry)) chunks.push(chunk);
      fs.writeFileSync(destination, Buffer.concat(chunks));
    }
    return true;
  }

  // ── layouts ─────────────────────────────────────────────────────────────────

  private async locate(projectId: string, relative: string, options: FileReadOptions): Promise<Located> {
    const segments = splitPath(relative);
    if (options.view?.kind === 'task') {
      const layout = await this.taskLayout(projectId, options.view.taskId, { live: true });
      if (!layout) throw new FileNotFoundError('This task has no files yet.');
      if ('live' in layout) return this.locateLive(projectId, layout, segments, options);
      return this.locateIn(projectId, layout, segments, options);
    }
    return this.locateIn(projectId, await this.projectLayout(projectId, options), segments, options);
  }

  /** The project's layout: each repository at its base (or `view`'s branch, or a pin). */
  private async projectLayout(projectId: string, options: Pick<FileReadOptions, 'pins' | 'view'>): Promise<Layout> {
    const manifest = await this.deps.workspaces.project(projectId);
    const pins = options.pins;
    const branch = options.view?.kind === 'branch' ? options.view.name : undefined;
    const checkouts: Checkout[] = manifest.repositories
      .filter((repository) => !pins || pins.repositories[repository.sshUrl])
      .map((repository) => ({ name: repository.name, segments: [repository.name], role: repository.role, sshUrl: repository.sshUrl,
        branch: branch ?? repository.branch, ...(branch && branch !== repository.branch ? { fallbackBranch: repository.branch } : {}),
        ...(pins ? { commit: pins.repositories[repository.sshUrl] } : {}) }));
    const mounts = manifest.resources.filter((resource) => !pins || resource.id in pins.data)
      .map(({ revisionId, bytes, ...resource }) => ({ ...resource, segments: splitPath(resource.path),
        ...(pins ? (pins.data[resource.id] ? { revisionId: pins.data[resource.id]! } : {}) : { ...(revisionId ? { revisionId } : {}), ...(bytes !== undefined ? { bytes } : {}) }) }))
      .filter((mount) => mount.segments.length > 0);
    return { checkouts, mounts, ...(branch ? { view: { kind: 'branch' as const, name: branch } } : {}) };
  }

  /** A task's world: live while it runs (and `live` is allowed), else as it
   * was last saved, else its branches on GitHub. */
  private async taskLayout(projectId: string, taskId: string, options: { live: boolean }): Promise<Layout | LiveWorld | undefined> {
    const task = await this.deps.store.getTask(taskId);
    if (!task || task.projectId !== projectId) throw new FileNotFoundError('No such task in this project.');
    const handle = ((await this.deps.store.currentWorld(taskId)) ?? task.lastView?.world) as WorldHandle | undefined;
    if (!handle) return undefined;
    const info = { kind: 'task' as const, id: task.id, ...(task.num != null ? { num: task.num } : {}), title: task.title };
    const state = await this.deps.store.worldState(handle.id);
    // A world on this host (a worktree) is read in place; a remote one only while it runs.
    const local = !isRemoteWorldKind(handle.kind) && Boolean(handle.root && fs.existsSync(handle.root));
    if (options.live && this.deps.openWorld && (state === 'ready' || (local && state !== 'released')))
      return { live: true, handle, taskId, view: { ...info, mode: 'live' } };
    const project = await this.deps.workspaces.project(projectId);
    const checkpoint = await this.deps.store.latestWorldCheckpoint(handle.id);
    if (checkpoint && checkpoint.filesystemDelta?.format === 2 && this.deps.checkpoints) {
      const saved = await this.savedFiles(checkpoint);
      const byCheckout = new Map<string, Map<string, ManifestEntry>>();
      const root = new Map<string, ManifestEntry>();
      for (const file of saved.files) {
        // As restore places them: `repo: ''` is the world root; a checkout's own name, else the first.
        const owner = file.repo === '' ? undefined : checkpoint.repos.find((repo) => repo.checkoutPath === file.repo) ?? checkpoint.repos[0];
        const into = owner ? byCheckout.get(owner.checkoutPath) ?? byCheckout.set(owner.checkoutPath, new Map()).get(owner.checkoutPath)! : root;
        into.set(file.path, file);
      }
      const repositories = await this.deps.store.listProjectRepositories(projectId);
      const wiki = (await this.deps.store.projectWiki(projectId))?.repository;
      const checkouts: Checkout[] = [];
      for (const repo of checkpoint.repos) {
        const sshUrl = repo.source ?? (await this.deps.store.getRepository(repo.repositoryId))?.sshUrl;
        if (!sshUrl) continue;
        const linked = repositories.find((candidate) => safeSame(candidate.repository.sshUrl, sshUrl));
        const role = repo.role ?? (wiki && safeSame(wiki.sshUrl, sshUrl) ? 'project-wiki' : 'development');
        const name = repo.checkoutPath === '.' ? (linked?.repository.name ?? 'repository') : repo.checkoutPath;
        const files = byCheckout.get(repo.checkoutPath);
        checkouts.push({ name, segments: repo.checkoutPath === '.' ? [] : [repo.checkoutPath], role, sshUrl, branch: repo.branch,
          ...(repo.base && repo.base !== repo.branch ? { fallbackBranch: repo.base } : {}),
          ...(repo.headSha ? { commit: repo.headSha } : {}), ...(files?.size ? { overlay: { files, read: saved.read } } : {}) });
      }
      const versions = new Map((checkpoint.resources ?? []).map((resource) => [resource.attachmentId, resource.revisionId]));
      const mounts = await Promise.all(project.resources.map(async ({ revisionId: current, bytes: _bytes, ...resource }) => {
        const attachment = versions.has(resource.id) ? undefined : await this.deps.store.getResourceAttachment(resource.id);
        const revisionId = versions.get(resource.id)
          ?? (attachment && this.deps.resources ? await this.deps.resources.workspaceRevision(attachment, taskId) : current);
        return { ...resource, segments: splitPath(resource.path), ...(revisionId ? { revisionId } : {}) };
      }));
      return { checkouts, mounts: mounts.filter((mount) => mount.segments.length > 0), ...(root.size ? { rootOverlay: { files: root, read: saved.read } } : {}),
        view: { ...info, mode: 'saved', savedAt: checkpoint.createdAt } };
    }
    // Never saved: what the task published (its branch on GitHub, else its base).
    const checkouts: Checkout[] = [];
    for (const repo of worldRepos(handle)) {
      const sshUrl = worldRepoSource(repo);
      const name = repo.name ?? path.posix.basename(repo.root);
      checkouts.push({ name, segments: repo.root === handle.root ? [] : [name], role: repo.role === 'project-wiki' ? 'project-wiki' : 'development',
        sshUrl, branch: repo.branch, ...(repo.base && repo.base !== repo.branch ? { fallbackBranch: repo.base } : {}) });
    }
    return { checkouts, mounts: project.resources.map(({ bytes: _bytes, ...resource }) => ({ ...resource, segments: splitPath(resource.path) }))
      .filter((mount) => mount.segments.length > 0), view: { ...info, mode: 'published' } };
  }

  private savedFiles(checkpoint: WorldCheckpoint) {
    let pending = this.saved.get(checkpoint.id);
    if (!pending) {
      pending = this.deps.checkpoints!.savedFiles(checkpoint);
      pending.catch(() => this.saved.delete(checkpoint.id));
      if (this.saved.size >= 16) this.saved.delete(this.saved.keys().next().value!);
      this.saved.set(checkpoint.id, pending);
    }
    return pending;
  }

  private locateIn(projectId: string, layout: Layout, segments: string[], options: FileReadOptions): Located {
    const display = segments.join('/');
    const withView = (node: FileNode): FileNode => layout.view ? { ...node, view: layout.view } : node;
    const folder = (stat: () => Promise<FileNode>): Located => ({ stat: async () => withView(await stat()),
      open: () => { throw new FileAccessError('This is a folder.'); } });
    const mount = layout.mounts.filter((candidate) => startsWith(segments, candidate.segments))
      .sort((a, b) => b.segments.length - a.segments.length)[0];
    if (mount) {
      if (!options.data) throw new FileAccessError('Viewing data needs access to project settings (project:settings:read).');
      const inside = segments.slice(mount.segments.length);
      return {
        stat: async () => withView(await this.dataStat(mount, inside, display, layout.mounts, segments)),
        open: (consume) => this.dataOpen(mount, inside, display, (file) => consume({ ...file, node: withView(file.node) })),
      };
    }
    const mounts = (directory: string[]) => overlayEntries(layout.mounts, directory);
    const checkout = layout.checkouts.filter((candidate) => startsWith(segments, candidate.segments))
      .sort((a, b) => b.segments.length - a.segments.length)[0];
    if (checkout) {
      const inside = segments.slice(checkout.segments.length);
      // The root checkout of a one-repository world sits beside the world's other saved files.
      const extra = checkout.segments.length ? [] : savedChildren(layout.rootOverlay, display);
      return {
        stat: async () => withView(await this.gitStat(projectId, checkout, inside, display, merge(mounts(segments), extra))),
        open: (consume) => this.gitOpen(projectId, checkout, inside, display, (file) => consume({ ...file, node: withView(file.node) })),
      };
    }
    const saved = layout.rootOverlay?.files.get(display);
    if (saved && !('deleted' in saved)) return this.savedFile(layout.rootOverlay!, saved, display, { kind: 'world' }, withView);
    if (!segments.length) {
      return folder(async () => ({ path: '', kind: 'directory', source: { kind: 'project' },
        entries: sortEntries(merge(merge(layout.checkouts.map((repository): FileEntry => ({ name: repository.name, kind: 'directory',
          mount: repository.role === 'project-wiki' ? 'wiki' : 'repository' })), savedChildren(layout.rootOverlay, '')), mounts([]))) }));
    }
    const virtual = merge(savedChildren(layout.rootOverlay, display), mounts(segments));
    if (virtual.length) return folder(async () => ({ path: display, kind: 'directory', source: { kind: 'project' }, entries: sortEntries(virtual) }));
    throw new FileNotFoundError(`Nothing at ${display}`);
  }

  /** A saved file (a task's uncommitted work) read from its checkpoint. */
  private savedFile(overlay: Overlay, entry: ManifestEntry, display: string, source: FileSource, withView: (node: FileNode) => FileNode): Located {
    const node = (): FileNode => 'link' in entry ? withView({ path: display, kind: 'symlink', source, target: entry.link })
      : withView({ path: display, kind: 'file', source, size: 'bytes' in entry ? entry.bytes : 0, ...('sha256' in entry ? { version: entry.sha256.slice(0, 40) } : {}) });
    return {
      stat: async () => node(),
      open: async (consume) => {
        const file = node();
        if (file.kind !== 'file') throw new FileAccessError(`${display} is not a file.`);
        return consume(streamOf(file, overlay.read(entry)));
      },
    };
  }

  // ── repositories ──────────────────────────────────────────────────────────

  private async withRepository<T>(projectId: string, checkout: Checkout,
    read: (mirror: string, commit: string, source: Extract<FileSource, { kind: 'repository' }>) => Promise<T>): Promise<T> {
    const credential = await this.deps.gitCredential(projectId, checkout.sshUrl);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-files-'));
    try {
      const { env } = materializeGitCredential(scratch, credential);
      const attempt = (branch: string) => readMirrored(checkout.sshUrl, env, { branch, scratch, scope: credential.mirrorScope, maxAgeMs: TIP_MAX_AGE_MS,
        ...(checkout.commit ? { commit: checkout.commit } : {}) },
        (mirror, commit, at) => read(mirror, commit, { kind: 'repository', name: checkout.name, role: checkout.role, branch: at, commit }));
      try { return await attempt(checkout.branch); }
      catch (error) {
        // A branch only some repositories have, or a task branch never pushed: its base.
        const missing = /Remote branch .* not found/.test(String((error as Error)?.message));
        if (!checkout.fallbackBranch || !(missing || (error instanceof MirroredCommitMissing && checkout.commit))) throw error;
        return await attempt(checkout.fallbackBranch);
      }
    } catch (error) {
      if (error instanceof FileNotFoundError || error instanceof FileAccessError) throw error;
      if (error instanceof MirroredCommitMissing) throw new FileNotFoundError(checkout.commit && checkout.overlay !== undefined || checkout.fallbackBranch
        ? `${checkout.name}: this task’s latest commits haven’t reached GitHub yet.` : `${checkout.name}: ${error.message}`);
      throw new Error(`Couldn’t read ${checkout.name}: ${firstLine(error)}`);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }

  private gitStat(projectId: string, checkout: Checkout, inside: string[], display: string, overlay: FileEntry[]): Promise<FileNode> {
    const rel = inside.join('/');
    const saved = checkout.overlay?.files.get(rel);
    return this.withRepository(projectId, checkout, async (mirror, commit, base) => {
      const source = checkout.overlay ? { ...base, ...(saved || savedChildren(checkout.overlay, rel).length ? { changed: true as const } : {}) } : base;
      const directory = async (tree: string | undefined, version?: string): Promise<FileNode> => ({ path: display, kind: 'directory', source,
        entries: sortEntries(merge(applySaved(tree ? await listTree(mirror, tree) : [], checkout.overlay, rel), overlay)),
        ...(version && !checkout.overlay ? { version } : {}) });
      if (saved && !('deleted' in saved)) {
        if ('link' in saved) return { path: display, kind: 'symlink', source, target: saved.link };
        return { path: display, kind: 'file', source, size: saved.bytes, version: saved.sha256.slice(0, 40) };
      }
      if (!inside.length) return directory(commit, `${commit}:`);
      const entry = saved ? undefined : await treeEntry(mirror, commit, rel);
      if (!entry) {
        // A folder only saved files or a data mount below it make.
        if (savedChildren(checkout.overlay, rel).length || overlay.length) return directory(undefined);
        throw new FileNotFoundError(`Nothing at ${display}`);
      }
      if (entry.kind === 'directory') return directory(`${commit}:${rel}`, entry.object);
      if (entry.kind === 'submodule') return { path: display, kind: 'submodule', source, target: entry.object };
      if (entry.kind === 'symlink') {
        const target = await git(mirror, ['cat-file', 'blob', entry.object]);
        return { path: display, kind: 'symlink', source, target: target.stdout, version: entry.object };
      }
      return { path: display, kind: 'file', source, size: entry.size ?? 0, version: entry.object };
    });
  }

  private gitOpen<T>(projectId: string, checkout: Checkout, inside: string[], display: string,
    consume: (file: OpenedFile) => Promise<T>): Promise<T> {
    const rel = inside.join('/');
    const saved = checkout.overlay?.files.get(rel);
    return this.withRepository(projectId, checkout, async (mirror, commit, source) => {
      if (saved) {
        if ('deleted' in saved) throw new FileNotFoundError(`Nothing at ${display}`);
        if ('link' in saved) throw new FileAccessError(`${display} is not a file.`);
        return consume(streamOf({ path: display, kind: 'file', source: { ...source, changed: true }, size: saved.bytes,
          version: saved.sha256.slice(0, 40) }, checkout.overlay!.read(saved)));
      }
      const entry = inside.length ? await treeEntry(mirror, commit, rel) : undefined;
      if (!entry) throw new FileNotFoundError(`Nothing at ${display}`);
      if (entry.kind !== 'file') throw new FileAccessError(`${display} is not a file.`);
      const blob = catBlob(mirror, entry.object);
      return consume({ node: { path: display, kind: 'file', source, size: entry.size ?? 0, version: entry.object },
        size: entry.size ?? 0, ...blob });
    });
  }

  // ── a running world ───────────────────────────────────────────────────────

  /** Read the world itself: whatever its agent has written, committed or not.
   * tavya's own folder, Git internals, `.env` files and the project's secret
   * files never show, and no path may lead out of the world. */
  private async locateLive(projectId: string, live: LiveWorld, segments: string[], options: FileReadOptions): Promise<Located> {
    const display = segments.join('/');
    if (segments.some((segment) => HIDDEN_NAMES.has(segment))) throw new FileNotFoundError(`Nothing at ${display}`);
    const project = await this.deps.workspaces.project(projectId);
    const secrets = new Set(project.secrets.flatMap((secret) => [secret.file, secret.dotenv].filter((place): place is string => Boolean(place))));
    const hidden = (rel: string) => secrets.has(rel) || path.posix.basename(rel) === '.env';
    if (hidden(display)) throw new FileNotFoundError(`Nothing at ${display}`);
    const mounts = project.resources.map((resource) => ({ ...resource, segments: splitPath(resource.path) })).filter((mount) => mount.segments.length > 0);
    const dataMount = mounts.find((mount) => startsWith(segments, mount.segments));
    if (dataMount && !options.data) throw new FileAccessError('Viewing data needs access to project settings (project:settings:read).');
    const repos = worldRepos(live.handle);
    const withView = (node: FileNode): FileNode => ({ ...node, view: live.view });
    const inspect = async (world: World): Promise<LiveStat> => {
      const result = await world.exec('node', ['-e', LIVE_STAT, JSON.stringify([live.handle.root, display])], { cwd: live.handle.root });
      if (result.code !== 0) throw new Error(`Couldn’t read the task’s world: ${firstLine(result.stderr || result.stdout)}`);
      return JSON.parse(result.stdout) as LiveStat;
    };
    const withWorld = async <T>(read: (world: World) => Promise<T>): Promise<T> => {
      const access = await this.deps.openWorld!(live.taskId, live.handle);
      try { return await read(access.world); }
      finally { await access.release(); }
    };
    const nodeOf = (stat: LiveStat): FileNode => {
      if (stat.missing || stat.outside) throw new FileNotFoundError(`Nothing at ${display}`);
      if (stat.kind === 'symlink') return withView({ path: display, kind: 'symlink', source: { kind: 'world' }, target: stat.target ?? '' });
      if (stat.kind === 'file') return withView({ path: display, kind: 'file', source: { kind: 'world' }, size: stat.size ?? 0 });
      if (stat.kind !== 'directory') throw new FileAccessError(`${display} is not a file or folder.`);
      const marks = (name: string): FileEntry['mount'] => {
        const child = [...segments, name];
        if (mounts.some((mount) => mount.segments.join('/') === child.join('/'))) return 'data';
        const repo = repos.find((candidate) => path.posix.relative(live.handle.root, candidate.root) === child.join('/'));
        return repo ? (repo.role === 'project-wiki' ? 'wiki' : 'repository') : undefined;
      };
      const entries = (stat.entries ?? []).filter((entry) => !HIDDEN_NAMES.has(entry.name) && !hidden([...segments, entry.name].join('/')))
        .map((entry): FileEntry => { const mount = marks(entry.name); return { name: entry.name, kind: entry.kind, ...(entry.size !== undefined ? { size: entry.size } : {}), ...(mount ? { mount } : {}) }; });
      return withView({ path: display, kind: 'directory', source: { kind: 'world' }, entries: sortEntries(entries) });
    };
    return {
      stat: () => withWorld(async (world) => nodeOf(await inspect(world))),
      open: async (consume) => {
        const access = await this.deps.openWorld!(live.taskId, live.handle);
        let released = false;
        const release = async () => { if (!released) { released = true; await access.release(); } };
        try {
          const stat = await inspect(access.world);
          const node = nodeOf(stat);
          if (node.kind !== 'file') throw new FileAccessError(`${display} is not a file.`);
          const real = stat.real ?? display;
          let chunks: AsyncIterable<Buffer>;
          if (access.world.readFileStream) chunks = access.world.readFileStream(real);
          else if ((node.size ?? 0) > LIVE_UNSTREAMED_MAX) throw new FileAccessError('Too large to read from this world here.');
          else { const buffer = await access.world.readFileBuffer(real); chunks = (async function* () { yield buffer; })(); }
          const opened = streamOf(node, chunks);
          return await consume({ ...opened, done: opened.done.finally(release) });
        } finally { await release(); }
      },
    };
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

interface LiveWorld { live: true; handle: WorldHandle; taskId: string; view: FileViewInfo }

interface LiveStat {
  missing?: true; outside?: true; kind?: FileKind | 'other'; size?: number; target?: string; real?: string;
  entries?: Array<{ name: string; kind: FileKind; size?: number }>;
}

/** Runs in the world: what one path is, never following a link out of the
 * world root, and a folder's entries (sizes of files; links as links). */
const LIVE_STAT = `const fs = require('node:fs'), path = require('node:path');
const [root, rel] = JSON.parse(process.argv[1]);
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const realRoot = fs.realpathSync(root);
const target = path.join(root, rel);
let s;
try { s = fs.lstatSync(target); } catch { out({ missing: true }); }
let real;
try { real = fs.realpathSync(target); } catch { real = undefined; }
const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
if (s.isSymbolicLink()) out({ kind: 'symlink', target: fs.readlinkSync(target) });
if (!real || !inside(real)) out({ outside: true });
const relReal = path.relative(realRoot, real).split(path.sep).join('/');
if (s.isFile()) out({ kind: 'file', size: s.size, real: relReal });
if (!s.isDirectory()) out({ kind: 'other' });
const entries = [];
for (const entry of fs.readdirSync(real, { withFileTypes: true }).slice(0, 10000)) {
  const kind = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null;
  if (!kind) continue;
  let size;
  if (kind === 'file') { try { size = fs.lstatSync(path.join(real, entry.name)).size; } catch {} }
  entries.push(size === undefined ? { name: entry.name, kind } : { name: entry.name, kind, size });
}
out({ kind: 'directory', real: relReal, entries });`;

/** An async source of bytes as an OpenedFile; `stop` abandons it. */
function streamOf(node: FileNode, chunks: AsyncIterable<Buffer>): OpenedFile {
  const stream = Readable.from(chunks, { objectMode: false });
  let failure: unknown;
  const done = new Promise<void>((resolve, reject) => {
    stream.on('error', (error) => { failure = error; reject(error); });
    stream.on('close', () => { if (!failure) resolve(); });
  });
  done.catch(() => {});
  return { node, size: node.size ?? 0, stream, done, stop: () => { stream.destroy(); } };
}

/** `git archive <commit>` unpacked into `target` (a checkout's files). */
async function archive(mirror: string, commit: string, target: string): Promise<void> {
  fs.mkdirSync(target, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const producer = spawn('git', ['-c', 'core.hooksPath=/dev/null', 'archive', '--format=tar', commit], { cwd: mirror, stdio: ['ignore', 'pipe', 'pipe'] });
    const consumer = spawn('tar', ['-x', '-C', target], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    producer.stderr.on('data', (chunk) => { stderr += chunk; });
    consumer.stderr.on('data', (chunk) => { stderr += chunk; });
    producer.stdout.pipe(consumer.stdin);
    let left = 2, failed = false;
    const settle = (code: number | null) => {
      if (code !== 0 && !failed) { failed = true; reject(new Error(stderr.trim() || 'git archive failed')); }
      if (--left === 0 && !failed) resolve();
    };
    producer.on('close', settle);
    consumer.on('close', settle);
    producer.on('error', reject);
    consumer.on('error', reject);
  });
}

function safeSame(a: string, b: string): boolean {
  try { return sameRepository(a, b); } catch { return a === b; }
}

/** Where a path a task's agent wrote (absolute in its world, or relative to
 * its working folder) sits in its project's Files: relative to the world
 * root, which Files lays out alike. Outside the world throws. */
export function worldFilesPath(handle: WorldHandle | undefined, cited: string): string {
  const value = String(cited).replace(/\\/g, '/');
  if (!value) throw new Error('missing path');
  let relative = value;
  if (handle) {
    const root = String(handle.root ?? '').replace(/\/+$/, '');
    if (value.startsWith('/')) {
      if (value !== root && !value.startsWith(`${root}/`)) throw new Error('That file is outside the task’s world.');
      relative = value === root ? '' : value.slice(root.length + 1);
    } else relative = worldWorkingRelativePath(handle, value);
  }
  return splitPath(relative === '.' ? '' : relative).join('/');
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

/** Entries saved files add directly inside `dir` (files, links, and the folders on the way to deeper ones). */
function savedChildren(overlay: Overlay | undefined, dir: string): FileEntry[] {
  if (!overlay) return [];
  const prefix = dir ? `${dir}/` : '';
  const entries = new Map<string, FileEntry>();
  for (const [file, entry] of overlay.files) {
    if (!file.startsWith(prefix) || 'deleted' in entry) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) { if (!entries.has(rest.slice(0, slash))) entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), kind: 'directory' }); continue; }
    entries.set(rest, 'link' in entry ? { name: rest, kind: 'symlink' } : { name: rest, kind: 'file', size: entry.bytes });
  }
  return [...entries.values()];
}

/** A commit's entries of `dir` with the task's saved changes on top: deletions removed, files replaced or added. */
function applySaved(entries: FileEntry[], overlay: Overlay | undefined, dir: string): FileEntry[] {
  if (!overlay) return entries;
  const prefix = dir ? `${dir}/` : '';
  const removed = new Set<string>();
  for (const [file, entry] of overlay.files)
    if ('deleted' in entry && file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) removed.add(file.slice(prefix.length));
  const added = savedChildren(overlay, dir);
  const byName = new Map(entries.filter((entry) => !removed.has(entry.name)).map((entry) => [entry.name, entry]));
  for (const entry of added) if (entry.kind !== 'directory' || !byName.has(entry.name)) byName.set(entry.name, entry);
  return [...byName.values()];
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
