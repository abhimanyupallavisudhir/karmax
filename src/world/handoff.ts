import type { Store } from '../store/db.js';
import type { TaskView } from '../domain/types.js';
import type { WorldHandle } from './types.js';
import { worldRepos, worldRepoSource } from './types.js';
import type { WorldRegistry } from './registry.js';
import type { RunnerPoolService } from './runners.js';
import type { GitHubAppService } from '../integrations/github-app.js';
import { brokerRefreshBranch, type GitBrokerAuth } from './git-broker.js';

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

/** Git is the durable handoff boundary between a hosted world and a developer's
 * laptop. It keeps laptops out of the control plane and provider credentials out
 * of sandboxes while preserving the exact task branch in both directions. */
export class WorldHandoffService {
  constructor(private store: Store, private worlds: WorldRegistry, private githubApp: GitHubAppService,
    private runners?: RunnerPoolService) {}

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
