import { expect, it } from 'vitest';
import { bootHarness } from './helpers/harness.js';
import { liveEnabled } from './helpers/live-gate.js';
import { MockAdapter } from '../src/agent/mock.js';
import { E2BWorldProvider } from '../src/world/e2b.js';
import type { WorldHandle } from '../src/world/types.js';

/**
 * Sub-tasks on the machine their parent chose, live on E2B (pramana: every new
 * sub-task took 8 of 16 shared CPUs from the project's defaults, and could
 * only be shrunk at its next pause). A parent sized 2 CPU / 4 GB starts two
 * sub-tasks: one inherits its machine, one asks for 2 GB with create_sub_task's
 * `params.computer`. Each child's sandbox is measured from inside it.
 *
 * Opt in with KARMAX_RUN_LIVE=1 and E2B_API_KEY. A few cents of E2B credit.
 */
it.skipIf(!liveEnabled() || !process.env.E2B_API_KEY)('starts each sub-task on its parent\'s machine, or on the size it asks for', async () => {
  const provider = new E2BWorldProvider();
  const mock = new MockAdapter();
  const memory = new Map<string, number>();
  const handles: WorldHandle[] = [];
  const h = await bootHarness('mock', { provider: 'mock', async runTurn(input, ctx) {
    handles.push(input.world.handle);
    const read = await input.world.exec('bash', ['-c', "awk '/MemTotal/ { print $2 }' /proc/meminfo"]);
    memory.set(input.world.handle.id, Math.round(Number(read.stdout.trim()) / 1024));
    return mock.runTurn(input, ctx);
  } }, { checkpoints: true });
  h.worlds.register(provider);
  let parentId: string | undefined;
  let token: string | undefined;
  try {
    const project = (await h.store.createProject('Sub-task computers live', { worldProvider: 'e2b', repos: [] }));
    token = (await h.tokens.mintPrincipal('user:live', ['*'], project.id)).token;
    const parent = await h.api.createTask(token, { projectId: project.id, title: 'Parent', workflow: 'software-dev',
      prompt: '@subtask Like parent :: @write a.txt :: same machine\n'
        + '@subtaskwith {"computer":{"memoryMb":2048}} :: Smaller :: @write b.txt :: smaller machine\n@incomplete',
      params: { 'agent:do': { provider: 'mock' }, computer: { provider: 'e2b', cpu: 2, memoryMb: 4096 } } });
    parentId = parent.id;
    await expect.poll(async () => (await h.store.childTasks(parent.id)).length, { timeout: 240_000, interval: 2000 }).toBe(2);
    const children = await h.store.childTasks(parent.id);
    const like = children.find((child) => child.title === 'Like parent')!;
    const smaller = children.find((child) => child.title === 'Smaller')!;
    expect(like.params.computer).toEqual({ provider: 'e2b', cpu: 2, memoryMb: 4096 });
    expect(smaller.params.computer).toEqual({ provider: 'e2b', cpu: 2, memoryMb: 2048 });
    await expect.poll(() => memory.has(like.id) && memory.has(smaller.id), { timeout: 600_000, interval: 3000 }).toBe(true);
    const measured = { parent: memory.get(parent.id), like: memory.get(like.id), smaller: memory.get(smaller.id) };
    console.log(`SUBTASK-COMPUTER-LIVE ${JSON.stringify(measured)}`);
    // MiB the kernel reports: a little under the machine's size.
    expect(measured.like!).toBeGreaterThan(3_500);
    expect(measured.smaller!).toBeLessThan(2_100);
    expect(measured.parent!).toBeGreaterThan(3_500);
  } finally {
    if (parentId && token) await h.api.signalTask(token, parentId, 'cancel').catch(() => undefined);
    try { await h.stop(); }
    finally {
      const ids = new Set(handles.map((handle) => handle.id));
      for (const entry of await provider.listSandboxes()) if (entry.taskId && ids.has(entry.taskId)) await entry.destroy();
    }
  }
}, 900_000);
