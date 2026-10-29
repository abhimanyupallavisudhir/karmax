import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { e2Machine, GcpDriver, gcpLabels, gcpServiceAccount } from '../src/world/gcp.js';
import { ProviderCapacityFull } from '../src/agent/limits.js';
import { VmWorldProvider } from '../src/world/vm/provider.js';
import { startupScript, vmProvisionVersion } from '../src/world/vm/provision.js';
import type { ResolvedWorldProviderConnection } from '../src/world/connections.js';
import type { WorldHandle } from '../src/world/types.js';
import { FakeGcp } from './helpers/fake-gcp.js';
import { sshdAvailable } from './helpers/local-sshd.js';

const connection = (key: string): ResolvedWorldProviderConnection => ({ organizationId: 'org_g', provider: 'gcp', apiKey: key,
  config: { region: 'europe-west3-a' } });

describe('Google Cloud sizes, labels, keys and the startup script', () => {
  it('makes an E2 custom machine of exactly the Computer, within E2’s rules', () => {
    expect(e2Machine({ cpu: 2, memoryMb: 2048 })).toEqual({ name: 'e2-custom-2-2048', cpu: 2, memoryMb: 2048 });
    // At least 2 CPUs, in even numbers; at least 0.5 GB per CPU, in 256 MB steps.
    expect(e2Machine({ cpu: 1, memoryMb: 1000 })).toEqual({ name: 'e2-custom-2-1024', cpu: 2, memoryMb: 1024 });
    expect(e2Machine({ cpu: 3, memoryMb: 1024 })).toEqual({ name: 'e2-custom-4-2048', cpu: 4, memoryMb: 2048 });
    // At most 8 GB per CPU: more memory brings more CPUs.
    expect(e2Machine({ cpu: 2, memoryMb: 32_768 })).toEqual({ name: 'e2-custom-4-32768', cpu: 4, memoryMb: 32_768 });
    expect(() => e2Machine({ cpu: 64, memoryMb: 2048 })).toThrow(/at most 32 CPUs/);
  });

  it('writes karmax’s labels as Compute Engine allows them', () => {
    expect(gcpLabels({ karmaxHome: 'abc123', karmaxTaskId: 'task_X1', karmaxLastRun: '1-2' }))
      .toEqual({ 'karmax-home': 'abc123', 'karmax-task': 'task_x1', 'karmax-last-run': '1-2' });
  });

  it('takes a service account key file and refuses anything else', () => {
    expect(() => gcpServiceAccount('not json')).toThrow(/service account key file/);
    expect(() => gcpServiceAccount('{"type":"service_account"}')).toThrow(/client_email, private_key and project_id/);
  });

  it('delivers the boot files and runs the boot script from a startup script', () => {
    const script = startupScript({ hostPrivateKey: 'HOST', authorizedKey: 'ssh-ed25519 AAAA world' }, '/dev/disk/by-id/google-karmax-home');
    const files = Object.fromEntries([...script.matchAll(/printf %s '([^']+)' \| base64 -d > '([^']+)' && chmod (\d+)/g)]
      .map((match) => [match[2], [match[3], Buffer.from(match[1]!, 'base64').toString()]]));
    expect(files['/etc/karmax/ssh_host_ed25519_key']).toEqual(['0600', 'HOST']);
    expect(files['/etc/karmax/volume-device']).toEqual(['0644', '/dev/disk/by-id/google-karmax-home']);
    expect(files['/var/lib/cloud/scripts/per-boot/karmax-boot.sh']![1]).toMatch(/blkid -p[\s\S]*mkfs.ext4[\s\S]*Port 2222/);
    expect(script.trimEnd().endsWith('exec /var/lib/cloud/scripts/per-boot/karmax-boot.sh')).toBe(true);
  });
});

describe.skipIf(!sshdAvailable)('Google Cloud worlds (fake Compute Engine, real sshd)', () => {
  let gcp: FakeGcp;
  let provider: VmWorldProvider;
  let driver: GcpDriver;
  let stamp: string;
  let ledger: Map<string, string>;
  const images = process.env.KARMAX_GCP_IMAGES;

  beforeEach(() => {
    // The image builder provisions a real machine as root: never on this one.
    process.env.KARMAX_GCP_IMAGES = '0';
    gcp = new FakeGcp();
    // A wait is 300 polls: at 1 ms a cold sshd boot on a busy runner can outlast it (CI #2182).
    driver = new GcpDriver(gcp.fetch, 10);
    stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-stamp-')), 'provisioned');
    ledger = new Map();
    provider = new VmWorldProvider(driver, async () => connection(gcp.key), undefined, {
      socket: gcp.socket, user: os.userInfo().username, home: gcp.home,
      provision: { stamp, script: `echo provisioned > ${stamp}`, sudo: false },
      ledger: {
        kvEntries: async (prefix) => [...ledger].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
        kvSet: (key, value) => { ledger.set(key, value); },
        kvDelete: (key) => { ledger.delete(key); },
      },
    });
  });
  afterEach(async () => {
    await gcp.close();
    if (images === undefined) delete process.env.KARMAX_GCP_IMAGES; else process.env.KARMAX_GCP_IMAGES = images;
  });

  it('creates a world: a pd-balanced home disk, an E2 machine with no service account behind karmax’s firewall', async () => {
    const world = await provider.create({ taskId: 'task_gcp', base: 'main', generation: 1, organizationId: 'org_g', resources: { diskGb: 100 } });
    const home = [...gcp.disks.values()].find((disk) => disk.labels['karmax-role'] === 'home')!;
    expect(home).toMatchObject({ sizeGb: 100, zone: 'europe-west3-a', type: 'zones/europe-west3-a/diskTypes/pd-balanced',
      labels: { 'karmax-task': 'task_gcp', 'karmax-org': 'org_g' } });
    const [instance] = [...gcp.instances.values()];
    expect(instance).toMatchObject({ machineType: 'zones/europe-west3-a/machineTypes/e2-custom-2-2048', status: 'RUNNING', serviceAccounts: undefined });
    expect(instance!.body.tags).toEqual({ items: ['karmax-vm'] });
    expect(instance!.body.metadata.items).toContainEqual({ key: 'block-project-ssh-keys', value: 'TRUE' });
    expect([...gcp.disks.values()].find((disk) => disk.name.endsWith('-root'))).toMatchObject({ sizeGb: 20,
      image: 'projects/debian-cloud/global/images/family/debian-12', labels: { 'karmax-role': 'root' } });
    expect(gcp.firewalls).toEqual([expect.objectContaining({ name: 'karmax-vm-ssh', targetTags: ['karmax-vm'],
      allowed: [{ IPProtocol: 'tcp', ports: ['2222'] }] })]);
    expect(world.handle.meta).toMatchObject({ machine: { cpu: 2, memoryMb: 2048, diskGb: 100 } });
    expect((await world.exec('sh', ['-c', 'echo ok'])).stdout).toBe('ok\n');
    // One token serves many requests.
    expect(gcp.tokensIssued).toBe(1);
  });

  it('boots new machines from karmax’s provisioned image once one exists', async () => {
    gcp.images.push({ name: 'karmax-vm-x', status: 'READY', labels: { 'karmax-image': vmProvisionVersion() }, creationTimestamp: new Date().toISOString() });
    await provider.create({ taskId: 'task_img', base: 'main', generation: 1, organizationId: 'org_g' });
    expect([...gcp.disks.values()].find((disk) => disk.name.endsWith('-root'))!.image).toBe(`projects/${gcp.project}/global/images/karmax-vm-x`);
  });

  it('parks by stopping the machine, wakes the same one with every file, and resizes it while stopped', async () => {
    const world = await provider.create({ taskId: 'task_park', base: 'main', generation: 1, organizationId: 'org_g' });
    await world.writeFile('cache/kept.txt', 'kept');
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    const [instance] = [...gcp.instances.values()];
    expect(instance!.status).toBe('TERMINATED');
    expect(await provider.probe(handle)).toBe('parked');
    handle.meta = { ...handle.meta, computer: { cpu: 4, memoryMb: 8192 } };
    const woken = await provider.open(handle);
    expect(instance).toMatchObject({ status: 'RUNNING', starts: 2, machineType: 'zones/europe-west3-a/machineTypes/e2-custom-4-8192' });
    expect(instance!.labels['karmax-last-run']).toMatch(/^\d+-\d+$/);
    expect(await woken.readFile('cache/kept.txt')).toBe('kept');
  });

  it('parks only once Google says the machine is stopping (it says RUNNING for a moment after the stop)', async () => {
    const world = await provider.create({ taskId: 'task_lag', base: 'main', generation: 1, organizationId: 'org_g' });
    gcp.stopLag = 3;
    await provider.park(world.handle as WorldHandle);
    expect(await provider.probe(world.handle as WorldHandle)).toBe('parked');
  });

  it('makes a world in the region’s next zone when the first has no capacity, and waits when none has', async () => {
    gcp.noCapacity.add('e2-custom-2-2048@europe-west3-a');
    await provider.create({ taskId: 'task_zone', base: 'main', generation: 1, organizationId: 'org_g' });
    expect([...gcp.instances.values()][0]!.zone).toBe('europe-west3-b');
    expect([...gcp.disks.values()].filter((disk) => disk.zone === 'europe-west3-a')).toEqual([]);
    gcp.noCapacity.add('e2-custom-2-2048@europe-west3-b').add('e2-custom-2-2048@europe-west3-c');
    const refused = await provider.create({ taskId: 'task_full', base: 'main', generation: 1, organizationId: 'org_g' }).catch((error) => error);
    expect(refused).toBeInstanceOf(ProviderCapacityFull);
    expect(refused.message).toMatch(/no e2-custom-2-2048 machine free in europe-west3/);
    expect([...gcp.disks.values()].filter((disk) => disk.labels['karmax-task'] === 'task_full')).toEqual([]);
  });

  it('waits out a full CPU quota, naming it', async () => {
    gcp.cpuQuota = 2;
    await provider.create({ taskId: 'task_q1', base: 'main', generation: 1, organizationId: 'org_g' });
    const refused = await provider.create({ taskId: 'task_q2', base: 'main', generation: 1, organizationId: 'org_g' }).catch((error) => error);
    expect(refused).toBeInstanceOf(ProviderCapacityFull);
    expect(refused.message).toMatch(/Quota 'CPUS' exceeded[\s\S]*IAM & Admin → Quotas/);
  });

  it('waits when the disk’s zone has no machine free at a wake', async () => {
    const world = await provider.create({ taskId: 'task_wake', base: 'main', generation: 1, organizationId: 'org_g' });
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    gcp.noCapacity.add('e2-custom-2-2048@europe-west3-a');
    const refused = await provider.open(handle).catch((error) => error);
    expect(refused).toBeInstanceOf(ProviderCapacityFull);
    expect(refused.message).toMatch(/where this world's disk is/);
  });

  it('replaces a machine that was deleted, on the same disk', async () => {
    const world = await provider.create({ taskId: 'task_gone', base: 'main', generation: 1, organizationId: 'org_g' });
    await world.writeFile('kept.txt', 'still here');
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    const [first] = [...gcp.instances.values()];
    await gcp.fetch(`https://compute.googleapis.com/compute/v1/projects/${gcp.project}/zones/${first!.zone}/instances/${first!.name}`,
      { method: 'DELETE', headers: { authorization: 'Bearer fake-token' } });
    const woken = await provider.open(handle);
    expect(await woken.readFile('kept.txt')).toBe('still here');
    expect(gcp.instances.size).toBe(1);
  });

  it('grows the disk in place and destroys the machine and both disks', async () => {
    const world = await provider.create({ taskId: 'task_grow', base: 'main', generation: 1, organizationId: 'org_g', resources: { diskGb: 20 } });
    const handle = world.handle as WorldHandle;
    expect(await provider.resize(handle, { diskGb: 40 })).toMatchObject({ disk: 'grown', machine: { diskGb: 40 } });
    expect([...gcp.disks.values()].find((disk) => disk.labels['karmax-role'] === 'home')!.sizeGb).toBe(40);
    await provider.destroy(handle);
    expect([gcp.instances.size, gcp.disks.size]).toEqual([0, 0]);
  });

  it('reports runs at the catalog’s E2 prices plus IPv4, and both disks by the hour', async () => {
    const world = await provider.create({ taskId: 'task_bill', base: 'main', generation: 1, organizationId: 'org_g', resources: { diskGb: 50 } });
    await provider.park(world.handle as WorldHandle);
    const [instance] = [...gcp.instances.values()];
    const start = Date.now() - 3 * 3_600_000;
    instance!.lastStartTimestamp = new Date(start).toISOString();
    instance!.lastStopTimestamp = new Date(start + 12 * 60_000).toISOString();
    for (const disk of gcp.disks.values()) disk.creationTimestamp = new Date(start).toISOString();
    const events = await driver.usage(connection(gcp.key), instance!.labels['karmax-home']!);
    const compute = events.filter((event) => event.kind !== 'disk');
    expect(compute.map((event) => event.activeMs / 60_000)).toEqual([5, 5, 2]);
    expect(compute[0]).toMatchObject({ taskId: 'task_bill', organizationId: 'org_g', cpu: 2, memoryMb: 2048,
      costMicros: Math.round((2 * 0.02835 + 2 * 0.0038 + 0.005) * 5 / 60 * 1e6) });
    const disks = events.filter((event) => event.kind === 'disk');
    expect(disks.filter((event) => event.diskGb === 50)).toHaveLength(3);
    expect(disks.filter((event) => event.diskGb === 20)).toHaveLength(3);
    expect(disks.find((event) => event.diskGb === 50)!.costMicros).toBe(Math.round(50 * 0.13 / 730 * 1e6));
  });

  it('books a deleted world’s last run and the last part-hour of both disks, which Google stops listing at once', async () => {
    const world = await provider.create({ taskId: 'task_gone', base: 'main', generation: 1, organizationId: 'org_g', resources: { diskGb: 50 } });
    await provider.park(world.handle as WorldHandle);
    const [instance] = [...gcp.instances.values()];
    // Made 1 h 23 min ago; ran its last 7 minutes and was stopped a minute ago.
    // One clock reading: two could differ by a millisecond (CI #2412: 2.0000166 minutes).
    const now = Date.now();
    const start = now - 83 * 60_000;
    instance!.lastStartTimestamp = new Date(now - 8 * 60_000).toISOString();
    instance!.lastStopTimestamp = new Date(now - 60_000).toISOString();
    for (const disk of gcp.disks.values()) disk.creationTimestamp = new Date(start).toISOString();
    await provider.destroy(world.handle as WorldHandle);
    expect([gcp.instances.size, gcp.disks.size]).toEqual([0, 0]);
    const events = (await provider.listUsageEvents('org_g')).events;
    expect(events.filter((event) => event.kind !== 'disk').map((event) => event.activeMs / 60_000)).toEqual([5, 2]);
    const disks = events.filter((event) => event.kind === 'disk');
    expect(disks.map((event) => [event.diskGb, Math.round(event.activeMs / 60_000)]).sort()).toEqual([[20, 23], [20, 60], [50, 23], [50, 60]]);
    expect(disks[0]).toMatchObject({ taskId: 'task_gone', organizationId: 'org_g' });
  });

  it('prices at us-central1’s list when the Cloud Billing catalog is closed', async () => {
    gcp.billingDown = true;
    const world = await provider.create({ taskId: 'task_price', base: 'main', generation: 1, organizationId: 'org_g' });
    await provider.park(world.handle as WorldHandle);
    const [instance] = [...gcp.instances.values()];
    instance!.lastStartTimestamp = new Date(Date.now() - 20 * 60_000).toISOString();
    instance!.lastStopTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
    const [event] = (await driver.usage(connection(gcp.key), instance!.labels['karmax-home']!)).filter((entry) => entry.kind !== 'disk');
    expect(event!.costMicros).toBe(Math.round((2 * 0.021811 + 2 * 0.002923 + 0.005) * 5 / 60 * 1e6));
  });

  it('tells the limits record E2’s largest machine within the region’s CPU quota', async () => {
    expect(await driver.limits(connection(gcp.key))).toMatchObject({ cpu: 32, memoryMb: 131_072, diskGb: 65_536 });
    gcp.cpuQuota = 8;
    expect(await new GcpDriver(gcp.fetch, 1).limits(connection(gcp.key))).toMatchObject({ cpu: 8, memoryMb: 65_536, pool: { cpu: 8 } });
    // The project's quota across regions binds when it is the lowest (managed today: E2 24, CPUS 200, all regions 100).
    gcp.cpuQuota = 24;
    gcp.globalCpuQuota = 6;
    expect(await new GcpDriver(gcp.fetch, 1).limits(connection(gcp.key))).toMatchObject({ cpu: 6, memoryMb: 49_152, pool: { cpu: 6 } });
    gcp.globalCpuQuota = 100;
    expect(await new GcpDriver(gcp.fetch, 1).limits(connection(gcp.key))).toMatchObject({ cpu: 24, pool: { cpu: 24 } });
  });

  it('refuses a project without the default network at the connection test, and a bad key at the token', async () => {
    await driver.test(connection(gcp.key));
    gcp.defaultNetwork = false;
    await expect(new GcpDriver(gcp.fetch, 1).test(connection(gcp.key))).rejects.toThrow(/no network named "default"/);
    const other = JSON.parse(new FakeGcp().key);
    await expect(new GcpDriver(gcp.fetch, 1).test(connection(JSON.stringify({ ...JSON.parse(gcp.key), private_key: other.private_key }))))
      .rejects.toThrow(/Google refused the service account key \(400\): Invalid JWT Signature/);
  });

  it('lists its worlds by home, and housekeeping deletes images of old versions', async () => {
    await provider.create({ taskId: 'task_list', base: 'main', generation: 1, organizationId: 'org_g' });
    const home = [...gcp.instances.values()][0]!.labels['karmax-home']!;
    expect(await driver.list(connection(gcp.key), home)).toEqual([expect.objectContaining({ taskId: 'task_list', generation: '1' })]);
    gcp.images.push({ name: 'karmax-vm-old', status: 'READY', labels: { 'karmax-image': 'old' }, creationTimestamp: '2026-01-01T00:00:00Z' });
    await driver.housekeep(connection(gcp.key));
    expect(gcp.images.map((image) => image.name)).not.toContain('karmax-vm-old');
  });
});
