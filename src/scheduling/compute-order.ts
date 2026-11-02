import { loadModel, PRIOR, schedulingPriority } from './model.js';
import { adjustRanks } from './order.js';
import { manualChoices, type PlannerStore } from './planner.js';
import { DEFAULT_SCHEDULING, treeRank } from './policy.js';
import { SizeModel } from './size-model.js';
import { kvJson, treeKey, type TreeLedger } from './state.js';

/**
 * One organization's order for machines (wiki features/quota-scheduling §
 * Compute): the scheduler's own order for model quota — its tree rank
 * (priority × how little the tree has spent), people's drag placements and
 * Run now — with each tree's rank divided by one more than the machines it
 * already holds. That divisor (D'Hondt's) apportions machines among an
 * organization's trees in proportion to their ranks, so a task that fans out
 * into many sub-tasks gets its share, not every machine: unlike a model turn,
 * a machine is often held for hours by a job, and a rank that falls as a tree
 * spends cannot undo an over-grab in time. Other organizations are not
 * ranked against: across them the queue stays first come, first served.
 */
export interface ComputeStanding {
  /** Its tree's rank among the organization's trees, per machine it would add (higher first). */
  rank: number;
  /** Someone said to run its task now: ahead of the organization's other trees. */
  runNow?: boolean;
  /** Its place among its own tree's waiting tasks (higher first): people's placements, then who asked first. */
  within: number;
}

export interface ComputeOrderStore extends PlannerStore {
  /** The task of each machine one organization holds now, on any provider. */
  activeLeaseTasks(organizationId: string): Promise<string[]>;
}

export async function computeStandings(store: ComputeOrderStore, organizationId: string,
  waiting: { taskId: string; since: number }[], nowMs = Date.now()): Promise<Map<string, ComputeStanding>> {
  const trees = new Map<string, { root: string; priority: number }>();
  for (const { taskId } of waiting) {
    const tree = await store.taskTree(taskId);
    trees.set(taskId, tree ? { root: tree.root, priority: tree.priority } : { root: taskId, priority: 0 });
  }
  let size: SizeModel;
  try { size = new SizeModel((await loadModel(store, organizationId, nowMs)).size); } catch { size = new SizeModel(PRIOR.size); }
  const roots = new Map<string, number>();
  for (const { root, priority } of trees.values()) {
    if (roots.has(root)) continue;
    const spent = (await kvJson<TreeLedger>(store, treeKey(root)))?.spent ?? 0;
    roots.set(root, treeRank({ priority: schedulingPriority(priority), attained: spent }, size, DEFAULT_SCHEDULING));
  }
  const { order, runNow } = await manualChoices(store, organizationId);
  const ranks = adjustRanks(roots, order);
  // Machines each tree holds now, wherever they run.
  const held = new Map<string, number>();
  const rootOf = new Map([...trees].map(([taskId, t]) => [taskId, t.root]));
  for (const task of await store.activeLeaseTasks(organizationId)) {
    const root = rootOf.get(task) ?? (await store.taskTree(task))?.root;
    if (root && roots.has(root)) held.set(root, (held.get(root) ?? 0) + 1);
  }
  // Within a tree: its tasks by people's placements, else who asked first.
  const within = new Map<string, number>();
  for (const root of roots.keys()) {
    const own = waiting.filter((w) => trees.get(w.taskId)!.root === root).sort((a, b) => a.since - b.since);
    const adjusted = adjustRanks(new Map(own.map((w, i) => [w.taskId, Math.exp(-i * 1e-3)])), order);
    for (const w of own) within.set(w.taskId, adjusted.get(w.taskId) ?? 1);
  }
  return new Map(waiting.map(({ taskId }) => {
    const root = trees.get(taskId)!.root;
    return [taskId, { rank: (ranks.get(root) ?? 0) / (1 + (held.get(root) ?? 0)), within: within.get(taskId) ?? 1,
      ...(runNow.has(root) ? { runNow: true } : {}) }];
  }));
}
