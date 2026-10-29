// Compute routing (wiki features/compute-routing): a task whose Computer says
// provider "Any" runs on whichever reachable account fits and has room — its
// organization's own first, then managed compute by price — and a full one
// gives way to the next.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { MANAGED_COMPUTE, WorldProviderConnectionService } from '../src/world/connections.js';
import { ComputeRouter, FULL_MEMORY_MS, computeNeeds, rankComputeOptions, type ComputeOption } from '../src/world/compute-router.js';
import { ComputeCreditExhausted, ManagedComputeBusy } from '../src/world/managed-compute.js';
import { ProviderCapacityFull, ProviderOutage } from '../src/agent/limits.js';
import { ANY_PROVIDER, assertInFlightComputerEdit, normalizeComputer } from '../src/domain/computer.js';
import { listPriceMicrosPerHour, providerFeatures, providerRegion } from '../src/domain/computer-limits.js';
import { taskProvider } from '../src/world/task-provider.js';
import { WorldRegistry } from '../src/world/registry.js';
import { RunnerPoolService } from '../src/world/runners.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const probes = { check: async () => {}, limits: async () => ({}) };

const option = (provider: string, funding: 'own' | 'managed', extra: Partial<ComputeOption> = {}): ComputeOption => ({
  provider, funding, limits: { cpu: 16, memoryMb: 65_536, diskGb: 2048 }, features: providerFeatures(provider),
  region: providerRegion(provider), ...extra });

describe('the rule', () => {
  it('asks Any for the size, desktop, allowlist and region the Computer states', () => {
    expect(computeNeeds({ resources: { cpu: 4, memoryMb: 8192, diskGb: 100 }, environment: { flavor: 'desktop' },
      network: { unrestricted: false }, region: 'eu' })).toEqual({ cpu: 4, memoryMb: 8192, diskGb: 100, desktop: true, allowlist: true, region: 'eu' });
    // Full internet unless the Computer says basic is enough.
    expect(computeNeeds({ resources: { cpu: 2 }, network: { unrestricted: true } })).toEqual({ cpu: 2, fullInternet: true });
    expect(computeNeeds({ resources: { cpu: 2 } })).toEqual({ cpu: 2, fullInternet: true });
    expect(computeNeeds({ resources: { cpu: 2 }, network: { unrestricted: true, basic: true } })).toEqual({ cpu: 2 });
  });

  // Daytona's Tiers 1 and 2 reach only essential services (registries, Git
  // hosts, AI and cloud APIs): such an account takes only a task whose
  // Computer says basic internet is enough (owner, 2026-10-29).
  it('gives a basic-internet account only tasks for which basic internet is enough', () => {
    const basic = option('daytona', 'managed', { features: { ...providerFeatures('daytona'), internet: 'basic', allowlist: false } });
    const full = rankComputeOptions({ fullInternet: true }, [basic, option('e2b', 'managed')]);
    expect(full.candidates.map((candidate) => candidate.provider)).toEqual(['e2b']);
    expect(full.rejected).toEqual([{ provider: 'daytona', funding: 'managed', reason: 'basic internet only' }]);
    expect(rankComputeOptions({}, [basic, option('e2b', 'managed')]).candidates.map((candidate) => candidate.provider)).toEqual(['e2b', 'daytona']);
    expect(rankComputeOptions({ allowlist: true }, [basic]).rejected).toEqual([{ provider: 'daytona', funding: 'managed', reason: 'no outbound allowlist' }]);
  });

  it('keeps only accounts that can give the machine, and says why the others cannot', () => {
    const route = rankComputeOptions({ cpu: 8, diskGb: 500, region: 'eu' }, [
      option('hetzner', 'managed', { limits: { cpu: 4, memoryMb: 8192, diskGb: 200 } }),
      option('e2b', 'own', { limits: { cpu: 8, memoryMb: 8192, diskGb: 29 } }),
      option('gcp', 'managed', { limits: { cpu: 8, memoryMb: 32_768, diskGb: 1024 } }),
      option('aws', 'managed', { region: 'us' }),
    ]);
    expect(route.candidates.map((candidate) => candidate.provider)).toEqual(['gcp']);
    expect(route.rejected).toEqual([
      { provider: 'hetzner', funding: 'managed', reason: 'at most 4 CPU' },
      { provider: 'e2b', funding: 'own', reason: 'at most 29 GB disk' },
      { provider: 'aws', funding: 'managed', reason: 'not in the EU' },
    ]);
    // A desktop or an allowlist only where the provider has one.
    expect(rankComputeOptions({ desktop: true }, [option('aws', 'managed'), option('e2b', 'own')]).rejected)
      .toEqual([{ provider: 'aws', funding: 'managed', reason: 'no desktop' }]);
    expect(rankComputeOptions({ allowlist: true }, [option('hetzner', 'managed'), option('daytona', 'own')]).candidates
      .map((candidate) => candidate.provider)).toEqual(['daytona']);
  });

  it('tries the organization\'s own accounts first, then managed compute by price for the size', () => {
    expect(listPriceMicrosPerHour('hetzner', {})).toBeLessThan(listPriceMicrosPerHour('gcp', {})!);
    expect(listPriceMicrosPerHour('gcp', {})).toBeLessThan(listPriceMicrosPerHour('aws', {})!);
    const route = rankComputeOptions({ cpu: 2, memoryMb: 4096 },
      [option('aws', 'managed'), option('gcp', 'managed'), option('e2b', 'own'), option('hetzner', 'managed')]);
    expect(route.candidates.map((candidate) => `${candidate.provider}:${candidate.funding}`))
      .toEqual(['e2b:own', 'hetzner:managed', 'gcp:managed', 'aws:managed']);
    expect(route.candidates[1]!.priceMicrosPerHour).toBe(listPriceMicrosPerHour('hetzner', { cpu: 2, memoryMb: 4096 }));
    // Two of the organization's own: the cheaper first.
    expect(rankComputeOptions({}, [option('e2b', 'own'), option('hetzner', 'own')]).candidates.map((candidate) => candidate.provider))
      .toEqual(['hetzner', 'e2b']);
  });

  it('tries a recently full or failing account last, and a restored world where it was first', () => {
    const options = [option('hetzner', 'managed', { doubt: 'full a few minutes ago' }), option('gcp', 'managed'), option('aws', 'managed')];
    expect(rankComputeOptions({}, options).candidates.map((candidate) => candidate.provider)).toEqual(['gcp', 'aws', 'hetzner']);
    expect(rankComputeOptions({}, options, 'aws').candidates.map((candidate) => candidate.provider)).toEqual(['aws', 'gcp', 'hetzner']);
  });

  it('turns away managed compute with no room or no credit, as busy rather than unfit', () => {
    const route = rankComputeOptions({}, [option('hetzner', 'managed', { busy: 'all 4 in use' }),
      option('aws', 'managed', { busy: 'out of compute this month', outOfCredit: 'Out of compute: …' })]);
    expect(route.candidates).toEqual([]);
    expect(route.rejected).toEqual([
      { provider: 'hetzner', funding: 'managed', reason: 'all 4 in use', busy: true },
      { provider: 'aws', funding: 'managed', reason: 'out of compute this month', busy: true, outOfCredit: 'Out of compute: …' },
    ]);
  });
});

describe('the Computer value', () => {
  it('accepts provider "any" and a region, and "any" never moves a running world', async () => {
    expect(normalizeComputer({ provider: 'any', cpu: 4, region: 'eu' })).toEqual({ provider: 'any', cpu: 4, region: 'eu' });
    expect(() => normalizeComputer({ region: 'mars' })).toThrow(/region must be eu or us/);
    expect(() => assertInFlightComputerEdit({ provider: 'worktree' }, { provider: ANY_PROVIDER })).not.toThrow();
    const store = await Store.create(':memory:');
    cleanups.push(() => store.close());
    const project = await store.createProject('P', {});
    const task = await store.createTask({ projectId: project.id, title: 'T', workflow: 'just-do', workflowVersion: '1.0.0',
      params: { prompt: 'x', computer: { provider: 'any' } } as any });
    expect(await taskProvider(store, task.id)).toBeUndefined();
  });
});

async function fixture(options: { hosted?: boolean; plan?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-compute-router-'));
  const store = await Store.create(':memory:', { hosted: options.hosted ?? true });
  cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const connections = new WorldProviderConnectionService(store, broker, probes);
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  if (options.plan) await store.setOrganizationPlan(organization.id, options.plan as any);
  let now = Date.now();
  const router = new ComputeRouter(store, connections, () => now);
  return { dir, store, broker, connections, organization, router, advance: (ms: number) => { now += ms; } };
}

describe('the accounts Any can reach', () => {
  it('offers the organization\'s own accounts and the managed compute it may use, never both for one provider', async () => {
    const f = await fixture({ plan: 'team' });
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'hetzner', apiKey: 'h', config: { maxRunning: 4, region: 'fsn1',
      limits: { cpu: 4, memoryMb: 8192, diskGb: 200 } } });
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'aws', apiKey: 'AKIA1234567890ABCDEF:secretvalue', config: { maxRunning: 24 } });
    await f.connections.save({ organizationId: f.organization.id, provider: 'aws', apiKey: 'AKIAOWNX4567890ABCD:ownsecret' });
    const options = await f.router.options(f.organization.id);
    expect(options.map((value) => `${value.provider}:${value.funding}:${value.region}`).sort()).toEqual(['aws:own:eu', 'hetzner:managed:eu']);
    expect(options.find((value) => value.provider === 'hetzner')?.limits).toMatchObject({ cpu: 4, memoryMb: 8192, diskGb: 200 });
    // "Any"'s ceiling is the largest any of them allows; a size none allows is refused up front.
    expect(await f.connections.limits(f.organization.id, 'any')).toMatchObject({ cpu: 64, diskGb: 16_384 });
    await expect(f.connections.assertFits(f.organization.id, 'any', { cpu: 32, diskGb: 100 })).resolves.toBeUndefined();
    await expect(f.connections.assertFits(f.organization.id, 'any', { cpu: 128 })).rejects.toThrow('CPU can be at most 64 on the computers this organization can use');
    expect(await f.connections.available(f.organization.id, 'any')).toBe(true);
  });

  it('learns which Daytona accounts reach basic internet only, and Any asks for a computer one of them can give', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-compute-basic-'));
    const store = await Store.create(':memory:', { hosted: true });
    cleanups.push(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const asked: string[] = [];
    const connections = new WorldProviderConnectionService(store, new CredentialBroker(new Vault(path.join(dir, 'vault'))),
      { check: async () => {}, limits: async (provider) => { asked.push(provider); return provider === 'daytona' ? { cpu: 4, network: 'basic' } : {}; } });
    const organization = await store.createOrganization({ name: 'Basic', ownerUserId: 'owner' });
    await connections.save({ organizationId: MANAGED_COMPUTE, provider: 'daytona', apiKey: 'dtn' });
    // A Daytona account read before its internet was is read again.
    await store.setWorldProviderConnectionLimits(MANAGED_COMPUTE, 'daytona', { cpu: 4, checkedAt: 1 });
    const options = await new ComputeRouter(store, connections).options(organization.id);
    expect(asked).toEqual(['daytona']);
    expect(options[0]?.features).toMatchObject({ internet: 'basic', allowlist: false });
    await expect(connections.assertFits(organization.id, 'any', { cpu: 2 }))
      .rejects.toThrow('None of the computers this organization can use has full internet; choose "Basic internet is enough"');
    await expect(connections.assertFits(organization.id, 'any', { cpu: 2, network: { unrestricted: true, basic: true } })).resolves.toBeUndefined();
    await expect(connections.assertFits(organization.id, 'any', { network: { unrestricted: false } }))
      .rejects.toThrow('None of the computers this organization can use has an outbound allowlist');
  });

  it('knows managed compute is full or out of credit, and remembers a provider\'s refusal for a while', async () => {
    const f = await fixture({ plan: 'free' });
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'gcp', apiKey: JSON.stringify(fakeServiceAccount()), config: { maxRunning: 1 } });
    await f.connections.save({ organizationId: f.organization.id, provider: 'e2b', apiKey: 'own' });
    await f.store.setWorldProviderConnectionStatus(f.organization.id, 'e2b', 'error', 'bad key');
    let options = await f.router.options(f.organization.id);
    expect(options.find((value) => value.provider === 'gcp')).toMatchObject({ busy: 'out of compute this month',
      outOfCredit: expect.stringMatching(/^Out of compute: tavya's computers come with a paid plan/) });
    expect(options.find((value) => value.provider === 'e2b')).toMatchObject({ doubt: 'its last connection test failed' });

    await f.store.setOrganizationPlan(f.organization.id, 'team');
    await f.router.noteFull(f.organization.id, { provider: 'gcp', funding: 'managed' }, 'quota');
    options = await f.router.options(f.organization.id);
    expect(options.find((value) => value.provider === 'gcp')).toMatchObject({ doubt: 'full a few minutes ago' });
    expect(options.find((value) => value.provider === 'gcp')?.busy).toBeUndefined();
    f.advance(FULL_MEMORY_MS + 1);
    expect((await f.router.options(f.organization.id)).find((value) => value.provider === 'gcp')?.doubt).toBeUndefined();
  });
});

describe('a CPU quota shared by an account\'s machines', () => {
  it('counts the CPUs already running on it, across organizations for managed compute', async () => {
    const f = await fixture({ plan: 'team' });
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'gcp', apiKey: JSON.stringify(fakeServiceAccount()),
      config: { maxRunning: 10, limits: { cpu: 8, memoryMb: 32_768, diskGb: 1024 } } });
    // What the account said: the lowest of E2_CPUS 24, CPUS 200 and CPUS_ALL_REGIONS 100.
    await f.store.setWorldProviderConnectionLimits(MANAGED_COMPUTE, 'gcp', { cpu: 24, pool: { cpu: 24 }, checkedAt: Date.now() });
    const other = await f.store.createOrganization({ name: 'Other', ownerUserId: 'other' });
    await f.store.setOrganizationPlan(other.id, 'team');
    const project = await f.store.createProject('Theirs', { worldProvider: 'any' }, other.id);
    const task = await f.store.createTask({ projectId: project.id, title: 'Big', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
    const runners = new RunnerPoolService(f.store, f.connections);
    const lease = await runners.acquire({ project, taskId: task.id, worldId: task.id, provider: 'gcp', resources: { cpu: 22, memoryMb: 4096 } });
    expect(await f.store.runningWorldCpus('gcp', null)).toBe(22);
    expect(await f.store.runningWorldCpus('gcp', other.id)).toBe(0);

    const gcp = async (cpu: number) => (await f.router.options(f.organization.id, { cpu })).find((value) => value.provider === 'gcp');
    expect((await gcp(2))?.busy).toBeUndefined();
    expect(await gcp(4)).toMatchObject({ busy: '22 of its 24 CPUs in use' });
    expect((await f.router.route(f.organization.id, { worldProvider: 'any', resources: { cpu: 4 } })).rejected)
      .toEqual([{ provider: 'gcp', funding: 'managed', reason: '22 of its 24 CPUs in use', busy: true }]);
    await runners.release(lease.leaseId, 'gcp');
    expect((await gcp(4))?.busy).toBeUndefined();
  });
});

describe('falling over', () => {
  const route = () => rankComputeOptions({}, [option('hetzner', 'managed'), option('gcp', 'managed'), option('aws', 'managed')]);

  it('tries the next candidate when one is full, remembers it, and records the decision', async () => {
    const f = await fixture({ plan: 'team' });
    const tried: string[] = [];
    const decisions: any[] = [];
    const { value, candidate } = await f.router.run(f.organization.id, route(), async (next, reason) => {
      tried.push(next.provider);
      if (next.provider === 'hetzner') throw new ProviderCapacityFull('Hetzner refused a new server: the CPU limit is full');
      // A refusal wrapped by the activity still counts (ApplicationFailure keeps it as its cause).
      if (next.provider === 'gcp') throw Object.assign(new Error('world-capacity'), { cause: new ManagedComputeBusy('All 10 in use') });
      return `made on ${next.provider}: ${reason}`;
    }, async (decision) => { decisions.push(decision); });
    expect(tried).toEqual(['hetzner', 'gcp', 'aws']);
    expect(candidate.provider).toBe('aws');
    expect(value).toBe('made on aws: cheapest that fits; Hetzner and Google Cloud were full');
    expect(decisions).toEqual([expect.objectContaining({ provider: 'aws', funding: 'managed',
      reason: 'cheapest that fits; Hetzner and Google Cloud were full',
      candidates: [expect.objectContaining({ provider: 'hetzner', outcome: 'full', detail: 'Hetzner refused a new server: the CPU limit is full' }),
        expect.objectContaining({ provider: 'gcp', outcome: 'full', detail: 'All 10 in use' }),
        expect.objectContaining({ provider: 'aws', outcome: 'chosen' })] })]);
    // Only the provider's own refusal is remembered: Hetzner goes last next time, Google Cloud does not.
    const next = rankComputeOptions({}, await Promise.all(['hetzner', 'gcp', 'aws'].map(async (provider) =>
      option(provider, 'managed', (await f.store.kvGet(`compute-full:${MANAGED_COMPUTE}:${provider}`)) ? { doubt: 'full' } : {}))));
    expect(next.candidates.map((value) => value.provider)).toEqual(['gcp', 'aws', 'hetzner']);
  });

  it('waits only when every candidate is full, saying which and why', async () => {
    const f = await fixture({ plan: 'team' });
    const decisions: any[] = [];
    const failure = await f.router.run(f.organization.id, route(), async (next) => {
      throw new ProviderCapacityFull(`${next.provider} is full`);
    }, async (decision) => { decisions.push(decision); }).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderCapacityFull);
    expect(failure.message).toBe('Every computer this task can use is full (Hetzner (tavya\'s): hetzner is full; '
      + 'Google Cloud (tavya\'s): gcp is full; AWS (tavya\'s): aws is full). Waiting for one to free up.');
    expect(decisions).toEqual([expect.objectContaining({ reason: failure.message })]);
    expect(decisions[0].provider).toBeUndefined();
  });

  it('says Out of compute when only spent credit stands in the way, and asks people when nothing fits', async () => {
    const f = await fixture();
    const spent = rankComputeOptions({}, [option('aws', 'managed', { busy: 'out of compute this month', outOfCredit: 'Out of compute: renews soon.' })]);
    const out = await f.router.run(f.organization.id, spent, async () => 'never', async () => {}).catch((error) => error);
    expect(out).toBeInstanceOf(ComputeCreditExhausted);
    expect(out.message).toBe('Out of compute: renews soon.');
    const busy = rankComputeOptions({}, [option('hetzner', 'managed', { busy: 'all 4 in use' })]);
    expect(await f.router.run(f.organization.id, busy, async () => 'never', async () => {}).catch((error) => error)).toBeInstanceOf(ManagedComputeBusy);

    const unfit = rankComputeOptions({ cpu: 64 }, [option('hetzner', 'managed', { limits: { cpu: 4 } })]);
    const none = await f.router.run(f.organization.id, unfit, async () => 'never', async () => {}).catch((error) => error);
    expect(none).not.toBeInstanceOf(ProviderCapacityFull);
    expect(none.message).toBe('No computer this organization can use fits this task: Hetzner (tavya\'s): at most 4 CPU. '
      + 'Change its Computer, or connect another under Settings → Computers.');
    const nothing = await f.router.run(f.organization.id, rankComputeOptions({}, []), async () => 'never', async () => {}).catch((error) => error);
    expect(nothing.message).toBe('No computer is connected: connect one under Settings → Computers.');
  });

  it('makes a new world elsewhere when a provider is down, and retries an outage only when every one is', async () => {
    const f = await fixture({ plan: 'team' });
    const decisions: any[] = [];
    const { candidate, value } = await f.router.run(f.organization.id, route(), async (next, reason) => {
      if (next.provider === 'hetzner') throw Object.assign(new Error('world-infra'), { cause: new ProviderOutage('Hetzner: unknown_error') });
      if (next.provider === 'gcp') throw new ProviderCapacityFull('quota');
      return reason;
    }, async (decision) => { decisions.push(decision); });
    expect(candidate.provider).toBe('aws');
    expect(value).toBe('cheapest that fits; Google Cloud was full; Hetzner was down');
    expect(decisions[0].candidates.map((entry: any) => entry.outcome)).toEqual(['down', 'full', 'chosen']);
    // An outage is not remembered as a full provider.
    expect(await f.store.kvGet(`compute-full:${MANAGED_COMPUTE}:hetzner`)).toBeUndefined();

    const outage = new ProviderOutage('everything is down');
    const failure = await f.router.run(f.organization.id, route(), async () => { throw outage; }, async () => {}).catch((error) => error);
    expect(failure).toBe(outage);
  });

  it('stops at an error that is not about room', async () => {
    const f = await fixture();
    const tried: string[] = [];
    await expect(f.router.run(f.organization.id, route(), async (next) => { tried.push(next.provider); throw new Error('clone failed'); },
      async () => {})).rejects.toThrow('clone failed');
    expect(tried).toEqual(['hetzner']);
  });
});

/** A fake cloud provider: makes a scratch world unless told it is full. */
function fakeProvider(kind: string, state: { full?: string; made: string[] }) {
  return {
    kind, parkable: false, capabilities: { remote: true },
    async create(spec: any) {
      if (state.full) throw new ProviderCapacityFull(state.full);
      state.made.push(spec.taskId);
      return { handle: { kind, id: spec.taskId, root: '/home/user/karmax', branch: `tavya/${spec.taskId}`, base: spec.base ?? 'main',
        meta: { funding: 'managed' } }, async exec() { return { code: 0, stdout: '', stderr: '' }; }, async destroy() {} } as any;
    },
    async open() { throw new Error('unused'); },
    async destroy() {},
  } as any;
}

describe('createWorld with provider "Any"', () => {
  async function activities(plan = 'team') {
    const f = await fixture({ plan });
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'hetzner', apiKey: 'h', config: { limits: { cpu: 4, memoryMb: 8192, diskGb: 200 } } });
    await f.connections.save({ organizationId: MANAGED_COMPUTE, provider: 'aws', apiKey: 'AKIA1234567890ABCDEF:secretvalue' });
    const project = await f.store.createProject('Cloud', { worldProvider: 'any' }, f.organization.id);
    const hetzner = { made: [] as string[], full: undefined as string | undefined };
    const aws = { made: [] as string[], full: undefined as string | undefined };
    const worlds = new WorldRegistry();
    worlds.register(fakeProvider('hetzner', hetzner));
    worlds.register(fakeProvider('aws', aws));
    const core = makeCoreActivities({ store: f.store, worlds, adapters: new Map(), profiles: new ProfileResolver(f.store, 'mock'),
      contentDir: path.join(f.dir, 'content'), providerConnections: f.connections, runners: new RunnerPoolService(f.store, f.connections) } as any);
    const task = async (title: string, computer?: Record<string, unknown>) => (await f.store.createTask({ projectId: project.id, title,
      workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: title, ...(computer ? { computer } : {}) } as any })).id;
    const events = async (taskId: string, type: string) => (await f.store.eventsSince(taskId, 0)).filter((event) => event.type === type);
    return { ...f, project, core, hetzner, aws, task, events };
  }

  it('makes the world on the cheapest that fits, and on the next when that one is full', async () => {
    const a = await activities();
    const first = await a.task('First');
    const handle = await a.core.createWorld({ taskId: first, base: 'main', kind: ANY_PROVIDER });
    expect(handle.kind).toBe('hetzner');
    expect(handle.meta?.routed).toBe('cheapest that fits');
    expect((await a.events(first, 'world.routed'))[0]?.payload).toMatchObject({ provider: 'hetzner', funding: 'managed',
      candidates: [expect.objectContaining({ provider: 'hetzner', outcome: 'chosen' }), expect.objectContaining({ provider: 'aws', outcome: 'untried' })] });

    a.hetzner.full = 'Hetzner refused a new server: the CPU limit is full';
    const second = await a.task('Second');
    const moved = await a.core.createWorld({ taskId: second, base: 'main', kind: ANY_PROVIDER });
    expect(moved.kind).toBe('aws');
    expect(moved.meta?.routed).toBe('cheapest that fits; Hetzner was full');
    expect(a.aws.made).toEqual([second]);
    // The refusal is remembered: the next task goes to AWS without asking Hetzner first.
    a.hetzner.full = undefined;
    const third = await a.task('Third');
    expect((await a.core.createWorld({ taskId: third, base: 'main', kind: ANY_PROVIDER })).kind).toBe('aws');
    expect(a.hetzner.made).toEqual([first]);
    // A size Hetzner's account cannot give goes where it fits.
    const big = await a.task('Big', { diskGb: 500 });
    expect((await a.core.createWorld({ taskId: big, base: 'main', kind: ANY_PROVIDER })).kind).toBe('aws');
    expect((await a.events(big, 'world.routed'))[0]?.payload.rejected).toEqual([{ provider: 'hetzner', funding: 'managed', reason: 'at most 200 GB disk' }]);
  });

  it('waits as a full provider does when every candidate is full', async () => {
    const a = await activities();
    a.hetzner.full = 'Hetzner: the CPU limit is full';
    a.aws.full = 'AWS: VcpuLimitExceeded';
    const taskId = await a.task('Waits');
    const failure = await a.core.createWorld({ taskId, base: 'main', kind: ANY_PROVIDER }).catch((error) => error);
    expect(failure).toMatchObject({ type: 'world-capacity', nonRetryable: true });
    expect(failure.message).toMatch(/^Every computer this task can use is full \(Hetzner \(tavya's\): Hetzner: the CPU limit is full; AWS \(tavya's\): AWS: VcpuLimitExceeded\)/);
    expect((await a.events(taskId, 'world.routed'))[0]?.payload).toMatchObject({ reason: failure.message });
    // Room again: the next attempt (the workflow's retry) gets a machine.
    a.aws.full = undefined;
    expect((await a.core.createWorld({ taskId, base: 'main', kind: ANY_PROVIDER })).kind).toBe('aws');
  });

  it('runs a named provider exactly, without routing', async () => {
    const a = await activities();
    const taskId = await a.task('Pinned', { provider: 'aws' });
    a.aws.full = 'AWS: VcpuLimitExceeded';
    const failure = await a.core.createWorld({ taskId, base: 'main', kind: 'aws' }).catch((error) => error);
    expect(failure).toMatchObject({ type: 'world-capacity', message: 'AWS: VcpuLimitExceeded' });
    expect(a.hetzner.made).toEqual([]);
    expect(await a.events(taskId, 'world.routed')).toEqual([]);
  });

  // A workflow passes the provider its task had when it started. A task that
  // has no world yet runs where its Computer says now: the one that failed on
  // an E2B the organization never connected (tavya.io, 2026-10-29) did not
  // land on Hetzner when someone picked it, nor on Any once that was the default.
  it('makes a new world where the task\'s Computer says now, not where it said when the workflow started', async () => {
    const a = await activities();
    const pinned = await a.task('Changed to Hetzner', { provider: 'hetzner' });
    const handle = await a.core.createWorld({ taskId: pinned, base: 'main', kind: 'e2b' });
    expect(handle.kind).toBe('hetzner');
    expect(a.hetzner.made).toEqual([pinned]);
    expect((await a.events(pinned, 'world.provisioning'))[0]?.payload).toEqual({ provider: 'hetzner' });

    const unpinned = await a.task('Started when E2B was the default');
    expect((await a.core.createWorld({ taskId: unpinned, base: 'main', kind: 'e2b' })).kind).toBe('hetzner');
    expect((await a.events(unpinned, 'world.routed'))[0]?.payload).toMatchObject({ provider: 'hetzner', funding: 'managed' });
  });
});

function fakeServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { type: 'service_account', project_id: 'p', client_email: 'sa@p.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
