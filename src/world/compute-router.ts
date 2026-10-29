import { ProviderCapacityFull, ProviderOutage } from '../agent/limits.js';
import { BRAND } from '../domain/brand.js';
import { machineShape, networkChoice, type ComputeRegion, type MachineShape } from '../domain/computer.js';
import { cloudProviders, listPriceMicrosPerHour, networkUnfit, providerLabel, providerMachine, providerRegion, providerWakeSeconds,
  type ComputerFeatures, type ComputerLimits } from '../domain/computer-limits.js';
import type { ProjectConfig } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { MANAGED_COMPUTE } from './connections.js';
import { assertComputeCredit, ComputeCreditExhausted, ManagedComputeBusy } from './managed-compute.js';

/**
 * Compute routing (wiki features/compute-routing): the machine a task gets
 * when its Computer says provider "Any" (`ANY_PROVIDER`) instead of naming one.
 *
 * The candidates are the cloud providers the organization can reach, one
 * account each: its own connection when it has one (BYOK), else the
 * installation's managed compute for that provider. Never both: an
 * organization's own account always wins for its provider, so a world is
 * never funded by an account other than the one the organization chose.
 *
 * A candidate qualifies when its account allows a machine of the task's size,
 * offers what the task needs (a desktop; the outbound network chosen: Full
 * internet needs an account with the open internet, Basic is enough takes one
 * that reaches only essential services too, Allowlist only one that enforces
 * an allowlist), runs in the region asked for, and is known to have room:
 * managed compute needs credit left this month and fewer than its
 * `maxRunning` machines in use, and an account with a pool shared by all its
 * machines (Daytona's tiers, a Google Cloud CPU quota) needs that much CPU and
 * memory left.
 *
 * The qualifying candidates are tried in this order:
 *   1. a restored world's previous provider (it comes back where it was);
 *   2. candidates not refused for capacity in the last 10 minutes, nor
 *      failing their last connection test, before those that were;
 *   3. the organization's own accounts before managed compute (it already
 *      pays for them);
 *   4. the lower list price per hour for this size (computer-limits.ts);
 *   5. the faster wake; then a fixed provider order.
 * A candidate that refuses for capacity, or whose provider is down, gives
 * way to the next (a capacity refusal is remembered); only when every one
 * refuses does the task wait for a machine.
 */

/** What a task asks of the machine "Any" picks. Neither `basic` nor
 * `allowlist`: it needs the open internet. */
export interface ComputeNeeds extends MachineShape {
  desktop?: boolean;
  /** Basic internet is enough (registries, Git hosts, AI and cloud APIs). */
  basic?: boolean;
  allowlist?: boolean;
  region?: ComputeRegion;
}

export function computeNeeds(config: Partial<ProjectConfig> | undefined): ComputeNeeds {
  const network = networkChoice(config?.network);
  return { ...machineShape(config),
    ...(config?.environment?.flavor === 'desktop' ? { desktop: true } : {}),
    ...(network === 'basic' ? { basic: true } : network === 'allowlist' ? { allowlist: true } : {}),
    ...(config?.region ? { region: config.region } : {}) };
}

export type ComputeFunding = 'own' | 'managed';

/** One account "Any" could use. */
export interface ComputeOption {
  provider: string;
  funding: ComputeFunding;
  limits: ComputerLimits;
  features: ComputerFeatures;
  region?: ComputeRegion;
  /** Known to have no room now, and why (managed compute in use or out of credit). */
  busy?: string;
  /** The organization's compute credit is spent: what to tell people. */
  outOfCredit?: string;
  /** Why it is tried last: a recent capacity refusal or a failing connection. */
  doubt?: string;
}

export interface ComputeCandidate {
  provider: string;
  funding: ComputeFunding;
  /** List price of this size per hour, in USD micros. */
  priceMicrosPerHour?: number;
  doubt?: string;
}

export interface RejectedOption {
  provider: string;
  funding: ComputeFunding;
  reason: string;
  busy?: boolean;
  outOfCredit?: string;
}

export interface ComputeRoute {
  needs: ComputeNeeds;
  /** In the order they are tried. */
  candidates: ComputeCandidate[];
  rejected: RejectedOption[];
  /** The provider a restored world was on, tried first. */
  prefer?: string;
}

/** A provider refusal is remembered this long, during which it is tried last. */
export const FULL_MEMORY_MS = 10 * 60_000;

const gb = (mb: number) => (Number.isInteger(mb / 1024) ? String(mb / 1024) : (mb / 1024).toFixed(1));
const REGION_LABEL: Record<ComputeRegion, string> = { eu: 'the EU', us: 'the US' };

/** Why an option cannot take this task, or undefined when it can. */
export function unfit(needs: ComputeNeeds, option: ComputeOption): string | undefined {
  const { limits, features } = option;
  if (needs.cpu != null && limits.cpu != null && needs.cpu > limits.cpu) return `at most ${limits.cpu} CPU`;
  if (needs.memoryMb != null && limits.memoryMb != null && needs.memoryMb > limits.memoryMb) return `at most ${gb(limits.memoryMb)} GB memory`;
  if (needs.diskGb != null && limits.diskGb != null && needs.diskGb > limits.diskGb) return `at most ${limits.diskGb} GB disk`;
  if (needs.desktop && !features.desktop) return 'no desktop';
  const network = networkUnfit(needs.allowlist ? 'allowlist' : needs.basic ? 'basic' : 'full', features);
  if (network) return network;
  if (needs.region && option.region !== needs.region) return `not in ${REGION_LABEL[needs.region]}`;
  return undefined;
}

/** Filter and order the options (the rule above). Pure, so it is tested alone. */
export function rankComputeOptions(needs: ComputeNeeds, options: ComputeOption[], prefer?: string): ComputeRoute {
  const order = cloudProviders();
  const rejected: RejectedOption[] = [];
  const candidates: ComputeCandidate[] = [];
  for (const option of options) {
    const reason = unfit(needs, option) ?? option.busy;
    if (reason) {
      rejected.push({ provider: option.provider, funding: option.funding, reason,
        ...(!unfit(needs, option) && option.busy ? { busy: true, ...(option.outOfCredit ? { outOfCredit: option.outOfCredit } : {}) } : {}) });
      continue;
    }
    const price = listPriceMicrosPerHour(option.provider, needs);
    candidates.push({ provider: option.provider, funding: option.funding,
      ...(price != null ? { priceMicrosPerHour: price } : {}), ...(option.doubt ? { doubt: option.doubt } : {}) });
  }
  const rank = (candidate: ComputeCandidate): number[] => [
    candidate.provider === prefer ? 0 : 1,
    candidate.doubt ? 1 : 0,
    candidate.funding === 'own' ? 0 : 1,
    candidate.priceMicrosPerHour ?? Number.MAX_SAFE_INTEGER,
    providerWakeSeconds(candidate.provider),
    order.indexOf(candidate.provider),
  ];
  candidates.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return 0;
  });
  return { needs, candidates, rejected, ...(prefer ? { prefer } : {}) };
}

/** "Hetzner (yours)" / "AWS (included)". */
export function optionLabel(option: { provider: string; funding: ComputeFunding }): string {
  return `${providerLabel(option.provider)}${option.funding === 'managed' ? ` (${BRAND}'s)` : ''}`;
}

/** The capacity refusal in an error's cause chain (a provider limit, managed
 * compute in use, spent credit), wrapped or not. */
export function capacityCause(error: unknown): Error | undefined {
  for (let cause = error, depth = 0; cause && depth < 8; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof ProviderCapacityFull) return cause;
    const name = (cause as { name?: string }).name;
    if (name === 'ProviderCapacityFull' || name === 'ManagedComputeBusy' || name === 'ComputeCreditExhausted') return cause as Error;
  }
  return undefined;
}

/** A provider that is down (an API outage, a failed action), wrapped or not:
 * a new world is better made elsewhere than waited for. */
function outageCause(error: unknown): Error | undefined {
  for (let cause = error, depth = 0; cause && depth < 8; cause = (cause as { cause?: unknown }).cause, depth++)
    if (cause instanceof ProviderOutage) return cause;
  return undefined;
}

/** What the connection service gives the router (WorldProviderConnectionService). */
export interface RouterConnections {
  list(organizationId: string): Promise<Array<{ provider: string; enabled: boolean; credentialConfigured: boolean; status?: string;
    managed?: boolean; limits: ComputerLimits; features: ComputerFeatures; config: { region?: string; target?: string } }>>;
  managedConnections(): Promise<Array<{ provider: string; config: { maxRunning?: number } }>>;
}

/** One decision, as recorded in `world.routed`. */
export interface RouteDecision {
  provider?: string;
  funding?: ComputeFunding;
  /** Short, for people: why this one ("cheapest that fits; Hetzner was full"). */
  reason: string;
  needs: ComputeNeeds;
  candidates: Array<ComputeCandidate & { outcome: 'chosen' | 'full' | 'down' | 'untried'; detail?: string }>;
  rejected: RejectedOption[];
}

export class ComputeRouter {
  constructor(private store: Store, private connections: RouterConnections, private now: () => number = Date.now) {}

  /** Every cloud account the organization can reach, with what is known about
   * its room for a machine of `needs`. */
  async options(organizationId: string, needs: ComputeNeeds = {}): Promise<ComputeOption[]> {
    const views = (await this.connections.list(organizationId))
      .filter((view) => cloudProviders().includes(view.provider) && view.enabled && view.credentialConfigured);
    const managed = views.some((view) => view.managed);
    const accounts = managed ? await this.connections.managedConnections() : [];
    return Promise.all(views.map(async (view): Promise<ComputeOption> => {
      const funding: ComputeFunding = view.managed ? 'managed' : 'own';
      const region = providerRegion(view.provider, view.config);
      const option: ComputeOption = { provider: view.provider, funding, limits: view.limits, features: view.features,
        ...(region ? { region } : {}) };
      if (funding === 'managed') {
        // Room in the credit for this machine's first minutes, as admission
        // will judge it (holds, top-ups: managed-compute.ts).
        const short = await assertComputeCredit(this.store, organizationId, view.provider, this.now(), { shape: needs })
          .then(() => undefined, (error: unknown) => { if (error instanceof ComputeCreditExhausted) return error; throw error; });
        if (short) return { ...option, busy: 'out of compute this month', outOfCredit: short.message };
        const maxRunning = accounts.find((account) => account.provider === view.provider)?.config.maxRunning;
        if (maxRunning && await this.store.runningManagedWorlds(view.provider) >= maxRunning)
          return { ...option, busy: `all ${maxRunning} in use` };
      } else if (view.status === 'error') option.doubt = 'its last connection test failed';
      // A CPU and memory quota all of the account's machines share (Google
      // Cloud: the lowest of E2_CPUS, CPUS and CPUS_ALL_REGIONS; Daytona's tier,
      // where a machine takes the snapshot size covering it): room is what the
      // worlds running on it leave. Machines outside tavya on the same account
      // are not counted, nor Daytona's disk pool (stopped sandboxes count
      // there, and tavya does not record them); the provider's own refusal
      // still falls over.
      const pool = view.limits.pool;
      if (pool?.cpu || pool?.memoryMb) {
        const running = await this.store.runningWorldMachines(view.provider, funding === 'managed' ? null : organizationId);
        const used = running.map((machine) => providerMachine(view.provider, machine))
          .reduce((sum, machine) => ({ cpu: sum.cpu + machine.cpu, memoryMb: sum.memoryMb + machine.memoryMb }), { cpu: 0, memoryMb: 0 });
        const next = providerMachine(view.provider, needs);
        if (pool.cpu && used.cpu + next.cpu > pool.cpu) return { ...option, busy: `${used.cpu} of its ${pool.cpu} CPUs in use` };
        if (pool.memoryMb && used.memoryMb + next.memoryMb > pool.memoryMb)
          return { ...option, busy: `${gb(used.memoryMb)} of its ${gb(pool.memoryMb)} GB memory in use` };
      }
      const full = await this.recentFull(funding === 'managed' ? MANAGED_COMPUTE : organizationId, view.provider);
      if (full) option.doubt = full;
      return option;
    }));
  }

  async route(organizationId: string, config: Partial<ProjectConfig> | undefined, prefer?: string): Promise<ComputeRoute> {
    const needs = computeNeeds(config);
    return rankComputeOptions(needs, await this.options(organizationId, needs), prefer);
  }

  /** Remember that an account refused for capacity, so the next routing tries it last. */
  async noteFull(organizationId: string, candidate: ComputeCandidate, reason: string): Promise<void> {
    const scope = candidate.funding === 'managed' ? MANAGED_COMPUTE : organizationId;
    await this.store.kvSet(fullKey(scope, candidate.provider), JSON.stringify({ at: this.now(), reason: reason.slice(0, 300) }));
  }

  /** It took a machine: whatever refusal was remembered is over. */
  async noteRoom(organizationId: string, candidate: ComputeCandidate): Promise<void> {
    const scope = candidate.funding === 'managed' ? MANAGED_COMPUTE : organizationId;
    if (await this.store.kvGet(fullKey(scope, candidate.provider))) await this.store.kvDelete(fullKey(scope, candidate.provider));
  }

  private async recentFull(scope: string, provider: string): Promise<string | undefined> {
    const raw = await this.store.kvGet(fullKey(scope, provider));
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as { at: number; reason?: string };
      return this.now() - value.at < FULL_MEMORY_MS ? 'full a few minutes ago' : undefined;
    } catch { return undefined; }
  }

  /**
   * Make the task's machine on the first candidate with room: `attempt`
   * creates (or restores) it on one provider; a capacity refusal or a provider
   * outage moves on to the next. Records `world.routed`. When none has room,
   * throws the capacity refusal the task waits on ("Waiting for a machine", or
   * "Out of compute"); when every one is down, the outage; when none fits at
   * all, an error saying why.
   */
  async run<T>(organizationId: string, route: ComputeRoute, attempt: (candidate: ComputeCandidate, reason: string) => Promise<T>,
    record: (decision: RouteDecision) => Promise<void>): Promise<{ value: T; candidate: ComputeCandidate }> {
    const full: Array<{ candidate: ComputeCandidate; detail: string; outage?: boolean }> = [];
    let down: unknown;
    const decision = (chosen?: ComputeCandidate): RouteDecision => ({
      ...(chosen ? { provider: chosen.provider, funding: chosen.funding } : {}),
      reason: chosen ? routeReason(route, chosen, full) : noRoomMessage(route, full),
      needs: route.needs,
      candidates: route.candidates.map((candidate) => {
        const refused = full.find((entry) => entry.candidate === candidate);
        return { ...candidate, outcome: candidate === chosen ? 'chosen' as const : refused ? (refused.outage ? 'down' as const : 'full' as const) : 'untried' as const,
          ...(refused ? { detail: refused.detail.slice(0, 300) } : {}) };
      }),
      rejected: route.rejected,
    });
    for (const candidate of route.candidates) {
      try {
        const value = await attempt(candidate, routeReason(route, candidate, full));
        await this.noteRoom(organizationId, candidate).catch(() => undefined);
        await record(decision(candidate)).catch(() => undefined);
        return { value, candidate };
      } catch (error) {
        const capacity = capacityCause(error);
        const cause = capacity ?? outageCause(error);
        if (!cause) throw error;
        if (!capacity) down ??= error;
        full.push({ candidate, detail: cause.message, ...(capacity ? {} : { outage: true }) });
        // Spent credit and managed compute in use are counted, not discovered:
        // only a provider's own refusal is worth remembering.
        if (capacity?.name === 'ProviderCapacityFull') await this.noteFull(organizationId, candidate, cause.message).catch(() => undefined);
      }
    }
    await record(decision()).catch(() => undefined);
    // Every one is down, none full: an outage, retried as such (world-infra).
    if (down && full.every((entry) => entry.outage) && !route.rejected.some((option) => option.busy)) throw down;
    throw noRoom(route, full);
  }
}

const fullKey = (scope: string, provider: string) => `compute-full:${scope}:${provider}`;

/** Why the chosen candidate, in a few words. */
export function routeReason(route: ComputeRoute, chosen: ComputeCandidate,
  tried: Array<{ candidate: ComputeCandidate; outage?: boolean }>): string {
  const why = chosen.provider === route.prefer ? 'where it ran before'
    : chosen.funding === 'own' && route.candidates.some((candidate) => candidate.funding === 'managed') ? 'your own account'
    : route.candidates.length + route.rejected.length > 1 ? 'cheapest that fits' : 'the only one';
  const said = (entries: typeof tried, what: string) => {
    const names = entries.map((entry) => providerLabel(entry.candidate.provider));
    return names.length ? [`${names.join(' and ')} ${names.length > 1 ? 'were' : 'was'} ${what}`] : [];
  };
  return [why, ...said(tried.filter((entry) => !entry.outage), 'full'), ...said(tried.filter((entry) => entry.outage), 'down')].join('; ');
}

function noRoomMessage(route: ComputeRoute, full: Array<{ candidate: ComputeCandidate; detail: string }>): string {
  const busy = route.rejected.filter((option) => option.busy);
  if (!route.candidates.length && !busy.length) return noFitMessage(route);
  const parts = [
    ...full.map((entry) => `${optionLabel(entry.candidate)}: ${entry.detail.replace(/\.$/, '')}`),
    ...busy.map((option) => `${optionLabel(option)}: ${option.reason}`),
  ];
  return `Every computer this task can use is full (${parts.join('; ')}). Waiting for one to free up.`;
}

function noFitMessage(route: ComputeRoute): string {
  if (!route.rejected.length) return 'No computer is connected: connect one under Settings → Computers.';
  return `No computer this organization can use fits this task: ${route.rejected
    .map((option) => `${optionLabel(option)}: ${option.reason}`).join('; ')}. Change its Computer, or connect another under Settings → Computers.`;
}

/** The error a task without a machine stops on: a capacity refusal it waits
 * out when some candidate is only full, else a plain error that asks people. */
function noRoom(route: ComputeRoute, full: Array<{ candidate: ComputeCandidate; detail: string }>): Error {
  const busy = route.rejected.filter((option) => option.busy);
  if (!full.length && !busy.length) return new Error(noFitMessage(route));
  // Only spent credit stands in the way: say so as the credit check does.
  if (!full.length && busy.every((option) => option.outOfCredit)) return new ComputeCreditExhausted(busy[0]!.outOfCredit!);
  const message = noRoomMessage(route, full);
  return full.length ? new ProviderCapacityFull(message) : new ManagedComputeBusy(message);
}
