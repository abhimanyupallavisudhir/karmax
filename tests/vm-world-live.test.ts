import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../src/agent/acp.js';
import { prewarmRemoteAgentHome } from '../src/agent/remote-process.js';
import { apiKeyEnv } from '../src/agent/provider-registry.js';
import { FlyDriver } from '../src/world/fly.js';
import { HetznerDriver } from '../src/world/hetzner.js';
import { VmWorldProvider, type VmDriver } from '../src/world/vm/provider.js';
import type { ResolvedWorldProviderConnection } from '../src/world/connections.js';
import type { World, WorldHandle } from '../src/world/types.js';
import { serviceHomeLabel } from '../src/world/services.js';
import { liveEnabled } from './helpers/live-gate.js';

/**
 * VM worlds on the real Fly.io and Hetzner control planes (wiki
 * features/vm-worlds). One 100 GB world per provider: a real OpenCode turn
 * writes a tracked file and a Git-ignored one, the world parks (no compute
 * billed) and wakes with both, grows to 150 GB while running with nothing
 * lost, then parks into the provider's slow path (Fly: stopped; Hetzner: the
 * server deleted) and wakes again. Every step's latency and the provider's
 * own usage are printed as one `VM-LIVE` JSON line for the wiki.
 *
 * Opt in with KARMAX_RUN_LIVE=1, FLY_API_TOKEN and/or HCLOUD_TOKEN, and a
 * metered model key (OPENAI_API_KEY for the default openai/gpt-5-mini).
 * Optional: KARMAX_FLY_REGION, KARMAX_FLY_ORG, KARMAX_FLY_IMAGE,
 * KARMAX_HETZNER_LOCATION. Everything the suite creates is deleted at the end
 * (Hetzner's provisioned snapshot, firewall and key too, unless they existed
 * before it ran). About $0.10 of compute and disk per provider.
 */
const model = process.env.KARMAX_LIVE_OPENCODE_MODEL ?? 'openai/gpt-5-mini';
const modelKey = process.env[apiKeyEnv(model.split('/')[0]!)];
const fly: ResolvedWorldProviderConnection = { provider: 'fly', apiKey: process.env.FLY_API_TOKEN ?? '',
  config: { region: process.env.KARMAX_FLY_REGION, organization: process.env.KARMAX_FLY_ORG, image: process.env.KARMAX_FLY_IMAGE } };
const hetzner: ResolvedWorldProviderConnection = { provider: 'hetzner', apiKey: process.env.HCLOUD_TOKEN ?? '',
  config: { region: process.env.KARMAX_HETZNER_LOCATION } };
const providers = [
  { name: 'Fly.io', connection: fly, driver: () => new FlyDriver() as VmDriver },
  { name: 'Hetzner', connection: hetzner, driver: () => new HetznerDriver() as VmDriver },
];

describe.each(providers)('a live $name VM world', ({ name, connection, driver: makeDriver }) => {
  const live = liveEnabled() && !!connection.apiKey && !!modelKey;
  const driver = makeDriver();
  const provider = new VmWorldProvider(driver, async () => connection);
  const report: Record<string, unknown> = { provider: name, region: connection.config.region ?? 'default' };
  const marker = `VM-${name.replace(/\W/g, '').toUpperCase()}-${Date.now().toString(36)}`;
  let home: string;
  let previousHome: string | undefined;
  let world: World;
  let handle: WorldHandle;
  let before: { firewalls: number; keys: number; snapshot?: string } | undefined;
  const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try { return await work(); } finally { report[label] = Math.round((Date.now() - started) / 100) / 10; }
  };

  async function turn(text: string, session?: string) {
    let started: string | undefined;
    prewarmRemoteAgentHome(world, 'opencode', undefined, session);
    const result = await new AcpAdapter('opencode').runTurn({
      profile: { id: 'live', name: 'Live', provider: 'opencode', model, role: 'do' }, world,
      messages: [{ id: 'm', role: 'user', text, ts: Date.now() }],
      systemPrompt: 'You are a careful assistant working in a Linux machine. Follow the user exactly.', role: 'do',
      resolvedAuth: { apiKey: modelKey }, extraEnv: { KARMAX_TOKEN: 'live-test-token' }, ...(session ? { session } : {}),
    } as any, { emit() {}, emitActivity() {}, onSession(id: string) { started = id; }, heartbeat() {}, createReviewInfo() {} } as any);
    return { result, session: started! };
  }

  const disk = async () => {
    const df = await world.exec('bash', ['-c', 'df -BG --output=size,avail "$HOME" | tail -1']);
    const [size, avail] = df.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    return { size: size!, avail: avail! };
  };

  beforeAll(async () => {
    if (!live) return;
    previousHome = process.env.KARMAX_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-live-vm-'));
    process.env.KARMAX_HOME = home; // a home label no production sweep owns
    if (driver instanceof HetznerDriver) {
      process.env.KARMAX_HETZNER_SNAPSHOTS = '0'; // built explicitly below, never left running in the background
      before = await hetznerInventory(connection);
      // What a project's first world triggers, done in the open: provision a stock server and snapshot it.
      report.snapshot = await timed('snapshotBuildS', () => driver.ensureSnapshot(connection));
    }
    handle = undefined as unknown as WorldHandle;
    world = await timed('createS', () => provider.create({ taskId: `live-vm-${Date.now().toString(36)}`, base: 'main', generation: 1,
      organizationId: 'org_live', resources: { cpu: 2, memoryMb: 2048, diskGb: 100 } }));
    handle = world.handle as WorldHandle;
    report.machine = handle.meta?.machine;
  }, 60 * 60_000);

  afterAll(async () => {
    if (!live) return;
    try {
      if (handle) await provider.destroy(handle).catch((error) => { report.destroyError = String(error); });
      // Anything else this run's home label owns (a failed create's leftovers).
      for (const leftover of await provider.listSandboxes().catch(() => [])) await leftover.destroy().catch(() => undefined);
      if (driver instanceof HetznerDriver) await cleanHetzner(connection, before);
      report.leftovers = (await provider.listSandboxes().catch(() => [])).length;
      console.log(`VM-LIVE ${JSON.stringify(report)}`);
    } finally {
      if (previousHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = previousHome;
      delete process.env.KARMAX_HETZNER_SNAPSHOTS;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30 * 60_000);

  it.skipIf(!live)('is a 100 GB machine whose agent writes tracked and ignored files', async () => {
    const size = await disk();
    report.diskAtCreate = size;
    expect(size.size).toBeGreaterThanOrEqual(95);
    const { result, session } = await timed('turnS', () => turn('With your bash tool run exactly: '
      + `mkdir -p notes node_modules/.cache && echo ${marker} > notes/agent.txt && echo ignored-${marker} > node_modules/.cache/kept.txt `
      + '&& cat notes/agent.txt. Then reply with the single word DONE.'));
    report.session = session;
    expect(result.termination).toEqual({ kind: 'success', status: 'end_turn' });
    expect((await world.readFile('notes/agent.txt')).trim()).toBe(marker);
    expect((await world.readFile('node_modules/.cache/kept.txt')).trim()).toBe(`ignored-${marker}`);
  }, 30 * 60_000);

  it.skipIf(!live)('parks without billing compute and wakes with every file', async () => {
    await timed('parkS', () => provider.park(handle));
    expect(await provider.probe(handle)).toBe('parked');
    world = await timed('wakeS', () => provider.open(handle));
    expect((await world.readFile('notes/agent.txt')).trim()).toBe(marker);
    expect((await world.readFile('node_modules/.cache/kept.txt')).trim()).toBe(`ignored-${marker}`);
    // The agent still works on the woken machine, in the same session.
    const { result } = await timed('turnAfterWakeS', () => turn('With your bash tool run exactly: cat notes/agent.txt. Reply with only its contents.',
      report.session as string));
    expect(result.output).toContain(marker);
  }, 30 * 60_000);

  it.skipIf(!live)('grows to 150 GB while running, losing nothing', async () => {
    const grown = await timed('growS', () => provider.resize(handle, { cpu: 2, memoryMb: 2048, diskGb: 150 }));
    expect(grown.disk).toBe('grown');
    handle = { ...handle, meta: { ...handle.meta, computer: { cpu: 2, memoryMb: 2048, diskGb: 150 }, machine: grown.machine } };
    let size = await disk();
    // Fly may only show the new size after a restart (`needs_restart`); the next wake grows the filesystem.
    report.diskAfterGrowLive = size;
    if (size.size < 145) {
      await provider.park(handle);
      world = await provider.open(handle);
      size = await disk();
    }
    report.diskAfterGrow = size;
    expect(size.size).toBeGreaterThanOrEqual(145);
    expect((await world.readFile('notes/agent.txt')).trim()).toBe(marker);
    expect((await world.readFile('node_modules/.cache/kept.txt')).trim()).toBe(`ignored-${marker}`);
  }, 30 * 60_000);

  it.skipIf(!live)('wakes from the slow park too (Hetzner: a new server on the same volume)', async () => {
    if (driver instanceof HetznerDriver) process.env.KARMAX_HETZNER_PARK_GRACE = '0';
    try {
      await timed('coldParkS', () => provider.park(handle));
      world = await timed('coldWakeS', () => provider.open(handle));
    } finally { delete process.env.KARMAX_HETZNER_PARK_GRACE; }
    expect((await world.readFile('notes/agent.txt')).trim()).toBe(marker);
    expect((await disk()).size).toBeGreaterThanOrEqual(145);
    report.usage = summarize((await provider.listUsageEvents('org_live')).events);
  }, 30 * 60_000);
});

function summarize(events: Array<{ kind?: string; activeMs: number; costMicros?: number; taskId?: string }>) {
  const own = events.filter((event) => event.taskId?.startsWith('live-vm-'));
  const sum = (kind: string) => own.filter((event) => (event.kind ?? 'compute') === kind);
  return {
    computeHours: Math.round(sum('compute').reduce((total, event) => total + event.activeMs, 0) / 36_000) / 100,
    computeUsd: sum('compute').reduce((total, event) => total + (event.costMicros ?? 0), 0) / 1e6,
    diskHours: Math.round(sum('disk').reduce((total, event) => total + event.activeMs, 0) / 36_000) / 100,
    diskUsd: sum('disk').reduce((total, event) => total + (event.costMicros ?? 0), 0) / 1e6,
  };
}

async function hetznerApi(connection: ResolvedWorldProviderConnection, method: string, route: string): Promise<any> {
  const response = await fetch(`https://api.hetzner.cloud/v1${route}`, { method, headers: { authorization: `Bearer ${connection.apiKey}` } });
  if (!response.ok && response.status !== 404) throw new Error(`Hetzner ${method} ${route}: ${response.status}`);
  return response.status === 204 ? {} : response.json().catch(() => ({}));
}

async function hetznerInventory(connection: ResolvedWorldProviderConnection) {
  const { vmProvisionVersion } = await import('../src/world/vm/provision.js');
  const firewalls = (await hetznerApi(connection, 'GET', '/firewalls?label_selector=karmaxFirewall%3Dvm')).firewalls ?? [];
  const keys = (await hetznerApi(connection, 'GET', '/ssh_keys?label_selector=karmaxSshKey%3Dno-root-login')).ssh_keys ?? [];
  const images = (await hetznerApi(connection, 'GET', `/images?type=snapshot&label_selector=karmaxImage%3D${vmProvisionVersion()}`)).images ?? [];
  return { firewalls: firewalls.length, keys: keys.length, snapshot: images[0] ? String(images[0].id) : undefined };
}

/** Delete what this run created at project level; keep what existed before it. */
async function cleanHetzner(connection: ResolvedWorldProviderConnection, before?: { firewalls: number; keys: number; snapshot?: string }) {
  for (const server of (await hetznerApi(connection, 'GET', `/servers?label_selector=karmaxHome%3D${serviceHomeLabel()}`)).servers ?? [])
    await hetznerApi(connection, 'DELETE', `/servers/${server.id}`);
  for (const builder of (await hetznerApi(connection, 'GET', '/servers?label_selector=karmaxImageBuilder')).servers ?? [])
    await hetznerApi(connection, 'DELETE', `/servers/${builder.id}`);
  if (process.env.KARMAX_LIVE_KEEP_SNAPSHOT !== '1')
    for (const image of (await hetznerApi(connection, 'GET', '/images?type=snapshot&label_selector=karmaxImage')).images ?? [])
      if (String(image.id) !== before?.snapshot) await hetznerApi(connection, 'DELETE', `/images/${image.id}`);
  if (!before?.firewalls) {
    for (const firewall of (await hetznerApi(connection, 'GET', '/firewalls?label_selector=karmaxFirewall%3Dvm')).firewalls ?? []) {
      // A firewall still applied to a server being deleted refuses deletion for a moment.
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fetch(`https://api.hetzner.cloud/v1/firewalls/${firewall.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${connection.apiKey}` } });
        if (response.ok || response.status === 404) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }
  if (!before?.keys)
    for (const key of (await hetznerApi(connection, 'GET', '/ssh_keys?label_selector=karmaxSshKey%3Dno-root-login')).ssh_keys ?? [])
      await hetznerApi(connection, 'DELETE', `/ssh_keys/${key.id}`);
}
