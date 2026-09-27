import { installationTiming, timingEnabled } from '../timing/index.js';
import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { Context } from '@temporalio/activity';
import type { ProviderNativeDiagnostic } from '../agent/limits.js';
import {
  MERGE_QUEUE_WORKFLOW,
  AGENT_QUEUE_WORKFLOW,
  ACCOUNT_COORDINATOR_WORKFLOW,
  SIG_ENQUEUE,
  SIG_RELEASE,
  SIG_PRIORITIZE,
  SIG_CANCEL_MERGE,
  SIG_SET_AGENT_CAPACITY,
  SIG_CANCEL_AGENT,
  SIG_RELEASE_AGENT,
  SIG_LEASE_ACCOUNT,
  SIG_CANCEL_ACCOUNT,
  SIG_RETURN_ACCOUNT,
  SIG_REGISTER_ACCOUNTS,
  UPD_REPORT_EXHAUSTED,
  UPD_SET_ACCOUNT_AVAILABILITY,
  UPD_REQUEST_AGENT,
  QRY_QUEUE,
  QRY_ACCOUNTS,
  QRY_ACCOUNT_LEASE,
  mergeQueueId,
  agentQueueId,
  accountCoordinatorId,
} from '../coordinators/names.js';

type AccountProvider = string;
type CredKind = 'login' | 'ambient' | 'key';
type LimitWindow = '5h' | 'weekly' | 'model';
type AccountStatus = 'available' | 'exhausted' | 'manual-off' | 'needs-attention';
type FailureTransitionInput = {
  kind?: 'quota' | 'credential';
  provider?: string;
  diagnostic?: ProviderNativeDiagnostic;
};

function transitionProvenance(failure?: FailureTransitionInput) {
  let sourceTaskId: string | undefined;
  let sourceActivityId: string | undefined;
  try {
    const info = Context.current().info;
    sourceTaskId = info.workflowExecution?.workflowId;
    sourceActivityId = String(info.activityId);
  } catch {
    // Gateway/operator calls run outside a Temporal activity context.
  }
  return {
    source: failure || sourceTaskId ? 'provider-failure' as const : 'manual' as const,
    ...(sourceTaskId ? { sourceTaskId } : {}),
    ...(sourceActivityId ? { sourceActivityId } : {}),
    ...(failure?.kind ? { kind: failure.kind } : {}),
    ...(failure?.provider ? { provider: failure.provider } : {}),
    ...(failure?.diagnostic ? { diagnostic: failure.diagnostic } : {}),
    at: Date.now(),
  };
}

export interface CoordinatorActivityDeps {
  client: Client;
  taskQueue: string;
  store?: {
    readonly hosted: boolean;
    appendEvent?(event: import('../domain/types.js').KarmaxEvent): (number) | Promise<number>;
    getSettings(scopeKey: string, workflow: string): (Record<string, unknown> | undefined) | Promise<Record<string, unknown> | undefined>;
    getProject(projectId: string): ({ organizationId?: string } | undefined) | Promise<{ organizationId?: string } | undefined>;
    getTask(taskId: string): ({ projectId: string } | undefined) | Promise<{ projectId: string } | undefined>;
    organizationEntitlements(organizationId: string): ({
      planName: string;
      maxActiveAgentRuns: number | null;
      currentMemberCount: number;
      maxMembers: number | null;
      overMemberLimit: boolean;
      agentRunAdmissionAllowed: boolean;
    }) | Promise<{
      planName: string;
      maxActiveAgentRuns: number | null;
      currentMemberCount: number;
      maxMembers: number | null;
      overMemberLimit: boolean;
      agentRunAdmissionAllowed: boolean;
    }>;
  };
}

async function agentQueueTarget(deps: CoordinatorActivityDeps,
  item: { taskId: string; projectId?: string; queueId?: string }): Promise<{
    workflowId: string;
    capacity: number;
    detail?: string;
    blocked?: boolean;
  }> {
  if (deps.store?.hosted) {
    const durableOrganizationId = item.queueId?.startsWith('agent-queue:')
      ? item.queueId.slice('agent-queue:'.length)
      : undefined;
    const projectId = durableOrganizationId ? undefined : item.projectId ?? (await deps.store.getTask(item.taskId))?.projectId;
    const organizationId = durableOrganizationId
      ?? (projectId ? (await deps.store.getProject(projectId))?.organizationId : undefined);
    if (!organizationId) throw new Error(`cannot resolve the organization for agent turn ${item.taskId}`);
    const entitlements = (await deps.store.organizationEntitlements(organizationId));
    const planCapacity = entitlements.maxActiveAgentRuns;
    if (planCapacity == null) throw new Error(`hosted organization ${organizationId} has no active-run entitlement`);
    if (!entitlements.agentRunAdmissionAllowed) {
      const limit = entitlements.maxMembers ?? 0;
      const extra = Math.max(1, entitlements.currentMemberCount - limit);
      return {
        workflowId: agentQueueId(organizationId),
        capacity: 0,
        blocked: true,
        detail: `${entitlements.planName} allows ${limit} organization user${limit === 1 ? '' : 's'}, but this organization has ${entitlements.currentMemberCount}. Remove ${extra} member${extra === 1 ? '' : 's'} or restore Team to start another agent run.`,
      };
    }
    return {
      workflowId: agentQueueId(organizationId),
      capacity: planCapacity,
      detail: `Waiting for ${entitlements.planName} plan capacity (${planCapacity} active agent run${planCapacity === 1 ? '' : 's'})`,
    };
  }
  const saved = Number((await deps.store?.getSettings('global', 'agent-queue'))?.capacity);
  return { workflowId: agentQueueId(), capacity: Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 3 };
}

/**
 * Client-side activities for the merge-queue coordinator. signal-with-start is a
 * client primitive (SPEC §3.2: create-or-signal atomically), so it lives in an
 * activity, not in workflow code. The coordinator is referenced by string name
 * to avoid importing its (sandbox-only) workflow module into Node.
 */
export function makeCoordinatorActivities(deps: CoordinatorActivityDeps) {
  const { client, taskQueue } = deps;
  const timing = async (taskId: string, turnId: string, name: string) => {
    if (!(await timingEnabled(deps.store))) return;
    let workflowRunId: string | undefined;
    try { workflowRunId = Context.current().info.workflowExecution?.runId; } catch { /* direct call */ }
    (await (await installationTiming(deps.store, { taskId, turnId, workflowRunId }, async row => (await deps.store?.appendEvent?.({ taskId, type: 'timing', ts: row.wallMs, payload: { ...row } })))).mark(name));
  };
  return {
    /** Enqueue a task for the merge slot, creating the coordinator if needed. */
    async enqueueMerge(domain: string, taskId: string): Promise<void> {
      await client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
        workflowId: mergeQueueId(domain),
        taskQueue,
        args: [{ domain }],
        signal: SIG_ENQUEUE,
        signalArgs: [{ taskId }],
      });
    },
    async releaseMerge(domain: string, taskId: string): Promise<void> {
      await client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
        workflowId: mergeQueueId(domain),
        taskQueue,
        args: [{ domain }],
        signal: SIG_RELEASE,
        signalArgs: [{ taskId }],
      });
    },
    async prioritizeMerge(domain: string, taskId: string): Promise<void> {
      await client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
        workflowId: mergeQueueId(domain),
        taskQueue,
        args: [{ domain }],
        signal: SIG_PRIORITIZE,
        signalArgs: [{ taskId }],
      });
    },
    async cancelMerge(domain: string, taskId: string): Promise<void> {
      await client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
        workflowId: mergeQueueId(domain),
        taskQueue,
        args: [{ domain }],
        signal: SIG_CANCEL_MERGE,
        signalArgs: [{ taskId }],
      });
    },
    /** Where `taskId` sits in `domain`'s queue.
     *
     * A failed query means the coordinator could not answer — it is wedged
     * (a nondeterministic workflow task retries forever, and queries against it
     * never resolve), or it has not started yet. That is NOT the same as an
     * empty queue, and reporting it as one is actively misleading: a task can
     * then sit in `merge` for hours while every surface says the queue is
     * empty. `unreachable` keeps the two distinguishable all the way to the UI.
     */
    async mergeQueuePosition(
      domain: string,
      taskId: string,
    ): Promise<{ position: number; total: number; current?: string; unreachable?: boolean }> {
      try {
        const view = (await client.workflow
          .getHandle(mergeQueueId(domain))
          .query(QRY_QUEUE)) as { queue: string[]; current?: string };
        const total = view.queue.length + (view.current ? 1 : 0);
        if (view.current === taskId) return { position: 0, total, current: view.current };
        const idx = view.queue.indexOf(taskId);
        if (idx < 0) {
          // We are polling for a slot in a queue that has never heard of us: the
          // enqueue was lost because the coordinator was rebuilt (see
          // `healCoordinators`) or reset underneath us. Waiting on a grant that
          // is never coming is exactly how a task burns its history down to a
          // hard TERMINATE, so re-enqueue instead. The coordinator ignores a
          // taskId it already has, making this idempotent — including on a first
          // poll that races ahead of our own enqueue being applied.
          await client.workflow.signalWithStart(MERGE_QUEUE_WORKFLOW, {
            workflowId: mergeQueueId(domain),
            taskQueue,
            args: [{ domain }],
            signal: SIG_ENQUEUE,
            signalArgs: [{ taskId }],
          });
          return { position: view.queue.length + 1, total: total + 1, current: view.current };
        }
        return { position: idx + 1, total, current: view.current };
      } catch {
        return { position: -1, total: 0, unreachable: true };
      }
    },
    /** Crash-safety check: is the grantee workflow still running? */
    async isTaskAlive(taskId: string): Promise<boolean> {
      try {
        const desc = await client.workflow.getHandle(taskId).describe();
        return desc.status.name === 'RUNNING';
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return false;
        throw error;
      }
    },

    // ── agent-turn coordinator (SPEC §6.1a) ──
    /** Enqueue and immediately acknowledge one turn. A queued request is granted
     * later by a durable signal from the coordinator to the owning task workflow. */
    async requestAgentSlot(item: {
      taskId: string;
      turnId: string;
      role: string;
      provider?: string;
      title?: string;
      projectId?: string;
    }): Promise<{ granted: boolean; position: number; capacity: number; detail?: string; blocked?: boolean; queueId: string }> {
      (await timing(item.taskId, item.turnId, 'queue.slot.requested'));
      const target = (await agentQueueTarget(deps, item));
      await client.workflow.signalWithStart(AGENT_QUEUE_WORKFLOW, {
        workflowId: target.workflowId,
        taskQueue,
        args: [{ capacity: target.capacity }],
        // Capacity is refreshed on every request, so a billing plan change takes
        // effect without restarting the coordinator. Shrinks never evict current
        // leases; the workflow simply keeps subsequent turns queued.
        signal: SIG_SET_AGENT_CAPACITY,
        signalArgs: [{ capacity: target.capacity }],
      });
      if (target.blocked) return {
        granted: false,
        position: -1,
        capacity: 0,
        blocked: true,
        queueId: target.workflowId,
        detail: target.detail,
      };
      const admission = await client.workflow.getHandle(target.workflowId).executeUpdate(UPD_REQUEST_AGENT, {
        args: [item],
      }) as { granted: boolean; position: number; capacity: number };
      return { ...admission, queueId: target.workflowId, ...(target.detail ? { detail: target.detail } : {}) };
    },
    async cancelAgentSlot(taskId: string, turnId: string, queueId?: string): Promise<void> {
      try {
        const target = (await agentQueueTarget(deps, { taskId, queueId }));
        const handle = client.workflow.getHandle(target.workflowId);
        // Re-read the plan at every queue mutation as well as every request. In
        // particular, a downgrade must be applied before releasing a lease can
        // promote more queued work at the former capacity.
        await handle.signal(SIG_SET_AGENT_CAPACITY, { capacity: target.capacity });
        await handle.signal(SIG_CANCEL_AGENT, { taskId, turnId });
      } catch {
        /* coordinator gone — nothing to cancel */
      }
    },
    async releaseAgentSlot(taskId: string, turnId: string, queueId?: string): Promise<void> {
      try {
        const target = (await agentQueueTarget(deps, { taskId, queueId }));
        const handle = client.workflow.getHandle(target.workflowId);
        await handle.signal(SIG_SET_AGENT_CAPACITY, { capacity: target.capacity });
        await handle.signal(SIG_RELEASE_AGENT, { taskId, turnId });
      } catch {
        /* coordinator gone — its lease is already gone too */
      }
    },

    // ── account/token coordinator (SPEC §6.2) ──
    /** Upsert credentials (logins, ambient, keys) into the pool, creating the coordinator. */
    async registerAccounts(accounts: { id: string; configHome: string; provider?: AccountProvider; kind?: CredKind; apiKeyHandle?: string; maxConcurrent?: number }[]): Promise<void> {
      await client.workflow.signalWithStart(ACCOUNT_COORDINATOR_WORKFLOW, {
        workflowId: accountCoordinatorId(),
        taskQueue,
        args: [{}],
        signal: SIG_REGISTER_ACCOUNTS,
        signalArgs: [{ accounts }],
      });
    },
    /** Request a credential lease for a turn (the coordinator signals the task back).
     *  `allowed` = the credential policy's ordered, enabled keys for this turn; the
     *  coordinator grants the first available one (empty ⇒ passthrough). */
    async leaseAccount(
      taskId: string,
      turnId: string,
      provider?: AccountProvider,
      allowed?: string[],
    ): Promise<{ waiting: boolean; earliestResetAt?: number; detail?: string }> {
      // The pool holds every organization's credentials. Without an allow-list
      // the coordinator grants any account of the provider, so a real provider
      // whose policy could not be resolved (the workflow's `.catch(() =>
      // undefined)`) must fail closed. Only the mock keeps the provider fallback.
      if (provider && provider !== 'mock' && allowed === undefined) allowed = ['missing:policy-unavailable'];
      (await timing(taskId, turnId, 'queue.account.requested'));
      await client.workflow.signalWithStart(ACCOUNT_COORDINATOR_WORKFLOW, {
        workflowId: accountCoordinatorId(),
        taskQueue,
        args: [{}],
        signal: SIG_LEASE_ACCOUNT,
        signalArgs: [{ taskId, turnId, provider, allowed }],
      });
      // A query may still be served by the closing run during continue-as-new.
      // Retry that acknowledgement without issuing another lease request.
      for (let attempt = 0; attempt < 10; attempt++) {
        const acknowledgement = await client.workflow.getHandle(accountCoordinatorId()).query(
          QRY_ACCOUNT_LEASE,
          { taskId, turnId },
        ) as { waiting: boolean; earliestResetAt?: number; detail?: string; continuingAsNew?: true };
        if (!acknowledgement.continuingAsNew) return acknowledgement;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100 * 2 ** attempt, 1000)));
      }
      throw new Error('Account coordinator is still continuing as new; retry lease acknowledgement');
    },
    /** Remove a not-yet-granted account request when its task/turn is cancelled. */
    async cancelAccount(taskId: string, turnId: string): Promise<void> {
      try {
        await client.workflow.getHandle(accountCoordinatorId()).signal(SIG_CANCEL_ACCOUNT, { taskId, turnId });
      } catch {
        /* coordinator gone — nothing to cancel */
      }
    },
    /** `lease` identifies WHICH granted record is coming back. Optional because the
     *  signal shipped without it; see the handler in coordinators/account.ts for why
     *  guessing (drop the oldest) corrupts the ledger's task attribution. */
    async returnAccount(accountId: string, lease?: { taskId: string; turnId: string }): Promise<void> {
      try {
        await client.workflow.getHandle(accountCoordinatorId()).signal(SIG_RETURN_ACCOUNT, { accountId, ...lease });
      } catch {
        /* coordinator gone — nothing to return */
      }
    },
    /**
     * Ground-truth exhaustion report (SPEC §6.2): auto-resolve calls this when a
     * turn fails on a usage/session limit. The wall-clock/timezone math that turns
     * a human-readable "resets 3:45pm" hint into an absolute instant lives here (a
     * side-effecting activity), not in the deterministic coordinator.
     */
    async reportAccountExhausted(args: {
      accountId: string; window: LimitWindow; resetHint?: string; note?: string; failure?: FailureTransitionInput;
    }): Promise<{ resetAt: number }> {
      const { resetAtFromHint } = await import('../agent/limits.js');
      const resetAt = resetAtFromHint(args.resetHint, args.window, Date.now());
      await client.workflow.getHandle(accountCoordinatorId()).executeUpdate(UPD_REPORT_EXHAUSTED, {
        args: [{
          accountId: args.accountId,
          window: args.window,
          resetAt,
          ...(args.note ? { note: args.note } : {}),
          transition: transitionProvenance(args.failure ?? { kind: 'quota' }),
        }],
      });
      return { resetAt };
    },
    /** Manual availability override (UI/MCP): force a login on/off, edit its reset. */
    async setAccountAvailability(args: {
      accountId: string; status: AccountStatus; resetAt?: number; onlyIfStatus?: AccountStatus;
      failure?: FailureTransitionInput;
    }): Promise<void> {
      const { failure, ...availability } = args;
      await client.workflow.getHandle(accountCoordinatorId()).executeUpdate(UPD_SET_ACCOUNT_AVAILABILITY, {
        args: [{
          ...availability,
          ...(args.status !== 'available' ? { transition: transitionProvenance(failure) } : {}),
        }],
      });
    },
    /** Full account availability view for the dashboard (empty if not running). */
    async accountsView(): Promise<{ accounts: unknown[]; waiting: number }> {
      try {
        return (await client.workflow.getHandle(accountCoordinatorId()).query(QRY_ACCOUNTS)) as { accounts: unknown[]; waiting: number };
      } catch {
        return { accounts: [], waiting: 0 };
      }
    },
    /** How many accounts are in the pool (0 if the coordinator isn't running). */
    async accountPoolSize(): Promise<number> {
      try {
        const view = (await client.workflow.getHandle(accountCoordinatorId()).query(QRY_ACCOUNTS)) as { accounts: unknown[] };
        return view.accounts.length;
      } catch (error) {
        // "No coordinator yet" genuinely means the optional pool is disabled.
        // A timeout / unavailable workflow task is different: returning 0 here
        // permanently bakes credential passthrough into the task execution. That
        // is fatal for a recovered remote world, whose provider subscription must
        // be copied from the leased config home. Let Temporal retry transient
        // query failures under the workflow's bounded coordinator policy.
        if (error instanceof WorkflowNotFoundError) return 0;
        throw error;
      }
    },
  };
}

export type coordinatorActivities = ReturnType<typeof makeCoordinatorActivities>;
