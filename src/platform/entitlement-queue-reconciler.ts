import type { Client } from '@temporalio/client';
import { SIG_SET_AGENT_CAPACITY, agentQueueId } from '../coordinators/names.js';
import type { Store } from '../store/db.js';

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

  start(): void {
    if (!this.options.store.hosted || this.unsubscribe) return;
    this.unsubscribe = this.options.store.onOrganizationEntitlementsChanged((organizationId) => {
      this.request(organizationId);
    });
    this.requestAll();
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => this.requestAll(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.requested.clear();
  }

  private requestAll(): void {
    for (const organization of this.options.store.listOrganizations()) this.request(organization.id);
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
    if (!this.options.store.hosted || !this.options.store.getOrganization(organizationId)) return;
    const entitlements = this.options.store.organizationEntitlements(organizationId);
    const capacity = entitlements.agentRunAdmissionAllowed
      ? entitlements.maxActiveAgentRuns
      : 0;
    if (capacity == null) return;
    await this.options.client.workflow.getHandle(agentQueueId(organizationId))
      .signal(SIG_SET_AGENT_CAPACITY, { capacity });
  }
}
