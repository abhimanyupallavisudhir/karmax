import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { PublishedView } from '../src/domain/view-publication.js';

const mocks = vi.hoisted(() => {
  vi.resetModules();
  return { park: vi.fn(), current: true };
});
vi.mock('@temporalio/workflow', () => ({
  patched: (id: string) => id === 'waiting-world-lifecycle-v1' || mocks.current,
  proxyActivities: () => ({ parkWaitingWorld: mocks.park }),
  isCancellation: () => false,
}));
import { publishTaskView } from '../src/workflows/view-publication.js';

afterAll(() => { vi.doUnmock('@temporalio/workflow'); vi.resetModules(); });
beforeEach(() => { mocks.park.mockReset(); mocks.current = true; });
it.each(['agentSlot', 'subagent', 'shell'])('does not schedule lifecycle work during %s waits', async kind => {
  const core = { publishView: vi.fn(async () => 'fence'), recordEvent: vi.fn() };
  const view = { status: 'waiting', waitingFor: { kind, detail: 'Still running' }, state: {},
    world: { id: 'task' } } as PublishedView;
  await publishTaskView(core, 'task', view);
  expect(core.publishView).toHaveBeenCalledOnce();
  expect(mocks.park).not.toHaveBeenCalled();
});
it('retains historical lifecycle commands before the non-idle-waits patch', async () => {
  mocks.current = false;
  const core = { publishView: vi.fn(async () => 'fence'), recordEvent: vi.fn() };
  const view = { status: 'waiting', waitingFor: { kind: 'subagent' }, state: {},
    world: { id: 'task' } } as PublishedView;
  await publishTaskView(core, 'task', view);
  expect(mocks.park).toHaveBeenCalledOnce();
});
