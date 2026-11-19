import crypto from 'node:crypto';
import path from 'node:path';
import type { Store } from '../store/db.js';
import type { WorldRegistry } from '../world/registry.js';
import type { World, WorldHandle } from '../world/types.js';
import { ComputeRouter, type RouterConnections } from '../world/compute-router.js';
import { ProviderCapacityFull } from './limits.js';
import { taskEnded } from '../world/task-ended.js';
import { costMicrosPerSecond, PROVIDER_METERED } from '../world/runners.js';
import { DEFAULT_MACHINE, defaultLoginSandboxes } from '../domain/computer.js';
import { timed } from '../timing/index.js';
import { loginCliPackages } from './remote-process.js';

/**
 * Login sandboxes (wiki features/computerless-tasks § Subscription logins).
 *
 * A task without a computer whose model is a subscription login (Claude Code,
 * Codex) runs that login's unmodified CLI — the only way a plan may be used —
 * and the CLI is a whole agent harness that must never run on the shared
 * host. So its turns run the CLI in a small cloud sandbox of its own, with no
 * repository, setup, wiki checkout or MCP server, offered only tavya's
 * platform tools. The task stays a task without a computer in every other
 * respect: its world is still the `none` world, which is what its tools see.
 *
 * One sandbox per task, kept while its conversation is active: a follow-up
 * finds it running (a turn starts in about a second) or, after
 * `idleMs` without a turn, parked by the lifecycle sweep (E2B pauses it, a
 * resume takes a second or two); a task that ended, or one parked for a day,
 * loses it. Compute is billed for the seconds it runs (E2B reports them
 * itself; others are booked here when it parks or goes).
 *
 * An organization runs at most `maxLoginSandboxes` of them at once
 * (OrganizationUsagePolicy); a turn beyond that waits, first come first
 * served, while the task says so. A running sandbox holds its slot until it
 * parks.
 */

/** Providers a login sandbox runs on: sandboxes that start in seconds and bill by
 * the second. A VM (Hetzner's hourly billing, minutes to provision) never is. */
export const LOGIN_SANDBOX_PROVIDERS: readonly string[] = ['e2b', 'daytona'];
/** Providers whose parked sandbox resumes in a second (E2B: 0.1–0.4 s). An
 * idle sandbox elsewhere is deleted instead: Daytona's park archives it, and
 * restoring an archive took ~80 s (2026-11-19), far longer than a new one. */
export const LOGIN_SANDBOX_PARKS: readonly string[] = ['e2b'];
/** How many paused, ready-to-claim sandboxes an organization that used one in
 * the last day keeps per provider that parks (`LOGIN_SANDBOX_PARKS`). */
export const LOGIN_SANDBOX_POOL = () => {
  const value = Number(process.env.KARMAX_LOGIN_SANDBOX_POOL ?? 1);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
};
/** A pooled sandbox older than this is replaced (its CLI may be outdated). */
const POOL_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
/** An organization keeps its pool this long after its last login sandbox. */
const POOL_KEEP_MS = 24 * 60 * 60_000;
/** The label generation of a login sandbox: never a task world's (those start at 1). */
export const LOGIN_SANDBOX_GENERATION = 0;
/** Running without a turn this long, it is parked. */
export const LOGIN_SANDBOX_IDLE_MS = () => envMs('KARMAX_LOGIN_SANDBOX_IDLE_MS', 3 * 60_000);
/** Parked this long, it is destroyed (the next turn makes another). */
export const LOGIN_SANDBOX_PARKED_MS = () => envMs('KARMAX_LOGIN_SANDBOX_PARKED_MS', 24 * 60 * 60_000);

/** A slot's or a wait's lease, renewed while its turn runs. */
const LEASE_MS = 90_000;
const RENEW_MS = 20_000;

function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const entryKey = (taskId: string) => `login-sandbox:${taskId}`;
const slotKey = (organizationId: string, index: number) => `login-sandbox-slot:${organizationId}:${index}`;
const waitPrefix = (organizationId: string) => `login-sandbox-wait:${organizationId}:`;
const poolPrefix = (organizationId: string, provider: string) => `login-sandbox-pool:${organizationId}:${provider}:`;
const recentKey = (organizationId: string, provider: string) => `login-sandbox-recent:${organizationId}:${provider}`;
/** The label a pooled sandbox carries instead of a task's (one per sandbox: providers adopt by label). */
export const POOL_LABEL_PREFIX = 'login-pool-';
const ownerKey = (label: string) => `login-sandbox-owner:${label}`;

/** A paused sandbox whose CLI already ran once, waiting for a conversation. */
interface PooledSandbox { organizationId: string; provider: string; funding?: 'own' | 'managed'; handle: WorldHandle;
  packages: string[]; createdAt: number }

/** What a pooled sandbox runs once before it pauses: the whole CLI start-up,
 * on a key that fails at the first request (nothing is sent anywhere else).
 * A pooled sandbox then gives the first token in ~2.6 s, against 6.5–7.8 s
 * for a new one (Claude Code 2.1.322 on E2B, 2026-11-19). */
const POOL_WARM_UP = (packages: readonly string[], root: string, homes: readonly string[]) => [
  // In each Claude home the organization's logins use (remoteAgentHomeRelative): the CLI's first
  // start in a home costs ~2.5 s more than later ones (3.7 s against 1.2 s, 2026-11-19).
  ...(homes.length ? homes : ['']).map((home) => `cd "$HOME" && ${home ? `CLAUDE_CONFIG_DIR=${JSON.stringify(path.posix.join(root, home))} ` : ''}`
    + `ANTHROPIC_API_KEY=sk-ant-warm-up timeout 60 npx --yes ${packages[0]} -p hi --output-format stream-json --verbose >/dev/null 2>&1`),
  ...packages.slice(1).map((pkg) => `timeout 60 npx --yes ${pkg} --version >/dev/null 2>&1`),
  'true'].join('; ');

export interface LoginSandboxEntry {
  organizationId: string;
  projectId?: string;
  provider: string;
  funding?: 'own' | 'managed';
  handle: WorldHandle;
  state: 'running' | 'parked';
  /** When its last turn ended (or began, while one runs). */
  usedAt: number;
  /** Since when it runs, for the providers whose usage is booked here. */
  runningSince: number;
  /** A turn holds it until then (renewed while it runs). */
  busyUntil?: number;
}

export interface LoginSandboxCandidate { provider: string; funding?: 'own' | 'managed' }

/** Where an organization's login sandboxes can run now: candidates in the order
 * they are tried; `busy` says some account would take one once it has room;
 * `reason` is why none can (no computer at all, credit spent). */
export interface LoginSandboxRoute { candidates: LoginSandboxCandidate[]; busy?: string; reason?: string }

export interface LoginSandboxDeps {
  store: Store;
  /** Where its sandboxes are made; absent, it only answers where they could run (readiness). */
  worlds?: WorldRegistry;
  /** The organization's computers (the compute router's view). */
  connections?: RouterConnections;
  /** Tests: where an organization's sandboxes run. */
  route?: (organizationId: string) => Promise<LoginSandboxRoute>;
  now?: () => number;
  pollMs?: number;
}

export interface LoginSandbox {
  world: World;
  provider: string;
  /** It was running, or parked, from an earlier turn of this task. */
  reused: boolean;
  /** The turn ended: it stays, running until the sweep parks it. */
  settle(): Promise<void>;
  /** Something went wrong with it: destroy it now. */
  discard(): Promise<void>;
}

/** What a turn waiting for a slot tells its task. */
export interface LoginSandboxQueued { inUse: number; cap: number; ahead: number }

export const NO_LOGIN_SANDBOX = 'this organization has no cloud computer to run it in';

export class LoginSandboxes {
  constructor(private deps: LoginSandboxDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private registry(): WorldRegistry {
    if (!this.deps.worlds) throw new Error('login sandboxes need the world providers');
    return this.deps.worlds;
  }

  /** How many may run at once in this organization. */
  async cap(organizationId: string): Promise<number> {
    const policy = await this.deps.store.getOrganizationUsagePolicy(organizationId).catch(() => undefined);
    return Math.max(1, Math.floor(policy?.maxLoginSandboxes ?? defaultLoginSandboxes()));
  }

  /** Where this organization's login sandboxes run, cheapest first. */
  async route(organizationId: string): Promise<LoginSandboxRoute> {
    if (this.deps.route) return this.deps.route(organizationId);
    if (!this.deps.connections) return { candidates: [], reason: NO_LOGIN_SANDBOX };
    // The default sandbox (no size of its own: no template to build), any
    // internet: the CLI reaches only its model's API and tavya.
    const route = await new ComputeRouter(this.deps.store, this.deps.connections)
      .route(organizationId, { network: { unrestricted: true, basic: true } as never });
    const fits = (provider: string) => LOGIN_SANDBOX_PROVIDERS.includes(provider);
    const candidates = route.candidates.filter((candidate) => fits(candidate.provider))
      .map((candidate) => ({ provider: candidate.provider, funding: candidate.funding }));
    const rejected = route.rejected.filter((option) => fits(option.provider));
    const busy = rejected.find((option) => option.busy && !option.outOfCredit);
    const spent = rejected.find((option) => option.outOfCredit)?.outOfCredit;
    return { candidates, ...(busy ? { busy: busy.reason } : {}),
      ...(!candidates.length && !busy ? { reason: spent ?? NO_LOGIN_SANDBOX } : {}) };
  }

  /** Why this organization cannot run a login sandbox at all, or undefined if it can (now or once one has room). */
  async unavailable(organizationId: string): Promise<string | undefined> {
    const route = await this.route(organizationId).catch(() => ({ candidates: [], reason: NO_LOGIN_SANDBOX } as LoginSandboxRoute));
    return route.candidates.length || route.busy ? undefined : route.reason ?? NO_LOGIN_SANDBOX;
  }

  async entry(taskId: string): Promise<LoginSandboxEntry | undefined> {
    const raw = await this.deps.store.kvGet(entryKey(taskId));
    if (!raw) return undefined;
    try { return JSON.parse(raw) as LoginSandboxEntry; } catch { return undefined; }
  }

  private async save(taskId: string, entry: LoginSandboxEntry): Promise<void> {
    await this.deps.store.kvSet(entryKey(taskId), JSON.stringify(entry));
  }

  /**
   * The task's sandbox for this turn: its own (running, or resumed from
   * parked) or a new one. Waits for a slot first, beyond the organization's
   * cap. While the turn runs, its slot and sandbox are renewed; `settle` or
   * `discard` ends that.
   */
  async open(input: { organizationId: string; projectId?: string; taskId: string; signal?: AbortSignal;
    heartbeat?: () => void; onQueued?: (queued: LoginSandboxQueued) => void | Promise<void>;
    /** Where in the sandbox this turn's CLI keeps its home (remoteAgentHomeRelative): the pool warms it. */
    cliHome?: string }): Promise<LoginSandbox> {
    const { organizationId, taskId } = input;
    await this.acquireSlot(organizationId, taskId, input);
    let renewal: NodeJS.Timeout | undefined;
    const renew = async () => {
      const until = this.now() + LEASE_MS;
      await this.renewSlot(organizationId, taskId, until).catch(() => undefined);
      const current = await this.entry(taskId).catch(() => undefined);
      if (current) await this.save(taskId, { ...current, busyUntil: until }).catch(() => undefined);
    };
    renewal = setInterval(() => { void renew(); }, RENEW_MS);
    renewal.unref?.();
    const stop = () => { if (renewal) clearInterval(renewal); renewal = undefined; };
    try {
      const opened = await this.reopen(taskId, input.signal) ?? await this.claim(input) ?? await this.create(input);
      const entry = { ...opened.entry, usedAt: this.now(), busyUntil: this.now() + LEASE_MS };
      await this.save(taskId, entry);
      // This organization uses login sandboxes: its pool is kept (and refilled now, after a claim).
      if (LOGIN_SANDBOX_PARKS.includes(entry.provider)) {
        const recent = await this.recent(organizationId, entry.provider);
        const homes = [...new Set([...(input.cliHome ? [input.cliHome] : []), ...recent.homes])].slice(0, 3);
        await this.deps.store.kvSet(recentKey(organizationId, entry.provider), JSON.stringify({ at: this.now(), homes })).catch(() => undefined);
        if (!opened.reused) void this.refill(organizationId, entry.provider, entry.funding).catch(() => undefined);
      }
      return {
        world: opened.world, provider: entry.provider, reused: opened.reused,
        settle: async () => {
          stop();
          const current = await this.entry(taskId);
          if (current) await this.save(taskId, { ...current, usedAt: this.now(), busyUntil: undefined });
          // It keeps running for the idle period: the slot is held that long.
          await this.renewSlot(organizationId, taskId, this.now() + LOGIN_SANDBOX_IDLE_MS() + LEASE_MS).catch(() => undefined);
        },
        discard: async () => {
          stop();
          await this.retire(taskId, 'destroy').catch(() => undefined);
        },
      };
    } catch (error) {
      stop();
      await this.releaseSlot(organizationId, taskId).catch(() => undefined);
      throw error;
    }
  }

  /** The task's sandbox from an earlier turn, running again; undefined when it has none (or it is gone). */
  private async reopen(taskId: string, signal?: AbortSignal): Promise<{ world: World; entry: LoginSandboxEntry; reused: true } | undefined> {
    const entry = await this.entry(taskId);
    if (!entry) return undefined;
    try {
      signal?.throwIfAborted();
      const provider = this.registry().get(entry.handle.kind);
      // E2B and Daytona resume a parked sandbox when it is opened.
      const world = await timed('login-sandbox.resume', () => provider.open(entry.handle));
      const resumed = entry.state === 'parked';
      return { world, reused: true, entry: { ...entry, state: 'running', ...(resumed ? { runningSince: this.now() } : {}) } };
    } catch (error) {
      if (signal?.aborted) throw error;
      // Gone (reaped, expired): a new one replaces it.
      await this.retire(taskId, 'destroy', { keepSlot: true }).catch(() => undefined);
      return undefined;
    }
  }

  /** A pooled sandbox of the organization's first candidate that parks, resumed and now the task's. */
  private async claim(input: { organizationId: string; projectId?: string; taskId: string; signal?: AbortSignal }):
    Promise<{ world: World; entry: LoginSandboxEntry; reused: false } | undefined> {
    const route = await this.route(input.organizationId).catch(() => undefined);
    const candidate = route?.candidates[0];
    if (!candidate || !LOGIN_SANDBOX_PARKS.includes(candidate.provider)) return undefined;
    const packages = loginCliPackages();
    for (const { key, value } of await this.deps.store.kvEntries(poolPrefix(input.organizationId, candidate.provider))) {
      input.signal?.throwIfAborted();
      let pooled: PooledSandbox;
      try { pooled = JSON.parse(value) as PooledSandbox; } catch { continue; }
      // Taken by this claim alone; one of other CLI versions is not taken (the sweep replaces it).
      if (pooled.packages.join(' ') !== packages.join(' ') || pooled.funding !== candidate.funding) continue;
      if (!(await this.deps.store.kvCompareAndSet(key, value, undefined))) continue;
      const label = pooled.handle.id;
      await this.deps.store.kvSet(ownerKey(label), input.taskId);
      try {
        const world = await timed('login-sandbox.claim', () => this.registry().get(pooled.provider).open(pooled.handle));
        const now = this.now();
        const entry: LoginSandboxEntry = { organizationId: input.organizationId, ...(input.projectId ? { projectId: input.projectId } : {}),
          provider: pooled.provider, ...(pooled.funding ? { funding: pooled.funding } : {}), handle: pooled.handle,
          state: 'running', usedAt: now, runningSince: now };
        await this.save(input.taskId, entry);
        return { world, entry, reused: false };
      } catch {
        await this.deps.store.kvDelete(ownerKey(label)).catch(() => undefined);
        await this.destroyHandle(pooled.handle);
      }
    }
    return undefined;
  }

  /** When the organization last used a sandbox of `provider`, and the CLI homes its logins use. */
  private async recent(organizationId: string, provider: string): Promise<{ at: number; homes: string[] }> {
    const raw = await this.deps.store.kvGet(recentKey(organizationId, provider)).catch(() => undefined);
    if (!raw) return { at: 0, homes: [] };
    try {
      const value = JSON.parse(raw) as { at?: number; homes?: string[] } | number;
      return typeof value === 'number' ? { at: value, homes: [] } : { at: Number(value.at ?? 0), homes: (value.homes ?? []).filter((home) => typeof home === 'string') };
    } catch { return { at: 0, homes: [] }; }
  }

  /** Make the organization's pool for `provider` whole: paused sandboxes whose CLI already started once. */
  private refilling = new Set<string>();
  async refill(organizationId: string, provider: string, funding?: 'own' | 'managed'): Promise<number> {
    const want = LOGIN_SANDBOX_POOL();
    const key = `${organizationId}:${provider}`;
    if (want < 1 || !LOGIN_SANDBOX_PARKS.includes(provider) || this.refilling.has(key)) return 0;
    this.refilling.add(key);
    let made = 0;
    try {
      const packages = loginCliPackages();
      for (;;) {
        const pool = (await this.deps.store.kvEntries(poolPrefix(organizationId, provider)))
          .filter(({ value }) => { try { return (JSON.parse(value) as PooledSandbox).packages.join(' ') === packages.join(' '); } catch { return false; } });
        if (pool.length >= want) return made;
        const label = `${POOL_LABEL_PREFIX}${crypto.randomUUID()}`;
        const poolKey = `${poolPrefix(organizationId, provider)}${label}`;
        const world = await timed('login-sandbox.pool-create', () => this.registry().get(provider).create({
          taskId: label, organizationId, generation: LOGIN_SANDBOX_GENERATION, base: 'main', scratch: true,
          network: { unrestricted: true }, warmPackages: packages }));
        // Known before it runs anything, so the orphan reaper spares it.
        const pooled: PooledSandbox = { organizationId, provider, ...(funding ? { funding } : {}), handle: world.handle, packages, createdAt: this.now() };
        await this.deps.store.kvSet(poolKey, JSON.stringify(pooled));
        try {
          const homes = (await this.recent(organizationId, provider)).homes;
          await timed('login-sandbox.pool-warm', () => world.exec('bash', ['-c', POOL_WARM_UP(packages, world.handle.root, homes)], { timeoutMs: 150_000 }));
          const provider_ = this.registry().get(provider);
          if (provider_.park) await provider_.park(world.handle);
        } catch (error) {
          await this.deps.store.kvDelete(poolKey).catch(() => undefined);
          await this.destroyHandle(world.handle);
          throw error;
        }
        made++;
      }
    } finally { this.refilling.delete(key); }
  }

  private async destroyHandle(handle: WorldHandle): Promise<void> {
    const provider = this.registry().get(handle.kind);
    await (provider.destroy ? provider.destroy(handle) : provider.open(handle).then((world) => world.destroy())).catch(() => undefined);
  }

  /** Pools of organizations that stopped using login sandboxes, and pooled ones too old or of another CLI version, go; the rest are refilled. */
  private async housekeepPools(now: number): Promise<void> {
    const packages = loginCliPackages().join(' ');
    for (const { key, value } of await this.deps.store.kvEntries('login-sandbox-pool:')) {
      let pooled: PooledSandbox;
      try { pooled = JSON.parse(value) as PooledSandbox; } catch { await this.deps.store.kvDelete(key); continue; }
      const recent = (await this.recent(pooled.organizationId, pooled.provider)).at;
      if (pooled.packages.join(' ') === packages && pooled.createdAt > now - POOL_MAX_AGE_MS && recent > now - POOL_KEEP_MS) continue;
      if (await this.deps.store.kvCompareAndSet(key, value, undefined)) await this.destroyHandle(pooled.handle);
    }
    for (const { key } of await this.deps.store.kvEntries('login-sandbox-recent:')) {
      const [organizationId, provider] = key.slice('login-sandbox-recent:'.length).split(':');
      if (!organizationId || !provider) continue;
      if ((await this.recent(organizationId, provider)).at <= now - POOL_KEEP_MS) { await this.deps.store.kvDelete(key); continue; }
      const funding = (await this.route(organizationId).catch(() => undefined))?.candidates.find((c) => c.provider === provider)?.funding;
      await this.refill(organizationId, provider, funding).catch(() => undefined);
    }
  }

  private async create(input: { organizationId: string; projectId?: string; taskId: string; signal?: AbortSignal }):
    Promise<{ world: World; entry: LoginSandboxEntry; reused: false }> {
    const route = await this.route(input.organizationId);
    if (!route.candidates.length) {
      if (route.busy) throw new ProviderCapacityFull(`Every cloud computer this organization can use is full (${route.busy}).`);
      throw new Error(route.reason ?? NO_LOGIN_SANDBOX);
    }
    let last: unknown;
    for (const candidate of route.candidates) {
      try {
        input.signal?.throwIfAborted();
        const world = await timed('login-sandbox.create', () => this.registry().get(candidate.provider).create({
          taskId: input.taskId, organizationId: input.organizationId, generation: LOGIN_SANDBOX_GENERATION,
          base: 'main', scratch: true, ...(input.signal ? { signal: input.signal } : {}),
          network: { unrestricted: true },
          // A template whose npx cache already holds the CLIs, where the provider has one.
          warmPackages: loginCliPackages(),
        }));
        world.handle.meta = { ...world.handle.meta, loginSandbox: true };
        const now = this.now();
        const entry: LoginSandboxEntry = { organizationId: input.organizationId, ...(input.projectId ? { projectId: input.projectId } : {}),
          provider: candidate.provider, ...(candidate.funding ? { funding: candidate.funding } : {}),
          handle: world.handle, state: 'running', usedAt: now, runningSince: now };
        // Recorded at once, so the orphan reaper knows it is this task's.
        await this.save(input.taskId, entry);
        return { world, entry, reused: false };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        last = error;
      }
    }
    throw last;
  }

  /** Park a running sandbox, or destroy it; book the seconds it ran where its provider does not. */
  private async retire(taskId: string, how: 'park' | 'destroy', options: { keepSlot?: boolean } = {}): Promise<void> {
    const entry = await this.entry(taskId);
    if (!entry) return;
    const provider = this.registry().get(entry.handle.kind);
    const now = this.now();
    const parks = how === 'park' && !!provider.park && LOGIN_SANDBOX_PARKS.includes(entry.provider);
    if (parks) await provider.park!(entry.handle);
    else await this.destroyHandle(entry.handle);
    if (entry.state === 'running') await this.book(taskId, entry, now).catch(() => undefined);
    if (parks) await this.save(taskId, { ...entry, state: 'parked', busyUntil: undefined });
    else {
      await this.deps.store.kvDelete(entryKey(taskId));
      if (entry.handle.id !== taskId) await this.deps.store.kvDelete(ownerKey(entry.handle.id)).catch(() => undefined);
    }
    if (!options.keepSlot) await this.releaseSlot(entry.organizationId, taskId);
  }

  /** Book the seconds a sandbox ran, for a provider that reports none itself (E2B does). */
  private async book(taskId: string, entry: LoginSandboxEntry, endedAt: number): Promise<void> {
    if (PROVIDER_METERED.has(entry.provider)) return;
    const seconds = Math.max(0, (endedAt - entry.runningSince) / 1000);
    if (!seconds) return;
    const cpu = DEFAULT_MACHINE.cpu ?? 2, memoryMb = DEFAULT_MACHINE.memoryMb ?? 2048;
    await this.deps.store.recordUsage({ id: `usage:login-sandbox:${taskId}:${entry.runningSince}`, organizationId: entry.organizationId,
      ...(entry.projectId ? { projectId: entry.projectId } : {}), taskId, worldId: taskId, provider: entry.provider,
      kind: 'world.active', quantity: seconds, unit: 'second',
      costMicros: Math.round(seconds * costMicrosPerSecond(entry.provider, cpu, memoryMb, 0)),
      startedAt: entry.runningSince, endedAt, fundingSource: entry.funding === 'managed' ? 'managed' : 'byok',
      metadata: { loginSandbox: true, cpu, memoryMb } });
  }

  /**
   * The lifecycle sweep's pass: a sandbox whose task ended goes; one idle
   * past `LOGIN_SANDBOX_IDLE_MS` parks (and frees its slot); one parked past
   * `LOGIN_SANDBOX_PARKED_MS` goes.
   */
  async housekeep(): Promise<number> {
    let changed = 0;
    const now = this.now();
    await this.housekeepPools(now).catch(() => undefined);
    for (const { key } of await this.deps.store.kvEntries('login-sandbox:')) {
      const taskId = key.slice('login-sandbox:'.length);
      const entry = await this.entry(taskId);
      if (!entry) continue;
      try {
        if (!(await this.deps.store.taskMetadata(taskId)) || await taskEnded(this.deps.store, taskId)) {
          await this.retire(taskId, 'destroy'); changed++; continue;
        }
        if (entry.busyUntil && entry.busyUntil > now) continue;
        if (entry.state === 'running' && entry.usedAt <= now - LOGIN_SANDBOX_IDLE_MS()) {
          await this.retire(taskId, 'park'); changed++; continue;
        }
        if (entry.state === 'parked' && entry.usedAt <= now - LOGIN_SANDBOX_PARKED_MS()) {
          await this.retire(taskId, 'destroy'); changed++;
        }
      } catch { /* the next sweep tries again */ }
    }
    return changed;
  }

  /** Whether `taskId`'s sandbox the reaper found is this task's live login sandbox (spared). */
  async protects(taskId: string, matches?: (handle: WorldHandle) => boolean | undefined): Promise<boolean> {
    if (taskId.startsWith(POOL_LABEL_PREFIX)) {
      // Pooled, or claimed by a task whose sandbox it now is.
      const pooled = (await this.deps.store.kvEntries('login-sandbox-pool:')).some(({ key }) => key.endsWith(`:${taskId}`));
      if (pooled) return true;
      const owner = await this.deps.store.kvGet(ownerKey(taskId));
      return owner ? this.protects(owner, matches) : false;
    }
    const entry = await this.entry(taskId);
    if (!entry || await taskEnded(this.deps.store, taskId)) return false;
    return !matches || matches(entry.handle) !== false;
  }

  // ── The per-organization cap: `cap` slots, and the turns waiting for one, first come first served.

  private async slots(organizationId: string, cap: number): Promise<Array<{ index: number; raw?: string; holder?: string; until?: number }>> {
    return Promise.all(Array.from({ length: cap }, async (_, index) => {
      const raw = await this.deps.store.kvGet(slotKey(organizationId, index));
      if (!raw) return { index };
      try { const value = JSON.parse(raw) as { holder: string; until: number }; return { index, raw, holder: value.holder, until: value.until }; }
      catch { return { index, raw }; }
    }));
  }

  private async acquireSlot(organizationId: string, taskId: string,
    input: { signal?: AbortSignal; heartbeat?: () => void; onQueued?: (queued: LoginSandboxQueued) => void | Promise<void> }): Promise<void> {
    const waitKey = `${waitPrefix(organizationId)}${taskId}`;
    let since: number | undefined;
    let arrived: number | undefined;
    let told: string | undefined;
    try {
      for (;;) {
        input.signal?.throwIfAborted();
        const now = this.now();
        const cap = await this.cap(organizationId);
        const slots = await this.slots(organizationId, cap);
        const mine = slots.find((slot) => slot.holder === taskId);
        const value = JSON.stringify({ holder: taskId, until: now + LEASE_MS });
        if (mine && await this.deps.store.kvCompareAndSet(slotKey(organizationId, mine.index), mine.raw, value)) return;
        const free = slots.filter((slot) => !slot.holder || (slot.until ?? 0) <= now);
        const waiting = (await this.deps.store.kvEntries(waitPrefix(organizationId))).flatMap(({ key, value: raw }) => {
          try {
            const wait = JSON.parse(raw) as { since: number; arrived?: number; until: number };
            return wait.until > now ? [{ key, since: wait.since, arrived: wait.arrived ?? 0 }] : [];
          } catch { return []; }
        });
        const own = waiting.find((wait) => wait.key === waitKey);
        since ??= own?.since ?? now;
        // Ties (one clock tick) go by arrival on this host's clock, then by key.
        arrived ??= own?.arrived ?? performance.timeOrigin + performance.now();
        const before = (wait: { key: string; since: number; arrived: number }) => wait.since < since!
          || (wait.since === since && (wait.arrived < arrived! || (wait.arrived === arrived && wait.key < waitKey)));
        const ahead = waiting.filter((wait) => wait.key !== waitKey && before(wait)).length;
        if (free.length > ahead) {
          for (const slot of free)
            if (await this.deps.store.kvCompareAndSet(slotKey(organizationId, slot.index), slot.raw, value)) return;
          continue;
        }
        await this.deps.store.kvSet(waitKey, JSON.stringify({ since, arrived, until: now + LEASE_MS }));
        const said = `${cap - free.length}/${cap}/${ahead}`;
        if (said !== told) { told = said; await input.onQueued?.({ inUse: cap - free.length, cap, ahead }); }
        input.heartbeat?.();
        await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? 1_000));
      }
    } finally {
      await this.deps.store.kvDelete(waitKey).catch(() => undefined);
    }
  }

  private async renewSlot(organizationId: string, taskId: string, until: number): Promise<void> {
    const cap = await this.cap(organizationId);
    for (const slot of await this.slots(organizationId, Math.max(cap, 1)))
      if (slot.holder === taskId) await this.deps.store.kvCompareAndSet(slotKey(organizationId, slot.index), slot.raw, JSON.stringify({ holder: taskId, until }));
  }

  private async releaseSlot(organizationId: string, taskId: string): Promise<void> {
    // Every slot it may hold, also one beyond a cap that has since been lowered.
    const cap = Math.max(await this.cap(organizationId), 16);
    for (const slot of await this.slots(organizationId, cap))
      if (slot.holder === taskId) await this.deps.store.kvCompareAndSet(slotKey(organizationId, slot.index), slot.raw, undefined);
  }
}
