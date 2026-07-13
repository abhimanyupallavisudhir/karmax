import {
  CancellationScope,
  condition,
  defineSignal,
  setHandler,
  type ActivityInterfaceFor,
} from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { classifyLimitError } from '../agent/limits.js';
import { SIG_ACCOUNT_GRANTED } from '../coordinators/names.js';
import { SIG_AGENT_TURN_STATE } from './names.js';
import type { AgentRole, TaskInput, TaskView } from './contract.js';

type Provider = 'claude' | 'codex' | 'mock';
type Grant = { accountId: string; configHome?: string; apiKeyHandle?: string };

const accountGrantedSignal = defineSignal<[{ turnId: string; accountId: string; configHome?: string; apiKeyHandle?: string }]>(SIG_ACCOUNT_GRANTED);
const agentTurnStateSignal = defineSignal<[{ turnId: string; role: AgentRole; provider?: Provider; state: 'running' }]>(SIG_AGENT_TURN_STATE);

export class AgentTurnCancelled extends Error {}
export class CredentialUnavailable extends Error {}

export interface AgentTurnLeaseHost {
  taskId: string;
  projectId: string;
  task(): TaskInput;
  status(): TaskView['status'];
  setStatus(status: TaskView['status']): void;
  setWaitingFor(waitingFor: TaskView['waitingFor']): void;
  setAgentTurn(agentTurn: TaskView['agentTurn']): void;
  cancelled(): boolean;
  publish(): Promise<void>;
}

/** Shared account lease → host-slot admission → running state machine for every
 * current agent workflow. Historical workflow versions keep their original
 * command sequence and do not instantiate this controller. */
export function createAgentTurnLeaser(
  core: ActivityInterfaceFor<coreActivities>,
  coord: ActivityInterfaceFor<coordinatorActivities>,
  host: AgentTurnLeaseHost,
) {
  let accountPool = 0;
  let turnSeq = 0;
  let activeScope: CancellationScope | undefined;
  let resumeStatus: TaskView['status'] = 'active';
  let currentTurn: TaskView['agentTurn'];
  const grants = new Map<string, Grant>();

  setHandler(accountGrantedSignal, (g) => {
    grants.set(g.turnId, { accountId: g.accountId, configHome: g.configHome, apiKeyHandle: g.apiKeyHandle });
  });
  setHandler(agentTurnStateSignal, async (next) => {
    if (!currentTurn || currentTurn.turnId !== next.turnId) return;
    currentTurn = { ...next };
    host.setAgentTurn(currentTurn);
    host.setWaitingFor(undefined);
    host.setStatus(resumeStatus);
    await host.publish();
  });

  const admitted = async <T>(
    turnId: string,
    role: AgentRole,
    provider: Provider | undefined,
    fn: (ctx: { accountConfigHome?: string; accountApiKeyHandle?: string; agentTurnId: string }) => Promise<T>,
    home?: string,
    key?: string,
  ): Promise<T> => {
    resumeStatus = host.status() === 'waiting' ? 'active' : host.status();
    currentTurn = { turnId, role, provider, state: 'waiting-slot' };
    host.setAgentTurn(currentTurn);
    host.setStatus('waiting');
    host.setWaitingFor({ kind: 'agentSlot', provider, detail: 'Waiting for host capacity to run the agent' });
    await host.publish();
    const scope = new CancellationScope({ cancellable: true });
    activeScope = scope;
    try {
      return await scope.run(() => fn({ accountConfigHome: home, accountApiKeyHandle: key, agentTurnId: turnId }));
    } finally {
      if (activeScope === scope) activeScope = undefined;
      if (currentTurn?.turnId === turnId) {
        currentTurn = undefined;
        host.setAgentTurn(undefined);
        host.setWaitingFor(undefined);
        if (host.status() === 'waiting') host.setStatus(resumeStatus);
        await host.publish();
      }
    }
  };

  return {
    async init(): Promise<void> {
      accountPool = await coord.accountPoolSize().catch(() => 0);
    },

    cancelActive(): void {
      activeScope?.cancel();
    },

    async run<T>(
      role: AgentRole,
      fn: (ctx: { accountConfigHome?: string; accountApiKeyHandle?: string; agentTurnId: string }) => Promise<T>,
    ): Promise<T> {
      const turnId = `${host.taskId}#${turnSeq++}`;
      if (accountPool <= 0) return admitted(turnId, role, undefined, fn);

      const resolved = await core.resolveProvider({ role, task: host.task() }).catch(() => undefined);
      const provider = resolved === 'claude' || resolved === 'codex' || resolved === 'mock' ? resolved : undefined;
      if (!provider) return admitted(turnId, role, undefined, fn);
      const allowed =
        provider === 'claude' || provider === 'codex'
          ? await core.resolveCredentialOrder({ taskId: host.taskId, projectId: host.projectId, provider }).catch(() => undefined)
          : undefined;

      await coord.leaseAccount(host.taskId, turnId, provider, allowed);
      const beforeWait = host.status();
      host.setStatus('waiting');
      host.setWaitingFor({ kind: 'account', provider });
      await host.publish();
      await condition(() => grants.has(turnId) || host.cancelled());
      const grant = grants.get(turnId);
      grants.delete(turnId);
      if (host.cancelled() && !grant) {
        await coord.cancelAccount(host.taskId, turnId).catch(() => undefined);
        host.setWaitingFor(undefined);
        host.setStatus(beforeWait === 'waiting' ? 'active' : beforeWait);
        await host.publish();
        throw new AgentTurnCancelled();
      }
      if (grant?.accountId === '(denied)') {
        host.setWaitingFor(undefined);
        host.setStatus(beforeWait === 'waiting' ? 'active' : beforeWait);
        await host.publish();
        throw new CredentialUnavailable(`No usable ${provider} credential; every allowed credential needs attention.`);
      }

      const passthrough = !grant || grant.accountId === '(passthrough)';
      const home = passthrough ? undefined : grant?.configHome;
      const key = passthrough ? undefined : grant?.apiKeyHandle;
      try {
        return await admitted(turnId, role, provider, fn, home, key);
      } catch (err) {
        if (grant && !passthrough && !host.cancelled()) {
          const cls = classifyLimitError(describeError(err));
          if (cls.hard) await coord.setAccountAvailability({ accountId: grant.accountId, status: 'needs-attention' }).catch(() => undefined);
          else if (cls.limited)
            await coord.reportAccountExhausted({ accountId: grant.accountId, window: cls.window ?? '5h', resetHint: cls.resetHint, note: cls.note }).catch(() => undefined);
        }
        throw err;
      } finally {
        if (grant && !passthrough) await coord.returnAccount(grant.accountId).catch(() => undefined);
      }
    },
  };
}

function describeError(err: unknown): string {
  const parts: string[] = [];
  let next: any = err;
  for (let depth = 0; next && depth < 6; depth++, next = next.cause) {
    if (next.message && !parts.includes(next.message)) parts.push(next.message);
  }
  return parts.join(' → ') || String(err);
}
