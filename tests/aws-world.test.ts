import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AwsDriver, awsCredentials, ec2Query, homeDevice, parseXml, signAws, stoppedAt } from '../src/world/aws.js';
import { ProviderCapacityFull } from '../src/agent/limits.js';
import { VmWorldProvider } from '../src/world/vm/provider.js';
import { runSlices } from '../src/world/vm/runs.js';
import { vmProvisionVersion } from '../src/world/vm/provision.js';
import type { ResolvedWorldProviderConnection } from '../src/world/connections.js';
import type { WorldHandle } from '../src/world/types.js';
import { FakeAws } from './helpers/fake-aws.js';
import { sshdAvailable } from './helpers/local-sshd.js';

const connection = (key: string): ResolvedWorldProviderConnection => ({ organizationId: 'org_a', provider: 'aws', apiKey: key,
  config: { region: 'eu-central-1' } });

describe('AWS signing, XML and keys', () => {
  it('signs as AWS’s own published SigV4 example does', () => {
    // docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html (IAM ListUsers).
    const headers = signAws({ method: 'GET', url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'), body: '',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } },
    { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, 'us-east-1', 'iam', new Date('2015-08-30T12:36:00Z'));
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, '
      + 'SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('reads EC2’s XML: sets are lists, empty or not; errors keep their code', () => {
    const answer = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>r</requestId>
  <reservationSet><item><instancesSet><item>
    <instanceId>i-1</instanceId><instanceState><code>80</code><name>stopped</name></instanceState>
    <reason>User initiated (2026-10-19 12:34:56 GMT)</reason><groupSet/>
    <tagSet><item><key>karmaxTaskId</key><value>task_a</value></item><item><key>Name</key><value>a &amp; b</value></item></tagSet>
  </item></instancesSet></item></reservationSet>
  <securityGroupInfo><item><groupId>sg-1</groupId></item></securityGroupInfo>
</DescribeInstancesResponse>`).DescribeInstancesResponse;
    const instance = answer.reservationSet[0].instancesSet[0];
    expect(instance).toMatchObject({ instanceId: 'i-1', instanceState: { name: 'stopped' }, groupSet: [] });
    expect(instance.tagSet).toEqual([{ key: 'karmaxTaskId', value: 'task_a' }, { key: 'Name', value: 'a & b' }]);
    expect(answer.securityGroupInfo).toEqual([{ groupId: 'sg-1' }]);
    expect(stoppedAt(instance)).toBe(Date.parse('2026-10-19T12:34:56Z'));
    expect(parseXml('<Response><Errors><Error><Code>VcpuLimitExceeded</Code><Message>m</Message></Error></Errors></Response>').Response.Errors.Error)
      .toEqual({ Code: 'VcpuLimitExceeded', Message: 'm' });
  });

  it('numbers lists and dots objects in query parameters', () => {
    expect(ec2Query({ InstanceId: ['i-1', 'i-2'], Filter: [{ Name: 'tag:a', Value: ['b'] }], MetadataOptions: { HttpTokens: 'required' },
      TagSpecification: [{ ResourceType: 'instance', Tag: [{ Key: 'k', Value: 'v' }] }], DryRun: false })).toEqual([
      ['InstanceId.1', 'i-1'], ['InstanceId.2', 'i-2'], ['Filter.1.Name', 'tag:a'], ['Filter.1.Value.1', 'b'], ['MetadataOptions.HttpTokens', 'required'],
      ['TagSpecification.1.ResourceType', 'instance'], ['TagSpecification.1.Tag.1.Key', 'k'], ['TagSpecification.1.Tag.1.Value', 'v'], ['DryRun', 'false']]);
  });

  it('takes an access key as ID:SECRET, as the console’s CSV, or as JSON, and refuses anything else', () => {
    const want = { accessKeyId: 'AKIAABCDEFGHIJKLMNOP', secretAccessKey: 'abc/def+ghi' };
    expect(awsCredentials('AKIAABCDEFGHIJKLMNOP:abc/def+ghi')).toEqual(want);
    expect(awsCredentials('Access key ID,Secret access key\nAKIAABCDEFGHIJKLMNOP,abc/def+ghi\n')).toEqual(want);
    expect(awsCredentials(JSON.stringify({ AccessKeyId: 'AKIAABCDEFGHIJKLMNOP', SecretAccessKey: 'abc/def+ghi' }))).toEqual(want);
    expect(() => awsCredentials('just-a-token')).toThrow(/access key ID and its secret/);
  });

  it('names a Nitro instance’s volume device by the volume', () => {
    expect(homeDevice('vol-0abc123')).toBe('/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0abc123');
  });

  it('books a run in whole slices, and its last part only once it ended', () => {
    const start = Date.parse('2026-10-19T10:00:00Z');
    const minute = 60_000;
    // Running 12 minutes: two whole slices, the third not yet.
    expect(runSlices([{ start }], start + 12 * minute, 0).map((slice) => [slice.id, (slice.end - slice.start) / minute]))
      .toEqual([[`${start}:0`, 5], [`${start}:1`, 5]]);
    // Stopped at 12 minutes: the third, two minutes long, now too.
    expect(runSlices([{ start, end: start + 12 * minute }], start + 30 * minute, 0).map((slice) => (slice.end - slice.start) / minute)).toEqual([5, 5, 2]);
    // Only what ends after `from`.
    expect(runSlices([{ start, end: start + 12 * minute }], start + 30 * minute, start + 6 * minute)).toHaveLength(2);
  });
});

describe.skipIf(!sshdAvailable)('AWS worlds (fake EC2, real sshd)', () => {
  let aws: FakeAws;
  let provider: VmWorldProvider;
  let driver: AwsDriver;
  let stamp: string;
  const images = process.env.KARMAX_AWS_IMAGES;

  beforeEach(() => {
    // The image builder provisions a real machine as root: never on this one.
    process.env.KARMAX_AWS_IMAGES = '0';
    aws = new FakeAws();
    // A wait is 300 polls: at 1 ms a cold sshd boot on a busy runner outlasted it (CI #2182).
    driver = new AwsDriver(aws.fetch, 10);
    stamp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vm-stamp-')), 'provisioned');
    provider = new VmWorldProvider(driver, async () => connection(aws.key), undefined, {
      socket: aws.socket, user: os.userInfo().username, home: aws.home,
      provision: { stamp, script: `echo provisioned > ${stamp}`, sudo: false },
    });
  });
  afterEach(async () => {
    await aws.close();
    if (images === undefined) delete process.env.KARMAX_AWS_IMAGES; else process.env.KARMAX_AWS_IMAGES = images;
  });

  it('picks the cheapest instance of karmax’s families that covers a Computer, never a T type', async () => {
    const shape = (cpu: number, memoryMb: number) => driver.shape({ cpu, memoryMb, diskGb: 50 }, connection(aws.key));
    expect(await shape(2, 2048)).toEqual({ cpu: 2, memoryMb: 4096, diskGb: 50 }); // c7i-flex.large
    expect(await shape(2, 8192)).toEqual({ cpu: 2, memoryMb: 8192, diskGb: 50 }); // m7i-flex.large
    expect(await shape(2, 16384)).toEqual({ cpu: 2, memoryMb: 16384, diskGb: 50 }); // r7i.large
    await expect(driver.shape({ diskGb: 20_000 }, connection(aws.key))).rejects.toThrow(/at most 16384 GB/);
    expect(await driver.limits(connection(aws.key))).toMatchObject({ cpu: 192, memoryMb: 1_572_864, diskGb: 16_384 });
  });

  it('creates a world: a gp3 home volume, an instance in the default VPC behind karmax’s security group, IMDSv2, no public key', async () => {
    const world = await provider.create({ taskId: 'task_aws', base: 'main', generation: 1, organizationId: 'org_a', resources: { diskGb: 100 } });
    const home = [...aws.volumes.values()].find((volume) => volume.tags.karmaxRole === 'home')!;
    expect(home).toMatchObject({ size: 100, zone: 'eu-central-1a', status: 'in-use', tags: { karmaxTaskId: 'task_aws', karmaxOrganizationId: 'org_a' } });
    const [instance] = [...aws.instances.values()];
    expect(instance).toMatchObject({ instanceType: 'c7i-flex.large', imageId: 'ami-debian', rootSize: 20, imds: 'required', groups: [aws.groups[0]!.groupId],
      tags: { karmaxTaskId: 'task_aws', karmaxWorld: home.tags.karmaxWorld } });
    expect(instance!.userData).toContain(Buffer.from(homeDevice(home.volumeId)).toString('base64'));
    expect(aws.requests.find((request) => request.action === 'RunInstances')!.params.KeyName).toBeUndefined();
    expect(aws.groups[0]!.ingress).toEqual([{ protocol: 'tcp', from: '2222', to: '2222', cidr: '0.0.0.0/0' }]);
    expect([...aws.volumes.values()].find((volume) => volume.rootOf)!.tags).toMatchObject({ karmaxRole: 'root', karmaxTaskId: 'task_aws' });
    expect(world.handle.meta).toMatchObject({ machine: { cpu: 2, memoryMb: 4096, diskGb: 100 } });
    expect((await world.exec('sh', ['-c', 'echo ok'])).stdout).toBe('ok\n');
    // A second world shares the security group.
    await provider.create({ taskId: 'task_aws2', base: 'main', generation: 1, organizationId: 'org_a' });
    expect(aws.groups).toHaveLength(1);
  });

  it('boots new instances from karmax’s provisioned image once one exists', async () => {
    aws.images.push({ imageId: 'ami-karmax', name: 'karmax-vm', state: 'available', tags: { karmaxImage: vmProvisionVersion() }, owner: 'self',
      creationDate: new Date().toISOString(), snapshot: 'snap-k' });
    await provider.create({ taskId: 'task_img', base: 'main', generation: 1, organizationId: 'org_a' });
    expect([...aws.instances.values()][0]!.imageId).toBe('ami-karmax');
  });

  it('parks by stopping the instance and wakes the same one, with every file', async () => {
    const world = await provider.create({ taskId: 'task_park', base: 'main', generation: 1, organizationId: 'org_a' });
    await world.writeFile('cache/kept.txt', 'kept');
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    const [instance] = [...aws.instances.values()];
    await waitFor(() => instance!.state === 'stopped');
    expect(await provider.probe(handle)).toBe('parked');
    const woken = await provider.open(handle);
    expect(aws.instances.size).toBe(1);
    expect(instance).toMatchObject({ state: 'running', launches: 2 });
    expect(await woken.readFile('cache/kept.txt')).toBe('kept');
    // The run before the wake stays countable.
    expect(instance!.tags.karmaxLastRun).toMatch(/^\d+-\d+$/);
  });

  it('wakes at a new size by changing the stopped instance’s type', async () => {
    const world = await provider.create({ taskId: 'task_size', base: 'main', generation: 1, organizationId: 'org_a' });
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    await waitFor(() => [...aws.instances.values()][0]!.state === 'stopped');
    handle.meta = { ...handle.meta, computer: { cpu: 2, memoryMb: 8192 } };
    await provider.open(handle);
    expect([...aws.instances.values()][0]!.instanceType).toBe('m7i-flex.large');
  });

  it('makes a world in another zone when the first has no capacity, and waits when none has', async () => {
    aws.noCapacity.add('c7i-flex.large@eu-central-1a').add('m7i-flex.large@eu-central-1a').add('c7i.large@eu-central-1a');
    await provider.create({ taskId: 'task_zone', base: 'main', generation: 1, organizationId: 'org_a' });
    expect([...aws.instances.values()][0]!.zone).toBe('eu-central-1b');
    // Nothing is left behind in the full zone.
    expect([...aws.volumes.values()].filter((volume) => volume.zone === 'eu-central-1a')).toEqual([]);
    for (const zone of aws.zones) for (const type of ['c7i-flex.large', 'm7i-flex.large', 'c7i.large']) aws.noCapacity.add(`${type}@${zone}`);
    const refused = await provider.create({ taskId: 'task_full', base: 'main', generation: 1, organizationId: 'org_a' }).catch((error) => error);
    expect(refused).toBeInstanceOf(ProviderCapacityFull);
    expect(refused.message).toMatch(/AWS has no c7i-flex.large, c7i.large, m7i-flex.large instance free in eu-central-1/);
    expect([...aws.volumes.values()].filter((volume) => volume.tags.karmaxTaskId === 'task_full')).toEqual([]);
  });

  it('waits out a full vCPU quota, naming it', async () => {
    aws.vcpuLimit = 2;
    await provider.create({ taskId: 'task_q1', base: 'main', generation: 1, organizationId: 'org_a' });
    const refused = await provider.create({ taskId: 'task_q2', base: 'main', generation: 1, organizationId: 'org_a' }).catch((error) => error);
    expect(refused).toBeInstanceOf(ProviderCapacityFull);
    expect(refused.message).toMatch(/vCPU limit of 2[\s\S]*Service Quotas/);
  });

  it('waits when the disk’s zone has no instance free at a wake', async () => {
    const world = await provider.create({ taskId: 'task_wake', base: 'main', generation: 1, organizationId: 'org_a' });
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    await waitFor(() => [...aws.instances.values()][0]!.state === 'stopped');
    for (const type of ['c7i-flex.large', 'm7i-flex.large', 'c7i.large']) aws.noCapacity.add(`${type}@eu-central-1a`);
    const refused = await provider.open(handle).catch((error) => error);
    expect(refused).toBeInstanceOf(ProviderCapacityFull);
    expect(refused.message).toMatch(/where this world's disk is/);
    expect(await provider.probe(handle)).toBe('parked');
  });

  it('replaces an instance AWS ended, on the same volume', async () => {
    const world = await provider.create({ taskId: 'task_gone', base: 'main', generation: 1, organizationId: 'org_a' });
    await world.writeFile('kept.txt', 'still here');
    const handle = world.handle as WorldHandle;
    await provider.park(handle);
    const [first] = [...aws.instances.values()];
    await waitFor(() => first!.state === 'stopped');
    // As if someone terminated it in the console.
    aws.requests.length = 0;
    await (aws.fetch('https://ec2.eu-central-1.amazonaws.com/', { method: 'POST', headers: { authorization: `AWS4-HMAC-SHA256 Credential=${aws.accessKeyId}/x` },
      body: new URLSearchParams({ Action: 'TerminateInstances', 'InstanceId.1': first!.instanceId }).toString() }));
    await waitFor(() => first!.state === 'terminated');
    const woken = await provider.open(handle);
    expect(await woken.readFile('kept.txt')).toBe('still here');
    expect([...aws.instances.values()].filter((instance) => instance.state === 'running')).toHaveLength(1);
  });

  it('grows the disk in place, and says why AWS refuses a second grow within 6 hours', async () => {
    const world = await provider.create({ taskId: 'task_grow', base: 'main', generation: 1, organizationId: 'org_a', resources: { diskGb: 20 } });
    const handle = world.handle as WorldHandle;
    expect(await provider.resize(handle, { diskGb: 40 })).toMatchObject({ disk: 'grown', restart: false, machine: { diskGb: 40 } });
    expect([...aws.volumes.values()].find((volume) => volume.tags.karmaxRole === 'home')!.size).toBe(40);
    await expect(provider.resize({ ...handle, meta: { ...handle.meta, machine: { cpu: 2, memoryMb: 4096, diskGb: 40 } } }, { diskGb: 80 }))
      .rejects.toThrow(/once every 6 hours/);
  });

  it('destroys the instance and both disks', async () => {
    const world = await provider.create({ taskId: 'task_rm', base: 'main', generation: 1, organizationId: 'org_a' });
    await provider.destroy(world.handle as WorldHandle);
    await waitFor(() => aws.volumes.size === 0);
    expect([...aws.instances.values()].map((instance) => instance.state)).toEqual(['terminated']);
  });

  it('reports runs at the Price List’s price plus IPv4, and both disks by the hour', async () => {
    const world = await provider.create({ taskId: 'task_bill', base: 'main', generation: 1, organizationId: 'org_a', resources: { diskGb: 50 } });
    const [instance] = [...aws.instances.values()];
    // Ran 12 minutes, stopped, ran again.
    await provider.park(world.handle as WorldHandle);
    await waitFor(() => instance!.state === 'stopped');
    const start = Math.floor(Date.now() / 1000) * 1000 - 3 * 3_600_000; // EC2 states a stop to the second
    instance!.launchTime = new Date(start).toISOString();
    instance!.reason = `User initiated (${new Date(start + 12 * 60_000).toISOString().slice(0, 19).replace('T', ' ')} GMT)`;
    for (const volume of aws.volumes.values()) volume.createTime = new Date(start).toISOString();
    const events = await driver.usage(connection(aws.key), [...aws.volumes.values()][0]!.tags.karmaxHome!);
    const compute = events.filter((event) => event.kind !== 'disk');
    expect(compute.map((event) => event.activeMs / 60_000)).toEqual([5, 5, 2]);
    expect(compute[0]).toMatchObject({ taskId: 'task_bill', organizationId: 'org_a', cpu: 2, memoryMb: 4096,
      costMicros: Math.round((0.0971 + 0.005) * 5 / 60 * 1e6) });
    const disks = events.filter((event) => event.kind === 'disk');
    expect(disks.filter((event) => event.diskGb === 50)).toHaveLength(3);
    expect(disks.filter((event) => event.diskGb === 20)).toHaveLength(3);
    expect(disks.find((event) => event.diskGb === 50)!.costMicros).toBe(Math.round(50 * 0.0952 / 730 * 1e6));
    // Booked twice, the ids are the same.
    expect((await driver.usage(connection(aws.key), [...aws.volumes.values()][0]!.tags.karmaxHome!)).map((event) => event.id))
      .toEqual(events.map((event) => event.id));
  });

  it('prices from karmax’s own table when the Price List API is closed to the key', async () => {
    aws.priceListDown = true;
    const world = await provider.create({ taskId: 'task_price', base: 'main', generation: 1, organizationId: 'org_a' });
    await provider.park(world.handle as WorldHandle);
    const [instance] = [...aws.instances.values()];
    await waitFor(() => instance!.state === 'stopped');
    instance!.launchTime = new Date(Date.now() - 20 * 60_000).toISOString();
    instance!.reason = `User initiated (${new Date(Date.now() - 10 * 60_000).toISOString().slice(0, 19).replace('T', ' ')} GMT)`;
    const [event] = (await driver.usage(connection(aws.key), instance!.tags.karmaxHome!)).filter((entry) => entry.kind !== 'disk');
    expect(event!.costMicros).toBe(Math.round((0.042395 * 2 + 0.005) * 5 / 60 * 1e6));
  });

  it('refuses a region without a default VPC at the connection test', async () => {
    aws.defaultVpc = false;
    await expect(driver.test(connection(aws.key))).rejects.toThrow(/no default VPC[\s\S]*Create default VPC/);
  });

  it('needs nothing the IAM policy in the docs does not allow', async () => {
    const world = await provider.create({ taskId: 'task_policy', base: 'main', generation: 1, organizationId: 'org_a' });
    const handle = world.handle as WorldHandle;
    await provider.resize(handle, { diskGb: 40 });
    await provider.park(handle);
    await waitFor(() => [...aws.instances.values()][0]!.state === 'stopped');
    handle.meta = { ...handle.meta, computer: { cpu: 2, memoryMb: 8192 } };
    await provider.open(handle);
    await driver.usage(connection(aws.key), [...aws.instances.values()][0]!.tags.karmaxHome!);
    aws.images.push({ imageId: 'ami-old', name: 'old', state: 'available', tags: { karmaxImage: 'old' }, owner: 'self', creationDate: '2026-01-01T00:00:00.000Z', snapshot: 'snap-old' });
    await driver.housekeep(connection(aws.key));
    await provider.destroy(handle);
    const markdown = fs.readFileSync(new URL('../web/docs/computers.md', import.meta.url), 'utf8');
    const policy = JSON.parse(markdown.match(/```json\n([\s\S]*?)```/)![1]!) as { Statement: Array<{ Action: string | string[] }> };
    const allowed = policy.Statement.flatMap((statement) => [statement.Action].flat());
    const used = [...new Set(aws.requests.map((request) => `ec2:${request.action}`))];
    const missing = used.filter((action) => !allowed.some((pattern) => new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(action)));
    expect(missing).toEqual([]);
    expect(used).toEqual(expect.arrayContaining(['ec2:RunInstances', 'ec2:AttachVolume', 'ec2:ModifyVolume', 'ec2:StartInstances',
      'ec2:ModifyInstanceAttribute', 'ec2:CreateTags', 'ec2:DeregisterImage', 'ec2:TerminateInstances', 'ec2:DeleteVolume']));
  });

  it('lists its worlds by home, and housekeeping ends stale builders and old images', async () => {
    const world = await provider.create({ taskId: 'task_list', base: 'main', generation: 1, organizationId: 'org_a' });
    const home = [...aws.instances.values()][0]!.tags.karmaxHome!;
    const listed = await driver.list(connection(aws.key), home);
    expect(listed).toEqual([expect.objectContaining({ taskId: 'task_list', generation: '1' })]);
    expect(driver.same(listed[0]!.ref, JSON.parse(Buffer.from((world.handle as WorldHandle).sealedProviderRef!.slice(5), 'base64url').toString()))).toBe(true);
    aws.images.push({ imageId: 'ami-old', name: 'karmax-vm-old', state: 'available', tags: { karmaxImage: 'old' }, owner: 'self',
      creationDate: '2026-01-01T00:00:00.000Z', snapshot: 'snap-old' });
    await driver.housekeep(connection(aws.key));
    expect(aws.images.map((image) => image.imageId)).not.toContain('ami-old');
    expect(aws.deletedSnapshots).toEqual(['snap-old']);
  });
});

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
