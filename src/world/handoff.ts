import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Store } from '../store/db.js';
import type { TaskView } from '../domain/types.js';
import type { WorldHandle } from './types.js';
import { worldRepos, worldRepoSource } from './types.js';
import type { WorldRegistry } from './registry.js';
import type { RunnerPoolService } from './runners.js';
import type { GitHubAppService } from '../integrations/github-app.js';
import { brokerPublishBranch, brokerRefreshBranch, type GitBrokerAuth, type GitBrokerCredential } from './git-broker.js';
import type { WorldAccessService } from './access.js';
import { git } from './git.js';
import { paths } from '../config/paths.js';

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

export interface MaterializedLocalCheckout {
  taskId: string;
  root: string;
  cwd: string;
  branch: string;
  repositories: Array<{ name: string; path: string; branch: string; head: string }>;
}

/** Git is the durable handoff boundary between a hosted world and a developer's
 * laptop. It keeps laptops out of the control plane and provider credentials out
 * of sandboxes while preserving the exact task branch in both directions. */
export class WorldHandoffService {
  constructor(private store: Store, private worlds: WorldRegistry, private githubApp: GitHubAppService,
    private runners?: RunnerPoolService, private worldAccess?: WorldAccessService,
    private localRoot = paths().localCheckouts) {}

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
    const linked = this.store.listProjectRepositories(project.id);
    const byUrl = new Map(linked.map((entry) => [entry.repository.sshUrl, entry.repository]));
    const auth: GitBrokerAuth = async (repo) => {
      if (repo.localPath) return {};
      const repository = byUrl.get(worldRepoSource(repo));
      if (!repository) throw new Error(`repository is not enrolled in this project: ${repo.repo}`);
      return this.githubApp.brokerCredentials(repository);
    };

    const access = this.worldAccess ? await this.worldAccess.open(taskId, handle, { dedicated: true }) : undefined;
    const world = access?.world ?? await this.worlds.open(handle);
    try {
      const published = await brokerPublishBranch(world, auth);
      if (published.skipped.length) throw new Error(`could not publish committed cloud branch for: ${published.skipped.join(', ')}`);
      this.store.appendEvent({ taskId, type: 'push.branch', ts: Date.now(), payload: {
        branch: handle.branch, repos: published.pushed, reason: 'local-materialization',
      } });
    } finally {
      await access?.release(true);
    }

    const root = path.join(this.localRoot, safeName(taskId));
    fs.mkdirSync(root, { recursive: true });
    const repositories: MaterializedLocalCheckout['repositories'] = [];
    for (const repo of worldRepositories) {
      const record = repo.localPath ? undefined : byUrl.get(worldRepoSource(repo));
      if (!repo.localPath && !record) throw new Error(`repository is not enrolled in this project: ${repo.repo}`);
      const source = repo.localPath ?? repo.repo;
      const credential = record ? await this.githubApp.brokerCredentials(record) : {};
      const env = await gitEnvironment(root, credential);
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
        if (env.keyPath) fs.rmSync(env.keyPath, { force: true });
      }
    }
    return { taskId, root, cwd: repositories.length === 1 ? repositories[0]!.path : root,
      branch: handle.branch, repositories };
  }

  private existingLocal(handle: WorldHandle): MaterializedLocalCheckout {
    const repositories = worldRepos(handle).map((repo) => ({ name: repo.name, path: repo.root, branch: repo.branch, head: '' }));
    return { taskId: handle.id, root: handle.root, cwd: handle.root, branch: handle.branch, repositories };
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
    const handleRepos = new Map(worldRepos(handle ?? ({ id: taskId, kind: 'unknown', root: '.', branch,
      base: task.lastView?.base ?? 'main' } as WorldHandle)).map((repo) => [worldRepoSource(repo), repo]));
    const repositories = linked.map((entry) => {
      const inWorld = handleRepos.get(entry.repository.sshUrl);
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
    const byUrl = new Map(linked.map((entry) => [entry.repository.sshUrl, entry.repository]));
    const auth: GitBrokerAuth = async (repo) => {
      const repository = byUrl.get(repo.repo);
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

async function gitEnvironment(root: string, credential: GitBrokerCredential): Promise<Record<string, string> & { keyPath?: string }> {
  const env: Record<string, string> & { keyPath?: string } = { GIT_TERMINAL_PROMPT: '0', ...(credential.env ?? {}) };
  if (credential.sshKey) {
    const keyPath = path.join(root, `.karmax-clone-${crypto.randomBytes(12).toString('hex')}.key`);
    fs.writeFileSync(keyPath, credential.sshKey.endsWith('\n') ? credential.sshKey : `${credential.sshKey}\n`, { mode: 0o600 });
    env.keyPath = keyPath;
    env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  }
  return env;
}

async function gitOk(cwd: string, args: string[], env: Record<string, string>): Promise<void> {
  const result = await git(cwd, args, { env, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
}
