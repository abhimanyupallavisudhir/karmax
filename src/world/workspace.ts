import path from 'node:path';
import type { Store } from '../store/db.js';
import type { ResourceAttachment, WorldLocation } from '../domain/types.js';
import { credentialResource, snapshotResource } from '../domain/resource-drivers.js';
import { ProjectEnvironment } from '../store/project-environment.js';
import type { ProjectResourceService } from './resources.js';
import type { WorldHandoffService } from './handoff.js';
import type { WorldHandle } from './types.js';
import { worldRepos } from './types.js';
import { remoteName } from './provision-git.js';
import { RESTIC_ENGINE } from './restic-engine.js';
import { sameRepository } from './repository-identity.js';

/** The oldest CLI this server still speaks to (`GET /api/meta` → `cli`). */
export const MIN_CLI_VERSION = '1.0.0';

/**
 * Everything `tavya clone` needs to assemble a world on a laptop (wiki
 * planned/tavya-cli): the same layout `createWorld` gives a task, the Git
 * checkouts, the resource versions at their paths, the secrets and the install
 * commands. Paths are relative to the workspace root, with `/` separators.
 */
export interface WorkspaceManifest {
  version: 1;
  organization: { id: string; name: string; slug?: string };
  project: { id: string; name: string };
  task?: { id: string; number?: number; title: string; status?: string; waitingFor?: string };
  /** A directory name for a new workspace. */
  directory: string;
  /** Where commands run: the only development repository, else the root. */
  workdir: string;
  repositories: Array<{ name: string; role: 'development' | 'project-wiki'; sshUrl: string; branch: string;
    base?: string; target?: string }>;
  resources: Array<{ id: string; name: string; driver: string; path: string; shape: 'file' | 'directory';
    access: 'read' | 'write'; revisionId?: string; bytes?: number; files?: number; transferable: boolean }>;
  /** `variable` alone: exported to every command; `file`: the value is that
   * whole file; `variable` with `dotenv`: a line of that `.env` file. */
  secrets: Array<{ id: string; name: string; variable?: string; file?: string; dotenv?: string; configured: boolean }>;
  install: Array<{ repository: string; commands: string[] }>;
}

export class WorkspaceService {
  constructor(private store: Store, private resources?: ProjectResourceService, private handoffs?: WorldHandoffService) {}

  async project(projectId: string): Promise<WorkspaceManifest> {
    const project = await this.store.getProject(projectId);
    if (!project?.organizationId) throw new Error('project not found');
    const linked = await this.store.listProjectRepositories(project.id);
    const repositories: WorkspaceManifest['repositories'] = linked.map(({ repository, baseBranch, targetBranch }) => ({
      name: repository.name, role: 'development' as const, sshUrl: repository.sshUrl,
      branch: baseBranch ?? repository.defaultBranch, ...(targetBranch ? { target: targetBranch } : {}) }));
    const wiki = (await this.store.projectWiki(project.id))?.repository;
    if (wiki && repositories.length) repositories.push({ name: wiki.name, role: 'project-wiki', sshUrl: wiki.sshUrl, branch: wiki.defaultBranch });
    return this.assemble(project.id, slug(project.name), uniqueRepositoryNames(repositories));
  }

  async task(taskId: string): Promise<WorkspaceManifest> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error('task not found');
    const project = await this.store.getProject(task.projectId);
    if (!project?.organizationId) throw new Error('project not found');
    if (!this.handoffs) throw new Error('local checkout handoff is unavailable');
    // The published task branch is the Git boundary, exactly as for Work locally.
    const plan = await this.handoffs.checkout(taskId);
    const repositories: WorkspaceManifest['repositories'] = plan.repositories.map((repository) => ({
      name: repository.name, role: 'development' as const, sshUrl: repository.sshUrl, branch: repository.branch,
      base: repository.base, ...(repository.target ? { target: repository.target } : {}) }));
    const handle = (await this.store.currentWorld(taskId)) as WorldHandle | undefined;
    const wikiRepo = handle ? worldRepos(handle).find((repo) => repo.role === 'project-wiki') : undefined;
    const wiki = (await this.store.projectWiki(project.id))?.repository;
    if (wiki && repositories.length) repositories.push({ name: wikiRepo?.name ?? wiki.name, role: 'project-wiki',
      sshUrl: wiki.sshUrl, branch: wikiRepo && sameRepositoryOrName(wikiRepo.repo, wiki.sshUrl) ? wikiRepo.branch : wiki.defaultBranch,
      base: wiki.defaultBranch });
    const view = task.lastView;
    return this.assemble(project.id, `${slug(project.name)}-${task.num ?? task.id}`, uniqueRepositoryNames(repositories), {
      id: task.id, ...(task.num != null ? { number: task.num } : {}), title: task.title,
      ...(view?.status ? { status: view.status } : {}), ...(view?.waitingFor?.kind ? { waitingFor: view.waitingFor.kind } : {}) });
  }

  private async assemble(projectId: string, directory: string, repositories: WorkspaceManifest['repositories'],
    task?: WorkspaceManifest['task']): Promise<WorkspaceManifest> {
    const project = (await this.store.getProject(projectId))!;
    const organization = await this.store.getOrganization(project.organizationId!);
    const development = repositories.filter((repository) => repository.role === 'development');
    const workdir = development.length === 1 ? development[0]!.name : '.';
    const place = (location: WorldLocation) => join(location.repository ?? workdir, location.path);
    const resources: WorkspaceManifest['resources'] = [];
    const secrets: WorkspaceManifest['secrets'] = [];
    for (const attachment of await this.store.listResourceAttachments(projectId)) {
      if (attachment.source.candidate === true && attachment.enabled === false) continue;
      if (credentialResource(attachment)) {
        secrets.push({ id: attachment.id, name: attachment.name, configured: Boolean(attachment.credentialHandles[0]),
          ...(attachment.target.kind === 'path' ? { file: place(attachment.target) }
            : { variable: attachment.target.name,
              ...(attachment.target.kind === 'environment' && attachment.target.dotenv ? { dotenv: place(attachment.target.dotenv) } : {}) }) });
        continue;
      }
      if (!snapshotResource(attachment) || attachment.target.kind !== 'path') continue;
      const revisionId = await this.revisionFor(attachment, task?.id);
      const revision = revisionId ? await this.store.getResourceRevision(revisionId) : undefined;
      resources.push({ id: attachment.id, name: attachment.name, driver: attachment.driver,
        path: place(attachment.target), shape: attachment.source.shape === 'file' ? 'file' : 'directory',
        access: attachment.access === 'write' ? 'write' : 'read',
        ...(revision ? { revisionId: revision.id, bytes: revision.bytes, files: revision.files } : {}),
        transferable: !revision || revision.engine === RESTIC_ENGINE });
    }
    const install = Object.entries((await new ProjectEnvironment(this.store).spec(projectId))?.install ?? {})
      .filter(([repository]) => repositories.some((entry) => entry.name === repository))
      .map(([repository, commands]) => ({ repository, commands }));
    return { version: 1,
      organization: { id: organization?.id ?? project.organizationId!, name: organization?.name ?? '',
        ...((organization as { slug?: string } | undefined)?.slug ? { slug: (organization as { slug?: string }).slug } : {}) },
      project: { id: project.id, name: project.name }, ...(task ? { task } : {}),
      directory, workdir, repositories, resources, secrets, install };
  }

  private async revisionFor(attachment: ResourceAttachment, taskId?: string): Promise<string | undefined> {
    return this.resources ? this.resources.workspaceRevision(attachment, taskId) : attachment.currentRevisionId;
  }
}

function join(workdir: string, target: string): string {
  return path.posix.normalize(path.posix.join(workdir, target.replace(/\\/g, '/'))).replace(/^\.\//, '') || '.';
}

/** The same slug the console puts in project URLs (web/app.js `slugify`). */
export function slug(value: string): string {
  return String(value || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}

function sameRepositoryOrName(a: string, b: string): boolean {
  try { if (sameRepository(a, b)) return true; } catch { /* not a URL */ }
  return remoteName(a) === remoteName(b);
}

/** Two repositories with one name get `-2`, `-3`… as worlds do. */
function uniqueRepositoryNames<T extends { name: string }>(repositories: T[]): T[] {
  const seen = new Map<string, number>();
  return repositories.map((repository) => {
    const base = repository.name.replace(/[^a-zA-Z0-9._-]/g, '-') || 'repo';
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { ...repository, name: count === 1 ? base : `${base}-${count}` };
  });
}
