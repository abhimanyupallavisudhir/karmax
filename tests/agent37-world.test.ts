import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderCapacityFull } from '../src/agent/limits.js';
import { Agent37Driver, agent37AccessKey, agent37BootScript, agent37ComputeDollarsPerHour, agent37Shape } from '../src/world/agent37.js';
import { VmWorldProvider } from '../src/world/vm/provider.js';
import { listPriceMicrosPerHour, diskGrowsAtStart } from '../src/domain/computer-limits.js';
import type { ResolvedWorldProviderConnection } from '../src/world/connections.js';
import type { ProviderUsageEvent, WorldHandle } from '../src/world/types.js';
import { serviceHomeLabel } from '../src/world/services.js';
import { FakeAgent37 } from './helpers/fake-agent37.js';
import { sshdAvailable } from './helpers/local-sshd.js';

const connection = (token: string, region?: string): ResolvedWorldProviderConnection => ({ organizationId: 'org_a', provider: 'agent37', apiKey: token,
  config: region ? { region } : {} });

describe('Agent37 sizes, prices and keys', () => {
  it('gives a Computer the smallest of Agent37’s four shapes that covers it', () => {
    expect(agent37Shape(undefined)).toEqual({ cpu: 2, memory: 4 });
    expect(agent37Shape({ cpu: 2, memoryMb: 2048 })).toEqual({ cpu: 2, memory: 4 });
    expect(agent37Shape({ cpu: 1, memoryMb: 6000 })).toEqual({ cpu: 4, memory: 8 });
    expect(agent37Shape({ cpu: 4, memoryMb: 16_384 })).toEqual({ cpu: 4, memory: 16 });
    expect(agent37Shape({ cpu: 2, memoryMb: 20_000 })).toEqual({ cpu: 4, memory: 32 });
    expect(() => agent37Shape({ cpu: 8, memoryMb: 4096 })).toThrow(/at most 4 CPUs and 32 GB/);
    expect(() => agent37Shape({ cpu: 4, memoryMb: 65_536 })).toThrow(/at most 4 CPUs and 32 GB/);
    expect(new Agent37Driver().shape(undefined)).toEqual({ cpu: 2, memoryMb: 4096, diskGb: 20 });
    expect(() => new Agent37Driver().shape({ diskGb: 150 })).toThrow(/at most 100 GB/);
  });

  it('prices a vm at 2.5× Agent37’s published default rate, the same in the router', () => {
    // agent37.com/docs/agents-api/vm-instances: a 2 vCPU / 4 GB vm is $11.36 a month with 4 GB of disk.
    expect(agent37ComputeDollarsPerHour({ cpu: 2, memoryMb: 4096 }) * 730 + 4 * 0.09).toBeCloseTo(11.36, 2);
    expect(listPriceMicrosPerHour('agent37', { cpu: 2, memoryMb: 4096, diskGb: 0 }))
      .toBe(Math.round(agent37ComputeDollarsPerHour({ cpu: 2, memoryMb: 4096 }) * 1e6));
    expect(diskGrowsAtStart('agent37')).toBe(true);
    expect(diskGrowsAtStart('fly')).toBe(false);
  });

  it('derives one tunnel key per workspace from its API key, with nothing stored', () => {
    const a = agent37AccessKey('sk_live_a');
    expect(agent37AccessKey('sk_live_a').publicKey).toBe(a.publicKey);
    expect(agent37AccessKey(' sk_live_a\n').publicKey).toBe(a.publicKey);
    expect(agent37AccessKey('sk_live_b').publicKey).not.toBe(a.publicKey);
    expect(a.publicKey).toMatch(/^ssh-ed25519 AAAA\S+ tavya$/);
  });

  it('boots karmax’s own sshd, gives the VM user Docker and checks sshd answers', () => {
    const script = agent37BootScript({ hostPrivateKey: 'HOST', authorizedKey: 'ssh-ed25519 AAAA world' });
    expect(script).toContain('sh /var/lib/cloud/scripts/per-boot/karmax-boot.sh');
    expect(script).toContain('usermod -aG docker user');
    expect(script).toContain(":2222 '");
    expect(script).toContain(Buffer.from('HOST').toString('base64'));
  });
});

describe.skipIf(!sshdAvailable)('Agent37 worlds (fake Sandbox API, real tunnel and sshd)', () => {
  let agent37: FakeAgent37;
  let provider: VmWorldProvider;
  let stamp: string;

  beforeEach(async () => {
    agent37 = await new FakeAgent37().start();
    stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-stamp-')), 'provisioned');
    provider = new VmWorldProvider(new Agent37Driver(agent37.options()), async () => connection(agent37.token), undefined, {
      user: os.userInfo().username, home: agent37.home, reconnectDelaysMs: [10, 10], connectTimeoutMs: 5_000,
      provision: { stamp, script: `echo provisioned > ${stamp}`, sudo: false },
    });
  });
  afterEach(async () => { await agent37.close(); });

  it('creates a world on a vm with its disk as the home, reached through the workspace’s tunnel', async () => {
    const world = await provider.create({ taskId: 'task_a37', base: 'main', generation: 1, organizationId: 'org_a',
      resources: { cpu: 2, memoryMb: 2048, diskGb: 30 } });
    const [instance] = [...agent37.instances.values()];
    expect(instance).toMatchObject({ type: 'vm', template: 'agent37-ubuntu', region: 'eu', mount_path: '/home/user',
      resources: { cpu: 2, memory: 4, disk: 30 }, env: { AGENT37_DOCKER_DATA: '/home/user/.karmax-docker' } });
    expect(instance!.name).toMatch(new RegExp(`^kx-${serviceHomeLabel().slice(0, 10)}-[0-9a-f]{12}$`));
    expect(instance!.metadata).toMatchObject({ karmaxTaskId: 'task_a37', karmaxGeneration: '1', karmaxOrganizationId: 'org_a',
      karmaxHome: serviceHomeLabel() });
    expect(agent37.requests.find((request) => request.method === 'POST' && request.path === '/instances')!.body.auto_sleep).toBe(false);
    // One workspace key, registered once; the world's own key is karmax's sshd's.
    expect([...agent37.keys.values()].map((key) => key.public_key)).toEqual([agent37AccessKey(agent37.token).publicKey]);
    expect(agent37.boots()).toBe(1);
    expect(fs.readFileSync(stamp, 'utf8')).toBe('provisioned\n');
    expect(world.handle).toMatchObject({ kind: 'agent37', meta: { machine: { cpu: 2, memoryMb: 4096, diskGb: 30 } } });
    expect(world.handle.sealedProviderRef).not.toContain('PRIVATE KEY');
    expect((await world.exec('sh', ['-c', 'echo hi > note.txt; cat note.txt'])).stdout).toBe('hi\n');
    // A second world registers nothing more.
    await provider.create({ taskId: 'task_a37b', base: 'main', generation: 1, organizationId: 'org_a' });
    expect(agent37.keys.size).toBe(1);
  });

  it('parks to a stopped instance and wakes it with every file, booting karmax’s sshd again', async () => {
    const world = await provider.create({ taskId: 'task_park', base: 'main', generation: 1, organizationId: 'org_a' });
    await world.writeFile('node_modules/big/index.js', 'ignored but kept');
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    expect([...agent37.instances.values()][0]!.status).toBe('stopped');
    expect(await provider.probe(handle)).toBe('parked');
    const woken = await provider.open(handle);
    expect(agent37.boots()).toBe(2);
    expect(await woken.readFile('node_modules/big/index.js')).toBe('ignored but kept');
    expect(await provider.probe(handle)).toBe('ready');
  });

  it('grows the disk and applies a new size at the next start, never under a running agent', async () => {
    const world = await provider.create({ taskId: 'task_grow', base: 'main', generation: 1, organizationId: 'org_a', resources: { diskGb: 20 } });
    await world.writeFile('data.bin', 'x'.repeat(1000));
    const handle = world.handle as WorldHandle;
    const grown = await provider.resize(handle, { cpu: 2, memoryMb: 4096, diskGb: 40 });
    expect(grown).toEqual({ disk: 'unchanged', restart: true, machine: { cpu: 2, memoryMb: 4096, diskGb: 40 } });
    // Nothing touched the running machine.
    expect(agent37.requests.some((request) => request.path.endsWith('/resize'))).toBe(false);
    expect((await world.exec('true', [])).code).toBe(0);
    await provider.park(handle);
    const resized = { ...handle, meta: { ...handle.meta, machine: grown.machine, computer: { cpu: 4, memoryMb: 8192, diskGb: 40 } } };
    const woken = await provider.open(resized);
    expect(agent37.requests.filter((request) => request.path.endsWith('/resize')).map((request) => request.body))
      .toEqual([{ cpu: 4, memory: 8, disk: 40 }]);
    expect([...agent37.instances.values()][0]!.resources).toEqual({ cpu: 4, memory: 8, disk: 40 });
    expect((await woken.readFile('data.bin')).length).toBe(1000);
  });

  it('starts karmax’s sshd again when the machine booted without it (Agent37 moved or rebooted it)', async () => {
    const world = await provider.create({ taskId: 'task_moved', base: 'main', generation: 1, organizationId: 'org_a' });
    const handle = world.handle as WorldHandle;
    const fresh = new VmWorldProvider(new Agent37Driver(agent37.options()), async () => connection(agent37.token), undefined, {
      user: os.userInfo().username, home: agent37.home, reconnectDelaysMs: [10, 10], connectTimeoutMs: 5_000,
      provision: { stamp, script: 'true', sudo: false },
    });
    agent37.killMachineSshd();
    const reopened = await fresh.open(handle);
    expect((await reopened.exec('echo', ['back'])).stdout).toBe('back\n');
    expect(agent37.boots()).toBe(1); // the restart command, not a second full boot
  });

  it('reconnects when the tunnel drops under a working world, instead of waiting on it for ever', async () => {
    const world = await provider.create({ taskId: 'task_drop', base: 'main', generation: 1, organizationId: 'org_a' });
    expect((await world.exec('echo', ['one'])).stdout).toBe('one\n');
    const before = agent37.tunnels;
    agent37.dropTunnels();
    const again = await Promise.race([world.exec('echo', ['two']),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('the world never noticed its tunnel was gone')), 20_000))]);
    expect(again.stdout).toBe('two\n');
    expect(agent37.tunnels).toBeGreaterThan(before);
  });

  it('lists its instances for the orphan reaper and destroys a world with its disk', async () => {
    const world = await provider.create({ taskId: 'task_list', base: 'main', generation: 1, organizationId: 'org_a' });
    const listed = await provider.listSandboxes('org_a');
    expect(listed.map((entry) => entry.taskId)).toEqual(['task_list']);
    expect(listed[0]!.matches?.(world.handle)).toBe(true);
    await provider.destroy(world.handle as WorldHandle);
    expect([...agent37.instances.values()][0]!.status).toBe('deleted');
    expect(await provider.listSandboxes('org_a')).toEqual([]);
  });

  it('says it is full when Agent37 has no room or the workspace’s memory limit is reached, leaving nothing behind', async () => {
    agent37.refuseCreate = { status: 503, code: 'no_capacity', message: 'no host in eu has room' };
    await expect(provider.create({ taskId: 'task_full', base: 'main', generation: 1, organizationId: 'org_a' }))
      .rejects.toBeInstanceOf(ProviderCapacityFull);
    agent37.refuseCreate = { status: 409, code: 'instance_limit_reached', message: 'memory limit 40 GB' };
    await expect(provider.create({ taskId: 'task_full', base: 'main', generation: 1, organizationId: 'org_a' }))
      .rejects.toThrow(/as much memory as its top-ups allow/);
    expect(agent37.instances.size).toBe(0);
  });

  it('deletes the instance when booting it fails', async () => {
    const driver = new Agent37Driver({ ...agent37.options(), bootScript: () => 'echo no sshd here >&2; exit 3' });
    const failing = new VmWorldProvider(driver, async () => connection(agent37.token), undefined, {
      user: os.userInfo().username, home: agent37.home, provision: { stamp, script: 'true', sudo: false } });
    await expect(failing.create({ taskId: 'task_boot', base: 'main', generation: 1, organizationId: 'org_a' }))
      .rejects.toThrow(/booting the Agent37 machine failed \(status 1\): no sshd here/);
    expect([...agent37.instances.values()].map((instance) => instance.status)).toEqual(['deleted']);
  });

  it('refuses a tunnel with a key Agent37 does not know', async () => {
    const world = await provider.create({ taskId: 'task_key', base: 'main', generation: 1, organizationId: 'org_a' });
    const stranger = new VmWorldProvider(new Agent37Driver(agent37.options()), async () => connection('sk_live_other'), undefined, {
      user: os.userInfo().username, home: agent37.home, reconnectDelaysMs: [10], connectTimeoutMs: 2_000, reachableMs: 1_000,
      provision: { stamp, script: 'true', sudo: false } });
    await expect(stranger.open(world.handle as WorldHandle)).rejects.toThrow();
  });

  it('books each instance-day Agent37 charged as compute at its rate and the rest as disk, to its task', async () => {
    const kept = new Map<string, string>();
    const ledger = { kvEntries: async (prefix: string) => [...kept].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      kvSet: (key: string, value: string) => { kept.set(key, value); }, kvDelete: (key: string) => { kept.delete(key); } };
    const booked = new VmWorldProvider(new Agent37Driver(agent37.options()), async () => connection(agent37.token), undefined, {
      user: os.userInfo().username, home: agent37.home, provision: { stamp, script: 'true', sudo: false }, ledger });
    const world = await booked.create({ taskId: 'task_bill', base: 'main', generation: 1, organizationId: 'org_a' });
    const id = [...agent37.instances.keys()][0]!;
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    // 60 awake minutes of a 2/4 vm, plus a day of its 20 GB disk.
    const compute = Math.round(agent37ComputeDollarsPerHour({ cpu: 2, memoryMb: 4096 }) * 1e6);
    agent37.usage.set(day(2), [{ id, compute_micros: compute + 2_466, awake_minutes: 60 }, { id: 'someone-else', compute_micros: 9, awake_minutes: 1 }]);
    agent37.usage.set(day(0), [{ id, compute_micros: 500, awake_minutes: 5 }]);
    // A day is booked once Agent37 has settled it (two hours after it ended): not today.
    expect((await booked.listUsageEvents('org_a')).events).toEqual([
      expect.objectContaining({ id: `${id}:${day(2)}`, taskId: 'task_bill', organizationId: 'org_a', activeMs: 3_600_000, cpu: 2, memoryMb: 4096, costMicros: compute }),
      expect.objectContaining({ id: `${id}:${day(2)}:disk`, kind: 'disk', diskGb: 20, costMicros: 2_466 }),
    ]);
    // Deleting it takes it out of the instance list, and its owner with it: what
    // it used today is read just before and kept for the feed.
    await booked.destroy(world.handle as WorldHandle);
    expect((await booked.listUsageEvents('org_a')).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `${id}:${day(0)}`, taskId: 'task_bill', activeMs: 300_000, costMicros: 500 }),
    ]));
  });

  it('books what Agent37 settles after a delete once that day is settled, also for a world it had settled nothing of', async () => {
    const kept = new Map<string, string>();
    const ledger = { kvEntries: async (prefix: string) => [...kept].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      kvSet: (key: string, value: string) => { kept.set(key, value); }, kvDelete: (key: string) => { kept.delete(key); } };
    const booked = new VmWorldProvider(new Agent37Driver(agent37.options()), async () => connection(agent37.token), undefined, {
      user: os.userInfo().username, home: agent37.home, provision: { stamp, script: 'true', sudo: false }, ledger });
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const rate = agent37ComputeDollarsPerHour({ cpu: 2, memoryMb: 4096 });
    const micros = (minutes: number) => Math.round(minutes / 60 * rate * 1e6);
    // Two worlds deleted today: Agent37 had settled 5 awake minutes of the first, nothing of the second.
    const first = await booked.create({ taskId: 'task_rest', base: 'main', generation: 1, organizationId: 'org_a' });
    const a = [...agent37.instances.keys()].at(-1)!;
    const second = await booked.create({ taskId: 'task_none', base: 'main', generation: 1, organizationId: 'org_b' });
    const b = [...agent37.instances.keys()].at(-1)!;
    agent37.usage.set(day(0), [{ id: a, compute_micros: micros(5), awake_minutes: 5 }]);
    await booked.destroy(first.handle as WorldHandle);
    await booked.destroy(second.handle as WorldHandle);
    const today = (await booked.listUsageEvents('org_a')).events;
    expect(today.map((event) => event.id)).toEqual([`${a}:${day(0)}`]);
    // Two days later (the deletes' records moved back): Agent37 has settled the
    // whole day, 8 and 3 awake minutes and their disks. The rest is booked once,
    // as rows of their own, and the day before the delete (booked whole while
    // the instance was listed) is not booked again.
    const shift = 2 * 86_400_000;
    for (const [key, value] of kept) {
      const entry = JSON.parse(value) as { at: number; events: ProviderUsageEvent[] };
      kept.set(key, JSON.stringify({ at: entry.at - shift, events: entry.events.map((event) => ({ ...event,
        id: event.id.replace(day(0), day(2)), startedAt: event.startedAt - shift, endedAt: event.endedAt - shift })) }));
    }
    agent37.usage.set(day(2), [{ id: a, compute_micros: micros(8) + 3_000, awake_minutes: 8 }, { id: b, compute_micros: micros(3) + 1_000, awake_minutes: 3 }]);
    agent37.usage.set(day(4), [{ id: a, compute_micros: 777, awake_minutes: 1 }]);
    const later = (await booked.listUsageEvents('org_a')).events;
    expect(later).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `${a}:${day(2)}`, costMicros: micros(5) }),
      expect.objectContaining({ id: `${a}:${day(2)}:rest`, taskId: 'task_rest', organizationId: 'org_a', activeMs: 180_000, costMicros: micros(8) - micros(5) }),
      expect.objectContaining({ id: `${a}:${day(2)}:disk:rest`, kind: 'disk', diskGb: 20, costMicros: 3_000 }),
    ]));
    expect(later).toHaveLength(3);
    expect(later.some((event) => event.record || event.id.includes(day(4)))).toBe(false);
    // Each organization's deleted worlds are read with its own feed.
    expect((await booked.listUsageEvents('org_b')).events).toEqual([
      expect.objectContaining({ id: `${b}:${day(2)}:rest`, taskId: 'task_none', organizationId: 'org_b', activeMs: 180_000, costMicros: micros(3) }),
      expect.objectContaining({ id: `${b}:${day(2)}:disk:rest`, kind: 'disk', costMicros: 1_000 }),
    ]);
  });

  it('checks a connection without making anything, and says when the wallet is empty', async () => {
    const driver = new Agent37Driver(agent37.options());
    await driver.test(connection(agent37.token));
    expect(agent37.instances.size).toBe(0);
    // Agent37's memory limit (40 GB once topped up) as machines of its smallest shape.
    expect(await driver.limits(connection(agent37.token))).toMatchObject({ cpu: 4, memoryMb: 32_768, diskGb: 100, pool: { machines: 10 } });
    agent37.balance = 0;
    await expect(driver.test(connection(agent37.token))).rejects.toThrow(/no balance/);
    await expect(driver.test(connection('sk_live_wrong'))).rejects.toThrow(/401/);
  });
});
