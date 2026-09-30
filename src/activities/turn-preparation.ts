import type { coreActivities } from './core.js';
import type { coordinatorActivities } from './coordinator.js';
import type { AgentRole, TaskInput } from '../domain/types.js';

/** Resolve one turn's credential policy in one activity, retaining the account
 * coordinator as the authority for whether leasing is enabled. */
export function makeTurnPreparationActivities(
  core: Pick<coreActivities, 'resolveProvider' | 'resolveCredentialOrder'>,
  coordinator: Pick<coordinatorActivities, 'accountPoolSize'>,
) {
  return {
    async prepareAgentTurn(args: { taskId: string; role: AgentRole; task: TaskInput }): Promise<{
      accountPool: number; provider?: string; allowed?: string[];
    }> {
      const accountPool = await coordinator.accountPoolSize();
      if (accountPool <= 0) return { accountPool };
      const provider = await core.resolveProvider(args).catch(() => undefined);
      if (!provider) return { accountPool };
      const allowed = provider !== 'mock'
        ? await core.resolveCredentialOrder({ ...args, projectId: args.task.projectId, provider }).catch(() => undefined)
        : undefined;
      return { accountPool, provider, allowed };
    },
  };
}
export type TurnPreparationActivities = ReturnType<typeof makeTurnPreparationActivities>;
