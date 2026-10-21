// Compute routing in a real workflow (wiki features/compute-routing): a task
// whose Computer says provider "Any" gets its world on the next candidate when
// the first is full, and waits for a machine only while every one is full.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { view } from './helpers/pipeline-harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { MemoryWorldProvider } from '../src/world/memory.js';
import { ProviderCapacityFull } from '../src/agent/limits.js';
import { providerFeatures } from '../src/domain/computer-limits.js';

/** A cloud provider for the test: a local scratch world, unless told it is full. */
function provider(kind: string, state: { full?: string }) {
  const memory = new MemoryWorldProvider();
  const as = (world: any) => { world.handle.kind = kind; world.handle.provider = kind; return world; };
  return {
    kind, parkable: false, capabilities: { remote: true },
    async create(spec: any) {
      if (state.full) throw new ProviderCapacityFull(state.full);
      return as(await memory.create(spec));
    },
    async open(handle: any) { return as(await memory.open({ ...handle, kind: 'memory' })); },
  } as any;
}

describe('provider "Any" in a running task (real Temporal, mock agent)', () => {
  let h: Harness;
  const hetzner: { full?: string } = {};
  const aws: { full?: string } = {};
  const account = (kind: string, diskGb: number) => ({ provider: kind, enabled: true, credentialConfigured: true, status: 'ready', managed: true,
    limits: { cpu: 16, memoryMb: 65_536, diskGb }, features: providerFeatures(kind), config: {} });
  // The organization reaches managed Hetzner and AWS (WorldProviderConnectionService's view).
  const connections = {
    list: async () => [account('hetzner', 200), account('aws', 2048)],
    managedConnections: async () => [],
    available: async () => true,
    assertFits: async () => undefined,
  };

  beforeAll(async () => {
    h = await bootHarness('mock', undefined, { providerConnections: connections } as any);
    h.worlds.register(provider('hetzner', hetzner));
    h.worlds.register(provider('aws', aws));
  }, 60_000);
  afterAll(() => h?.stop());

  async function start(title: string) {
    const project = await h.store.createProject(title, { worldProvider: 'any' });
    const task = await h.store.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.27.0',
      params: { prompt: title } });
    const handle = await h.client.workflow.start('softwareDev', { taskQueue: TASK_QUEUE, workflowId: task.id,
      args: [{ taskId: task.id, projectId: project.id, title, prompt: '@review routed', base: 'main', target: 'main',
        project: { worldProvider: 'any', repos: [], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }] });
    const routed = async () => (await h.store.eventsSince(task.id, 0)).filter((event) => event.type === 'world.routed').map((event) => event.payload);
    return { taskId: task.id, handle, routed };
  }

  it('makes the world on the next provider when the first is full', async () => {
    hetzner.full = 'Hetzner refused a new server: the CPU limit is full';
    aws.full = undefined;
    const { taskId, handle, routed } = await start('Falls over');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    expect((await h.store.currentWorld(taskId))?.kind).toBe('aws');
    expect(await routed()).toEqual([expect.objectContaining({ provider: 'aws', funding: 'managed',
      reason: 'cheapest that fits; Hetzner was full',
      candidates: [expect.objectContaining({ provider: 'hetzner', outcome: 'full' }), expect.objectContaining({ provider: 'aws', outcome: 'chosen' })] })]);
    await handle.signal('cancel');
    await handle.result();
  }, 90_000);

  it('waits for a machine while every provider is full, and goes on once one has room', async () => {
    hetzner.full = 'Hetzner refused a new server: the CPU limit is full';
    aws.full = 'AWS refused an instance: VcpuLimitExceeded';
    const { taskId, handle, routed } = await start('Waits');
    await expect.poll(async () => (await view(handle)).waitingFor?.summary, { timeout: 30_000, interval: 200 }).toBe('Waiting for a machine');
    const waiting = await view(handle);
    expect(waiting).toMatchObject({ stage: 'setup', status: 'waiting', waitingFor: { kind: 'retry',
      detail: expect.stringMatching(/^Every computer this task can use is full \(.*VcpuLimitExceeded.*\)\. Waiting for one to free up\.$/) } });
    expect(waiting.waitingFor.detail).toContain('Hetzner refused a new server: the CPU limit is full');
    expect((await routed()).at(-1)).toMatchObject({ reason: waiting.waitingFor.detail });
    expect((await routed()).at(-1)?.provider).toBeUndefined();

    hetzner.full = undefined;
    await handle.signal('retry');
    await expect.poll(async () => (await view(handle)).stage, { timeout: 30_000 }).toBe('review');
    expect((await view(handle)).error).toBeUndefined();
    // Both were full a moment ago, so price decides again: Hetzner, which has room now.
    expect((await h.store.currentWorld(taskId))?.kind).toBe('hetzner');
    expect((await routed()).at(-1)).toMatchObject({ provider: 'hetzner', reason: 'cheapest that fits' });
    await handle.signal('cancel');
    await handle.result();
  }, 120_000);
});
