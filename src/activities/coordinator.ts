import type { Client } from '@temporalio/client';
import {
  MERGE_QUEUE_WORKFLOW,
  AGENT_QUEUE_WORKFLOW,
  ACCOUNT_COORDINATOR_WORKFLOW,
  SIG_ENQUEUE,
  SIG_RELEASE,
  SIG_PRIORITIZE,
  SIG_CANCEL_MERGE,
  SIG_REQUEST_AGENT,
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

export interface CoordinatorActivityDeps {
  client: Client;
  taskQueue: string;
  store?: {
    getSettings(scopeKey: string, workflow: string): Record<string, unknown> | undefined;
  };
}

/**
 * Client-side activities for the merge-queue coordinator. signal-with-start is a
 * client primitive (SPEC §3.2: create-or-signal atomically), so it lives in an
 * activity, not in workflow code. The coordinator is referenced by string name
 * to avoid importing its (sandbox-only) workflow module into Node.
 */
export function makeCoordinatorActivities(deps: CoordinatorActivityDeps) {
  const { client, taskQueue } = deps;
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
      } catch {
        return false;
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
    }): Promise<{ granted: boolean; position: number; capacity: number }> {
      const saved = Number(deps.store?.getSettings('global', 'agent-queue')?.capacity);
      const capacity = Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 3;
      await client.workflow.signalWithStart(AGENT_QUEUE_WORKFLOW, {
        workflowId: agentQueueId(),
        taskQueue,
        args: [{ capacity }],
        signal: SIG_REQUEST_AGENT,
        signalArgs: [item],
      });
      return await client.workflow.getHandle(agentQueueId()).executeUpdate(UPD_REQUEST_AGENT, {
        args: [item],
      }) as { granted: boolean; position: number; capacity: number };
    },
    async cancelAgentSlot(taskId: string, turnId: string): Promise<void> {
      try {
        await client.workflow.getHandle(agentQueueId()).signal(SIG_CANCEL_AGENT, { taskId, turnId });
      } catch {
        /* coordinator gone — nothing to cancel */
      }
    },
    async releaseAgentSlot(taskId: string, turnId: string): Promise<void> {
      try {
        await client.workflow.getHandle(agentQueueId()).signal(SIG_RELEASE_AGENT, { taskId, turnId });
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
    ): Promise<{ waiting: boolean }> {
      await client.workflow.signalWithStart(ACCOUNT_COORDINATOR_WORKFLOW, {
        workflowId: accountCoordinatorId(),
        taskQueue,
        args: [{}],
        signal: SIG_LEASE_ACCOUNT,
        signalArgs: [{ taskId, turnId, provider, allowed }],
      });
      // A consistent query after signal acceptance observes the coordinator after
      // it has either parked this request or sent its grant/denial signal. This
      // lets the task publish a login-wait label only for a genuine queue wait.
      return await client.workflow.getHandle(accountCoordinatorId()).query(
        QRY_ACCOUNT_LEASE,
        { taskId, turnId },
      ) as { waiting: boolean };
    },
    /** Remove a not-yet-granted account request when its task/turn is cancelled. */
    async cancelAccount(taskId: string, turnId: string): Promise<void> {
      try {
        await client.workflow.getHandle(accountCoordinatorId()).signal(SIG_CANCEL_ACCOUNT, { taskId, turnId });
      } catch {
        /* coordinator gone — nothing to cancel */
      }
    },
    async returnAccount(accountId: string): Promise<void> {
      try {
        await client.workflow.getHandle(accountCoordinatorId()).signal(SIG_RETURN_ACCOUNT, { accountId });
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
    async reportAccountExhausted(args: { accountId: string; window: LimitWindow; resetHint?: string; note?: string }): Promise<{ resetAt: number }> {
      const { resetAtFromHint } = await import('../agent/limits.js');
      const resetAt = resetAtFromHint(args.resetHint, args.window, Date.now());
      await client.workflow.getHandle(accountCoordinatorId()).executeUpdate(UPD_REPORT_EXHAUSTED, {
        args: [{
          accountId: args.accountId,
          window: args.window,
          resetAt,
          ...(args.note ? { note: args.note } : {}),
        }],
      });
      return { resetAt };
    },
    /** Manual availability override (UI/MCP): force a login on/off, edit its reset. */
    async setAccountAvailability(args: { accountId: string; status: AccountStatus; resetAt?: number }): Promise<void> {
      await client.workflow.getHandle(accountCoordinatorId()).executeUpdate(UPD_SET_ACCOUNT_AVAILABILITY, { args: [args] });
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
      } catch {
        return 0;
      }
    },
  };
}

export type coordinatorActivities = ReturnType<typeof makeCoordinatorActivities>;
