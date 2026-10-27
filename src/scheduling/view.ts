import type { Priority, QueueStatus } from './policy.js';

/** One task in the Queues page's agent-work list (wiki features/quota-scheduling). */
export interface SchedulingQueueTask {
  taskId: string;
  /** Its tree's root (itself for a root task). */
  root: string;
  projectId: string;
  num?: number;
  title: string;
  /** The root's number and title, for a sub-task. */
  rootNum?: number;
  rootTitle?: string;
  /** The tree's priority, as the scheduler uses it (unset is medium). */
  priority: Priority;
}

export interface SchedulingQueueView {
  organizationId: string;
  /** When the scheduler last planned (ms). */
  plannedAt?: number;
  /** Turns holding a login now. */
  running: (SchedulingQueueTask & { turnId: string; accountId: string; since?: number })[];
  /** Turns waiting, in the order they will get quota. */
  waiting: (SchedulingQueueTask & { turnId: string; status: Exclude<QueueStatus, 'admit'>; until?: number;
    /** Orders someone set for this task by dragging. */
    pins?: { above: string; below: string; by?: string }[] })[];
}
