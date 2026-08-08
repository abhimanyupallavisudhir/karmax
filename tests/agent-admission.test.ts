import { describe, expect, it, vi } from 'vitest';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

describe('agent turn admission', () => {
  it('uses a blocking update and classifies coordinator failures as retryable infrastructure', async () => {
    const store = new Store(':memory:');
    const worlds = new WorldRegistry();
    const world = await worlds.create('memory', { taskId: 'admission-task', base: 'main' });
    const coordinator = {
      signal: vi.fn(async () => undefined),
      executeUpdate: vi.fn(async () => {
        throw new Error('Failed to query Workflow → 8 RESOURCE_EXHAUSTED: consistent query buffer is full');
      }),
      query: vi.fn(),
    };
    const client = {
      workflow: {
        signalWithStart: vi.fn(async () => undefined),
        getHandle: vi.fn(() => coordinator),
      },
    } as any;
    const core = makeCoreActivities({
      store,
      worlds,
      adapters: new Map(),
      profiles: new ProfileResolver(store, 'mock'),
      client,
      taskQueue: 'test',
    });

    const error = await core.runAgentTurn({
      taskId: 'admission-task',
      role: 'do',
      agentTurnId: 'admission-task#0',
      worldHandle: world.handle,
      messages: [{ id: 'm0', role: 'user', text: 'publish', ts: 0 }],
      task: {
        projectId: 'project',
        title: 'Admission',
        prompt: 'publish',
        project: {},
        workflow: 'software-dev',
      },
    } as any).then(() => undefined, (caught) => caught);

    expect(coordinator.executeUpdate).toHaveBeenCalledWith('waitAgentSlot', {
      args: [{
        taskId: 'admission-task',
        turnId: 'admission-task#0',
        role: 'do',
        provider: 'mock',
        title: 'Admission',
        projectId: 'project',
      }],
    });
    expect(coordinator.query).not.toHaveBeenCalled();
    expect(error).toMatchObject({
      type: 'agent-infra',
      nonRetryable: false,
    });
    expect(error.message).toContain('agent-slot admission failed');
    await world.destroy();
  });

  it('classifies a remote sandbox reconnect timeout as retryable infrastructure', async () => {
    const store = new Store(':memory:');
    const worlds = new WorldRegistry();
    worlds.register({
      kind: 'fake-remote', capabilities: { remote: true },
      async create() { throw new Error('unused'); },
      async open() {
        throw Object.assign(new Error('E2B reconnect failed'), { code: 'ETIMEDOUT' });
      },
      async destroy() {},
    } as any);
    const core = makeCoreActivities({
      store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'),
    });

    const error = await core.runAgentTurn({
      taskId: 'reconnect-task', role: 'do',
      worldHandle: { kind: 'fake-remote', id: 'reconnect-task', root: '/workspace',
        branch: 'karmax/reconnect-task', base: 'main' },
      messages: [{ id: 'm0', role: 'user', text: 'continue', ts: 0 }],
      task: { projectId: 'project', title: 'Reconnect', prompt: 'continue', project: {},
        workflow: 'software-dev' },
    } as any).then(() => undefined, (caught) => caught);

    expect(error).toMatchObject({ type: 'agent-infra', nonRetryable: false });
    store.close();
  });
});
