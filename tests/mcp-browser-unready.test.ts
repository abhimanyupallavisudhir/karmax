import { describe, expect, it, vi } from 'vitest';

// A cloud world whose browser cannot be made ready (an install that failed, a
// Chromium that will not launch on a machine busy with the agent's own work).
vi.mock('../src/agent/remote-process.js', () => ({
  isRemoteAgentWorld: () => true,
  ensureRemoteNode: async () => '/opt/node/bin',
  ensureRemoteBrowser: async () => { throw new Error('remote Chromium readiness probe failed: timed out'); },
}));

const { prepareConnections } = await import('../src/mcp/connections/runtime.js');
const { AgentToolsUnavailable } = await import('../src/agent/limits.js');

describe('a browser tool that cannot be made ready', () => {
  const world = { handle: { version: 2, sealedProviderRef: 'test', root: '/home/user/task' } } as any;

  it('fails the turn as tools that did not start, so it is retried rather than handed to a person', async () => {
    const failure = await prepareConnections(undefined, world, ['browser:chrome-devtools'], 'project', 'task', () => {})
      .then(() => undefined, (error) => error);
    expect(failure).toBeInstanceOf(AgentToolsUnavailable);
    expect(failure.servers).toEqual([{ name: 'chrome-devtools', status: 'failed' }]);
    expect(failure.cause.message).toMatch(/readiness probe failed/);
  });

  it('is left out of the retry, which names it', async () => {
    const unavailable: string[] = [];
    const servers = await prepareConnections(undefined, world, ['browser:chrome-devtools'], 'project', 'task', () => {},
      undefined, { toolsOptional: true, onUnavailable: (name) => unavailable.push(name) });
    expect(servers).toEqual([]);
    expect(unavailable).toEqual(['chrome-devtools']);
  });
});
