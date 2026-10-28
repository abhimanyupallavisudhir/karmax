import { describe, expect, it, vi } from 'vitest';
import { ReviewActionRunner } from '../src/gateway/review-actions.js';

// Opinions task 2: the task was done, so its view still named world
// generation 1; the world had since been woken from its checkpoint as
// generation 2. "Open explorer" ran its server in generation 2 but stamped the
// preview lease with 1, and the preview gateway — which serves a lease only for
// the world's current generation — answered "This preview has stopped".

function staleViewRunner() {
  const leases: any[] = [];
  const executions: any[] = [];
  const released: unknown[] = [];
  const opened = {
    handle: { id: 'world', kind: 'e2b', generation: 2 },
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    startProcess: async () => ({ onOutput: () => () => {}, onExit: () => () => {}, kill: async () => {} }),
  };
  const store = {
    getTask: async () => ({ projectId: 'project' }), getProject: async () => ({ id: 'project', organizationId: 'org' }),
    createExecution: async (execution: any) => { executions.push(execution); },
    setExecutionRunning: async () => {}, finishExecution: async () => {}, appendExecutionFrame: async () => {},
    createPreviewLease: async (lease: any) => { leases.push(lease); return lease; }, revokePreviewLease: async () => undefined,
    heartbeatExecution: async () => {}, execution: async () => ({}),
  };
  const worlds = { get: () => ({ capabilities: { remote: true } }), open: vi.fn(async () => opened) };
  const runners = { acquire: async () => ({ leaseId: 'runner-lease' }), release: async (id: string) => { released.push(id); } };
  const access = { releaseLeaseAndParkIfIdle: async (handle: unknown, id: string) => { released.push([handle, id]); } };
  const runner = new ReviewActionRunner(worlds as any, store as any, runners as any, access as any);
  const start = () => runner.start({ taskId: 'task', world: { id: 'world', kind: 'e2b', generation: 1 } as any,
    label: 'Open explorer', command: 'python3 -m http.server 8000', server: true, openUrls: ['http://localhost:8000/explorer/'] });
  return { leases, executions, released, opened, worlds, runner, start };
}

describe('review action world generation', () => {
  it('stamps its preview lease and execution with the generation it opened, not the one the task view names', async () => {
    const { leases, executions, runner, start } = staleViewRunner();
    try {
      await start();
      expect(leases.map((lease) => lease.generation)).toEqual([2]);
      expect(executions.map((execution) => execution.generation)).toEqual([2]);
    } finally { await runner.stopAll(); }
  });

  it('parks the world it opened when the server ends', async () => {
    const { released, opened, runner, start } = staleViewRunner();
    await start();
    await runner.stopAll();
    expect(released).toEqual([[opened.handle, 'runner-lease']]);
  });

  it('creates no preview lease when the world cannot be opened', async () => {
    const { leases, released, worlds, start } = staleViewRunner();
    worlds.open.mockRejectedValueOnce(new Error('sandbox gone'));
    await expect(start()).rejects.toThrow('sandbox gone');
    expect(leases).toEqual([]);
    expect(released).toEqual([[{ id: 'world', kind: 'e2b', generation: 1 }, 'runner-lease']]);
  });
});
