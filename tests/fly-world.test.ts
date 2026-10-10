import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  });

  it('refuses a disk larger than a Fly volume can be', () => {
    expect(() => new FlyDriver().shape({ diskGb: 600 }, connection('x'))).toThrow(/at most 500 GB/);
    expect(new FlyDriver().shape(undefined, connection('x'))).toEqual({ cpu: 2, memoryMb: 2048, diskGb: 20 });
  });
});

describe.skipIf(!sshdAvailable)('Fly.io worlds (fake Machines API, real sshd)', () => {
  let fly: FakeFly;
  let provider: VmWorldProvider;
  let stamp: string;

  beforeEach(() => {
    fly = new FakeFly();
    stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-stamp-')), 'provisioned');
    provider = new VmWorldProvider(new FlyDriver(fly.fetch, 10), async () => connection(fly.token), undefined, {
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
      .toEqual({ disk: 'grown', restart: true, machine: { cpu: 2, memoryMb: 2048, diskGb: 150 } });
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

  it('replaces a machine an interrupted create left behind instead of billing for two', async () => {
    await provider.create({ taskId: 'task_retry', base: 'main', generation: 1, organizationId: 'org_a' });
    await provider.create({ taskId: 'task_retry', base: 'main', generation: 1, organizationId: 'org_a' });
    expect(fly.apps.size).toBe(1);
  });

  it('deletes everything it made when provisioning fails', async () => {
    const failing = new VmWorldProvider(new FlyDriver(fly.fetch, 10), async () => connection(fly.token), undefined, {
      socket: fly.socket, user: os.userInfo().username, home: fly.home, provision: { stamp, script: 'echo broken >&2; exit 3', sudo: false } });
    await expect(failing.create({ taskId: 'task_fail', base: 'main', generation: 1 })).rejects.toThrow(/provisioning the Fly.io machine failed \(status 3\)[\s\S]*broken/);
    expect(fly.apps.size).toBe(0);
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
