import crypto from 'node:crypto';
import type { MachineShape } from '../domain/computer.js';
import type { ComputerLimits } from '../domain/computer-limits.js';
import type { ResolvedWorldProviderConnection } from './connections.js';
import type { ProviderUsageEvent, WorldLifecycleState } from './types.js';
import { runDetached, type VmAllocation, type VmBootKeys, type VmDriver, type VmListing, type VmShape } from './vm/provider.js';
import { cloudInit, VM_ETC, VM_SSH_PORT, VM_USER, vmProvisionScript, vmProvisionStamp, vmProvisionVersion } from './vm/provision.js';
import { decodeRun, diskHours, encodeRun, FINAL_USAGE_WINDOW_MS, runSlices, type FinalUsage, type MachineRun } from './vm/runs.js';
import { generateSshKeyPair, quote, SshTransport } from './vm/ssh.js';
import { ProviderCapacityFull, ProviderOutage } from '../agent/limits.js';

/**
 * Amazon EC2 instances as VM worlds (`vm/provider.ts`). The world's files are
 * an EBS volume (gp3, up to 16 TiB, grown in place) mounted as the VM home;
 * the instance around it boots from karmax's provisioned image.
 *
 * EC2 bills an instance per second while it runs and a stopped one nothing
 * but its disks, so a park simply stops the instance: its root disk, and so
 * the project's setup, survive, and a wake is a start (~20 s). A new size is
 * applied to the stopped instance. An instance that will not answer is
 * replaced by a new one in the volume's availability zone.
 *
 * Instance types: the current Intel families with no CPU credits, so what a
 * machine costs is its hourly price and nothing else (a T-family instance
 * past its credits bills a surplus EC2 reports to no API). `-flex` types are
 * the cheapest of them; their CPUs run at full speed most of the time.
 *
 * The API is EC2's query API, signed with SigV4 (no SDK, as the S3 store).
 * Creates carry a client token, so any request can be sent again.
 */

const API_VERSION = '2016-11-15';
export const AWS_DEFAULT_REGION = 'eu-central-1';
/** Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances, in vCPUs. */
const AWS_STANDARD_VCPU_QUOTA = 'L-1216C47A';
/** Storage for General Purpose SSD (gp3) volumes, in TiB. */
const AWS_GP3_STORAGE_QUOTA = 'L-7A658B76';
export const AWS_MAX_DISK_GB = 16_384;
export const AWS_DEFAULT_DISK_GB = 20;
/** The root disk: the system and karmax's tools; the world is on its own volume. */
const ROOT_DISK_GB = 20;
/** Debian's own AMIs (wiki.debian.org/Cloud/AmazonEC2Image). */
const DEBIAN_OWNER = '136693071363';
const DEBIAN_IMAGES = 'debian-12-amd64-*';
const HOME_DEVICE = '/dev/sdf';
/** The families karmax rents, with their us-east-1 price per vCPU-hour: the
 * order of preference, and the price when the Price List API cannot be read. */
const FAMILIES: Record<string, number> = { 'c7i-flex': 0.042395, 'm7i-flex': 0.04788, c7i: 0.044625, m7i: 0.0504, r7i: 0.06615 };
/** A public IPv4 address, per hour, in every region (2024-02 onward). */
const IPV4_HOURLY = 0.005;
const GP3_GB_MONTH = 0.08;
const BUILDER_STALE_MS = 60 * 60_000;
const API_RETRIES = 4;
/** How many instance types a launch or a start tries when one has no capacity. */
const TYPE_FALLBACKS = 3;
const RETRIED = new Set(['RequestLimitExceeded', 'Throttling', 'ThrottlingException', 'RequestThrottled', 'InternalError',
  'InternalFailure', 'ServiceUnavailable', 'Unavailable', 'RequestExpired']);
/** None of the instance type in the zone just now, or never there: try another. */
const NO_CAPACITY = new Set(['InsufficientInstanceCapacity', 'InsufficientHostCapacity', 'InsufficientReservedInstanceCapacity',
  'InsufficientVolumeCapacity', 'Unsupported']);
/** The account's own limits (Service Quotas): only time or AWS raise them. */
const ACCOUNT_LIMIT = new Set(['VcpuLimitExceeded', 'InstanceLimitExceeded', 'VolumeLimitExceeded', 'MaxIOPSLimitExceeded',
  'AddressLimitExceeded', 'MaxSpotInstanceCountExceeded']);

type Fetch = typeof fetch;

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

/** An access key as it is pasted: `ID:SECRET`, the console's CSV download, or JSON. */
export function awsCredentials(apiKey: string): AwsCredentials {
  const text = apiKey.trim();
  if (text.startsWith('{')) {
    const value = JSON.parse(text) as Record<string, string>;
    const accessKeyId = value.accessKeyId ?? value.AccessKeyId ?? value.aws_access_key_id;
    const secretAccessKey = value.secretAccessKey ?? value.SecretAccessKey ?? value.aws_secret_access_key;
    if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey, ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}) };
  }
  const fields = text.split(/[\s,:]+/).filter((field) => field && !/^(access|secret|key|id)$/i.test(field));
  const id = fields.find((field) => /^(AKIA|ASIA)[A-Z0-9]{12,}$/.test(field));
  const secret = id ? fields[fields.indexOf(id) + 1] : undefined;
  if (!id || !secret) throw new Error('an AWS key is an access key ID and its secret access key');
  return { accessKeyId: id, secretAccessKey: secret };
}

/** SigV4 headers for one request (docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html). */
export function signAws(request: { method: string; url: URL; headers: Record<string, string>; body: string },
  credentials: AwsCredentials, region: string, service: string, now = new Date()): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(request.body);
  const headers: Record<string, string> = { ...request.headers, host: request.url.host, 'x-amz-date': amzDate,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}) };
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const canonical = [request.method, request.url.pathname || '/', request.url.search.slice(1),
    names.map((name) => `${name}:${String(lower[name]).trim()}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = [date, region, service, 'aws4_request'].reduce<Buffer>((secret, part) => hmac(secret, part), Buffer.from(`AWS4${credentials.secretAccessKey}`));
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, `
    + `SignedHeaders=${names.join(';')}, Signature=${hmac(key, toSign).toString('hex')}` };
}

/**
 * EC2's XML as plain values: an element with text is its text; one with
 * elements, an object of them (a repeated name becomes an array); a `…Set`
 * (EC2's lists, `<item>` per entry) an array, empty or not.
 */
export function parseXml(xml: string): Record<string, any> {
  interface Node { name: string; children: Array<[string, unknown]>; text: string }
  const value = (node: Node): unknown => {
    if (node.name.endsWith('Set') || (node.children.length && node.children.every(([name]) => name === 'item')))
      return node.children.map(([, child]) => child);
    if (!node.children.length) return decode(node.text);
    const grouped = new Map<string, unknown[]>();
    for (const [name, child] of node.children) grouped.set(name, [...(grouped.get(name) ?? []), child]);
    return Object.fromEntries([...grouped].map(([name, values]) => [name, values.length === 1 ? values[0] : values]));
  };
  const stack: Node[] = [{ name: 'root', children: [], text: '' }];
  for (const match of xml.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>|([^<]+)/g)) {
    const [, closing, name, selfClosing, text] = match;
    const top = stack[stack.length - 1]!;
    if (text !== undefined) { top.text += text; continue; }
    if (!name) continue;
    if (closing) {
      const node = stack.pop()!;
      stack[stack.length - 1]!.children.push([node.name, value(node)]);
    } else if (selfClosing) top.children.push([name, value({ name, children: [], text: '' })]);
    else stack.push({ name, children: [], text: '' });
  }
  return value(stack[0]!) as Record<string, any>;
}

function decode(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) =>
    ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()]
      ?? String.fromCodePoint(entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))));
}

/** EC2's query parameters from nested values: lists are numbered from 1, objects dotted. */
export function ec2Query(params: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, index) => walk(`${prefix}.${index + 1}`, item));
    else if (typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(prefix ? `${prefix}.${key}` : key, item);
    else out.push([prefix, String(value)]);
  };
  walk('', params);
  return out;
}

/** A list in an EC2 answer: absent, one entry, or several. */
function list<T>(value: unknown): T[] {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function tagsOf(value: unknown): Record<string, string> {
  return Object.fromEntries(list<{ key: string; value?: string }>(value).map((tag) => [tag.key, typeof tag.value === 'string' ? tag.value : '']));
}
function tagList(tags: Record<string, string>): Array<{ Key: string; Value: string }> {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}

interface Instance {
  instanceId: string; instanceType: string; launchTime: string; placement: { availabilityZone: string };
  /** `reason`: EC2's StateTransitionReason, "User initiated (2026-10-19 12:00:00 GMT)". */
  instanceState: { name: string }; ipAddress?: string; reason?: string; tagSet?: unknown;
  blockDeviceMapping?: unknown;
}
interface Volume { volumeId: string; size: string; createTime: string; availabilityZone: string; status: string;
  attachmentSet?: unknown; tagSet?: unknown }
interface InstanceType { name: string; family: string; cpu: number; memoryMb: number }

export class AwsDriver implements VmDriver {
  readonly kind = 'aws';
  readonly name = 'AWS';
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private building = new Map<string, Promise<void>>();

  /** `pollMs` is the driver's second: every wait is a multiple of it (tests shrink it). */
  constructor(private fetchImpl: Fetch = fetch, private pollMs = 1_000,
    /** Test seam: how the image builder reaches its instance over SSH. */
    private builderTransport?: (host: string, keys: { privateKey: string; hostKey: string }) => SshTransport) {}

  /** The cheapest instance type of karmax's families that covers the Computer. */
  async shape(resources: MachineShape | undefined, connection: ResolvedWorldProviderConnection): Promise<VmShape> {
    const diskGb = Math.max(1, resources?.diskGb ?? AWS_DEFAULT_DISK_GB);
    if (diskGb > AWS_MAX_DISK_GB) throw new Error(`An AWS volume holds at most ${AWS_MAX_DISK_GB} GB, not ${diskGb} GB`);
    const type = (await this.typesFor(connection, { cpu: resources?.cpu ?? 2, memoryMb: resources?.memoryMb ?? 2048 }))[0]!;
    return { cpu: type.cpu, memoryMb: type.memoryMb, diskGb };
  }

  async allocate(connection: ResolvedWorldProviderConnection, request: { labels: Record<string, string>; shape: VmShape;
    keys: VmBootKeys; signal?: AbortSignal }): Promise<VmAllocation> {
    const region = this.region(connection);
    const world = worldName(request.labels);
    const tags = { ...request.labels, karmaxWorld: world };
    const [image, group, subnets, types] = await Promise.all([this.image(connection), this.securityGroup(connection),
      this.subnets(connection), this.typesFor(connection, request.shape)]);
    if (!image.karmax) this.buildImage(connection);
    const offered = await this.offerings(connection, types.map((type) => type.name));
    let refused: unknown;
    // Zone by zone: the volume is made where an instance of the type can be.
    for (const subnet of subnets) {
      const here = types.filter((type) => offered.get(type.name)?.has(subnet.zone)).slice(0, TYPE_FALLBACKS);
      if (!here.length) continue;
      request.signal?.throwIfAborted();
      const volume = await this.createVolume(connection, subnet.zone, request.shape.diskGb, { ...tags, karmaxRole: 'home', Name: world });
      const ref = { volume: volume.volumeId, region, zone: subnet.zone, world };
      try {
        const instance = await this.launch(connection, { types: here, subnet: subnet.id, image, group, tags: { ...tags, Name: world },
          userData: cloudInit(request.keys, homeDevice(volume.volumeId)) });
        if (!instance) { refused = new Error(`no ${here.map((type) => type.name).join(', ')} free in ${subnet.zone}`); await this.destroy(connection, ref); continue; }
        await this.waitVolume(connection, volume.volumeId, 'available');
        await this.waitInstance(connection, instance.instanceId, ['running']);
        await this.ec2(connection)('AttachVolume', { VolumeId: volume.volumeId, InstanceId: instance.instanceId, Device: HOME_DEVICE });
        return { ref };
      } catch (error) {
        await this.destroy(connection, ref).catch(() => undefined);
        throw error;
      }
    }
    throw new ProviderCapacityFull(`AWS has no ${types.slice(0, TYPE_FALLBACKS).map((type) => type.name).join(', ')} instance free in ${region} just now. `
      + 'tavya waits until one is free; to start sooner, give this task another size.', { cause: refused });
  }

  async endpoint(connection: ResolvedWorldProviderConnection, ref: Record<string, string>) {
    const instance = await this.instanceOf(connection, ref);
    const host = instance?.instanceState.name === 'running' ? instance.ipAddress : undefined;
    if (!host) throw Object.assign(new Error('the AWS instance of this world is not running'), { code: 'ECONNREFUSED' });
    return { host, port: VM_SSH_PORT };
  }

  async start(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, shape: VmShape, keys: VmBootKeys): Promise<void> {
    let instance = await this.instanceOf(connection, ref);
    if (!instance || ['shutting-down', 'terminated'].includes(instance.instanceState.name)) return this.replace(connection, ref, shape, keys);
    if (['pending', 'running'].includes(instance.instanceState.name)) return;
    if (instance.instanceState.name === 'stopping') instance = await this.waitInstance(connection, instance.instanceId, ['stopped']);
    const api = this.ec2(connection);
    // The run that just ended stays countable until the feed books it (`usage`).
    const ended = stoppedAt(instance);
    if (ended) await api('CreateTags', { ResourceId: [instance.instanceId], Tag: tagList({ karmaxLastRun: encodeRun({ start: Date.parse(instance.launchTime), end: ended }) }) });
    const zone = instance.placement.availabilityZone;
    const fitting = await this.typesFor(connection, shape);
    const offered = await this.offerings(connection, fitting.map((type) => type.name));
    const types = fitting.filter((type) => offered.get(type.name)?.has(zone)).slice(0, TYPE_FALLBACKS);
    let refused: unknown;
    for (const type of types) {
      try {
        if (instance.instanceType !== type.name) {
          await api('ModifyInstanceAttribute', { InstanceId: instance.instanceId, InstanceType: { Value: type.name } });
          instance.instanceType = type.name;
        }
        await api('StartInstances', { InstanceId: [instance.instanceId] });
        return;
      } catch (error) {
        if (!NO_CAPACITY.has((error as AwsError).code ?? '')) throw error;
        refused = error;
      }
    }
    throw new ProviderCapacityFull(`AWS has no ${types.map((type) => type.name).join(', ') || 'instance of this size'} free in `
      + `${zone}, where this world's disk is, just now. tavya waits until one is free; `
      + 'to start sooner, give this task another size.', { cause: refused });
  }

  /** A new instance on the world's volume, in place of any it has. */
  async replace(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, shape: VmShape, keys: VmBootKeys): Promise<void> {
    await this.terminate(connection, ref);
    const volume = await this.volume(connection, ref.volume!);
    if (!volume) throw Object.assign(new Error('the AWS volume of this world no longer exists'), { status: 404 });
    await this.waitVolume(connection, volume.volumeId, 'available');
    const [image, group, subnets, types] = await Promise.all([this.image(connection), this.securityGroup(connection),
      this.subnets(connection), this.typesFor(connection, shape)]);
    const subnet = subnets.find((entry) => entry.zone === volume.availabilityZone);
    if (!subnet) throw new Error(`the default VPC has no subnet in ${volume.availabilityZone}, where this world's disk is`);
    const offered = await this.offerings(connection, types.map((type) => type.name));
    const here = types.filter((type) => offered.get(type.name)?.has(subnet.zone)).slice(0, TYPE_FALLBACKS);
    const tags = Object.fromEntries(Object.entries(tagsOf(volume.tagSet)).filter(([key]) => key.startsWith('karmax') && key !== 'karmaxRole'));
    const instance = await this.launch(connection, { types: here, subnet: subnet.id, image, group, tags: { ...tags, Name: ref.world! },
      userData: cloudInit(keys, homeDevice(volume.volumeId)) });
    if (!instance) throw new ProviderCapacityFull(`AWS has no ${here.map((type) => type.name).join(', ')} instance free in ${subnet.zone}, `
      + 'where this world\'s disk is, just now. tavya waits until one is free; to start sooner, give this task another size.');
    await this.waitInstance(connection, instance.instanceId, ['running']);
    await this.ec2(connection)('AttachVolume', { VolumeId: volume.volumeId, InstanceId: instance.instanceId, Device: HOME_DEVICE });
  }

  /** Stop the instance. Returns once EC2 has begun (it says stopping): a
   * park that returned while it still said running read as not parked. */
  async stop(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    const instance = await this.instanceOf(connection, ref);
    if (!instance || !['pending', 'running'].includes(instance.instanceState.name)) return;
    await this.ec2(connection)('StopInstances', { InstanceId: [instance.instanceId] });
    await this.waitInstance(connection, instance.instanceId, ['stopping', 'stopped']);
  }

  async destroy(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    await this.terminate(connection, ref);
    if (!ref.volume || !(await this.volume(connection, ref.volume))) return;
    for (let attempt = 0; ; attempt++) {
      try { await this.ec2(connection)('DeleteVolume', { VolumeId: ref.volume }); return; }
      catch (error) {
        const code = (error as AwsError).code ?? '';
        if (code === 'InvalidVolume.NotFound') return;
        // Still detaching from the terminated instance.
        if (attempt >= 60 || !['VolumeInUse', 'IncorrectState'].includes(code)) throw error;
        await this.sleep(3);
      }
    }
  }

  async growDisk(connection: ResolvedWorldProviderConnection, ref: Record<string, string>, diskGb: number): Promise<boolean> {
    if (diskGb > AWS_MAX_DISK_GB) throw new Error(`An AWS volume holds at most ${AWS_MAX_DISK_GB} GB`);
    const volume = await this.volume(connection, ref.volume!);
    if (!volume) throw Object.assign(new Error('the AWS volume of this world no longer exists'), { status: 404 });
    if (Number(volume.size) >= diskGb) return false;
    try { await this.ec2(connection)('ModifyVolume', { VolumeId: volume.volumeId, Size: diskGb }); }
    catch (error) {
      if (/rate|6 hours|modification/i.test((error as Error).message) && (error as AwsError).code !== 'InvalidParameterValue')
        throw new Error('AWS lets a disk grow once every 6 hours, and this world\'s grew less than 6 hours ago. Ask again later.', { cause: error });
      throw error;
    }
    // The machine sees the new size once the modification is optimizing.
    const until = Date.now() + 600 * this.pollMs;
    for (;;) {
      const answer = await this.ec2(connection)('DescribeVolumesModifications', { VolumeId: [volume.volumeId] });
      const state = list<{ modificationState: string; targetSize: string }>(answer.volumeModificationSet)
        .find((entry) => Number(entry.targetSize) === diskGb)?.modificationState;
      if (state === 'optimizing' || state === 'completed') return true;
      if (state === 'failed') throw new AwsOutage(`AWS could not grow the disk to ${diskGb} GB`);
      if (Date.now() > until) throw new AwsOutage(`AWS did not grow the disk to ${diskGb} GB within 10 minutes`);
      await this.sleep(2);
    }
  }

  async state(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<WorldLifecycleState | undefined> {
    if (!ref.volume || !(await this.volume(connection, ref.volume))) return 'missing';
    const instance = await this.instanceOf(connection, ref);
    return instance && ['pending', 'running'].includes(instance.instanceState.name) ? 'ready' : 'parked';
  }

  async list(connection: ResolvedWorldProviderConnection, home: string): Promise<VmListing[]> {
    const volumes = await this.volumes(connection, { 'tag:karmaxHome': home, 'tag:karmaxRole': 'home' });
    return volumes.map((volume) => {
      const tags = tagsOf(volume.tagSet);
      const ref = { volume: volume.volumeId, region: this.region(connection), zone: volume.availabilityZone, world: tags.karmaxWorld ?? volume.volumeId };
      return { id: ref.world, ref, ...(tags.karmaxTaskId ? { taskId: tags.karmaxTaskId } : {}),
        ...(tags.karmaxGeneration ? { generation: tags.karmaxGeneration } : {}), destroy: () => this.destroy(connection, ref) };
    });
  }

  same(a: Record<string, string>, b: Record<string, string>): boolean { return !!a.volume && a.volume === b.volume; }

  /**
   * What EC2 bills: each instance's runs (per second, at its type's price plus
   * its public IPv4 address) in five-minute slices, and each volume, root and
   * home, by the hour whatever the instance does. A terminated instance stays
   * listed for about an hour, long enough for its last run to be booked; a
   * deleted volume is not, so `final` (just before a world is deleted) also
   * reports its disks' last part-hours, and a run still going as ending then.
   */
  async usage(connection: ResolvedWorldProviderConnection, home: string, since?: number, final?: FinalUsage): Promise<ProviderUsageEvent[]> {
    const now = final?.at ?? Date.now();
    const from = final ? now - FINAL_USAGE_WINDOW_MS : Math.max(since !== undefined ? since - 2 * 3_600_000 : 0, now - 7 * 86_400_000);
    const filters = { 'tag:karmaxHome': home, ...(final ? { 'tag:karmaxWorld': final.ref.world! } : {}) };
    const events: ProviderUsageEvent[] = [];
    for (const instance of await this.instances(connection, filters)) {
      const tags = tagsOf(instance.tagSet);
      if (!tags.karmaxTaskId) continue;
      const runs: MachineRun[] = [];
      const start = Date.parse(instance.launchTime);
      const running = ['pending', 'running'].includes(instance.instanceState.name);
      const ended = running ? final?.at : stoppedAt(instance);
      // A stopped instance whose stop time EC2 does not say is not counted on (never forever).
      if (running || ended) runs.push({ start, ...(ended ? { end: ended } : {}) });
      const previous = decodeRun(tags.karmaxLastRun);
      if (previous) runs.push(previous);
      const type = (await this.types(connection)).find((entry) => entry.name === instance.instanceType);
      const hourly = await this.hourlyPrice(connection, instance.instanceType) + IPV4_HOURLY;
      for (const slice of runSlices(runs, now, from))
        events.push({ id: `instance-${instance.instanceId}:${slice.id}`, sandboxId: instance.instanceId, ...owner(tags), startedAt: slice.start,
          endedAt: slice.end, activeMs: slice.end - slice.start, cpu: type?.cpu ?? 0, memoryMb: type?.memoryMb ?? 0,
          costMicros: Math.round(hourly * (slice.end - slice.start) / 3_600_000 * 1e6) });
    }
    const gbMonth = await this.gp3Price(connection);
    for (const volume of await this.volumes(connection, filters)) {
      const tags = tagsOf(volume.tagSet);
      for (const hour of diskHours(Date.parse(volume.createTime), now, from, final?.at))
        events.push({ id: `volume-${volume.volumeId}:${hour.id}`, sandboxId: volume.volumeId, ...owner(tags), kind: 'disk',
          startedAt: hour.start, endedAt: hour.end, activeMs: hour.end - hour.start, cpu: 0, memoryMb: 0, diskGb: Number(volume.size),
          costMicros: Math.round(Number(volume.size) * gbMonth / 730 * (hour.end - hour.start) / 3_600_000 * 1e6) });
    }
    return events;
  }

  /** Builders that died mid-build, and images of provisioning versions no longer made. */
  async housekeep(connection: ResolvedWorldProviderConnection): Promise<void> {
    const api = this.ec2(connection);
    const now = Date.now();
    const builders = (await this.instances(connection, { 'tag-key': 'karmaxImageBuilder' })).filter((instance) =>
      !['shutting-down', 'terminated'].includes(instance.instanceState.name) && now - Date.parse(instance.launchTime) > BUILDER_STALE_MS
      && !this.building.has(`${this.key(connection)}:${tagsOf(instance.tagSet).karmaxImageBuilder}`));
    if (builders.length) await api('TerminateInstances', { InstanceId: builders.map((instance) => instance.instanceId) });
    await this.removeImages(connection, (image) => image.version === vmProvisionVersion() || now - image.created < 86_400_000);
  }

  /** The largest instance of karmax's families offered in the region, a 16
   * TiB volume, and the account's budget: its running On-Demand Standard vCPU
   * quota, which every instance of karmax's families (C, M, R) counts against. */
  async limits(connection: ResolvedWorldProviderConnection): Promise<ComputerLimits> {
    const [types, quota, storage] = await Promise.all([this.types(connection), this.quota(connection, 'ec2', AWS_STANDARD_VCPU_QUOTA),
      this.quota(connection, 'ebs', AWS_GP3_STORAGE_QUOTA)]);
    // Every world's home and root disks are gp3: their total is the account's disk budget (TiB → GiB).
    const pool = { ...(quota ? { cpu: Math.floor(quota) } : {}), ...(storage ? { diskGb: Math.floor(storage * 1024) } : {}) };
    return { ...(types.length ? { cpu: Math.max(...types.map((type) => type.cpu)), memoryMb: Math.max(...types.map((type) => type.memoryMb)) } : {}),
      diskGb: AWS_MAX_DISK_GB, ...(Object.keys(pool).length ? { pool } : {}), checkedAt: Date.now() };
  }

  /** One Service Quotas value in the region; undefined when the key may not
   * read it (it needs `servicequotas:GetServiceQuota`), so a person enters it. */
  private async quota(connection: ResolvedWorldProviderConnection, service: string, code: string): Promise<number | undefined> {
    const region = this.region(connection);
    try {
      const answer = await this.json(connection, `https://servicequotas.${region}.amazonaws.com/`, region, 'servicequotas',
        'ServiceQuotasV20190624.GetServiceQuota', { ServiceCode: service, QuotaCode: code }) as { Quota?: { Value?: number } };
      const value = Number(answer.Quota?.Value);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch { return undefined; }
  }

  /** The key works, and the region has the default VPC worlds are made in. */
  async test(connection: ResolvedWorldProviderConnection): Promise<void> {
    await this.ec2(connection)('DescribeInstances', { MaxResults: 5 });
    await this.subnets(connection);
  }

  // ---------------------------------------------------------------------------

  /** Launch one instance, trying `types` in turn while the zone has none of one; undefined when none. */
  private async launch(connection: ResolvedWorldProviderConnection, request: { types: InstanceType[]; subnet: string;
    image: { id: string; rootDevice: string }; group: string; tags: Record<string, string>; userData: string }): Promise<Instance | undefined> {
    for (const type of request.types) {
      try {
        const answer = await this.ec2(connection)('RunInstances', {
          ImageId: request.image.id, InstanceType: type.name, MinCount: 1, MaxCount: 1, ClientToken: crypto.randomUUID(),
          UserData: Buffer.from(request.userData).toString('base64'),
          NetworkInterface: [{ DeviceIndex: 0, SubnetId: request.subnet, AssociatePublicIpAddress: true, SecurityGroupId: [request.group],
            DeleteOnTermination: true }],
          BlockDeviceMapping: [{ DeviceName: request.image.rootDevice, Ebs: { VolumeSize: ROOT_DISK_GB, VolumeType: 'gp3', DeleteOnTermination: true } }],
          MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled' },
          InstanceInitiatedShutdownBehavior: 'stop',
          TagSpecification: [{ ResourceType: 'instance', Tag: tagList(request.tags) },
            { ResourceType: 'volume', Tag: tagList({ ...request.tags, karmaxRole: 'root' }) }],
        });
        return list<Instance>(answer.instancesSet)[0];
      } catch (error) {
        if (!NO_CAPACITY.has((error as AwsError).code ?? '')) throw error;
      }
    }
    return undefined;
  }

  private async createVolume(connection: ResolvedWorldProviderConnection, zone: string, sizeGb: number, tags: Record<string, string>): Promise<Volume> {
    return await this.ec2(connection)('CreateVolume', { AvailabilityZone: zone, Size: sizeGb, VolumeType: 'gp3', ClientToken: crypto.randomUUID(),
      TagSpecification: [{ ResourceType: 'volume', Tag: tagList(tags) }] }) as Volume;
  }

  /** Every instance of the world (on its volume, or made for it and not yet on it), terminated. */
  private async terminate(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<void> {
    const ids = new Set((await this.instances(connection, { 'tag:karmaxWorld': ref.world! }))
      .filter((instance) => instance.instanceState.name !== 'terminated').map((instance) => instance.instanceId));
    const attached = ref.volume ? await this.attachedInstance(connection, ref.volume) : undefined;
    if (attached) ids.add(attached);
    if (ids.size) await this.ec2(connection)('TerminateInstances', { InstanceId: [...ids] }).catch((error) => {
      if ((error as AwsError).code !== 'InvalidInstanceID.NotFound') throw error;
    });
  }

  /** The world's instance: the one its volume is attached to, else one made for it. */
  private async instanceOf(connection: ResolvedWorldProviderConnection, ref: Record<string, string>): Promise<Instance | undefined> {
    const attached = ref.volume ? await this.attachedInstance(connection, ref.volume) : undefined;
    if (attached) return (await this.instances(connection, undefined, [attached]))[0];
    const made = (await this.instances(connection, { 'tag:karmaxWorld': ref.world! })).filter((instance) => instance.instanceState.name !== 'terminated');
    return made.sort((a, b) => Date.parse(b.launchTime) - Date.parse(a.launchTime))[0];
  }

  private async attachedInstance(connection: ResolvedWorldProviderConnection, volumeId: string): Promise<string | undefined> {
    const volume = await this.volume(connection, volumeId);
    return list<{ instanceId: string; status: string }>(volume?.attachmentSet).find((entry) => entry.status !== 'detached')?.instanceId;
  }

  private async volume(connection: ResolvedWorldProviderConnection, id: string): Promise<Volume | undefined> {
    try { return (await this.volumes(connection, undefined, [id]))[0]; }
    catch (error) { if ((error as AwsError).code === 'InvalidVolume.NotFound') return undefined; throw error; }
  }

  private async volumes(connection: ResolvedWorldProviderConnection, filters?: Record<string, string>, ids?: string[]): Promise<Volume[]> {
    return this.pages<Volume>(connection, 'DescribeVolumes', { ...(ids ? { VolumeId: ids } : {}), ...(filters ? { Filter: filterList(filters) } : {}) },
      (answer) => list<Volume>(answer.volumeSet));
  }

  private async instances(connection: ResolvedWorldProviderConnection, filters?: Record<string, string>, ids?: string[]): Promise<Instance[]> {
    try {
      return await this.pages<Instance>(connection, 'DescribeInstances', { ...(ids ? { InstanceId: ids } : {}), ...(filters ? { Filter: filterList(filters) } : {}) },
        (answer) => list<{ instancesSet?: unknown }>(answer.reservationSet).flatMap((reservation) => list<Instance>(reservation.instancesSet)));
    } catch (error) { if ((error as AwsError).code === 'InvalidInstanceID.NotFound') return []; throw error; }
  }

  private async pages<T>(connection: ResolvedWorldProviderConnection, action: string, params: Record<string, unknown>,
    items: (answer: Record<string, any>) => T[]): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < 50; page++) {
      const answer = await this.ec2(connection)(action, { ...params, ...(token ? { NextToken: token } : {}) });
      out.push(...items(answer));
      token = typeof answer.nextToken === 'string' && answer.nextToken ? answer.nextToken : undefined;
      if (!token) break;
    }
    return out;
  }

  private async waitInstance(connection: ResolvedWorldProviderConnection, id: string, states: string[], ms = 300 * this.pollMs): Promise<Instance> {
    const until = Date.now() + ms;
    for (;;) {
      const instance = (await this.instances(connection, undefined, [id]))[0];
      if (instance && states.includes(instance.instanceState.name)) return instance;
      if (instance?.instanceState.name === 'terminated')
        throw new AwsOutage(`AWS ended instance ${id} as it started${instance.reason ? `: ${instance.reason}` : ''}`);
      if (Date.now() > until) throw new AwsOutage(`AWS instance ${id} was not ${states.join(' or ')} within ${Math.round(ms / 60_000)} minutes`);
      await this.sleep(2);
    }
  }

  private async waitVolume(connection: ResolvedWorldProviderConnection, id: string, status: string): Promise<void> {
    const until = Date.now() + 300 * this.pollMs;
    for (;;) {
      const volume = await this.volume(connection, id);
      if (volume?.status === status) return;
      if (!volume || volume.status === 'error') throw new AwsOutage(`AWS volume ${id} ${volume ? 'failed' : 'vanished'}`);
      if (Date.now() > until) throw new AwsOutage(`AWS volume ${id} was not ${status} within 5 minutes`);
      await this.sleep(2);
    }
  }

  /** Every type of karmax's families in the region, x86 and not bare metal (an hour's cache). */
  private types(connection: ResolvedWorldProviderConnection): Promise<InstanceType[]> {
    return this.cached(connection, 'types', 3_600_000, async () => {
      const found = await this.pages<{ instanceType: string; vCpuInfo: { defaultVCpus: string }; memoryInfo: { sizeInMiB: string } }>(
        connection, 'DescribeInstanceTypes', { Filter: [{ Name: 'instance-type', Value: Object.keys(FAMILIES).map((family) => `${family}.*`) },
          { Name: 'processor-info.supported-architecture', Value: ['x86_64'] }, { Name: 'bare-metal', Value: ['false'] }] },
        (answer) => list(answer.instanceTypeSet));
      return found.map((entry) => ({ name: entry.instanceType, family: entry.instanceType.split('.')[0]!,
        cpu: Number(entry.vCpuInfo.defaultVCpus), memoryMb: Number(entry.memoryInfo.sizeInMiB) }))
        .filter((type) => type.family in FAMILIES);
    });
  }

  /** The types that cover a shape, cheapest first. */
  private async typesFor(connection: ResolvedWorldProviderConnection, want: { cpu: number; memoryMb: number }): Promise<InstanceType[]> {
    const price = (type: InstanceType) => FAMILIES[type.family]! * type.cpu;
    const fits = (await this.types(connection)).filter((type) => type.cpu >= want.cpu && type.memoryMb >= want.memoryMb)
      .sort((a, b) => price(a) - price(b) || a.cpu - b.cpu || a.memoryMb - b.memoryMb);
    if (!fits[0]) throw new Error(`AWS has no instance in ${this.region(connection)} with ${want.cpu} CPU and ${Math.round(want.memoryMb / 1024)} GB of memory`);
    return fits;
  }

  /** Which zones of the region offer each type. */
  private async offerings(connection: ResolvedWorldProviderConnection, names: string[]): Promise<Map<string, Set<string>>> {
    const all = await this.cached(connection, 'offerings', 3_600_000, async () => {
      const found = await this.pages<{ instanceType: string; location: string }>(connection, 'DescribeInstanceTypeOfferings',
        { LocationType: 'availability-zone', Filter: [{ Name: 'instance-type', Value: Object.keys(FAMILIES).map((family) => `${family}.*`) }] },
        (answer) => list(answer.instanceTypeOfferingSet));
      const map = new Map<string, Set<string>>();
      for (const entry of found) map.set(entry.instanceType, (map.get(entry.instanceType) ?? new Set()).add(entry.location));
      return map;
    });
    return new Map(names.map((name) => [name, all.get(name) ?? new Set()]));
  }

  /** The default VPC's subnets, one per zone. */
  private subnets(connection: ResolvedWorldProviderConnection): Promise<Array<{ id: string; zone: string; vpc: string }>> {
    return this.cached(connection, 'subnets', 3_600_000, async () => {
      const vpc = list<{ vpcId: string }>((await this.ec2(connection)('DescribeVpcs', { Filter: filterList({ 'is-default': 'true' }) })).vpcSet)[0];
      if (!vpc) throw new Error(`AWS region ${this.region(connection)} has no default VPC, where tavya makes its machines. `
        + 'Create one (VPC console → Your VPCs → Actions → Create default VPC), or choose another region.');
      const subnets = list<{ subnetId: string; availabilityZone: string; state: string }>((await this.ec2(connection)('DescribeSubnets',
        { Filter: filterList({ 'vpc-id': vpc.vpcId, 'default-for-az': 'true' }) })).subnetSet).filter((subnet) => subnet.state === 'available');
      if (!subnets.length) throw new Error(`the default VPC of AWS region ${this.region(connection)} has no default subnets`);
      return subnets.map((subnet) => ({ id: subnet.subnetId, zone: subnet.availabilityZone, vpc: vpc.vpcId }))
        .sort((a, b) => a.zone.localeCompare(b.zone));
    });
  }

  /** The security group of karmax's machines: inbound SSH to karmax's port only. Made once per VPC. */
  private securityGroup(connection: ResolvedWorldProviderConnection): Promise<string> {
    return this.cached(connection, 'security-group', Infinity, async () => {
      const api = this.ec2(connection);
      const vpc = (await this.subnets(connection))[0]!.vpc;
      const existing = list<{ groupId: string }>((await api('DescribeSecurityGroups',
        { Filter: filterList({ 'vpc-id': vpc, 'tag:karmaxSecurityGroup': 'vm' }) })).securityGroupInfo)[0];
      if (existing) return existing.groupId;
      const created = await api('CreateSecurityGroup', { GroupName: `karmax-vm-${crypto.randomBytes(3).toString('hex')}`,
        GroupDescription: 'tavya VM worlds: SSH to port 2222 only', VpcId: vpc,
        TagSpecification: [{ ResourceType: 'security-group', Tag: tagList({ karmaxSecurityGroup: 'vm', Name: 'karmax-vm' }) }] });
      const groupId = String(created.groupId);
      await api('AuthorizeSecurityGroupIngress', { GroupId: groupId,
        IpPermissions: [{ IpProtocol: 'tcp', FromPort: VM_SSH_PORT, ToPort: VM_SSH_PORT, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] });
      return groupId;
    });
  }

  /** The image a machine boots: an explicit one, karmax's provisioned one, else stock Debian. */
  private async image(connection: ResolvedWorldProviderConnection): Promise<{ id: string; rootDevice: string; karmax: boolean }> {
    const api = this.ec2(connection);
    const describe = async (params: Record<string, unknown>) => list<{ imageId: string; rootDeviceName: string; creationDate: string;
      imageState: string }>((await api('DescribeImages', params)).imagesSet).filter((image) => image.imageState === 'available')
      .sort((a, b) => b.creationDate.localeCompare(a.creationDate))[0];
    if (connection.config.image) {
      const image = await describe({ ImageId: [connection.config.image] });
      if (!image) throw new Error(`AWS has no image ${connection.config.image} in ${this.region(connection)}`);
      return { id: image.imageId, rootDevice: image.rootDeviceName, karmax: true };
    }
    const karmax = await describe({ Owner: ['self'], Filter: filterList({ 'tag:karmaxImage': vmProvisionVersion() }) });
    if (karmax) return { id: karmax.imageId, rootDevice: karmax.rootDeviceName, karmax: true };
    const debian = await this.cached(connection, 'debian', 86_400_000, () => describe({ Owner: [DEBIAN_OWNER],
      Filter: filterList({ name: DEBIAN_IMAGES, architecture: 'x86_64' }) }));
    if (!debian) throw new Error(`AWS has no Debian 12 image in ${this.region(connection)}`);
    return { id: debian.imageId, rootDevice: debian.rootDeviceName, karmax: false };
  }

  /** Build the provisioned image in the background, once per account, region and version. */
  private buildImage(connection: ResolvedWorldProviderConnection): void {
    if (process.env.KARMAX_AWS_IMAGES === '0') return;
    this.build(connection).catch((error) => {
      console.warn(`[aws] building the karmax VM image failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** This process's build of the provisioned image, started if none runs. */
  private build(connection: ResolvedWorldProviderConnection): Promise<void> {
    const version = vmProvisionVersion();
    const key = `${this.key(connection)}:${version}`;
    let build = this.building.get(key);
    if (!build) {
      build = this.runBuild(connection, version).finally(() => this.building.delete(key));
      this.building.set(key, build);
    }
    return build;
  }

  /** The provisioned image, built now if there is none (about ten minutes). */
  async ensureImage(connection: ResolvedWorldProviderConnection): Promise<string> {
    const until = Date.now() + 60 * 60_000;
    for (;;) {
      const image = await this.image(connection);
      if (image.karmax) return image.id;
      // Another process may be building it: wait for its image.
      if ((await this.instances(connection, { 'tag:karmaxImageBuilder': vmProvisionVersion() }))
        .some((instance) => !['shutting-down', 'terminated'].includes(instance.instanceState.name))) await this.sleep(15);
      else await this.build(connection);
      if (Date.now() > until) throw new Error('the karmax VM image was not ready within an hour');
    }
  }

  /** Delete karmax's images (and their snapshots) that `keep` does not keep. */
  async removeImages(connection: ResolvedWorldProviderConnection, keep: (image: { version: string; created: number }) => boolean): Promise<void> {
    const api = this.ec2(connection);
    const images = list<{ imageId: string; tagSet?: unknown; blockDeviceMapping?: unknown; creationDate: string }>(
      (await api('DescribeImages', { Owner: ['self'], Filter: [{ Name: 'tag-key', Value: ['karmaxImage'] }] })).imagesSet);
    for (const image of images) {
      if (keep({ version: tagsOf(image.tagSet).karmaxImage ?? '', created: Date.parse(image.creationDate) })) continue;
      await api('DeregisterImage', { ImageId: image.imageId });
      for (const mapping of list<{ ebs?: { snapshotId?: string } }>(image.blockDeviceMapping))
        if (mapping.ebs?.snapshotId) await api('DeleteSnapshot', { SnapshotId: mapping.ebs.snapshotId }).catch(() => undefined);
    }
  }

  private async runBuild(connection: ResolvedWorldProviderConnection, version: string): Promise<void> {
    const api = this.ec2(connection);
    const running = (await this.instances(connection, { 'tag:karmaxImageBuilder': version }))
      .filter((instance) => !['shutting-down', 'terminated'].includes(instance.instanceState.name));
    if (running.length) return; // another process builds it
    const host = generateSshKeyPair('karmax-builder-host');
    const client = generateSshKeyPair('karmax-builder');
    const [image, group, subnets, types] = await Promise.all([this.image(connection), this.securityGroup(connection),
      this.subnets(connection), this.typesFor(connection, { cpu: 2, memoryMb: 4096 })]);
    const offered = await this.offerings(connection, types.map((type) => type.name));
    let instance: Instance | undefined;
    for (const subnet of subnets) {
      const here = types.filter((type) => offered.get(type.name)?.has(subnet.zone)).slice(0, TYPE_FALLBACKS);
      instance = here.length ? await this.launch(connection, { types: here, subnet: subnet.id, image, group,
        tags: { karmaxImageBuilder: version, karmaxHome: 'image-builder', Name: `karmax-image-${version}` },
        userData: cloudInit({ hostPrivateKey: host.privateKey, authorizedKey: client.publicKey }) }) : undefined;
      if (instance) break;
    }
    if (!instance) throw new Error('AWS had no instance free to build the image on');
    try {
      const started = await this.waitInstance(connection, instance.instanceId, ['running']);
      const transport = this.builderTransport?.(started.ipAddress!, { privateKey: client.privateKey, hostKey: host.publicKey })
        ?? new SshTransport(async () => ({ host: started.ipAddress!, port: VM_SSH_PORT, hostKey: host.publicKey,
          username: VM_USER, privateKey: client.privateKey }));
      try {
        for (let attempt = 0; ; attempt++) {
          try { if ((await transport.exec('true', { timeoutMs: 20_000 })).code === 0) break; } catch { transport.reset(); }
          if (attempt > 60) throw new Error('the image builder never answered SSH');
          await this.sleep(5);
        }
        await runDetached(transport, vmProvisionScript(), true, 30 * 60_000)
          .catch((error) => { throw new Error(`provisioning failed: ${error instanceof Error ? error.message : String(error)}`); });
        // Nothing of this instance's own may reach the worlds made from it.
        await transport.exec(`sudo -n sh -c ${quote(`rm -rf ${VM_ETC} /etc/ssh/sshd_config.d/00-karmax.conf /var/lib/cloud/scripts/per-boot/karmax-boot.sh; `
          + `test -f ${vmProvisionStamp()} && cloud-init clean --logs --seed; sync`)}`, { timeoutMs: 120_000 });
      } finally {
        transport.close();
      }
      await api('StopInstances', { InstanceId: [instance.instanceId] });
      await this.waitInstance(connection, instance.instanceId, ['stopped'], 600 * this.pollMs);
      const created = await api('CreateImage', { InstanceId: instance.instanceId, Name: `karmax-vm-${version}-${crypto.randomBytes(3).toString('hex')}`,
        Description: `karmax VM ${version}`, TagSpecification: [{ ResourceType: 'image', Tag: tagList({ karmaxImage: version }) },
          { ResourceType: 'snapshot', Tag: tagList({ karmaxImage: version }) }] });
      const until = Date.now() + 45 * 60 * this.pollMs;
      for (;;) {
        const state = list<{ imageState: string }>((await api('DescribeImages', { ImageId: [String(created.imageId)] })).imagesSet)[0]?.imageState;
        if (state === 'available') break;
        if (state === 'failed' || Date.now() > until) throw new Error(`the karmax VM image ${created.imageId} ${state === 'failed' ? 'failed' : 'was not ready within 45 minutes'}`);
        await this.sleep(10);
      }
    } finally {
      await api('TerminateInstances', { InstanceId: [instance.instanceId] }).catch(() => undefined);
    }
  }

  /** An instance type's on-demand Linux price here (AWS Price List API), else
   * karmax's us-east-1 figure for its family. */
  private hourlyPrice(connection: ResolvedWorldProviderConnection, type: string): Promise<number> {
    return this.cached(connection, `price:${type}`, 86_400_000, async () => {
      const price = await this.priceList(connection, [['instanceType', type], ['operatingSystem', 'Linux'], ['tenancy', 'Shared'],
        ['preInstalledSw', 'NA'], ['capacitystatus', 'Used'], ['licenseModel', 'No License required']], 'Hrs');
      if (price !== undefined) return price;
      const cpu = (await this.types(connection)).find((entry) => entry.name === type)?.cpu ?? 2;
      return (FAMILIES[type.split('.')[0]!] ?? 0.05) * cpu;
    });
  }

  private gp3Price(connection: ResolvedWorldProviderConnection): Promise<number> {
    return this.cached(connection, 'price:gp3', 86_400_000, async () =>
      await this.priceList(connection, [['productFamily', 'Storage'], ['volumeApiName', 'gp3']], 'GB-Mo') ?? GP3_GB_MONTH);
  }

  /** One on-demand price from the Price List API, or undefined when it cannot be read. */
  private async priceList(connection: ResolvedWorldProviderConnection, filters: Array<[string, string]>, unit: string): Promise<number | undefined> {
    try {
      const answer = await this.json(connection, 'https://api.pricing.us-east-1.amazonaws.com/', 'us-east-1', 'pricing',
        'AWSPriceListService.GetProducts', { ServiceCode: 'AmazonEC2', FormatVersion: 'aws_v1', MaxResults: 20,
          Filters: [...filters, ['regionCode', this.region(connection)]].map(([Field, Value]) => ({ Type: 'TERM_MATCH', Field, Value })) }) as { PriceList?: string[] };
      for (const entry of answer.PriceList ?? []) {
        const product = JSON.parse(entry) as { terms?: { OnDemand?: Record<string, { priceDimensions: Record<string, { unit: string; pricePerUnit: { USD?: string } }> }> } };
        for (const term of Object.values(product.terms?.OnDemand ?? {}))
          for (const dimension of Object.values(term.priceDimensions)) {
            const usd = Number(dimension.pricePerUnit.USD);
            if (dimension.unit === unit && usd > 0) return usd;
          }
      }
    } catch (error) {
      console.warn(`[aws] the Price List API did not answer (${error instanceof Error ? error.message : String(error)}); karmax's own prices are used`);
    }
    return undefined;
  }

  private cached<T>(connection: ResolvedWorldProviderConnection, name: string, ms: number, make: () => Promise<T>): Promise<T> {
    const key = `${this.key(connection)}:${name}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.value as Promise<T>;
    const value = make();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }

  private key(connection: ResolvedWorldProviderConnection): string {
    return crypto.createHash('sha256').update(`${connection.apiKey}\n${this.region(connection)}`).digest('hex');
  }

  private region(connection: ResolvedWorldProviderConnection): string { return connection.config.region ?? AWS_DEFAULT_REGION; }

  private sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * this.pollMs));
  }

  /** A JSON 1.1 API (the Price List API). */
  private async json(connection: ResolvedWorldProviderConnection, endpoint: string, region: string, service: string, target: string, body: unknown): Promise<unknown> {
    const url = new URL(endpoint);
    const text = JSON.stringify(body);
    const headers = signAws({ method: 'POST', url, body: text, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target } },
      awsCredentials(connection.apiKey), region, service);
    const response = await this.fetchImpl(url, { method: 'POST', headers, body: text, signal: AbortSignal.timeout(60_000) });
    const answer = await response.text();
    if (!response.ok) throw new AwsError(`AWS ${target} failed (${response.status}): ${answer.slice(0, 300)}`, response.status);
    return JSON.parse(answer);
  }

  /**
   * One EC2 request. Throttling and AWS's own failures are sent again (creates
   * carry a client token, so a repeat makes nothing twice); what still fails
   * is an `AwsOutage`, waited out by the platform. A full account limit is
   * `ProviderCapacityFull`; anything else (bad input, a missing resource, a
   * permission) an `AwsError` with AWS's code.
   */
  private ec2(connection: ResolvedWorldProviderConnection) {
    const credentials = awsCredentials(connection.apiKey);
    const region = this.region(connection);
    const url = new URL(`https://ec2.${region}.amazonaws.com/`);
    const redact = (text: string) => text.split(credentials.secretAccessKey).join('[redacted]');
    return async (action: string, params: Record<string, unknown> = {}): Promise<Record<string, any>> => {
      const body = new URLSearchParams([['Action', action], ['Version', API_VERSION], ...ec2Query(params)]).toString();
      for (let attempt = 0; ; attempt++) {
        const last = attempt >= API_RETRIES;
        let response: Response;
        let text: string;
        try {
          const headers = signAws({ method: 'POST', url, body, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } },
            credentials, region, 'ec2');
          response = await this.fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(120_000) });
          text = await response.text();
        } catch (error) {
          if (!last) { await this.sleep(2 ** attempt); continue; }
          throw new AwsOutage(`AWS ${action} got no answer: ${redact(error instanceof Error ? error.message : String(error))}`, undefined, { cause: error });
        }
        const parsed = parseXml(text);
        if (response.ok) return Object.values(parsed)[0] as Record<string, any> ?? {};
        const failure = list<{ Code?: string; Message?: string }>(parsed.Response?.Errors?.Error)[0];
        const code = failure?.Code;
        const message = `AWS ${action} failed (${response.status}${code ? ` ${code}` : ''}): ${redact(failure?.Message ?? text.slice(0, 300))}`;
        // EC2 answers "no capacity" with a 500: the caller tries elsewhere at once.
        if (NO_CAPACITY.has(code ?? '')) throw new AwsError(message, response.status, code);
        const retried = RETRIED.has(code ?? '') || response.status >= 500 || response.status === 429;
        if (retried && !last) { await this.sleep(Math.min(30, 2 ** attempt + Math.random())); continue; }
        if (retried) throw new AwsOutage(message, code);
        if (ACCOUNT_LIMIT.has(code ?? '')) throw new ProviderCapacityFull(`${message}. This AWS account's limit is full: tavya waits until `
          + 'there is room; to start sooner, give this task a smaller size, stop another task, or ask AWS to raise the limit '
          + '(Service Quotas → Amazon EC2 → Running On-Demand Standard instances).', { cause: new AwsError(message, response.status, code) });
        throw new AwsError(message, response.status, code);
      }
    };
  }
}

export class AwsError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); this.name = 'AwsError'; }
}

/** An AWS failure that passes with time: retried by the platform as infrastructure, never the agent's. */
export class AwsOutage extends ProviderOutage {
  constructor(message: string, readonly code?: string, options?: { cause?: unknown }) { super(message, options); this.name = 'AwsOutage'; }
}

/** The device a world's volume appears as on a Nitro instance (NVMe, named by the volume). */
export function homeDevice(volumeId: string): string {
  return `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeId.replace('-', '')}`;
}

/** When a stopped instance stopped: EC2 says so only in its transition reason. */
export function stoppedAt(instance: Pick<Instance, 'reason' | 'instanceState'>): number | undefined {
  if (['pending', 'running'].includes(instance.instanceState.name)) return undefined;
  const match = instance.reason?.match(/\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) GMT\)/);
  const at = match ? Date.parse(`${match[1]!.replace(' ', 'T')}Z`) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

function filterList(filters: Record<string, string>): Array<{ Name: string; Value: string[] }> {
  return Object.entries(filters).map(([Name, value]) => ({ Name, Value: [value] }));
}

function owner(tags: Record<string, string>) {
  return { ...(tags.karmaxTaskId ? { taskId: tags.karmaxTaskId } : {}), ...(tags.karmaxOrganizationId ? { organizationId: tags.karmaxOrganizationId } : {}) };
}

/** `kx-<home>-<world>`: names the world's volume and instance, and the tag tying them together. */
function worldName(labels: Record<string, string>): string {
  const world = crypto.createHash('sha256').update(`${labels.karmaxTaskId}:${labels.karmaxGeneration}`).digest('hex').slice(0, 12);
  return `kx-${labels.karmaxHome!.slice(0, 10)}-${world}`;
}

function sha256(value: string | Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key: Buffer, value: string): Buffer { return crypto.createHmac('sha256', key).update(value).digest(); }
