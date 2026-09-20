import type { Client } from '@temporalio/client';
import {
  QRY_AGENT_QUEUE,
  SIG_CANCEL_AGENT,
  SIG_RELEASE_AGENT,
  SIG_SET_AGENT_CAPACITY,
  agentQueueId,
} from '../coordinators/names.js';
import type { Store } from '../store/db.js';

interface AgentQueueItem {
  taskId: string;
  turnId: string;
}

interface AgentQueueView {
  queue: AgentQueueItem[];
  current: AgentQueueItem[];
}

async function hasDurableTurnIdentity(store: Store, taskId: string): Promise<boolean> {
  const task = (await store.getTask(taskId));
  if (!task) return true;
  const [major = 0, minor = 0] = task.workflowVersion.split('.').map(Number);
  if (major > 1) return true;
  if (major < 1) return false;
  const workflow = task.executionWorkflow ?? task.workflow;
  if (workflow === 'software-dev' || workflow === 'goal') return minor >= 4;
  if (workflow === 'just-do' || workflow === 'merge-only') return minor >= 2;
  return false;
}

export interface EntitlementQueueReconcilerOptions {
  store: Store;
  client: Client;
  /** Periodic retry/startup repair interval. Set to 0 in focused tests. */
  intervalMs?: number;
  log?: (message: string) => void;
}

/**
 * Keeps each hosted organization's durable agent queue aligned with its current
 * entitlement state. Store mutation notifications provide immediate recovery;
 * the periodic sweep repairs a missed signal after a crash or Temporal outage.
 *
 * Reconciliation signals existing coordinators only. It deliberately does not
 * start an empty workflow for every organization: the first admission still
 * creates the queue with the same computed capacity.
 */
export class EntitlementQueueReconciler {
  private readonly intervalMs: number;
  private readonly requested = new Set<string>();
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;

  constructor(private readonly options: EntitlementQueueReconcilerOptions) {
    this.intervalMs = Math.max(0, Math.floor(options.intervalMs ?? 60_000));
  }

  async start(): Promise<void> {
    if (!this.options.store.hosted || this.unsubscribe) return;
    this.unsubscribe = this.options.store.onOrganizationEntitlementsChanged((organizationId) => {
      this.request(organizationId);
    });
    (await this.requestAll());
    if (this.intervalMs > 0) {
      this.timer = setInterval(async () => (await this.requestAll()), this.intervalMs);
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.requested.clear();
    // The Temporal client must remain open until a signal/query already in
    // progress has settled. Otherwise its internal retry timer can fire after
    // shutdown and surface as an uncaught "Channel has been shut down" error.
    await this.draining;
  }

  private async requestAll(): Promise<void> {
    for (const organization of (await this.options.store.listOrganizations())) this.request(organization.id);
  }

  private request(organizationId: string): void {
    this.requested.add(organizationId);
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = undefined;
        // A request can arrive as the previous drain settles.
        if (this.requested.size) this.request(this.requested.values().next().value!);
      });
    }
  }

  private async drain(): Promise<void> {
    while (this.requested.size) {
      const organizationId = this.requested.values().next().value!;
      this.requested.delete(organizationId);
      try {
        await this.reconcileOrganization(organizationId);
      } catch (error) {
        // No queue exists until an organization first admits an agent turn.
        // Every other failure is retried by the periodic sweep and surfaced to
        // the operator without making the membership/billing write fail.
        if ((error as { name?: string } | undefined)?.name !== 'WorkflowNotFoundError') {
          this.options.log?.(`Could not reconcile agent capacity for ${organizationId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  async reconcileOrganization(organizationId: string): Promise<void> {
    if (!this.options.store.hosted || !(await this.options.store.getOrganization(organizationId))) return;
    const entitlements = (await this.options.store.organizationEntitlements(organizationId));
    const capacity = entitlements.agentRunAdmissionAllowed
      ? entitlements.maxActiveAgentRuns
      : 0;
    if (capacity == null) return;
    const handle = this.options.client.workflow.getHandle(agentQueueId(organizationId));
    await handle.signal(SIG_SET_AGENT_CAPACITY, { capacity });

    // Task-level liveness is insufficient: a task can remain alive after one of
    // its model activities was killed or cancelled. Its workflow view carries
    // the stable turn id, so reclaim only entries it explicitly no longer owns.
    // A query failure is conservative and preserves a possibly-live lease.
    const ownership = new Map<string, Promise<boolean>>();
    const stillOwned = (taskId: string, turnId: string): Promise<boolean> => {
      const key = `${taskId}\0${turnId}`;
      let result = ownership.get(key);
      if (!result) {
        result = (async () => {
          try {
            const taskView = await this.options.client.workflow.getHandle(taskId).query('view') as {
              status?: string;
              agentTurn?: { turnId?: string; state?: string };
            };
            return !['done', 'failed', 'cancelled'].includes(taskView.status ?? '')
              && taskView.agentTurn?.turnId === turnId
              && (taskView.agentTurn.state === 'waiting-slot' || taskView.agentTurn.state === 'running');
          } catch {
            return true;
          }
        })();
        ownership.set(key, result);
      }
      return result;
    };

    // Usage admission is a second, trusted enforcement boundary for historical
    // and external workflows. It must retain the plan cap, but not dead activity
    // residue that can otherwise consume Free's only slot forever. Pre-durable
    // workflow versions did not expose stable turn ownership in their views, so
    // preserve those admissions rather than mistaking an old shape for staleness.
    for (const admission of (await this.options.store.activeAgentUsageAdmissions(organizationId))) {
      if ((await hasDurableTurnIdentity(this.options.store, admission.taskId))
        && !(await stillOwned(admission.taskId, admission.id)))
        (await this.options.store.finishUsageAdmission(admission.id, false));
    }

    let view: AgentQueueView;
    try {
      view = await handle.query(QRY_AGENT_QUEUE) as AgentQueueView;
    } catch {
      return;
    }
    for (const item of view.current) {
      if (!(await stillOwned(item.taskId, item.turnId)))
        await handle.signal(SIG_RELEASE_AGENT, { taskId: item.taskId, turnId: item.turnId });
    }
    for (const item of view.queue) {
      if (!(await stillOwned(item.taskId, item.turnId)))
        await handle.signal(SIG_CANCEL_AGENT, { taskId: item.taskId, turnId: item.turnId });
    }
  }
}
