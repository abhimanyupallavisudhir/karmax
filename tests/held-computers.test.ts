import { expect, it, vi } from 'vitest';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';

// Provider limits filled up (Hetzner CPUs, volumes, IPs) with nothing showing
// which task held what: one list of every task's machine and disk, and a way
// to free one, for people and agents alike.
it('lists what each task holds at its providers and frees one on request', async () => {
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Held');
    const other = await store.createProject('Unreadable');
    const make = async (projectId: string, title: string, status: string, state: 'ready' | 'parked' | 'hibernated') => {
      const task = await store.createTask({ projectId, title, workflow: 'software-dev', workflowVersion: '1.26.0', params: { prompt: title } as any });
      await store.saveView(task.id, { taskId: task.id, title, workflow: 'software-dev', stage: 'do', status, messages: [], actions: [] } as any);
      const handle = await store.registerWorld({ kind: 'hetzner', id: task.id, root: '/home/user/karmax', branch: 'b', base: 'main',
        meta: { computer: { cpu: 8, memoryMb: 16384, diskGb: 100 } } } as any, projectId);
      await store.setWorldState(handle, state);
      return task;
    };
    const running = await make(project.id, 'Running', 'active', 'ready');
    const cancelled = await make(project.id, 'Cancelled', 'cancelled', 'parked');
    await make(project.id, 'Hibernated', 'cancelled', 'hibernated');
    await make(other.id, 'Elsewhere', 'waiting', 'parked');
    const tokens = new TokenAuthority(store);
    const token = (await tokens.mintPrincipal('user:dev', ['task:read', 'task:edit'], project.id, undefined, project.organizationId)).token;
    const release = vi.fn(async () => ({ state: 'hibernated' as const }));
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens, worldLifecycle: { release } });

    const { computers } = await api.listComputers(token, project.organizationId!);
    expect(computers.map((computer) => computer.title).sort()).toEqual(['Cancelled', 'Running']);
    expect(computers.find((computer) => computer.taskId === cancelled.id)).toMatchObject({
      provider: 'hetzner', state: 'parked', taskStatus: 'cancelled', projectName: 'Held',
      machine: { cpu: 8, memoryMb: 16384, diskGb: 100 }, releasable: true });
    expect(computers.find((computer) => computer.taskId === running.id)).toMatchObject({ state: 'ready', releasable: false });

    expect(await api.releaseComputer(token, cancelled.id)).toEqual({ state: 'hibernated' });
    expect(release).toHaveBeenCalledWith(cancelled.id);
    release.mockRejectedValueOnce(new Error('the task is working; stop it or wait until it pauses'));
    await expect(api.releaseComputer(token, running.id)).rejects.toThrow(/working/);
    const reader = (await tokens.mintPrincipal('user:viewer', ['task:read'], project.id, undefined, project.organizationId)).token;
    await expect(api.releaseComputer(reader, cancelled.id)).rejects.toThrow(/task:edit/);
    expect((await api.listComputers(reader, project.organizationId!)).computers.every((computer) => !computer.releasable)).toBe(true);
  } finally { await store.close(); }
});
