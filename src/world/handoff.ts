import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../store/db.js';
import type { TaskView } from '../domain/types.js';
import type { WorldHandle } from './types.js';
import { worldRepos, worldRepoSource, worldWorkingDirectory } from './types.js';
import type { WorldRegistry } from './registry.js';
import type { RunnerPoolService } from './runners.js';
import type { GitHubAppService } from '../integrations/github-app.js';
import {
  brokerPublishBranch,
  brokerRefreshBranch,
  describePublishFailures,
  type GitBrokerAuth,
  type GitBrokerCredential,
} from './git-broker.js';
import type { WorldAccessService } from './access.js';
import { git } from './git.js';
import { paths } from '../config/paths.js';
import { materializeGitCredential } from './git-credential.js';
import { sameRepository } from './repository-identity.js';

export interface LocalCheckoutPlan {
  taskId: string;
  taskNumber?: number;
  title: string;
  workspace: string;
  repositories: Array<{ id: string; name: string; sshUrl: string; branch: string; base: string; target?: string }>;
  cloneScript: string;
  updateScript: string;
  pushScript: string;
}

export interface ProjectCheckoutPlan {
  projectId: string;
  name: string;
  workspace: string;
  repositories: Array<{ id: string; name: string; sshUrl: string; branch: string }>;
  cloneScript: string;
  updateScript: string;
}

export interface MaterializedLocalCheckout {
  taskId: string;
  root: string;
  cwd: string;
  branch: string;
  repositories: Array<{ name: string; path: string; branch: string; head: string }>;
}

export interface LocalFileOpen {
  path: string;
  command: string;
  materialized: boolean;
}

export interface PortableFileCheckout extends LocalCheckoutPlan {
  file: { repository: string; relativePath: string; line?: number };
  /** One idempotent script: reuse a clean checkout when present, otherwise
   * clone it, then open the cited file in VS Code. */
  openScript: string;
}

interface LocalMaterializationRecord {
  version: 1;
  source: string;
  repositories: Array<{ name: string; branch: string; head: string }>;
}

const LOCAL_MATERIALIZATION_RECORD = '.karmax-materialization.json';

/** Git is the durable handoff boundary between a hosted world and a developer's
 * laptop. It keeps laptops out of the control plane and provider credentials out
 * of sandboxes while preserving the exact task branch in both directions. */
export class WorldHandoffService {
  constructor(private store: Store, private worlds: WorldRegistry, private githubApp: GitHubAppService,
    private runners?: RunnerPoolService, private worldAccess?: WorldAccessService,
    private localRoot = paths().localCheckouts,
    private resources?: import('./resources.js').ProjectResourceService) {}

  /** Resolve an agent-authored path into the corresponding host checkout and
   * return a pasteable editor command. Remote worlds cross the normal Git
   * handoff boundary first; local worktrees already are the host checkout. */
  async openFile(taskId: string, view: TaskView, requestedPath: string, line?: number): Promise<LocalFileOpen> {
    const handle = this.store.currentWorld(taskId) as WorldHandle | undefined;
    if (!handle) throw new Error('task has no recoverable world');
    const repositories = worldRepos(handle);
    const { absolute, repoIndex, relative } = resolveWorldFile(handle, requestedPath);
    const remote = Boolean(this.worlds.get(handle.kind).capabilities?.remote);
    // Script and just-do worlds may intentionally have no Git repository. A
    // local one is already openable in place; a remote one has no durable Git
    // boundary through which it could be materialized.
    if (!repositories.length) {
      if (remote) throw new Error('task world has no Git repository to materialize');
      if (!pathInside(handle.root, absolute)) throw new Error('file path is outside the task world');
      if (!fs.existsSync(absolute)) throw new Error('file is not present in the task world');
      return localFileOpen(absolute, line, false);
    }
    if (repoIndex < 0) throw new Error('file path is outside the task repositories');
    const checkout = remote ? await this.materialize(taskId, view) : this.existingLocal(handle);
    const localRepo = checkout.repositories[repoIndex];
    if (!localRepo) throw new Error('local checkout does not contain the requested repository');
    const localPath = path.resolve(localRepo.path, relative);
    if (!pathInside(localRepo.path, localPath) || !fs.existsSync(localPath))
      throw new Error('file is not present in the local checkout');
    return localFileOpen(localPath, line, remote);
  }

  /** Build the laptop-side equivalent of openFile without pretending the hosted
   * gateway can write to a browser user's filesystem. The returned shell script
   * crosses the same published Git boundary and is safe to run repeatedly: it
   * only fast-forwards a clean checkout. */
  fileCheckout(taskId: string, view: TaskView, requestedPath: string, line?: number): PortableFileCheckout {
    if (view.agentTurn || view.status === 'active')
      throw new Error('wait for the agent to reach a checkpoint before materializing its branch locally');
    const handle = this.store.currentWorld(taskId) as WorldHandle | undefined;
    if (!handle) throw new Error('task has no recoverable world');
    const repositories = worldRepos(handle);
    const { repoIndex, relative } = resolveWorldFile(handle, requestedPath);
    if (!repositories.length) throw new Error('task world has no Git repository to check out');
    if (repoIndex < 0) throw new Error('file path is outside the task repositories');
    const plan = this.checkout(taskId);
    const sourceRepo = repositories[repoIndex]!;
    const destinationRepo = plan.repositories.find((repo) => repo.name === sourceRepo.name);
    if (!destinationRepo) throw new Error('local checkout does not contain the requested repository');
    const location = path.posix.join(destinationRepo.name, relative.split(path.sep).join('/'))
      + (Number.isInteger(line) && Number(line) > 0 ? `:${line}` : '');
    const script = ['set -eu', `mkdir -p ${sh(plan.workspace)}`, `cd ${sh(plan.workspace)}`];
    for (const repository of plan.repositories) {
      script.push(`if [ -d ${sh(`${repository.name}/.git`)} ]; then`,
        `  test -z "$(git -C ${sh(repository.name)} status --porcelain)" || { echo ${sh(`Checkout ${repository.name} has uncommitted changes; move or commit them first.`)} >&2; exit 1; }`,
        `  git -C ${sh(repository.name)} fetch origin ${sh(repository.branch)}`,
        `  git -C ${sh(repository.name)} switch ${sh(repository.branch)}`,
        `  git -C ${sh(repository.name)} merge --ff-only ${sh(`origin/${repository.branch}`)}`,
        'else',
        `  git clone --branch ${sh(repository.branch)} --single-branch ${sh(repository.sshUrl)} ${sh(repository.name)}`,
        'fi');
    }
    script.push(`code --goto ${sh(location)}`);
    return { ...plan, file: { repository: destinationRepo.name, relativePath: relative, ...(line ? { line } : {}) },
      openScript: script.join('\n') };
  }

  /** Publish the exact committed cloud branch through the trusted broker, then
   * clone/update a durable checkout on the Karmax host. This is intentionally a
   * separate world: local testing and native CLI forks can never mutate the live
   * cloud sandbox behind the workflow's back. */
  async materialize(taskId: string, view: TaskView): Promise<MaterializedLocalCheckout> {
    const task = this.store.getTask(taskId);
    const project = task ? this.store.getProject(task.projectId) : undefined;
    if (!task || !project?.organizationId) throw new Error('task project is unavailable');
    if (view.agentTurn || view.status === 'active')
      throw new Error('wait for the agent to reach a checkpoint before materializing its branch locally');
    const handle = this.store.currentWorld(taskId) as WorldHandle | undefined;
    if (!handle) throw new Error('task has no recoverable world');
    if (!this.worlds.get(handle.kind).capabilities?.remote)
      return this.existingLocal(handle);
    const worldRepositories = worldRepos(handle);
    if (!worldRepositories.length) throw new Error('task world has no Git repositories to materialize');
    const root = path.join(this.localRoot, safeName(taskId));
    const source = materializationSource(handle, view);
    const cached = await cachedMaterialization(taskId, root, handle.branch, worldRepositories, source);
    if (cached) return cached;
    const linked = this.store.listProjectRepositories(project.id);
    const auth: GitBrokerAuth = async (repo) => {
      if (repo.localPath) return {};
      const repository = linked.find((entry) => sameRepository(entry.repository.sshUrl, worldRepoSource(repo)))?.repository;
      if (!repository) throw new Error(`repository is not enrolled in this project: ${repo.repo}`);
      return this.githubApp.brokerCredentials(repository);
    };

    const released = this.store.worldState(taskId) === 'released';
    if (released) {
      // Completion deliberately destroys provider compute after checkpointing
      // and publishing the task branch. Reopening that provider can never work;
      // the published branch is now the durable materialization source.
      const published = this.store.eventsSince(taskId, 0).some((event) => event.type === 'push.branch'
        && (event.payload as { branch?: string } | undefined)?.branch === handle.branch);
      if (!published) throw new Error('the released task world has no published branch to materialize');
    } else {
      const access = this.worldAccess ? await this.worldAccess.open(taskId, handle, { dedicated: true }) : undefined;
      const world = access?.world ?? await this.worlds.open(handle);
      try {
        const published = await brokerPublishBranch(world, auth);
        if (published.skipped.length) throw new Error(`could not publish committed cloud branch for: ${describePublishFailures(published)}`);
        this.store.appendEvent({ taskId, type: 'push.branch', ts: Date.now(), payload: {
          branch: handle.branch, repos: published.pushed, reason: 'local-materialization',
        } });
      } finally {
        await access?.release(true);
      }
    }

    fs.mkdirSync(root, { recursive: true });
    const repositories: MaterializedLocalCheckout['repositories'] = [];
    for (const repo of worldRepositories) {
      const record = repo.localPath ? undefined
        : linked.find((entry) => sameRepository(entry.repository.sshUrl, worldRepoSource(repo)))?.repository;
      if (!repo.localPath && !record) throw new Error(`repository is not enrolled in this project: ${repo.repo}`);
      const source = repo.localPath ?? repo.repo;
      const credential = record ? await this.githubApp.brokerCredentials(record) : {};
      const materialized = gitEnvironment(root, credential);
      const env = materialized.env;
      const destination = path.join(root, safeName(repo.name));
      try {
        if (fs.existsSync(path.join(destination, '.git'))) {
          const dirty = await git(destination, ['status', '--porcelain']);
          if (dirty.code !== 0) throw new Error(dirty.stderr || dirty.stdout);
          if (dirty.stdout.trim()) throw new Error(`local checkout ${destination} has uncommitted changes`);
          await gitOk(destination, ['fetch', 'origin', repo.branch], env);
          await gitOk(destination, ['switch', repo.branch], env);
          await gitOk(destination, ['merge', '--ff-only', `origin/${repo.branch}`], env);
        } else {
          if (fs.existsSync(destination) && fs.readdirSync(destination).length)
            throw new Error(`local checkout path is occupied: ${destination}`);
          await gitOk(root, ['clone', '--branch', repo.branch, '--single-branch', source, destination], env);
        }
        const head = (await git(destination, ['rev-parse', 'HEAD'])).stdout.trim();
        repositories.push({ name: repo.name, path: destination, branch: repo.branch, head });
      } finally {
        fs.rmSync(materialized.directory, { recursive: true, force: true });
      }
    }
    saveMaterialization(root, { version: 1, source,
      repositories: repositories.map(({ name, branch, head }) => ({ name, branch, head })) });
    return { taskId, root, cwd: repositories.length === 1 ? repositories[0]!.path : root,
      branch: handle.branch, repositories };
  }

  private existingLocal(handle: WorldHandle): MaterializedLocalCheckout {
    const repositories = worldRepos(handle).map((repo) => ({ name: repo.name, path: repo.root, branch: repo.branch, head: '' }));
    return { taskId: handle.id, root: handle.root, cwd: worldWorkingDirectory(handle), branch: handle.branch, repositories };
  }

  checkout(taskId: string): LocalCheckoutPlan {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error('task not found');
    const project = this.store.getProject(task.projectId);
    if (!project) throw new Error('project not found');
    const handle = this.store.currentWorld(taskId) as WorldHandle | undefined;
    const branch = handle?.branch ?? task.lastView?.branch;
    if (!branch) throw new Error('task does not have a branch yet');
    if (handle && this.worlds.get(handle.kind).capabilities?.remote) {
      const published = this.store.eventsSince(taskId, 0).some((event) => event.type === 'push.branch'
        && (event.payload as { branch?: string } | undefined)?.branch === branch);
      if (!published) throw new Error('the task branch has not reached GitHub yet; wait for the next human checkpoint');
    }
    const linked = this.store.listProjectRepositories(project.id);
    if (!linked.length) throw new Error('project has no GitHub repositories');
    const handleRepos = worldRepos(handle ?? ({ id: taskId, kind: 'unknown', root: '.', branch,
      base: task.lastView?.base ?? 'main' } as WorldHandle));
    const repositories = linked.map((entry) => {
      const inWorld = handleRepos.find((repo) => sameRepository(worldRepoSource(repo), entry.repository.sshUrl));
      const base = inWorld?.base ?? entry.baseBranch ?? entry.repository.defaultBranch;
      return { id: entry.repository.id, name: inWorld?.name ?? entry.repository.name, sshUrl: entry.repository.sshUrl,
        branch: inWorld?.branch ?? branch, base, target: inWorld?.target ?? entry.targetBranch ?? base };
    });
    const workspace = `karmax-${task.num ?? task.id}`;
    const clone = ['set -eu', `mkdir -p ${sh(workspace)}`, `cd ${sh(workspace)}`];
    const update = ['set -eu', `cd ${sh(workspace)}`];
    const push = ['set -eu', `cd ${sh(workspace)}`];
    for (const repository of repositories) {
      clone.push(`git clone --branch ${sh(repository.branch)} --single-branch ${sh(repository.sshUrl)} ${sh(repository.name)}`);
      update.push(`git -C ${sh(repository.name)} fetch origin ${sh(repository.branch)}`,
        `git -C ${sh(repository.name)} switch ${sh(repository.branch)}`,
        `git -C ${sh(repository.name)} merge --ff-only ${sh(`origin/${repository.branch}`)}`);
      push.push(`git -C ${sh(repository.name)} push origin ${sh(repository.branch)}`);
    }
    return { taskId, taskNumber: task.num, title: task.title, workspace, repositories,
      cloneScript: clone.join('\n'), updateScript: update.join('\n'), pushScript: push.join('\n') };
  }

  /** Build a portable, credential-free checkout plan for the project's source
   * repositories. Unlike a task handoff this intentionally follows each
   * repository's default branch: it is the clean starting point for local work,
   * not a way to enter or mutate a live task world. */
  projectCheckout(projectId: string): ProjectCheckoutPlan {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error('project not found');
    const linked = this.store.listProjectRepositories(projectId);
    if (!linked.length) throw new Error('project has no GitHub repositories');
    const repositories = linked.map(({ repository }) => ({
      id: repository.id,
      name: repository.name,
      sshUrl: repository.sshUrl,
      branch: repository.defaultBranch,
    }));
    const slug = safeName(project.name.toLowerCase()).replace(/^-+|-+$/g, '') || safeName(project.id);
    const workspace = `karmax-${slug}`;
    const clone = ['set -eu', `mkdir -p ${sh(workspace)}`, `cd ${sh(workspace)}`];
    const update = ['set -eu', `cd ${sh(workspace)}`];
    for (const repository of repositories) {
      clone.push(`git clone --branch ${sh(repository.branch)} --single-branch ${sh(repository.sshUrl)} ${sh(repository.name)}`);
      update.push(`git -C ${sh(repository.name)} fetch origin ${sh(repository.branch)}`,
        `git -C ${sh(repository.name)} switch ${sh(repository.branch)}`,
        `git -C ${sh(repository.name)} merge --ff-only ${sh(`origin/${repository.branch}`)}`);
    }
    return { projectId, name: project.name, workspace, repositories,
      cloneScript: clone.join('\n'), updateScript: update.join('\n') };
  }

  async refresh(taskId: string, view: TaskView): Promise<{ updated: Array<{ repo: string; branch: string; sha: string }>;
    parked: boolean; warning?: string }> {
    const task = this.store.getTask(taskId);
    const project = task ? this.store.getProject(task.projectId) : undefined;
    if (!task || !project?.organizationId) throw new Error('task project is unavailable');
    if (view.status !== 'waiting' || view.agentTurn)
      throw new Error('local changes can only be imported while the task is waiting and no agent turn is running');
    if (!['human', 'confirm'].includes(view.waitingFor?.kind ?? ''))
      throw new Error('task must be waiting for human review before importing local changes');
    if (this.store.listExecutions(taskId).some((execution) => ['starting', 'running', 'stop-requested'].includes(execution.state)))
      throw new Error('close task terminals and review processes before importing local changes');
    let handle = this.store.currentWorld(taskId) as WorldHandle | undefined;
    if (!handle) throw new Error('task has no recoverable world');
    if (!this.worlds.get(handle.kind).capabilities?.remote) throw new Error('local projects already use their on-disk world directly');
    const linked = this.store.listProjectRepositories(project.id);
    if (!linked.length) throw new Error('project has no GitHub repositories');
    const auth: GitBrokerAuth = async (repo) => {
      const repository = linked.find((entry) => sameRepository(entry.repository.sshUrl, worldRepoSource(repo)))?.repository;
      if (!repository) throw new Error(`repository is not enrolled in this project: ${repo.repo}`);
      return this.githubApp.brokerCredentials(repository);
    };
    const existingLease = typeof handle.meta?.worldLeaseId === 'string' ? this.store.worldLease(handle.meta.worldLeaseId) : undefined;
    let acquiredLeaseId: string | undefined;
    if (existingLease?.state !== 'active' && this.runners) {
      const lease = await this.runners.acquire({ project, taskId, worldId: handle.id, provider: handle.kind,
        priority: Number(task.params.priority ?? 0) });
      acquiredLeaseId = lease.leaseId;
      handle = this.store.updateWorldMeta(handle, { worldLeaseId: lease.leaseId, runnerPoolId: lease.runnerPoolId }) as WorldHandle;
      this.store.setWorldState(handle, 'ready');
    }
    let world: Awaited<ReturnType<WorldRegistry['open']>> | undefined;
    let result: Awaited<ReturnType<typeof brokerRefreshBranch>> | undefined;
    let parked = false;
    let warning: string | undefined;
    let operationError: unknown;
    try {
      world = await this.worlds.open(handle);
      result = await brokerRefreshBranch(world, auth);
      this.store.appendEvent({ taskId, type: 'world.local-handoff-imported', ts: Date.now(), payload: {
        provider: handle.kind, generation: world.handle.generation ?? handle.generation ?? 1,
        repositories: result.updated.map((entry) => ({ repo: entry.repo, branch: entry.branch, sha: entry.sha })),
      } });
    } catch (error) {
      operationError = error;
    }
    // The task is at a human wait and has no live execution, so every refresh
    // ends parked—even if a previous provider park failed and left it `ready`.
    // This also closes the existing lease in that recovery case instead of
    // silently leaving metered compute running.
    if (world) {
      try {
        await this.resources?.scrubSecrets(world.handle);
        const parkedHandle = await this.worlds.park(world.handle);
        parked = await this.worlds.status(parkedHandle) === 'parked';
        if (!parked) warning = 'the provider did not confirm that the world was parked';
      } catch (error) {
        warning = `the world could not be parked: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (parked) {
        const current = (this.store.currentWorld(taskId) ?? handle) as WorldHandle;
        const leaseId = acquiredLeaseId ?? (existingLease?.state === 'active' ? existingLease.id : undefined);
        if (leaseId) this.runners?.release(leaseId, handle.kind);
        this.store.updateWorldMeta(current, { worldLeaseId: null });
        this.store.setWorldState((this.store.currentWorld(taskId) ?? current) as WorldHandle, 'parked');
      }
    }
    // If opening failed before a provider world existed, there is nothing useful
    // to keep metered. A successfully opened world that could not re-park keeps
    // its lease attached so billing/admission remains honest until lifecycle
    // recovery handles it.
    if (!world && acquiredLeaseId) {
      this.runners?.release(acquiredLeaseId, handle.kind);
      const current = this.store.currentWorld(taskId) as WorldHandle | undefined;
      if (current) this.store.updateWorldMeta(current, { worldLeaseId: null });
    }
    if (operationError) {
      const primary = operationError instanceof Error ? operationError.message : String(operationError);
      throw new Error(warning ? `${primary}; additionally, ${warning}` : primary);
    }
    return { ...result!, parked, ...(warning ? { warning } : {}) };
  }
}

function sh(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

function safeName(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, '-'); }

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveWorldFile(handle: WorldHandle, requestedPath: string): {
  absolute: string; repoIndex: number; relative: string;
} {
  const requested = requestedPath.trim();
  if (!requested) throw new Error('file path is required');
  const absolute = path.resolve(path.isAbsolute(requested)
    ? requested
    : path.join(worldWorkingDirectory(handle), requested));
  const repositories = worldRepos(handle);
  if (!repositories.length) {
    if (!pathInside(handle.root, absolute)) throw new Error('file path is outside the task world');
    return { absolute, repoIndex: -1, relative: path.relative(path.resolve(handle.root), absolute) };
  }
  const repoIndex = repositories.findIndex((repo) => pathInside(repo.root, absolute));
  if (repoIndex < 0) throw new Error('file path is outside the task repositories');
  return { absolute, repoIndex,
    relative: path.relative(path.resolve(repositories[repoIndex]!.root), absolute) };
}

function localFileOpen(localPath: string, line: number | undefined, materialized: boolean): LocalFileOpen {
  const location = Number.isInteger(line) && Number(line) > 0 ? `${localPath}:${line}` : localPath;
  return { path: localPath, command: `code --goto ${sh(location)}`, materialized };
}

function materializationSource(handle: WorldHandle, view: TaskView): string {
  return JSON.stringify({
    generation: handle.generation ?? 1,
    // A checkpoint is the durable content version at a human boundary. Older
    // worlds without checkpoints fall back to the workflow view revision.
    revision: handle.checkpointId ?? view.updatedAt,
    repositories: worldRepos(handle).map((repo) => ({
      name: repo.name,
      source: worldRepoSource(repo),
      localPath: repo.localPath,
      branch: repo.branch,
    })),
  });
}

/** Return an already materialized checkout only when both its source revision
 * and every local Git worktree are unchanged. This makes repeated file-open and
 * native-fork clicks cheap without masking local edits or stale checkouts. */
async function cachedMaterialization(taskId: string, root: string, branch: string,
  expected: ReturnType<typeof worldRepos>, source: string): Promise<MaterializedLocalCheckout | undefined> {
  let record: LocalMaterializationRecord;
  try {
    record = JSON.parse(fs.readFileSync(path.join(root, LOCAL_MATERIALIZATION_RECORD), 'utf8')) as LocalMaterializationRecord;
  } catch { return undefined; }
  if (record.version !== 1 || record.source !== source || record.repositories.length !== expected.length)
    return undefined;
  const repositories: MaterializedLocalCheckout['repositories'] = [];
  for (let index = 0; index < expected.length; index++) {
    const repo = expected[index]!;
    const saved = record.repositories[index];
    const destination = path.join(root, safeName(repo.name));
    if (!saved || saved.name !== repo.name || saved.branch !== repo.branch || !fs.existsSync(path.join(destination, '.git')))
      return undefined;
    const [status, currentBranch, head] = await Promise.all([
      git(destination, ['status', '--porcelain']),
      git(destination, ['branch', '--show-current']),
      git(destination, ['rev-parse', 'HEAD']),
    ]);
    if (status.code !== 0 || status.stdout.trim() || currentBranch.code !== 0
      || currentBranch.stdout.trim() !== repo.branch || head.code !== 0 || head.stdout.trim() !== saved.head)
      return undefined;
    repositories.push({ name: repo.name, path: destination, branch: repo.branch, head: saved.head });
  }
  return { taskId, root, cwd: repositories.length === 1 ? repositories[0]!.path : root, branch, repositories };
}

function saveMaterialization(root: string, record: LocalMaterializationRecord): void {
  const destination = path.join(root, LOCAL_MATERIALIZATION_RECORD);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function gitEnvironment(root: string, credential: GitBrokerCredential): {
  env: Record<string, string>; directory: string;
} {
  const directory = fs.mkdtempSync(path.join(root, '.karmax-clone-auth-'));
  return { env: materializeGitCredential(directory, credential).env, directory };
}

async function gitOk(cwd: string, args: string[], env: Record<string, string>): Promise<void> {
  const result = await git(cwd, args, { env, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
}
