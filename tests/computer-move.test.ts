import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldLifecycleManager } from '../src/world/runners.js';
import { WorldCheckpointService } from '../src/world/checkpoint.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { assertInFlightComputerEdit } from '../src/domain/computer.js';

/**
 * Moving a running task to another cloud provider (pramana#22: from a 29 GB
 * E2B sandbox to a Hetzner volume). It is a resize across providers: at the
 * task's next idle park the world hibernates to its portable checkpoint, and
 * the wake restores that checkpoint where the task's own Computer now says.
 */
describe('moving a running task to another provider', () => {
  it('lets a running task change provider between cloud providers, keeping what it relies on', () => {
    expect(() => assertInFlightComputerEdit({ provider: 'e2b' }, { provider: 'hetzner', diskGb: 100 })).not.toThrow();
    expect(() => assertInFlightComputerEdit({ provider: 'e2b', flavor: 'desktop' }, { provider: 'hetzner' }))
      .toThrow(/Hetzner has no desktop/);
    expect(() => assertInFlightComputerEdit({ provider: 'e2b', network: { unrestricted: false, allowDomains: ['pypi.org'] } },
      { provider: 'fly' })).toThrow(/Fly\.io has no outbound allowlist/);
    expect(() => assertInFlightComputerEdit({ provider: 'e2b' }, { provider: 'worktree' })).toThrow(/between cloud providers/);
    // Experience and network still never change in flight.
    expect(() => assertInFlightComputerEdit({ provider: 'e2b' }, { flavor: 'desktop' })).toThrow(/experience/);
  });

  it('hibernates a parked world at once when its task asks for another provider', async () => {
    const store = await Store.create(':memory:');
    const project = await store.createProject('Move', { resources: { cpu: 2, memoryMb: 2048 } });
    const worlds = new WorldRegistry();
    const task = await store.createTask({ projectId: project.id, title: 'Big data', workflow: 'software-dev',
      workflowVersion: '1.27.0', params: { prompt: 'x' } });
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    world.handle.meta = { projectId: project.id, computer: { cpu: 2, memoryMb: 2048 } };
    world.handle = (await store.registerWorld(world.handle, project.id)) as typeof world.handle;
    await store.saveWorldCheckpoint({ id: 'checkpoint-m', worldId: world.handle.id, generation: 1, projectId: project.id,
      runnerPoolId: 'local', environmentDigest: 'test', repos: [], createdAt: Date.now() });
    await store.setWorldState(world.handle, 'parked');
    const lifecycle = new WorldLifecycleManager(store, worlds, { addNotice: async () => undefined } as any, 1_000);
    expect(await lifecycle.sweep(Date.now() + 1)).toBe(0);
    // Only the task's own choice moves it: an organization default never does.
    await store.patchTaskParams(task.id, { computer: { provider: 'hetzner' } });
    expect(await lifecycle.sweep(Date.now() + 1)).toBe(1);
    expect(await store.worldState(world.handle.id)).toBe('hibernated');
    expect((await store.eventsOfType(task.id, 'world.hibernated')).at(-1)?.payload).toMatchObject({ move: { from: 'memory', to: 'hetzner' } });
  });

  async function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-move-'));
    const store = await Store.create(':memory:');
    const project = await store.createProject('Move');
    const task = await store.createTask({ projectId: project.id, title: 'Big data', workflow: 'software-dev',
      workflowVersion: '1.27.0', params: { prompt: 'x', computer: { provider: 'hetzner', diskGb: 100 } } });
    const service = new WorldCheckpointService(store, new WorldRegistry(), new LocalObjectStore(path.join(dir, 'objects')),
      new CredentialBroker(new Vault(dir)));
    const handle = { version: 2, kind: 'e2b', provider: 'e2b', id: task.id, root: '/home/user/karmax', workspaceRoot: '/home/user/karmax',
      branch: `tavya/${task.id}`, base: 'main', meta: { projectId: project.id } } as any;
    const restored: string[] = [];
    const notices: string[] = [];
    (service as any).addNotice = async (_id: string, text: string) => { notices.push(text); };
    return { store, task, service, handle, restored, notices };
  }

  it('restores a hibernated world where its task now runs, and says so', async () => {
    const { store, task, service, handle, restored, notices } = await fixture();
    (service as any).restore = async (_id: string, kind: string) => { restored.push(kind); return { ...handle, kind, provider: kind }; };
    const result = await service.restoreWhereTaskRuns('checkpoint-1', handle);
    expect(result.kind).toBe('hetzner');
    expect(restored).toEqual(['hetzner']);
    expect((await store.eventsOfType(task.id, 'world.moved')).at(-1)?.payload).toMatchObject({ from: 'e2b', to: 'hetzner' });
    expect(notices).toEqual([expect.stringMatching(/moved to Hetzner/)]);
  });

  it('stays on its old provider when the new one cannot take it, and the task goes back to it', async () => {
    const { store, task, service, handle, restored, notices } = await fixture();
    (service as any).restore = async (_id: string, kind: string) => {
      restored.push(kind);
      if (kind === 'hetzner') throw new Error('server limit reached');
      return { ...handle, kind, provider: kind };
    };
    const result = await service.restoreWhereTaskRuns('checkpoint-1', handle);
    expect(result.kind).toBe('e2b');
    expect(restored).toEqual(['hetzner', 'e2b']);
    // No loop: the next park does not try again until someone asks again.
    expect((await store.getTask(task.id))!.params.computer).toEqual({ provider: 'e2b', diskGb: 100 });
    expect((await store.eventsOfType(task.id, 'world.move_failed')).at(-1)?.payload)
      .toMatchObject({ from: 'e2b', to: 'hetzner', error: 'server limit reached' });
    expect(notices).toEqual([expect.stringMatching(/could not move to Hetzner.*server limit reached/s)]);
  });

  it('restores on the same provider when the task asks for no other', async () => {
    const { store, task, service, handle, restored } = await fixture();
    await store.patchTaskParams(task.id, { computer: { diskGb: 100 } });
    (service as any).restore = async (_id: string, kind: string) => { restored.push(kind); return { ...handle, kind }; };
    await service.restoreWhereTaskRuns('checkpoint-1', handle);
    expect(restored).toEqual(['e2b']);
  });
});
