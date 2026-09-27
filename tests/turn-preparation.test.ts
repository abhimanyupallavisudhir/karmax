import { it, expect, vi } from 'vitest';
import { makeTurnPreparationActivities } from '../src/activities/turn-preparation.js';
import type { TaskInput } from '../src/domain/types.js';

it('keeps the account coordinator authoritative and preserves provider credential order', async () => {
  const coordinator = { accountPoolSize: vi.fn().mockResolvedValue(1) };
  const core = { resolveProvider: vi.fn().mockResolvedValue('claude'), resolveCredentialOrder: vi.fn().mockResolvedValue(['a', 'b']) };
  const { prepareAgentTurn } = makeTurnPreparationActivities(core, coordinator);
  const args = { taskId: 't', role: 'do' as const, task: { projectId: 'p' } as TaskInput };
  expect(await prepareAgentTurn(args)).toEqual({ accountPool: 1, provider: 'claude', allowed: ['a', 'b'] });
  expect(core.resolveCredentialOrder).toHaveBeenCalledWith({ ...args, projectId: 'p', provider: 'claude' });
  coordinator.accountPoolSize.mockRejectedValueOnce(new Error('coordinator unavailable'));
  await expect(prepareAgentTurn(args)).rejects.toThrow('coordinator unavailable');
  coordinator.accountPoolSize.mockResolvedValue(0);
  core.resolveProvider.mockClear();
  expect(await prepareAgentTurn(args)).toEqual({ accountPool: 0 });
  expect(core.resolveProvider).not.toHaveBeenCalled();
});
