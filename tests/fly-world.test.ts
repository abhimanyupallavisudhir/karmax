import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderCapacityFull } from '../src/agent/limits.js';
import { FlyDriver, flyComputeDollarsPerSecond, flyGuest, machineRuns } from '../src/world/fly.js';
import { VmWorldProvider } from '../src/world/vm/provider.js';
import type { ResolvedWorldProviderConnection } from '../src/world/connections.js';
import type { WorldHandle } from '../src/world/types.js';
import { serviceHomeLabel } from '../src/world/services.js';
import { FakeFly } from './helpers/fake-fly.js';
import { sshdAvailable } from './helpers/local-sshd.js';

const connection = (token: string): ResolvedWorldProviderConnection => ({ organizationId: 'org_a', provider: 'fly', apiKey: token,
  config: { region: 'fra', organization: 'personal' } });

describe('Fly.io sizes and prices', () => {
  it('picks the smallest Fly guest that covers a Computer', () => {
    expect(flyGuest({ cpu: 2, memoryMb: 2048 })).toEqual({ cpu_kind: 'shared', cpus: 2, memory_mb: 2048 });
    expect(flyGuest({ cpu: 1, memoryMb: 3000 })).toEqual({ cpu_kind: 'shared', cpus: 2, memory_mb: 3072 });
    expect(flyGuest({ cpu: 4, memoryMb: 16_384 })).toEqual({ cpu_kind: 'shared', cpus: 8, memory_mb: 16_384 });
    expect(flyGuest({ cpu: 2, memoryMb: 32_768 })).toEqual({ cpu_kind: 'performance', cpus: 4, memory_mb: 32_768 });
    expect(() => flyGuest({ cpu: 32, memoryMb: 4096 })).toThrow(/at most 16 CPUs/);
  });

  it('prices a machine by Fly’s published formula', () => {
    // docs.fly.io/about/pricing: shared-cpu-2x with 2 GB is $13.39 per 30-day month in iad.
    expect(flyComputeDollarsPerSecond({ cpu_kind: 'shared', cpus: 2, memory_mb: 2048 }, 'iad') * 30 * 86_400).toBeCloseTo(13.39, 2);
  });

  it('reads billable runs from a machine’s event log, ignoring one still running', () => {
    expect(machineRuns([
      { type: 'launch', status: 'created', timestamp: 1 },
      { type: 'start', status: 'started', timestamp: 10 },
      { type: 'exit', status: 'stopped', timestamp: 70 },
      { type: 'start', status: 'started', timestamp: 100 },
    ])).toEqual([{ startedAt: 10, endedAt: 70 }]);
    // Deleted while running: that run ends then.
    expect(machineRuns([
      { type: 'start', status: 'started', timestamp: 10 },
      { type: 'exit', status: 'stopped', timestamp: 70 },
      { type: 'start', status: 'started', timestamp: 100 },
    ], 130)).toEqual([{ startedAt: 10, endedAt: 70 }, { startedAt: 100, endedAt: 130 }]);
  });

  it('refuses a disk larger than a Fly volume can be', () => {
    expect(() => new FlyDriver().shape({ diskGb: 600 })).toThrow(/at most 500 GB/);
    expect(new FlyDriver().shape(undefined)).toEqual({ cpu: 2, memoryMb: 2048, diskGb: 20 });
  });
});

describe.skipIf(!sshdAvailable)('Fly.io worlds (fake Machines API, real sshd)', () => {
  let fly: FakeFly;
  let provider: VmWorldProvider;
  let stamp: string;

  beforeEach(() => {
    fly = new FakeFly();
    stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-stamp-')), 'provisioned');
    provider = new VmWorldProvider(new FlyDriver(fly.fetch, 10, { image: async () => 'ghcr.io/owner/karmax-vm:v1' }), async () => connection(fly.token), undefined, {
      socket: fly.socket, user: os.userInfo().username, home: fly.home,
      provision: { stamp, script: `echo provisioned > ${stamp}`, sudo: false },
    });
  });
  afterEach(async () => { await fly.close(); });

  it('creates a world on its own app, volume and machine, labelled for the lifecycle sweep', async () => {
    const world = await provider.create({ taskId: 'task_fly', base: 'main', generation: 1, organizationId: 'org_a',
      resources: { cpu: 2, memoryMb: 4096, diskGb: 100 } });
    expect([...fly.apps.keys()]).toEqual([expect.stringMatching(new RegExp(`^kx-${serviceHomeLabel().slice(0, 10)}-[0-9a-f]{12}$`))]);
    expect([...fly.apps.values()][0]!.ips).toEqual(['shared_v4']);
    expect([...fly.volumes.values()].map((volume) => [volume.size_gb, volume.region])).toEqual([[100, 'fra']]);
    const machine = [...fly.machines.values()][0]!;
    expect(machine.config.guest).toEqual({ cpu_kind: 'shared', cpus: 2, memory_mb: 4096, persist_rootfs: 'always' });
    // The published image when there is one (a connection's own Advanced → Image wins).
    expect(machine.config.image).toBe('ghcr.io/owner/karmax-vm:v1');
    expect(machine.config.metadata).toMatchObject({ karmaxTaskId: 'task_fly', karmaxGeneration: '1', karmaxOrganizationId: 'org_a',
      karmaxHome: serviceHomeLabel() });
    expect(machine.config.services).toEqual([expect.objectContaining({ internal_port: 2222, ports: [{ port: 443, handlers: ['tls'] }] })]);
    // Provisioned once, then the world works over SSH.
    expect(fs.readFileSync(stamp, 'utf8')).toBe('provisioned\n');
    expect(world.handle).toMatchObject({ kind: 'fly', root: path.join(fly.home, 'karmax'), meta: { machine: { cpu: 2, memoryMb: 4096, diskGb: 100 } } });
    expect(world.handle.sealedProviderRef).not.toContain('PRIVATE KEY');
    expect((await world.exec('sh', ['-c', 'echo hi > note.txt; cat note.txt'])).stdout).toBe('hi\n');
  });

  it('parks to a stopped machine, wakes with every file — ignored ones too — and bills only the run', async () => {
    const world = await provider.create({ taskId: 'task_park', base: 'main', generation: 1, organizationId: 'org_a', resources: { diskGb: 100 } });
    await world.writeFile('node_modules/big/index.js', 'ignored but kept');
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    expect([...fly.machines.values()][0]!.state).toBe('stopped');
    expect(await provider.probe(handle)).toBe('parked');
    const woken = await provider.open(handle);
    expect(await woken.readFile('node_modules/big/index.js')).toBe('ignored but kept');
    expect(await provider.probe(handle)).toBe('ready');
    const usage = await provider.listUsageEvents('org_a');
    const runs = usage.events.filter((event) => event.kind !== 'disk');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ taskId: 'task_park', organizationId: 'org_a', cpu: 2, memoryMb: 2048 });
    expect(runs[0]!.costMicros).toBeGreaterThanOrEqual(0);
  });

  it('grows the disk in place and applies a new CPU and memory at the next start', async () => {
    const world = await provider.create({ taskId: 'task_grow', base: 'main', generation: 1, organizationId: 'org_a', resources: { diskGb: 100 } });
    await world.writeFile('data.bin', 'x'.repeat(1000));
    const handle = world.handle as WorldHandle;
    expect(await provider.resize(handle, { diskGb: 150, cpu: 4, memoryMb: 8192 }))
      .toEqual({ disk: 'grown', restart: true, machine: { cpu: 4, memoryMb: 8192, diskGb: 150 } });
    expect([...fly.volumes.values()][0]!.size_gb).toBe(150);
    // Never shrinks.
    expect(await provider.resize(handle, { diskGb: 120 })).toMatchObject({ disk: 'unchanged' });
    await provider.park(handle);
    const resized = { ...handle, meta: { ...handle.meta, computer: { cpu: 4, memoryMb: 8192, diskGb: 150 } } };
    const woken = await provider.open(resized);
    expect([...fly.machines.values()][0]!.config.guest).toMatchObject({ cpu_kind: 'shared', cpus: 4, memory_mb: 8192 });
    expect((await woken.readFile('data.bin')).length).toBe(1000);
  });

  it('lists its machines for the orphan reaper, and destroys a world with its volume', async () => {
    const world = await provider.create({ taskId: 'task_reap', base: 'main', generation: 1, organizationId: 'org_a' });
    const listed = await provider.listSandboxes('org_a');
    expect(listed).toEqual([expect.objectContaining({ taskId: 'task_reap' })]);
    expect(listed[0]!.matches!(world.handle)).toBe(true);
    await provider.destroy(world.handle as WorldHandle);
    expect(fly.apps.size).toBe(0);
    expect(fly.volumes.size).toBe(0);
    expect(await provider.probe(world.handle as WorldHandle)).toBe('missing');
    await expect(provider.open(world.handle as WorldHandle)).rejects.toMatchObject({ status: 404 });
  });

  it('waits out Fly answering 404 for a machine it has just created', async () => {
    fly.notFoundAfterCreate = 3;
    const world = await provider.create({ taskId: 'task_404', base: 'main', generation: 1, organizationId: 'org_a' });
    expect((await world.exec('sh', ['-c', 'echo ok'])).stdout).toBe('ok\n');
    expect(await provider.probe(world.handle as WorldHandle)).toBe('ready');
  });

  it('replaces a machine an interrupted create left behind instead of billing for two', async () => {
    await provider.create({ taskId: 'task_retry', base: 'main', generation: 1, organizationId: 'org_a' });
    await provider.create({ taskId: 'task_retry', base: 'main', generation: 1, organizationId: 'org_a' });
    expect(fly.apps.size).toBe(1);
  });

  it('deletes everything it made when provisioning fails', async () => {
    const failing = new VmWorldProvider(new FlyDriver(fly.fetch, 10), async () => connection(fly.token), undefined, {
      socket: fly.socket, user: os.userInfo().username, home: fly.home, provision: { stamp, script: 'echo broken >&2; exit 3', sudo: false } });
    await expect(failing.create({ taskId: 'task_fail', base: 'main', generation: 1 })).rejects.toThrow(/provisioning the Fly.io machine failed: the script exited with status 3:\nbroken/);
    expect(fly.apps.size).toBe(0);
  });

  // Fly allows an organization 50 machines unless billing@fly.io raises it, and a
  // region can be out of room: either is a full provider, so the task waits for a
  // machine or Any tries the next provider, instead of failing.
  it('says it is full when Fly refuses a machine for its organization\'s limit or a full region, and leaves nothing behind', async () => {
    for (const error of ['Your organization has reached its machine limit. Please contact billing@fly.io',
      'insufficient resources available to fulfill request: could not reserve resource for machine']) {
      fly.refuseMachines = { status: 422, error };
      const failure = await provider.create({ taskId: 'task_full', base: 'main', generation: 1 }).catch((value) => value);
      expect(failure).toBeInstanceOf(ProviderCapacityFull);
      expect(failure.message).toContain(error);
      expect(fly.apps.size).toBe(0);
    }
    fly.refuseMachines = { status: 422, error: 'invalid image' };
    expect(await provider.create({ taskId: 'task_bad', base: 'main', generation: 1 }).catch((value) => value)).not.toBeInstanceOf(ProviderCapacityFull);
  });

  it('refuses an organization on Fly’s free trial, which stops every machine after 5 minutes', async () => {
    fly.trial = true;
    await expect(provider.create({ taskId: 'task_trial', base: 'main', generation: 1 }))
      .rejects.toThrow(/free trial, which stops every machine after 5 minutes\. Add a payment method at https:\/\/fly.io\/dashboard\/personal\/billing/);
    await expect(new FlyDriver(fly.fetch, 10).test(connection(fly.token))).rejects.toThrow(/free trial/);
    expect(fly.apps.size).toBe(0);
    fly.trial = false;
    await new FlyDriver(fly.fetch, 10).test(connection(fly.token));
  });

  it('refuses an outbound allowlist and a desktop, which a VM cannot enforce or offer', async () => {
    await expect(provider.create({ taskId: 'task_net', base: 'main', network: { allowDomains: ['example.com'] } }))
      .rejects.toThrow(/unrestricted outbound network/);
    await expect(provider.create({ taskId: 'task_desk', base: 'main', environment: { flavor: 'desktop' } })).rejects.toThrow(/headless/);
    expect(fly.apps.size).toBe(0);
  });

  it('meters the volume by the hour, whatever the machine does', async () => {
    await provider.create({ taskId: 'task_disk', base: 'main', generation: 1, organizationId: 'org_a', resources: { diskGb: 100 } });
    const volume = [...fly.volumes.values()][0]!;
    volume.created_at = new Date(Date.now() - 3 * 3_600_000 - 60_000).toISOString();
    const disk = (await provider.listUsageEvents('org_a')).events.filter((event) => event.kind === 'disk');
    expect(disk).toHaveLength(3);
    // $0.15 per GB-month: 100 GB for an hour.
    expect(disk[0]).toMatchObject({ diskGb: 100, activeMs: 3_600_000, costMicros: Math.round(100 * 0.15 / 720 * 1e6) });
  });
});

// pramana#137 (2026-11-08): the lifecycle sweep, in the gateway, stopped a Fly
// world's machine in the same second a turn leased it; the worker had opened
// that world before and trusted its own memory, so every turn, review and
// checkpoint for 2.5 hours failed "could not reach the VM over SSH: Timed out
// while waiting for handshake" (Fly's edge takes the connection of a stopped
// machine and never answers). Whatever stops a machine, a caller who still
// uses its world gets it running again, and one nobody uses stays stopped.
describe.skipIf(!sshdAvailable)('Fly.io worlds whose machine stops or hangs under them', () => {
  let fly: FakeFly;
  let stamp: string;
  const vm = (extra: ConstructorParameters<typeof VmWorldProvider>[3] = {}) =>
    new VmWorldProvider(new FlyDriver(fly.fetch, 10, { image: async () => 'ghcr.io/owner/karmax-vm:v1' }), async () => connection(fly.token), undefined, {
      socket: fly.socket, user: os.userInfo().username, home: fly.home,
      provision: { stamp, script: `echo provisioned > ${stamp}`, sudo: false },
      connectTimeoutMs: 1_000, reconnectDelaysMs: [50, 50, 50], ...extra,
    });
  const machine = () => [...fly.machines.values()][0]!;
  const starts = () => fly.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/start')).length;

  beforeEach(() => {
    fly = new FakeFly();
    fly.silentEdge = true;
    stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-stamp-')), 'provisioned');
  });
  afterEach(async () => { await fly.close(); });

  it('starts a machine another process stopped, for a world opened before and for one opened after (pramana#137)', async () => {
    const worker = vm();
    const gateway = vm();
    const world = await worker.create({ taskId: 'task_137', base: 'main', generation: 1, organizationId: 'org_a' });
    const handle = world.handle as WorldHandle;
    await world.writeFile('kept.txt', 'on the volume');
    // The gateway's sweep stops it: the worker's connection dies with the machine.
    await gateway.stopStray(handle);
    expect(machine().state).toBe('stopped');
    // A world already in use carries on.
    expect((await world.exec('sh', ['-c', 'cat kept.txt'])).stdout).toBe('on the volume');
    expect(machine().state).toBe('started');
    // Stopped again; a new open asks the cloud instead of trusting what this process remembers.
    await gateway.stopStray(handle);
    const reopened = await worker.open(handle);
    expect((await reopened.exec('sh', ['-c', 'echo again'])).stdout).toBe('again\n');
    expect(machine().state).toBe('started');
  }, 60_000);

  it('starts the machine once for every caller that finds it stopped', async () => {
    const worker = vm();
    const world = await worker.create({ taskId: 'task_many', base: 'main', generation: 1, organizationId: 'org_a' });
    await vm().stopStray(world.handle as WorldHandle);
    const before = starts();
    const outputs = await Promise.all(Array.from({ length: 6 }, (_, index) => world.exec('sh', ['-c', `echo ${index}`])));
    expect(outputs.map((output) => output.stdout)).toEqual(['0\n', '1\n', '2\n', '3\n', '4\n', '5\n']);
    expect(starts() - before).toBe(1);
  }, 60_000);

  it('starts it inside the world\'s transition lock, and only for a world someone uses', async () => {
    const worker = vm();
    const world = await worker.create({ taskId: 'task_wanted', base: 'main', generation: 1, organizationId: 'org_a' });
    const transitions: string[] = [];
    let wanted = false;
    worker.coordinate({
      operation: async (worldId, work) => { transitions.push(worldId); return work(); },
      wanted: async () => wanted,
    });
    // Parked by someone else, and nobody holds it: a leftover caller must not wake it.
    await fly.stopOutOfBand(machine().id);
    await expect(world.exec('sh', ['-c', 'echo stray'])).rejects.toMatchObject({ name: 'WorldNotRunningError' });
    expect(machine().state).toBe('stopped');
    // A turn leases it: now it is wanted, and the next command starts it.
    wanted = true;
    expect((await world.exec('sh', ['-c', 'echo leased'])).stdout).toBe('leased\n');
    expect(machine().state).toBe('started');
    expect(transitions).toContain('task_wanted');
  }, 60_000);

  it('restarts a running machine that stops answering SSH', async () => {
    const worker = vm({ reachableMs: 1_500 });
    const world = await worker.create({ taskId: 'task_hung', base: 'main', generation: 1, organizationId: 'org_a' });
    await world.writeFile('kept.txt', 'still here');
    fly.deafen(machine().id);
    expect((await world.exec('sh', ['-c', 'cat kept.txt'])).stdout).toBe('still here');
    expect(machine().state).toBe('started');
    expect(fly.deaf.size).toBe(0);
  }, 60_000);

  it('says the machine is gone, so the world is recovered from its checkpoint, instead of timing out', async () => {
    const worker = vm();
    const world = await worker.create({ taskId: 'task_gone', base: 'main', generation: 1, organizationId: 'org_a' });
    await new FlyDriver(fly.fetch, 10).destroy(connection(fly.token), { app: machine().app });
    await expect(world.exec('true', [])).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/no longer exists/) });
  }, 60_000);

  it('never wakes a world this process parked', async () => {
    const worker = vm();
    const world = await worker.create({ taskId: 'task_parked', base: 'main', generation: 1, organizationId: 'org_a' });
    await worker.park(world.handle as WorldHandle);
    const before = starts();
    await expect(world.exec('true', [])).rejects.toThrow(/VM connection closed/);
    expect(machine().state).toBe('stopped');
    expect(starts()).toBe(before);
  }, 60_000);
});
