import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloudInit, HetznerDriver, paidMsLeft } from '../src/world/hetzner.js';
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
  const snapshots = process.env.KARMAX_HETZNER_SNAPSHOTS;

  beforeEach(() => {
    // The snapshot builder provisions a real machine as root: never on this one.
    process.env.KARMAX_HETZNER_SNAPSHOTS = '0';
    hetzner = new FakeHetzner();
    driver = new HetznerDriver(hetzner.fetch, 1);
    stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-stamp-')), 'provisioned');
    provider = new VmWorldProvider(driver, async () => connection(hetzner.token), undefined, {
      socket: hetzner.socket, user: os.userInfo().username, home: hetzner.home,
      provision: { stamp, script: `echo provisioned > ${stamp}`, sudo: false },
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

  it('lists worlds for the orphan reaper and destroys the server and the volume', async () => {
    const world = await provider.create({ taskId: 'task_hreap', base: 'main', generation: 1, organizationId: 'org_h' });
    const listed = await provider.listSandboxes('org_h');
    expect(listed).toEqual([expect.objectContaining({ taskId: 'task_hreap' })]);
    expect(listed[0]!.matches!(world.handle)).toBe(true);
    await listed[0]!.destroy();
    expect([hetzner.servers.size, hetzner.volumes.size]).toEqual([0, 0]);
    expect(await provider.probe(world.handle as WorldHandle)).toBe('missing');
  });

  it('boots new servers from the provisioned snapshot once one exists', async () => {
    const { vmProvisionVersion } = await import('../src/world/vm/provision.js');
    hetzner.images.push({ id: 4242, status: 'available', labels: { karmaxImage: vmProvisionVersion() } });
    await provider.create({ taskId: 'task_snap', base: 'main', generation: 1, organizationId: 'org_h' });
    expect(hetzner.requests.find((request) => request.method === 'POST' && request.path === '/v1/servers')!.body.image).toBe('4242');
  });
});
