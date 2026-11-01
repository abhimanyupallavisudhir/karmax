import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { SshEndpoint } from '../../src/world/vm/ssh.js';
import { startLocalSshd, type LocalSshd } from './local-sshd.js';

type Tags = Record<string, string>;
interface FakeInstance { instanceId: string; instanceType: string; launchTime: string; zone: string; state: string; reason: string;
  ip: string; subnet: string; groups: string[]; tags: Tags; userData: string; imageId: string; rootSize: number; imds?: string;
  sshd?: LocalSshd; launches: number }
interface FakeVolume { volumeId: string; size: number; zone: string; createTime: string; status: string; tags: Tags;
  attachment?: { instanceId: string; device: string }; dir: string; modifiedAt?: number; rootOf?: string }

/** Instance types as DescribeInstanceTypes answers them (a few of each family). */
export const AWS_TYPES: Array<{ name: string; cpu: number; memoryMb: number }> = [
  { name: 'c7i-flex.large', cpu: 2, memoryMb: 4096 }, { name: 'c7i-flex.xlarge', cpu: 4, memoryMb: 8192 },
  { name: 'm7i-flex.large', cpu: 2, memoryMb: 8192 }, { name: 'm7i-flex.xlarge', cpu: 4, memoryMb: 16384 },
  { name: 'c7i.large', cpu: 2, memoryMb: 4096 }, { name: 'c7i.xlarge', cpu: 4, memoryMb: 8192 },
  { name: 'm7i.large', cpu: 2, memoryMb: 8192 }, { name: 'r7i.large', cpu: 2, memoryMb: 16384 },
  { name: 'r7i.48xlarge', cpu: 192, memoryMb: 1_572_864 },
  // Not one of karmax's families: never chosen, however cheap.
  { name: 't3.medium', cpu: 2, memoryMb: 4096 },
];

/**
 * Amazon EC2's query API (and the Price List API) as an in-memory fetch,
 * answering in EC2's own XML: instances, volumes, the default VPC's subnets,
 * security groups, images, tags. A running instance is a real sshd booted
 * from its cloud-init user data — the keys karmax delivered — with its
 * attached home volume as the VM home.
 */
export class FakeAws {
  instances = new Map<string, FakeInstance>();
  volumes = new Map<string, FakeVolume>();
  groups: Array<{ groupId: string; vpcId: string; tags: Tags; ingress: unknown[] }> = [];
  images: Array<{ imageId: string; name: string; state: string; tags: Tags; owner: string; creationDate: string; snapshot: string }> = [
    { imageId: 'ami-debian-old', name: 'debian-12-amd64-20250101', state: 'available', tags: {}, owner: '136693071363', creationDate: '2025-01-01T00:00:00.000Z', snapshot: 'snap-0' },
    { imageId: 'ami-debian', name: 'debian-12-amd64-20260901', state: 'available', tags: {}, owner: '136693071363', creationDate: '2026-09-01T00:00:00.000Z', snapshot: 'snap-1' },
  ];
  deletedSnapshots: string[] = [];
  requests: Array<{ action: string; params: Record<string, string> }> = [];
  /** Service Quotas calls, as IAM actions (`servicequotas:GetServiceQuota`). */
  quotaRequests: string[] = [];
  zones = ['eu-central-1a', 'eu-central-1b', 'eu-central-1c'];
  /** `type@zone` with no capacity just now. */
  noCapacity = new Set<string>();
  /** Types a zone does not offer at all: `type@zone`. */
  notOffered = new Set<string>();
  /** The account's running On-Demand vCPU quota. */
  vcpuLimit?: number;
  /** Whether the key may read Service Quotas (servicequotas:GetServiceQuota). */
  quotasReadable = false;
  /** The account's gp3 storage quota, in TiB. */
  gp3StorageTiB?: number;
  defaultVpc = true;
  /** Volumes refuse a second modification within 6 hours, as EBS does. */
  priceListDown = false;
  faults: Array<(request: { action: string; params: Record<string, string> }) => Response | undefined> = [];
  private ids = 100;
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-aws-'));
  readonly home = path.join(this.root, 'home');

  constructor(readonly accessKeyId = 'AKIAFAKEFAKEFAKE1234', readonly secret = 'fake/secret+key') {}

  get key(): string { return `${this.accessKeyId}:${this.secret}`; }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (!headers.get('authorization')?.startsWith(`AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/`))
      return xmlError(401, 'AuthFailure', 'AWS was not able to validate the provided access credentials');
    if (url.host === 'api.pricing.us-east-1.amazonaws.com') return this.pricing(JSON.parse(String(init.body)));
    if (url.host.startsWith('servicequotas.')) return this.serviceQuota(headers.get('x-amz-target'), JSON.parse(String(init.body)));
    const params = Object.fromEntries(new URLSearchParams(String(init.body)));
    const request = { action: params.Action!, params };
    this.requests.push(request);
    for (const fault of this.faults) { const answer = fault(request); if (answer) return answer; }
    return this.route(params.Action!, params);
  };

  /** Refuse matching actions `times` times with EC2's error. */
  refuse(action: string, status: number, code: string, message: string, times = 1): void {
    const fault = (request: { action: string }) => {
      if (request.action !== action) return undefined;
      if (--times <= 0) this.faults.splice(this.faults.indexOf(fault), 1);
      return xmlError(status, code, message);
    };
    this.faults.push(fault);
  }

  /** Service Quotas, which an EC2-only key may not read (`quotasReadable` false). */
  private serviceQuota(target: string | null, body: { ServiceCode: string; QuotaCode: string }): Response {
    this.quotaRequests.push(`servicequotas:${target?.split('.').pop()}`);
    if (!this.quotasReadable) return new Response(JSON.stringify({ __type: 'AccessDeniedException',
      message: 'User is not authorized to perform: servicequotas:GetServiceQuota' }), { status: 400 });
    const value = target !== 'ServiceQuotasV20190624.GetServiceQuota' ? undefined
      : body.ServiceCode === 'ec2' && body.QuotaCode === 'L-1216C47A' ? this.vcpuLimit
      : body.ServiceCode === 'ebs' && body.QuotaCode === 'L-7A658B76' ? this.gp3StorageTiB : undefined;
    if (value === undefined) return new Response(JSON.stringify({ __type: 'NoSuchResourceException', message: 'no such quota' }), { status: 400 });
    return new Response(JSON.stringify({ Quota: { QuotaCode: body.QuotaCode, Value: value } }), { status: 200 });
  }

  private pricing(body: { Filters: Array<{ Field: string; Value: string }> }): Response {
    if (this.priceListDown) return new Response('{"message":"not authorized"}', { status: 400 });
    const field = (name: string) => body.Filters.find((filter) => filter.Field === name)?.Value;
    const type = field('instanceType');
    const price = type ? { 'c7i-flex.large': '0.0971', 'm7i-flex.large': '0.1100', 'c7i.large': '0.1020' }[type] ?? '0.2' : '0.0952';
    const unit = type ? 'Hrs' : 'GB-Mo';
    const product = { terms: { OnDemand: { 'X.Y': { priceDimensions: { 'X.Y.Z': { unit, pricePerUnit: { USD: price } } } } } } };
    return new Response(JSON.stringify({ PriceList: [JSON.stringify(product)] }), { status: 200 });
  }

  private route(action: string, p: Record<string, string>): Response {
    const list = (prefix: string) => values(p, prefix);
    const filters = filtersOf(p);
    const ok = (body: Record<string, unknown>) => xml(`${action}Response`, { requestId: 'req', ...body });
    switch (action) {
      case 'DescribeInstanceTypes': {
        const patterns = filters['instance-type'] ?? ['*'];
        return ok({ instanceTypeSet: AWS_TYPES.filter((type) => patterns.some((pattern) => glob(pattern, type.name)))
          .map((type) => ({ instanceType: type.name, vCpuInfo: { defaultVCpus: type.cpu }, memoryInfo: { sizeInMiB: type.memoryMb } })) });
      }
      case 'DescribeInstanceTypeOfferings': {
        const patterns = filters['instance-type'] ?? ['*'];
        return ok({ instanceTypeOfferingSet: AWS_TYPES.filter((type) => patterns.some((pattern) => glob(pattern, type.name)))
          .flatMap((type) => this.zones.filter((zone) => !this.notOffered.has(`${type.name}@${zone}`))
            .map((zone) => ({ instanceType: type.name, locationType: 'availability-zone', location: zone }))) });
      }
      case 'DescribeVpcs': return ok({ vpcSet: this.defaultVpc ? [{ vpcId: 'vpc-default', isDefault: true }] : [] });
      case 'DescribeSubnets': return ok({ subnetSet: this.defaultVpc ? this.zones.map((zone) =>
        ({ subnetId: `subnet-${zone}`, availabilityZone: zone, state: 'available', vpcId: 'vpc-default', defaultForAz: true })) : [] });
      case 'DescribeSecurityGroups': return ok({ securityGroupInfo: this.groups.filter((group) => matches(group.tags, filters))
        .map((group) => ({ groupId: group.groupId, vpcId: group.vpcId, tagSet: tagSet(group.tags) })) });
      case 'CreateSecurityGroup': {
        const group = { groupId: `sg-${++this.ids}`, vpcId: p.VpcId!, tags: tagsOf(p, 'TagSpecification.1.Tag'), ingress: [] as unknown[] };
        this.groups.push(group);
        return ok({ return: true, groupId: group.groupId });
      }
      case 'AuthorizeSecurityGroupIngress': {
        this.groups.find((group) => group.groupId === p.GroupId)!.ingress.push({ protocol: p['IpPermissions.1.IpProtocol'],
          from: p['IpPermissions.1.FromPort'], to: p['IpPermissions.1.ToPort'], cidr: p['IpPermissions.1.IpRanges.1.CidrIp'] });
        return ok({ return: true });
      }
      case 'DescribeImages': {
        const ids = list('ImageId');
        const owners = list('Owner');
        return ok({ imagesSet: this.images.filter((image) => (!ids.length || ids.includes(image.imageId))
          && (!owners.length || owners.some((owner) => owner === image.owner || (owner === 'self' && image.owner === 'self')))
          && matches({ ...image.tags, name: image.name, architecture: 'x86_64' }, filters))
          .map((image) => ({ imageId: image.imageId, name: image.name, imageState: image.state, creationDate: image.creationDate,
            rootDeviceName: '/dev/xvda', tagSet: tagSet(image.tags), blockDeviceMapping: [{ deviceName: '/dev/xvda', ebs: { snapshotId: image.snapshot } }] })) });
      }
      case 'CreateImage': {
        const image = { imageId: `ami-${++this.ids}`, name: p.Name!, state: 'available', tags: tagsOf(p, 'TagSpecification.1.Tag'), owner: 'self',
          creationDate: new Date().toISOString(), snapshot: `snap-${this.ids}` };
        this.images.push(image);
        return ok({ imageId: image.imageId });
      }
      case 'DeregisterImage': this.images = this.images.filter((image) => image.imageId !== p.ImageId); return ok({ return: true });
      case 'DeleteSnapshot': this.deletedSnapshots.push(p.SnapshotId!); return ok({ return: true });
      case 'CreateVolume': {
        const volume: FakeVolume = { volumeId: `vol-0${++this.ids}abc`, size: Number(p.Size), zone: p.AvailabilityZone!, createTime: new Date().toISOString(),
          status: 'available', tags: tagsOf(p, 'TagSpecification.1.Tag'), dir: path.join(this.root, `vol_${this.ids}`) };
        fs.mkdirSync(volume.dir);
        this.volumes.set(volume.volumeId, volume);
        return ok(this.volumeView(volume));
      }
      case 'DescribeVolumes': {
        const ids = list('VolumeId');
        const missing = ids.find((id) => !this.volumes.has(id));
        if (missing) return xmlError(400, 'InvalidVolume.NotFound', `The volume '${missing}' does not exist.`);
        return ok({ volumeSet: [...this.volumes.values()].filter((volume) => (!ids.length || ids.includes(volume.volumeId))
          && matches(volume.tags, filters)).map((volume) => this.volumeView(volume)) });
      }
      case 'DeleteVolume': {
        const volume = this.volumes.get(p.VolumeId!);
        if (!volume) return xmlError(400, 'InvalidVolume.NotFound', 'no such volume');
        if (volume.attachment) return xmlError(400, 'VolumeInUse', `Volume ${volume.volumeId} is currently attached`);
        this.volumes.delete(volume.volumeId);
        fs.rmSync(volume.dir, { recursive: true, force: true });
        return ok({ return: true });
      }
      case 'ModifyVolume': {
        const volume = this.volumes.get(p.VolumeId!)!;
        if (volume.modifiedAt && Date.now() - volume.modifiedAt < 6 * 3_600_000)
          return xmlError(400, 'VolumeModificationRateExceeded', "You've reached the maximum modification rate per volume limit. Wait at least 6 hours between modifications per EBS volume.");
        volume.size = Number(p.Size);
        volume.modifiedAt = Date.now();
        return ok({ volumeModification: { volumeId: volume.volumeId, modificationState: 'modifying', targetSize: volume.size } });
      }
      case 'DescribeVolumesModifications': return ok({ volumeModificationSet: list('VolumeId').map((id) =>
        ({ volumeId: id, modificationState: 'optimizing', targetSize: this.volumes.get(id)!.size })) });
      case 'AttachVolume': {
        const volume = this.volumes.get(p.VolumeId!)!;
        const instance = this.instances.get(p.InstanceId!)!;
        if (volume.attachment) return xmlError(400, 'VolumeInUse', 'already attached');
        if (volume.zone !== instance.zone) return xmlError(400, 'InvalidVolume.ZoneMismatch', 'zones differ');
        volume.attachment = { instanceId: instance.instanceId, device: p.Device! };
        volume.status = 'in-use';
        this.linkHome(instance);
        return ok({ volumeId: volume.volumeId, instanceId: instance.instanceId, device: p.Device, status: 'attaching' });
      }
      case 'RunInstances': return this.runInstance(p);
      case 'DescribeInstances': {
        const ids = list('InstanceId');
        const missing = ids.find((id) => !this.instances.has(id));
        if (missing) return xmlError(400, 'InvalidInstanceID.NotFound', `The instance ID '${missing}' does not exist`);
        const found = [...this.instances.values()].filter((instance) => (!ids.length || ids.includes(instance.instanceId))
          && matches(instance.tags, filters));
        return ok({ reservationSet: found.map((instance) => ({ reservationId: 'r-1', instancesSet: [this.instanceView(instance)] })) });
      }
      case 'StartInstances': {
        const instance = this.instances.get(list('InstanceId')[0]!)!;
        if (this.noCapacity.has(`${instance.instanceType}@${instance.zone}`))
          return xmlError(500, 'InsufficientInstanceCapacity', `We currently do not have sufficient ${instance.instanceType} capacity in the Availability Zone you requested`);
        if (instance.state !== 'stopped') return xmlError(400, 'IncorrectInstanceState', `The instance '${instance.instanceId}' is not in a state from which it can be started.`);
        void this.boot(instance);
        return ok({ instancesSet: [{ instanceId: instance.instanceId, currentState: { name: 'pending' } }] });
      }
      case 'StopInstances': {
        for (const id of list('InstanceId')) void this.halt(this.instances.get(id)!);
        return ok({ instancesSet: [] });
      }
      case 'TerminateInstances': {
        for (const id of list('InstanceId')) {
          const instance = this.instances.get(id);
          if (!instance) return xmlError(400, 'InvalidInstanceID.NotFound', 'no such instance');
          void this.halt(instance).then(() => {
            instance.state = 'terminated';
            instance.reason = `User initiated (${gmt(new Date())})`;
            for (const volume of this.volumes.values()) {
              if (volume.attachment?.instanceId !== id) continue;
              if (volume.rootOf === id) { this.volumes.delete(volume.volumeId); continue; }
              volume.attachment = undefined;
              volume.status = 'available';
            }
          });
        }
        return ok({ instancesSet: [] });
      }
      case 'ModifyInstanceAttribute': {
        const instance = this.instances.get(p.InstanceId!)!;
        if (instance.state !== 'stopped') return xmlError(400, 'IncorrectInstanceState', 'must be stopped');
        instance.instanceType = p['InstanceType.Value']!;
        return ok({ return: true });
      }
      case 'CreateTags': {
        for (const id of list('ResourceId')) {
          const target = this.instances.get(id) ?? this.volumes.get(id);
          Object.assign(target!.tags, tagsOf(p, 'Tag'));
        }
        return ok({ return: true });
      }
    }
    return xmlError(400, 'InvalidAction', `The action ${action} is not valid for this web service.`);
  }

  private runInstance(p: Record<string, string>): Response {
    const type = p.InstanceType!;
    const subnet = p['NetworkInterface.1.SubnetId']!;
    const zone = subnet.replace(/^subnet-/, '');
    if (this.noCapacity.has(`${type}@${zone}`))
      return xmlError(500, 'InsufficientInstanceCapacity', `We currently do not have sufficient ${type} capacity in the Availability Zone you requested (${zone}).`);
    const cpu = AWS_TYPES.find((entry) => entry.name === type)?.cpu ?? 2;
    const running = [...this.instances.values()].filter((instance) => ['pending', 'running'].includes(instance.state))
      .reduce((sum, instance) => sum + (AWS_TYPES.find((entry) => entry.name === instance.instanceType)?.cpu ?? 2), 0);
    if (this.vcpuLimit !== undefined && running + cpu > this.vcpuLimit)
      return xmlError(400, 'VcpuLimitExceeded', `You have requested more vCPU capacity than your current vCPU limit of ${this.vcpuLimit} allows for the instance bucket that the specified instance type belongs to.`);
    const instance: FakeInstance = { instanceId: `i-0${++this.ids}`, instanceType: type, launchTime: new Date().toISOString(), zone, state: 'pending',
      reason: '', ip: `10.1.0.${this.ids % 250}`, subnet, groups: values(p, 'NetworkInterface.1.SecurityGroupId'), tags: tagsOf(p, 'TagSpecification.1.Tag'),
      userData: Buffer.from(p.UserData ?? '', 'base64').toString(), imageId: p.ImageId!, rootSize: Number(p['BlockDeviceMapping.1.Ebs.VolumeSize']),
      imds: p['MetadataOptions.HttpTokens'], launches: 0 };
    this.instances.set(instance.instanceId, instance);
    const root: FakeVolume = { volumeId: `vol-0${++this.ids}root`, size: instance.rootSize, zone, createTime: instance.launchTime, status: 'in-use',
      tags: tagsOf(p, 'TagSpecification.2.Tag'), attachment: { instanceId: instance.instanceId, device: '/dev/xvda' }, dir: path.join(this.root, `root_${this.ids}`),
      rootOf: instance.instanceId };
    fs.mkdirSync(root.dir);
    this.volumes.set(root.volumeId, root);
    void this.boot(instance);
    return xml('RunInstancesResponse', { requestId: 'req', reservationId: 'r-1', instancesSet: [this.instanceView(instance)] });
  }

  private volumeView(volume: FakeVolume) {
    return { volumeId: volume.volumeId, size: volume.size, availabilityZone: volume.zone, status: volume.status, createTime: volume.createTime,
      volumeType: 'gp3', tagSet: tagSet(volume.tags),
      attachmentSet: volume.attachment ? [{ volumeId: volume.volumeId, instanceId: volume.attachment.instanceId, device: volume.attachment.device, status: 'attached' }] : [] };
  }

  private instanceView(instance: FakeInstance) {
    return { instanceId: instance.instanceId, imageId: instance.imageId, instanceState: { code: 16, name: instance.state },
      reason: instance.reason, instanceType: instance.instanceType, launchTime: instance.launchTime,
      placement: { availabilityZone: instance.zone }, subnetId: instance.subnet,
      ...(instance.state === 'running' ? { ipAddress: instance.ip } : {}), tagSet: tagSet(instance.tags) };
  }

  /** The home volume attached to an instance is the VM home. */
  private linkHome(instance: FakeInstance): void {
    const volume = [...this.volumes.values()].find((entry) => entry.attachment?.instanceId === instance.instanceId && !entry.rootOf);
    if (!volume) return;
    fs.rmSync(this.home, { force: true });
    fs.symlinkSync(volume.dir, this.home);
  }

  /** What cloud-init and the boot script do: sshd with the delivered keys. */
  private async boot(instance: FakeInstance): Promise<void> {
    const files = new Map<string, string>();
    for (const match of instance.userData.matchAll(/- path: (\S+)\n {4}permissions: '\d+'\n {4}encoding: b64\n {4}content: (\S+)/g))
      files.set(match[1]!, Buffer.from(match[2]!, 'base64').toString());
    const hostPrivate = files.get('/etc/karmax/ssh_host_ed25519_key')!;
    const { utils } = await import('ssh2');
    const parsed = utils.parseKey(hostPrivate) as any;
    instance.launchTime = new Date().toISOString();
    instance.launches++;
    instance.sshd = await startLocalSshd({ hostKey: { privateKey: hostPrivate, publicKey: `${parsed.type} ${parsed.getPublicSSH().toString('base64')}` },
      clientKey: { privateKey: '', publicKey: files.get('/etc/karmax/authorized_keys')!.trim() } });
    instance.state = 'running';
    this.linkHome(instance);
  }

  private async halt(instance: FakeInstance): Promise<void> {
    if (instance.state === 'stopped' || instance.state === 'terminated') return;
    instance.state = 'stopping';
    await instance.sshd?.stop();
    instance.sshd = undefined;
    instance.state = 'stopped';
    instance.reason = `User initiated (${gmt(new Date())})`;
  }

  /** The network: `<instance ip>:2222` reaches that instance's sshd. */
  socket = async (endpoint: Pick<SshEndpoint, 'host' | 'port'>): Promise<Duplex> => {
    const instance = [...this.instances.values()].find((value) => value.ip === endpoint.host && value.sshd);
    if (!instance || endpoint.port !== 2222) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    return new Promise((resolve, reject) => {
      const socket = net.connect(instance.sshd!.endpoint.port, '127.0.0.1', () => resolve(socket));
      socket.on('error', reject);
    });
  };

  async close(): Promise<void> {
    for (const instance of this.instances.values()) await instance.sshd?.stop();
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

function gmt(date: Date): string { return `${date.toISOString().slice(0, 19).replace('T', ' ')} GMT`; }

/** `Prefix.1`, `Prefix.2`, … */
function values(params: Record<string, string>, prefix: string): string[] {
  const out: string[] = [];
  for (let index = 1; params[`${prefix}.${index}`] !== undefined; index++) out.push(params[`${prefix}.${index}`]!);
  return out;
}
function tagsOf(params: Record<string, string>, prefix: string): Tags {
  const tags: Tags = {};
  for (let index = 1; params[`${prefix}.${index}.Key`] !== undefined; index++) tags[params[`${prefix}.${index}.Key`]!] = params[`${prefix}.${index}.Value`] ?? '';
  return tags;
}
function filtersOf(params: Record<string, string>): Record<string, string[]> {
  const filters: Record<string, string[]> = {};
  for (let index = 1; params[`Filter.${index}.Name`] !== undefined; index++) filters[params[`Filter.${index}.Name`]!] = values(params, `Filter.${index}.Value`);
  return filters;
}
function matches(tags: Tags, filters: Record<string, string[]>): boolean {
  return Object.entries(filters).every(([name, wanted]) => {
    if (name === 'tag-key') return wanted.some((key) => key in tags);
    if (name.startsWith('tag:')) return wanted.includes(tags[name.slice(4)] ?? '\u0000');
    if (name === 'vpc-id' || name === 'is-default' || name === 'default-for-az' || name === 'processor-info.supported-architecture' || name === 'bare-metal') return true;
    if (name in tags) return wanted.some((pattern) => glob(pattern, tags[name]!));
    return true;
  });
}
function glob(pattern: string, value: string): boolean {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);
}
function tagSet(tags: Tags) { return Object.entries(tags).map(([key, value]) => ({ key, value })); }

function toXml(name: string, value: unknown): string {
  if (Array.isArray(value)) return `<${name}>${value.map((item) => toXml('item', item)).join('')}</${name}>`;
  if (value && typeof value === 'object') return `<${name}>${Object.entries(value).map(([key, item]) => toXml(key, item)).join('')}</${name}>`;
  if (value === undefined) return '';
  return `<${name}>${String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</${name}>`;
}
function xml(root: string, body: Record<string, unknown>): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${toXml(root, body).replace(`<${root}>`, `<${root} xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">`)}`,
    { status: 200, headers: { 'content-type': 'text/xml' } });
}
function xmlError(status: number, code: string, message: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Errors><Error><Code>${code}</Code><Message>${message.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Message></Error></Errors><RequestID>req</RequestID></Response>`,
    { status, headers: { 'content-type': 'text/xml' } });
}
