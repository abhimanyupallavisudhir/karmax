import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { bootHarness } from './helpers/harness.js';
import { liveEnabled } from './helpers/live-gate.js';
import { MockAdapter } from '../src/agent/mock.js';
import { HetznerDriver } from '../src/world/hetzner.js';
import { VmWorldProvider } from '../src/world/vm/provider.js';
import { WorldLifecycleManager } from '../src/world/runners.js';
import type { ResolvedWorldProviderConnection } from '../src/world/connections.js';
import type { World, WorldHandle } from '../src/world/types.js';

/**
 * A full Hetzner limit, live (pramana: CPUs, volume space and public IPs ran
 * out one after another; each failed after ~20 min of retries and was retried
 * by hand dozens of times). A task asks for a disk larger than the project's
 * volume limit leaves room for: Hetzner refuses it at once (nothing is made,
 * nothing bills) and the task waits for a machine, saying why, instead of
 * failing. Given a disk that fits, Retry starts it at once; the task then
 * shows in what each task holds, and Free computer deletes its server and
 * volume.
 *
 * Opt in with KARMAX_RUN_LIVE=1 and HCLOUD_TOKEN. About €0.02 (one server hour,
 * a 20 GB volume for minutes). KARMAX_LIVE_HUGE_DISK_GB (default 10000) must
 * exceed the project's free volume space.
 */
it.skipIf(!liveEnabled() || !process.env.HCLOUD_TOKEN)('waits for room while Hetzner refuses, starts on Retry once it fits, and frees the computer on request', async () => {
  const previousHome = process.env.KARMAX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-live-capacity-'));
  process.env.KARMAX_HOME = home; // only this run's machines carry this home label
  const connection: ResolvedWorldProviderConnection = { provider: 'hetzner', apiKey: process.env.HCLOUD_TOKEN!,
    config: { region: process.env.KARMAX_HETZNER_LOCATION } };
  const provider = new VmWorldProvider(new HetznerDriver(), async () => connection);
  const mock = new MockAdapter();
  const worlds: World[] = [];
  const h = await bootHarness('mock', { provider: 'mock', async runTurn(input, ctx) {
    worlds.push(input.world);
    return mock.runTurn(input, ctx);
  } }, { checkpoints: true });
  h.worlds.register(provider);
  let taskId: string | undefined;
  let token: string | undefined;
  const started = Date.now();
  const at: Record<string, number> = {};
  const mark = (what: string) => { at[what] = Math.round((Date.now() - started) / 1000); };
  try {
    const project = (await h.store.createProject('Hetzner capacity live', { worldProvider: 'hetzner', repos: [] }));
    token = (await h.tokens.mintPrincipal('user:live', ['*'], project.id, undefined, project.organizationId)).token;
    const hugeDiskGb = Number(process.env.KARMAX_LIVE_HUGE_DISK_GB ?? 10_000);
    const task = await h.api.createTask(token, { projectId: project.id, title: 'Capacity live', workflow: 'software-dev',
      prompt: '@write result.txt :: started once there was room', params: { 'agent:do': { provider: 'mock' }, computer: { provider: 'hetzner', diskGb: hugeDiskGb } } });
    taskId = task.id;
    const handle = h.client.workflow.getHandle(task.id);
    const view = async () => (await handle.query<any>('view'));

    await expect.poll(async () => (await view()).waitingFor?.summary, { timeout: 5 * 60_000, interval: 2000 }).toBe('Waiting for a machine');
    mark('waiting for a machine');
    const waiting = await view();
    expect(waiting).toMatchObject({ stage: 'setup', status: 'waiting', waitingFor: { kind: 'retry' } });
    expect(waiting.waitingFor.detail).toMatch(/Hetzner refused .*volumes is full/);
    expect(waiting.waitingFor.until - Date.now()).toBeLessThanOrEqual(30_000);
    expect(await provider.listSandboxes()).toEqual([]); // nothing was made
    console.log(`CAPACITY-LIVE waiting: ${waiting.waitingFor.detail}`);

    // Room for a smaller disk: Retry starts it at once.
    await h.api.updateParams(token, task.id, { computer: { provider: 'hetzner', diskGb: 20 } });
    await handle.signal('retry');
    await expect.poll(async () => (await view()).stage, { timeout: 20 * 60_000, interval: 3000 }).toBe('review');
    mark('review');
    expect(await worlds[0]!.readFile('result.txt')).toContain('started once there was room');
    await expect.poll(async () => (await h.store.eventsOfType(task.id, 'world.parked')).length, { timeout: 10 * 60_000, interval: 3000 }).toBeGreaterThan(0);
    mark('parked');

    const { computers } = await h.api.listComputers(token, project.organizationId!);
    expect(computers).toEqual([expect.objectContaining({ taskId: task.id, provider: 'hetzner', state: 'parked', releasable: true })]);
    const lifecycle = new WorldLifecycleManager(h.store, h.worlds, h.checkpoints!);
    expect(await lifecycle.release(task.id)).toEqual({ state: 'hibernated' });
    mark('freed');
    expect(await provider.probe(worlds[0]!.handle as WorldHandle)).toBe('missing');
    expect((await h.api.listComputers(token, project.organizationId!)).computers).toEqual([]);
    console.log(`CAPACITY-LIVE ${JSON.stringify({ secondsSinceStart: at })}`);
  } finally {
    if (taskId && token) await h.api.signalTask(token, taskId, 'cancel').catch(() => undefined);
    try { await h.stop(); }
    finally {
      for (const entry of await provider.listSandboxes().catch(() => [])) await entry.destroy().catch(() => undefined);
      if (previousHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}, 45 * 60_000);
