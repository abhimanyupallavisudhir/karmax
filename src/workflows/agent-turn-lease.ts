import {
  CancellationScope,
  condition,
  patched,
  defineSignal,
  setHandler,
  type ActivityInterfaceFor,
} from '@temporalio/workflow';
import type { coreActivities } from '../activities/core.js';
import type { coordinatorActivities } from '../activities/coordinator.js';
import { limitFailureClassification } from './failures.js';
import { SIG_ACCOUNT_GRANTED, SIG_AGENT_SLOT_GRANTED } from '../coordinators/names.js';
import { SIG_AGENT_TURN_STATE } from './names.js';
import type { AgentRole, TaskInput, TaskView, WorldHandleLike } from './contract.js';
import { agentTurnId } from './turn-id.js';

type Provider = 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'mock';
type CredentialKind = 'login' | 'ambient' | 'key';
type Grant = {
  accountId: string;
  configHome?: string;
  apiKeyHandle?: string;
  credentialKind?: CredentialKind;
  credentialProvider?: string;
};

const accountGrantedSignal = defineSignal<[{
  turnId: string;
  accountId: string;
  configHome?: string;
  apiKeyHandle?: string;
  credentialKind?: CredentialKind;
  credentialProvider?: string;
}]>(SIG_ACCOUNT_GRANTED);
const agentSlotGrantedSignal = defineSignal<[{ turnId: string }]>(SIG_AGENT_SLOT_GRANTED);
const agentTurnStateSignal = defineSignal<[{
  turnId: string;
  role: AgentRole;
  provider?: Provider;
  state: 'running' | 'waiting-host';
  detail?: string;
}]>(SIG_AGENT_TURN_STATE);

type AgentTurnContext = {
  accountConfigHome?: string;
  accountApiKeyHandle?: string;
  accountCredentialKind?: CredentialKind;
  accountCredentialProvider?: string;
  agentTurnId: string;
  agentAdmissionManaged?: true;
  /** The owning workflow already holds the durable coordinator lease. */
  agentSlotGranted?: true;
};

export class AgentTurnCancelled extends Error {}
export class CredentialUnavailable extends Error {}

export interface AgentTurnLeaseHost {
  taskId: string;
  projectId: string;
  task(): TaskInput;
  world(): WorldHandleLike | undefined;
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
  durableAdmission = false,
) {
  let accountPool = 0;
  let turnSeq = 0;
  let activeScope: CancellationScope | undefined;
  let resumeStatus: TaskView['status'] = 'active';
  let currentTurn: TaskView['agentTurn'];
  const grants = new Map<string, Grant>();
  const slotGrants = new Set<string>();

  setHandler(accountGrantedSignal, (g) => {
    grants.set(g.turnId, {
      accountId: g.accountId,
      configHome: g.configHome,
      apiKeyHandle: g.apiKeyHandle,
      credentialKind: g.credentialKind,
      credentialProvider: g.credentialProvider,
    });
  });
  setHandler(agentSlotGrantedSignal, ({ turnId }) => {
    slotGrants.add(turnId);
  });
  setHandler(agentTurnStateSignal, async (next) => {
    if (!currentTurn || currentTurn.turnId !== next.turnId) return;
    if (next.state === 'waiting-host') {
      currentTurn = { turnId: next.turnId, role: next.role, provider: next.provider, state: 'waiting-slot' };
      host.setAgentTurn(currentTurn);
      host.setWaitingFor({ kind: 'agentSlot', provider: next.provider, detail: next.detail ?? 'Starting agent' });
      host.setStatus('waiting');
      await host.publish();
      return;
    }
    currentTurn = { turnId: next.turnId, role: next.role, provider: next.provider, state: 'running' };
    host.setAgentTurn(currentTurn);
    host.setWaitingFor(undefined);
    host.setStatus(resumeStatus);
    await host.publish();
  });

  const admitted = async <T>(
    turnId: string,
    role: AgentRole,
    provider: Provider | undefined,
    fn: (ctx: AgentTurnContext) => Promise<T>,
    home?: string,
    key?: string,
    credentialKind?: CredentialKind,
    credentialProvider?: string,
  ): Promise<T> => {
    resumeStatus = host.status() === 'waiting' ? 'active' : host.status();
    currentTurn = { turnId, role, provider, state: 'waiting-slot' };
    host.setAgentTurn(currentTurn);
    host.setStatus('waiting');
    host.setWaitingFor({
      kind: 'agentSlot',
      provider,
      detail: durableAdmission ? 'Starting agent' : 'Waiting for host capacity to run the agent',
    });
    await host.publish();
    const scope = new CancellationScope({ cancellable: true });
    activeScope = scope;
    let slotHeld = false;
    let slotRequested = false;
    let queueId: string | undefined;
    try {
      return await scope.run(async () => {
        if (patched('agent-turn-cancel-before-start-v1') && host.cancelled()) throw new AgentTurnCancelled();
        if (durableAdmission) {
          const world = host.world();
          if (!world) throw new Error('agent world is not ready');
          const usesHostCapacity = await core.agentUsesHostCapacity({
            role,
            task: host.task(),
            worldHandle: world as any,
            accountConfigHome: home,
            accountApiKeyHandle: key,
            accountCredentialKind: credentialKind,
            accountCredentialProvider: credentialProvider,
          });
          if (usesHostCapacity) {
            slotRequested = true;
            let admission;
            for (;;) {
              admission = await coord.requestAgentSlot({
                taskId: host.taskId,
                turnId,
                role,
                provider,
                title: host.task().title,
                projectId: host.projectId,
              });
              queueId = admission.queueId;
              if (!admission.blocked) break;
              host.setWaitingFor({ kind: 'agentSlot', provider, detail: admission.detail });
              await host.publish();
              await condition(() => host.cancelled(), '30 seconds');
              if (host.cancelled()) throw new AgentTurnCancelled();
            }
            slotHeld = admission.granted || slotGrants.delete(turnId);
            if (!slotHeld) {
              host.setWaitingFor({
                kind: 'agentSlot',
                provider,
                detail: admission.detail ?? 'Waiting for host capacity to start agent',
              });
              await host.publish();
              await condition(() => slotGrants.has(turnId) || host.cancelled());
              slotHeld = slotGrants.delete(turnId);
            }
            if (host.cancelled() && !slotHeld) throw new AgentTurnCancelled();
            host.setWaitingFor({ kind: 'agentSlot', provider, detail: 'Starting agent' });
            await host.publish();
          }
        }
        if (patched('agent-turn-cancel-before-start-v1') && host.cancelled()) throw new AgentTurnCancelled();
        return await fn({
          accountConfigHome: home,
          accountApiKeyHandle: key,
          accountCredentialKind: credentialKind,
          accountCredentialProvider: credentialProvider,
          agentTurnId: turnId,
          ...(durableAdmission ? { agentAdmissionManaged: true as const } : {}),
          ...(slotHeld ? { agentSlotGranted: true as const } : {}),
        });
      });
    } catch (err) {
      if (durableAdmission && host.cancelled()) throw new AgentTurnCancelled();
      throw err;
    } finally {
      slotGrants.delete(turnId);
      if (durableAdmission && slotRequested) {
        if (slotHeld) await coord.releaseAgentSlot(host.taskId, turnId, queueId).catch(() => undefined);
        else await coord.cancelAgentSlot(host.taskId, turnId, queueId).catch(() => undefined);
      }
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
      accountPool = patched('agent-turn-account-pool-refresh-v1')
        ? await coord.accountPoolSize() : await coord.accountPoolSize().catch(() => 0);
    },

    cancelActive(): void {
      activeScope?.cancel();
    },

    async run<T>(
      role: AgentRole,
      fn: (ctx: AgentTurnContext) => Promise<T>,
    ): Promise<T> {
      if (patched('agent-turn-account-pool-refresh-v1')) accountPool = await coord.accountPoolSize();
      const turnId = agentTurnId(host.taskId, turnSeq++);
      if (accountPool <= 0) return admitted(turnId, role, undefined, fn);

      const resolved = await core.resolveProvider({ role, task: host.task() }).catch(() => undefined);
      const credentialProvider = typeof resolved === 'string' && resolved ? resolved : undefined;
      if (!credentialProvider) return admitted(turnId, role, undefined, fn);
      const allowed =
        credentialProvider !== 'mock'
          ? await core.resolveCredentialOrder({ taskId: host.taskId, projectId: host.projectId, provider: credentialProvider, role, task: host.task() }).catch(() => undefined)
          : undefined;
      const provider =
        credentialProvider === 'claude' || credentialProvider === 'codex' || credentialProvider === 'opencode'
        || credentialProvider === 'kimi' || credentialProvider === 'grok' || credentialProvider === 'mock'
          ? credentialProvider
          : undefined;

      const lease = await coord.leaseAccount(host.taskId, turnId, credentialProvider, allowed);
      const beforeWait = host.status();
      host.setStatus('waiting');
      // Historical activity results decode as undefined and retain their recorded
      // account-wait publication. New executions distinguish a real parked lease
      // from an immediate grant without changing the workflow command sequence.
      host.setWaitingFor(lease?.waiting === false
        ? { kind: 'agentSlot', provider, detail: 'Starting agent' }
        : { kind: 'account', provider: credentialProvider,
            ...(lease?.earliestResetAt !== undefined ? { earliestResetAt: lease.earliestResetAt } : {}),
            ...(lease?.detail ? { detail: lease.detail } : {}) });
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
        throw new CredentialUnavailable(`No usable ${credentialProvider} credential; every allowed credential needs attention.`);
      }

      const passthrough = !grant || grant.accountId === '(passthrough)';
      const home = passthrough ? undefined : grant?.configHome;
      const key = passthrough ? undefined : grant?.apiKeyHandle;
      const credentialKind = passthrough ? undefined : grant?.credentialKind;
      const leasedCredentialProvider = passthrough ? undefined : grant?.credentialProvider;
      try {
        return await admitted(turnId, role, provider, fn, home, key, credentialKind, leasedCredentialProvider);
      } catch (err) {
        if (grant && !passthrough && !host.cancelled()) {
          const cls = limitFailureClassification(err);
          if (cls?.hard) await coord.setAccountAvailability({
            accountId: grant.accountId,
            status: 'needs-attention',
            ...(cls.diagnostic ? { failure: {
              kind: cls.kind, provider: cls.provider, diagnostic: cls.diagnostic,
            } } : {}),
          }).catch(() => undefined);
          else if (cls?.limited)
            await coord.reportAccountExhausted({
              accountId: grant.accountId,
              window: cls.window ?? '5h',
              resetHint: cls.resetHint,
              note: cls.note,
              ...(cls.diagnostic ? { failure: {
                kind: cls.kind, provider: cls.provider, diagnostic: cls.diagnostic,
              } } : {}),
            }).catch(() => undefined);
        }
        throw err;
      } finally {
        // Name the lease — see the matching note in software-dev.ts.
        if (grant && !passthrough)
          await coord.returnAccount(grant.accountId, { taskId: host.taskId, turnId }).catch(() => undefined);
      }
    },
  };
}
