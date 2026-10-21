import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloudInit, HetznerDriver, paidMsLeft } from '../src/world/hetzner.js';
import { isTransportError, ProviderCapacityFull, ProviderOutage } from '../src/agent/limits.js';
import { VmWorldProvider } from '../src/world/vm/provider.js';
import type { ResolvedWorldProviderConnection } from '../src/world/connections.js';
import type { WorldHandle } from '../src/world/types.js';
import { FakeHetzner } from './helpers/fake-hetzner.js';
import { sshdAvailable } from './helpers/local-sshd.js';

const connection = (token: string): ResolvedWorldProviderConnection => ({ organizationId: 'org_h', provider: 'hetzner', apiKey: token,
  config: { region: 'fsn1' } });

describe('Hetzner sizes, hours and cloud-init', () => {
  let hetzner: FakeHetzner;
  beforeAll(() => { hetzner = new FakeHetzner(); });
  afterAll(async () => { await hetzner.close(); });

  it('picks the cheapest current x86 server type that covers a Computer', async () => {
    const driver = new HetznerDriver(hetzner.fetch, 1);
    // cx11 is deprecated and cax11 is ARM (no Google Chrome build): cx22 it is.
    expect(await driver.shape(undefined, connection(hetzner.token))).toEqual({ cpu: 2, memoryMb: 4096, diskGb: 20 });
    expect(await driver.shape({ cpu: 3, memoryMb: 6000, diskGb: 100 }, connection(hetzner.token))).toEqual({ cpu: 4, memoryMb: 8192, diskGb: 100 });
    // A volume is at least 10 GB.
    expect((await driver.shape({ diskGb: 5 }, connection(hetzner.token))).diskGb).toBe(10);
    await expect(driver.shape({ cpu: 64 }, connection(hetzner.token))).rejects.toThrow(/no server at fsn1 with 64 CPU/);
    await expect(driver.shape({ diskGb: 20_000 }, connection(hetzner.token))).rejects.toThrow(/at most 10240 GB/);
  });

  it('tells the limits record the largest machine its location offers, and a 10 TB volume', async () => {
    const { computerLimits } = await import('../src/domain/computer-limits.js');
    const measured = await new HetznerDriver(hetzner.fetch, 1).limits(connection(hetzner.token));
    expect(measured).toMatchObject({ cpu: 4, memoryMb: 8192, diskGb: 10_240 });
    expect(computerLimits('hetzner', measured)).toMatchObject({ cpu: 4, memoryMb: 8192, diskGb: 10_240,
      source: { cpu: 'provider', memoryMb: 'provider', diskGb: 'provider' } });
    // Fly's limits are fixed by Fly, not by the account.
    expect(computerLimits('fly')).toMatchObject({ cpu: 16, memoryMb: 131_072, diskGb: 500, source: { diskGb: 'default' } });
  });

  it('counts a server’s paid hour from its creation', () => {
    const created = Date.parse('2026-10-10T10:00:00Z');
    expect(paidMsLeft({ created: '2026-10-10T10:00:00Z' }, created + 10 * 60_000)).toBe(50 * 60_000);
    expect(paidMsLeft({ created: '2026-10-10T10:00:00Z' }, created + 70 * 60_000)).toBe(50 * 60_000);
  });

  it('delivers the keys, the volume device and the boot script through cloud-init', () => {
    const data = cloudInit({ hostPrivateKey: 'HOST', authorizedKey: 'ssh-ed25519 AAAA world' }, '/dev/disk/by-id/scsi-0HC_Volume_7');
    expect(data.startsWith('#cloud-config\n')).toBe(true);
    const files = Object.fromEntries([...data.matchAll(/- path: (\S+)\n {4}permissions: '(\d+)'\n {4}encoding: b64\n {4}content: (\S+)/g)]
      .map((match) => [match[1], [match[2], Buffer.from(match[3]!, 'base64').toString()]]));
    expect(files['/etc/karmax/ssh_host_ed25519_key']).toEqual(['0600', 'HOST']);
    expect(files['/etc/karmax/volume-device']).toEqual(['0644', '/dev/disk/by-id/scsi-0HC_Volume_7']);
    expect(files['/var/lib/cloud/scripts/per-boot/karmax-boot.sh']![1]).toMatch(/Port 2222[\s\S]*PasswordAuthentication no/);
  });
});

describe.skipIf(!sshdAvailable)('Hetzner worlds (fake Cloud API, real sshd)', () => {
  let hetzner: FakeHetzner;
  let provider: VmWorldProvider;
  let driver: HetznerDriver;
  let stamp: string;
  let ledger: Map<string, string>;
  const snapshots = process.env.KARMAX_HETZNER_SNAPSHOTS;

  beforeEach(() => {
    // The snapshot builder provisions a real machine as root: never on this one.
    process.env.KARMAX_HETZNER_SNAPSHOTS = '0';
    hetzner = new FakeHetzner();
    driver = new HetznerDriver(hetzner.fetch, 1);
    stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-stamp-')), 'provisioned');
    ledger = new Map();
    provider = new VmWorldProvider(driver, async () => connection(hetzner.token), undefined, {
      socket: hetzner.socket, user: os.userInfo().username, home: hetzner.home,
      provision: { stamp, script: `echo provisioned > ${stamp}`, sudo: false },
      ledger: {
        kvEntries: async (prefix) => [...ledger].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
        kvSet: (key, value) => { ledger.set(key, value); },
        kvDelete: (key) => { ledger.delete(key); },
      },
    });
  });
  afterEach(async () => {
    await hetzner.close();
    if (snapshots === undefined) delete process.env.KARMAX_HETZNER_SNAPSHOTS; else process.env.KARMAX_HETZNER_SNAPSHOTS = snapshots;
  });

  it('creates a world from a volume and a server behind the project firewall, with no root password', async () => {
    const world = await provider.create({ taskId: 'task_hz', base: 'main', generation: 1, organizationId: 'org_h', resources: { diskGb: 100 } });
    const [volume] = [...hetzner.volumes.values()];
    expect(volume).toMatchObject({ size: 100, location: { name: 'fsn1' }, labels: { karmaxTaskId: 'task_hz', karmaxOrganizationId: 'org_h' } });
    const created = hetzner.requests.find((request) => request.method === 'POST' && request.path === '/v1/servers')!.body;
    expect(created).toMatchObject({ server_type: 'cx22', location: 'fsn1', image: 'debian-12', volumes: [volume!.id],
      firewalls: [{ firewall: hetzner.firewalls[0]!.id }], ssh_keys: [hetzner.sshKeys[0]!.id] });
    const rules = hetzner.requests.find((request) => request.path === '/v1/firewalls' && request.method === 'POST')!.body.rules;
    expect(rules).toEqual([expect.objectContaining({ direction: 'in', protocol: 'tcp', port: '2222' }), expect.objectContaining({ protocol: 'icmp' })]);
    expect(world.handle.meta).toMatchObject({ machine: { cpu: 2, memoryMb: 4096, diskGb: 100 } });
    expect((await world.exec('sh', ['-c', 'echo ok'])).stdout).toBe('ok\n');
    // A second world reuses the project's firewall and key.
    await provider.create({ taskId: 'task_hz2', base: 'main', generation: 1, organizationId: 'org_h' });
    expect([hetzner.firewalls.length, hetzner.sshKeys.length]).toEqual([1, 1]);
  });

  it('parks inside the paid hour by powering off, and wakes the same server', async () => {
    const world = await provider.create({ taskId: 'task_grace', base: 'main', generation: 1, organizationId: 'org_h' });
    await world.writeFile('cache/kept.txt', 'kept');
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    const [server] = [...hetzner.servers.values()];
    expect(server).toMatchObject({ status: 'off', labels: { karmaxParkedAt: expect.any(String) } });
    expect(await provider.probe(handle)).toBe('parked');
    const woken = await provider.open(handle);
    expect([...hetzner.servers.keys()]).toEqual([server!.id]);
    expect(server!.labels.karmaxParkedAt).toBeUndefined();
    expect(await woken.readFile('cache/kept.txt')).toBe('kept');
  });

  it('deletes a parked server as its paid hour ends; the wake makes a new one on the same volume', async () => {
    const world = await provider.create({ taskId: 'task_cold', base: 'main', generation: 1, organizationId: 'org_h' });
    await world.writeFile('big/data.bin', 'x'.repeat(4096));
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    const [first] = [...hetzner.servers.values()];
    first!.created = new Date(Date.now() - 57 * 60_000).toISOString();
    await provider.housekeep('org_h');
    expect(hetzner.servers.size).toBe(0);
    expect([...hetzner.volumes.values()][0]!.server).toBeNull();
    expect(await provider.probe(handle)).toBe('parked');
    const woken = await provider.open(handle);
    const [second] = [...hetzner.servers.values()];
    expect(second!.id).not.toBe(first!.id);
    expect(second!.volumes).toEqual([[...hetzner.volumes.keys()][0]]);
    expect((await woken.readFile('big/data.bin')).length).toBe(4096);
  });

  it('replays the boot hooks after a restart, and setup too on a new server’s root disk', async () => {
    // pramana's setup apt-installs tesseract: outside the volume, so a server
    // made after the paid hour (from the snapshot) lacks it until setup runs again.
    const world = await provider.create({ taskId: 'task_hooks', base: 'main', generation: 1, organizationId: 'org_h' });
    // What activateProjectRuntime ran right after the create, and recorded.
    await world.exec('sh', ['-c', 'echo setup >> hooks.log; echo boot >> hooks.log']);
    const handle = { ...world.handle, meta: { ...world.handle.meta,
      machineHooks: { setup: ['echo setup >> hooks.log'], boot: ['echo boot >> hooks.log'] } } } as WorldHandle;
    const mark = path.join(path.dirname(stamp), '.world-hooks-boot');
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
    expect(fs.readFileSync(mark, 'utf8')).toBe(bootId);
    // The fake's servers share this host's boot: a park and wake within it replays nothing.
    await provider.park(handle);
    expect(await (await provider.open(handle)).readFile('hooks.log')).toBe('setup\nboot\n');
    // A power-on is a new boot: the boot hooks run again, setup does not.
    await provider.park(handle);
    fs.writeFileSync(mark, 'an-earlier-boot\n');
    expect(await (await provider.open(handle)).readFile('hooks.log')).toBe('setup\nboot\nboot\n');
    expect(fs.readFileSync(mark, 'utf8')).toBe(bootId);
    // Past the paid hour the wake is a new server whose root disk is the snapshot's: no mark.
    await provider.park(handle);
    [...hetzner.servers.values()][0]!.created = new Date(Date.now() - 57 * 60_000).toISOString();
    await provider.housekeep('org_h');
    fs.rmSync(mark);
    expect(await (await provider.open(handle)).readFile('hooks.log')).toBe('setup\nboot\nboot\nsetup\nboot\n');
    // Another process opening the running world (a worker restart) replays nothing.
    const other = new VmWorldProvider(driver, async () => connection(hetzner.token), undefined, {
      socket: hetzner.socket, user: os.userInfo().username, home: hetzner.home, provision: { stamp, script: 'exit 1', sudo: false } });
    expect(await (await other.open(handle)).readFile('hooks.log')).toBe('setup\nboot\nboot\nsetup\nboot\n');
  });

  it('parks straight to a deleted server when its paid hour is nearly over', async () => {
    const world = await provider.create({ taskId: 'task_late', base: 'main', generation: 1, organizationId: 'org_h' });
    [...hetzner.servers.values()][0]!.created = new Date(Date.now() - 58 * 60_000).toISOString();
    await provider.park(world.handle as WorldHandle);
    expect(hetzner.servers.size).toBe(0);
  });

  it('grows the volume in place and moves to a bigger server type at the next wake', async () => {
    const world = await provider.create({ taskId: 'task_hgrow', base: 'main', generation: 1, organizationId: 'org_h', resources: { diskGb: 100 } });
    await world.writeFile('keep.txt', 'all of it');
    const handle = world.handle as WorldHandle;
    expect(await provider.resize(handle, { diskGb: 150, cpu: 4, memoryMb: 8192 }))
      .toEqual({ disk: 'grown', restart: true, machine: { cpu: 2, memoryMb: 4096, diskGb: 150 } });
    expect([...hetzner.volumes.values()][0]!.size).toBe(150);
    await provider.park(handle);
    const woken = await provider.open({ ...handle, meta: { ...handle.meta, computer: { cpu: 4, memoryMb: 8192, diskGb: 150 } } });
    expect([...hetzner.servers.values()].map((server) => server.server_type.name)).toEqual(['cpx31']);
    expect(await woken.readFile('keep.txt')).toBe('all of it');
  });

  it('bills each started server hour at its price with its IPv4, and each volume hour', async () => {
    await provider.create({ taskId: 'task_bill', base: 'main', generation: 1, organizationId: 'org_h', resources: { diskGb: 100 } });
    [...hetzner.servers.values()][0]!.created = new Date(Date.now() - 150 * 60_000).toISOString();
    [...hetzner.volumes.values()][0]!.created = new Date(Date.now() - 150 * 60_000).toISOString();
    const events = (await provider.listUsageEvents('org_h')).events;
    const hours = events.filter((event) => event.kind !== 'disk');
    expect(hours).toHaveLength(3); // the third hour has started, so it is owed
    expect(hours[0]).toMatchObject({ taskId: 'task_bill', organizationId: 'org_h', cpu: 2, memoryMb: 4096, activeMs: 3_600_000,
      costMicros: Math.round((0.006 + 0.0008) * 1.17 * 1e6) });
    const disk = events.filter((event) => event.kind === 'disk');
    expect(disk).toHaveLength(2); // volume hours count once they pass
    expect(disk[0]).toMatchObject({ diskGb: 100, costMicros: Math.round(100 * 0.044 / 730 * 1.17 * 1e6) });
  });

  it('books a deleted volume’s hour under way, which Hetzner bills in full, also when the orphan reaper deletes it', async () => {
    await provider.create({ taskId: 'task_hgone', base: 'main', generation: 1, organizationId: 'org_h', resources: { diskGb: 100 } });
    [...hetzner.volumes.values()][0]!.created = new Date(Date.now() - 90 * 60_000).toISOString();
    expect((await provider.listUsageEvents('org_h')).events.filter((event) => event.kind === 'disk')).toHaveLength(1);
    await (await provider.listSandboxes('org_h'))[0]!.destroy();
    expect(hetzner.volumes.size).toBe(0);
    const disk = (await provider.listUsageEvents('org_h')).events.filter((event) => event.kind === 'disk');
    expect(disk.map((event) => event.id.split(':')[1])).toEqual(['0', '1']);
    expect(disk[1]).toMatchObject({ taskId: 'task_hgone', diskGb: 100, activeMs: 3_600_000, costMicros: Math.round(100 * 0.044 / 730 * 1.17 * 1e6) });
  });

  it('lists worlds for the orphan reaper and destroys the server and the volume', async () => {
    const world = await provider.create({ taskId: 'task_hreap', base: 'main', generation: 1, organizationId: 'org_h' });
    const listed = await provider.listSandboxes('org_h');
    expect(listed).toEqual([expect.objectContaining({ taskId: 'task_hreap' })]);
    expect(listed[0]!.matches!(world.handle)).toBe(true);
    await listed[0]!.destroy();
    expect([hetzner.servers.size, hetzner.volumes.size]).toEqual([0, 0]);
    expect(await provider.probe(world.handle as WorldHandle)).toBe('missing');
  });

  it('makes the project firewall and key once when several servers start together', async () => {
    // Canary of task #610: a project's first world and its snapshot builder each made their own.
    await Promise.all(['task_a', 'task_b', 'task_c'].map((taskId) =>
      provider.create({ taskId, base: 'main', generation: 1, organizationId: 'org_h' })));
    expect([hetzner.firewalls.length, hetzner.sshKeys.length]).toEqual([1, 1]);
  });

  it('frees parked servers when the project\'s shared vCPU limit refuses a new one (pramana#58)', async () => {
    hetzner.sharedCoresLimit = 4;
    const parked = await provider.create({ taskId: 'task_parked', base: 'main', generation: 1, organizationId: 'org_h' });
    await provider.park(parked.handle as WorldHandle);
    // Off but kept for a free wake within its paid hour, it still holds 2 of the 4 cores.
    expect([...hetzner.servers.values()]).toEqual([expect.objectContaining({ status: 'off' })]);
    const world = await provider.create({ taskId: 'task_big', base: 'main', generation: 1, organizationId: 'org_h', resources: { cpu: 4, memoryMb: 8192 } });
    expect([...hetzner.servers.values()].map((server) => server.server_type.name)).toEqual(['cpx31']);
    expect((await world.exec('sh', ['-c', 'echo ok'])).stdout).toBe('ok\n');
    // The parked world wakes on a new server later, as after its paid hour.
    expect(await provider.probe(parked.handle as WorldHandle)).toBe('parked');
  });

  it('says what holds a full shared vCPU limit, as a wait rather than a failure (pramana#58)', async () => {
    hetzner.sharedCoresLimit = 4;
    await provider.create({ taskId: 'task_busy', base: 'main', generation: 1, organizationId: 'org_h' });
    const refused = await provider.create({ taskId: 'task_big', base: 'main', generation: 1, organizationId: 'org_h',
      resources: { cpu: 4, memoryMb: 8192 } }).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderCapacityFull);
    // Setup waits it out like an outage (world-infra) instead of asking a person at once.
    expect(isTransportError(refused)).toBe(true);
    // It names the task holding them, and that the memory decides the server too (pramana#88).
    expect((refused as Error).message).toBe('Hetzner refused a 4-CPU, 8 GB server: this Hetzner project\'s limit on shared CPUs is full, '
      + 'with 2 in use by 1 other server (task task_busy). tavya waits until enough are free; to start sooner, give this task fewer CPUs '
      + 'and less memory (Hetzner\'s servers with 8 GB have 4 CPUs), stop another task, or ask Hetzner to raise the limit (Hetzner Console → Limits).');
    // Nothing of the refused world is left behind.
    expect([hetzner.servers.size, hetzner.volumes.size]).toEqual([1, 1]);
  });

  // pramana#79 (2026-10-17): a publication woke a parked world and Hetzner
  // refused "Primary IP limit exceeded": every server held an IPv4 and an IPv6
  // address, so the project's limit of ten admitted five servers.
  it('gives each server one public address, so the project\'s IP limit admits twice as many (pramana#79)', async () => {
    hetzner.primaryIpLimit = 4;
    for (const taskId of ['task_ip1', 'task_ip2', 'task_ip3', 'task_ip4'])
      await provider.create({ taskId, base: 'main', generation: 1, organizationId: 'org_h' });
    expect(hetzner.servers.size).toBe(4);
    expect(hetzner.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/servers'))
      .every((request) => request.body.public_net?.enable_ipv6 === false)).toBe(true);
  });

  it('says what a full IP limit is, as a wait rather than a failure (pramana#79)', async () => {
    hetzner.primaryIpLimit = 1;
    await provider.create({ taskId: 'task_ip', base: 'main', generation: 1, organizationId: 'org_h' });
    const refused = await provider.create({ taskId: 'task_ip_more', base: 'main', generation: 1, organizationId: 'org_h' })
      .then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderCapacityFull);
    expect(isTransportError(refused)).toBe(true);
    expect((refused as Error).message).toBe('Hetzner refused a new server: this Hetzner project\'s limit on public IP addresses is full, '
      + 'with 1 server using them. tavya waits until one is free; to start sooner, stop another task, '
      + 'or ask Hetzner to raise the limit (Hetzner Console → Limits).');
    expect([hetzner.servers.size, hetzner.volumes.size]).toEqual([1, 1]);
  });

  it('wakes a parked world although Hetzner fails the power-on (pramana#59)', async () => {
    // Production, 2026-10-16 12:32:06: start_server failed "Unknown Error"; the same request a second later worked.
    const world = await provider.create({ taskId: 'task_wake', base: 'main', generation: 1, organizationId: 'org_h' });
    await world.writeFile('kept.txt', 'kept');
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    const [server] = [...hetzner.servers.values()];
    hetzner.failingActions.set('poweron', 1);
    const woken = await provider.open(handle);
    expect([...hetzner.servers.keys()]).toEqual([server!.id]);
    expect(server!.labels.karmaxParkedAt).toBeUndefined();
    expect(await woken.readFile('kept.txt')).toBe('kept');
  });

  it('replaces a server Hetzner cannot start with a new one on the same volume', async () => {
    const world = await provider.create({ taskId: 'task_stuck', base: 'main', generation: 1, organizationId: 'org_h' });
    await world.writeFile('kept.txt', 'kept');
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    const [stuck] = [...hetzner.servers.values()];
    hetzner.failingActions.set('poweron', Infinity);
    const woken = await provider.open(handle);
    const [fresh] = [...hetzner.servers.values()];
    expect(hetzner.servers.size).toBe(1);
    expect(fresh!.id).not.toBe(stuck!.id);
    expect(fresh!.volumes).toEqual([[...hetzner.volumes.keys()][0]]);
    expect(await woken.readFile('kept.txt')).toBe('kept');
  });

  it('replaces a woken server that never answers SSH', async () => {
    const reachable = new VmWorldProvider(driver, async () => connection(hetzner.token), undefined, {
      socket: hetzner.socket, user: os.userInfo().username, home: hetzner.home, reachableMs: 1_500,
      provision: { stamp, script: `echo provisioned > ${stamp}`, sudo: false },
    });
    const world = await reachable.create({ taskId: 'task_deaf', base: 'main', generation: 1, organizationId: 'org_h' });
    await world.writeFile('kept.txt', 'kept');
    const handle = world.handle as WorldHandle;
    await reachable.park(handle);
    const [deaf] = [...hetzner.servers.values()];
    hetzner.deafBoots = 1;
    const woken = await reachable.open(handle);
    expect([...hetzner.servers.keys()]).not.toContain(deaf!.id);
    expect(await woken.readFile('kept.txt')).toBe('kept');
    // Twice deaf: a retryable outage, not an error for the agent or a person.
    await reachable.park(woken.handle as WorldHandle);
    hetzner.deafBoots = 2;
    const refused = await reachable.open(handle).then(() => undefined, (error: unknown) => error);
    expect(isTransportError(refused)).toBe(true);
    expect((refused as Error).message).toMatch(/did not answer SSH/);
    // Nothing is left billing for a machine that does nothing.
    expect([...hetzner.servers.values()].filter((server) => server.status !== 'off')).toEqual([]);
  });

  it('makes every Hetzner failure that passes a retryable outage, never the agent\'s error', async () => {
    const world = await provider.create({ taskId: 'task_out', base: 'main', generation: 1, organizationId: 'org_h' });
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    hetzner.failingActions.set('poweron', Infinity);
    hetzner.refuse('POST', /^\/v1\/servers$/, 503, 'unavailable', 'service unavailable', Infinity);
    const refused = await provider.open(handle).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderOutage);
    expect(isTransportError(refused)).toBe(true);
    expect((refused as Error).message).toMatch(/Hetzner/);
    // The volume, the world's files, is never what a failed wake gives up.
    expect(hetzner.volumes.size).toBe(1);
  });

  it('retries Hetzner\'s refusals (rate limit, locked) on any request, and sends no create twice on a 500', async () => {
    hetzner.refuse('POST', /^\/v1\/servers$/, 429, 'rate_limit_exceeded', 'limit of 3600 requests per hour reached');
    hetzner.refuse('POST', /^\/v1\/volumes$/, 423, 'locked', 'resource is locked');
    const world = await provider.create({ taskId: 'task_busy_api', base: 'main', generation: 1, organizationId: 'org_h' });
    expect((await world.exec('sh', ['-c', 'echo ok'])).stdout).toBe('ok\n');
    // A 500 to a create may have created it: not sent again here; the create's own retry deletes leftovers first.
    hetzner.refuse('POST', /^\/v1\/volumes$/, 500, 'server_error', 'internal server error');
    const before = hetzner.requests.filter((request) => request.method === 'POST' && request.path === '/v1/volumes').length;
    const failed = await provider.create({ taskId: 'task_500', base: 'main', generation: 1, organizationId: 'org_h' })
      .then(() => undefined, (error: unknown) => error);
    expect(isTransportError(failed)).toBe(true);
    expect(hetzner.requests.filter((request) => request.method === 'POST' && request.path === '/v1/volumes').length).toBe(before + 1);
  });

  it('takes the next server type when Hetzner has none of the cheapest left', async () => {
    hetzner.soldOut.add('cx22');
    const world = await provider.create({ taskId: 'task_sold', base: 'main', generation: 1, organizationId: 'org_h' });
    expect([...hetzner.servers.values()].map((server) => server.server_type.name)).toEqual(['cpx31']);
    expect((await world.exec('sh', ['-c', 'echo ok'])).stdout).toBe('ok\n');
    // A type the location stopped offering within the hour the types are cached for, too.
    hetzner.soldOut.clear();
    hetzner.refuse('POST', /^\/v1\/servers$/, 422, 'invalid_input', 'unsupported location for server type');
    await provider.create({ taskId: 'task_gone', base: 'main', generation: 1, organizationId: 'org_h' });
    expect(hetzner.servers.size).toBe(2);
  });

  it('says what holds a full volume limit, as a wait rather than a failure', async () => {
    hetzner.volumesLimitGb = 150;
    await provider.create({ taskId: 'task_disk', base: 'main', generation: 1, organizationId: 'org_h', resources: { diskGb: 100 } });
    const refused = await provider.create({ taskId: 'task_disk2', base: 'main', generation: 1, organizationId: 'org_h', resources: { diskGb: 70 } })
      .then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderCapacityFull);
    expect(isTransportError(refused)).toBe(true);
    expect((refused as Error).message).toBe('Hetzner refused a 70 GB disk: this Hetzner project\'s limit on the total size of its volumes '
      + 'is full, with 100 GB in 1 volume. tavya waits until there is room; to start sooner, give this task a smaller disk, '
      + 'delete another task, or ask Hetzner to raise the limit (Hetzner Console → Limits).');
    expect(hetzner.volumes.size).toBe(1);
  });

  it('parks a server that will not shut down by deleting it; the volume stays', async () => {
    const world = await provider.create({ taskId: 'task_nostop', base: 'main', generation: 1, organizationId: 'org_h' });
    await world.writeFile('kept.txt', 'kept');
    const handle = world.handle as WorldHandle;
    hetzner.failingActions.set('shutdown', Infinity);
    hetzner.failingActions.set('poweroff', Infinity);
    await provider.park(handle);
    expect([hetzner.servers.size, hetzner.volumes.size]).toEqual([0, 1]);
    expect(await provider.probe(handle)).toBe('parked');
    expect(await (await provider.open(handle)).readFile('kept.txt')).toBe('kept');
  });

  it('keeps housekeeping past a server it cannot delete', async () => {
    for (const taskId of ['task_h1', 'task_h2']) {
      const world = await provider.create({ taskId, base: 'main', generation: 1, organizationId: 'org_h' });
      await provider.park(world.handle as WorldHandle);
    }
    for (const server of hetzner.servers.values()) server.created = new Date(Date.now() - 57 * 60_000).toISOString();
    const [first] = [...hetzner.servers.keys()];
    hetzner.refuse('DELETE', new RegExp(`^/v1/servers/${first}$`), 403, 'protected', 'server is protected', Infinity);
    await expect(provider.housekeep('org_h')).rejects.toThrow(/protected/);
    expect([...hetzner.servers.keys()]).toEqual([first]);
  });

  it('boots new servers from the provisioned snapshot once one exists', async () => {
    const { vmProvisionVersion } = await import('../src/world/vm/provision.js');
    hetzner.images.push({ id: 4242, status: 'available', labels: { karmaxImage: vmProvisionVersion() } });
    await provider.create({ taskId: 'task_snap', base: 'main', generation: 1, organizationId: 'org_h' });
    expect(hetzner.requests.find((request) => request.method === 'POST' && request.path === '/v1/servers')!.body.image).toBe('4242');
  });
});
