import type { ProjectConfig, TaskView, WorldHandleRef } from '../domain/types.js';
import type { WorldHandle } from './types.js';

/** Resolve the provider handle carried by current views, with a narrow fallback
 * for historical single-host worktree views. Never invent remote/container
 * metadata: an opaque handle is required for those providers. */
export function worldHandleForView(view: TaskView | undefined, taskId: string, project?: ProjectConfig): WorldHandle | undefined {
  const direct = validHandle(view?.world) ?? validHandle(view?.state?.recoveryWorld);
  if (direct) return direct as WorldHandle;
  if (!view?.worldPath || !view.branch || (project?.worldProvider && !['worktree', 'memory'].includes(project.worldProvider))) return undefined;
  const repos = project?.repos?.filter(Boolean) ?? [];
  if (repos.length > 1) return undefined;
  const repo = repos[0];
  return {
    kind: 'worktree',
    id: taskId,
    root: view.worldPath,
    branch: view.branch,
    base: view.base ?? project?.defaultBase ?? 'main',
    target: view.targetBranch ?? project?.defaultTarget,
    ...(repo
      ? { repo, repos: [{ name: repo.split('/').filter(Boolean).pop() ?? taskId, repo, root: view.worldPath, branch: view.branch, base: view.base ?? project?.defaultBase ?? 'main' }] }
      : {}),
  };
}

function validHandle(value: unknown): WorldHandleRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const h = value as Partial<WorldHandleRef>;
  if (!h.kind || !h.id || !h.root || !h.branch || !h.base) return undefined;
  return h as WorldHandleRef;
}
