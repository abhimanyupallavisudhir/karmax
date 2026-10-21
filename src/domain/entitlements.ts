export type HostedPlanId = 'free' | 'individual' | 'team';

export interface HostedPlan {
  id: HostedPlanId;
  name: string;
  monthlyBasePriceCents: number;
  includedActiveUsers: number;
  monthlyAdditionalActiveUserPriceCents: number;
  maxMembers: number | null;
  /** Base organization concurrency. Team adds additionalActiveUserAgentRuns for
   * every active user beyond includedActiveUsers. */
  maxActiveAgentRuns: number;
  additionalActiveUserAgentRuns: number;
  /** Managed storage. Team adds additionalActiveUserStorageBytes for every
   * active user beyond includedActiveUsers. */
  storageBytes: number;
  additionalActiveUserStorageBytes: number;
  /** Managed compute credit each month, in USD micros at tavya's prices
   * (COMPUTE_PRICE_MULTIPLIER × the provider's). Team adds
   * additionalActiveUserComputeCreditMicros for every active user beyond
   * includedActiveUsers. */
  computeCreditMicros: number;
  additionalActiveUserComputeCreditMicros: number;
  unlimitedProjects: true;
}

const GIB = 1024 ** 3;

/** A storage pack adds managed storage to a paid plan, billed monthly per pack.
 * A Free organization cannot hold packs: they ride on a paid subscription. */
export const STORAGE_PACK = Object.freeze({ bytes: 100 * GIB, monthlyPriceCents: 400 });

/** A compute pack adds managed compute credit each month to a paid plan:
 * a dollar paid buys a dollar of compute at tavya's prices. */
export const COMPUTE_PACK = Object.freeze({ creditMicros: 10_000_000, monthlyPriceCents: 1_000 });

/** Managed compute's rules that the billing terms state (src/launch/legal.ts;
 * wiki features/managed-compute): holds, auto top-up, and the grace before a
 * spent organization's parked disks are hibernated. The code takes its
 * numbers from here, so the terms and the behaviour cannot drift apart. */
export const COMPUTE_TERMS = Object.freeze({
  /** Work on a managed computer sets aside its next minutes… */
  holdMinutes: 15,
  /** …and starts only if this many fit. */
  minStartMinutes: 5,
  /** One auto top-up: this much credit for this much money. */
  topUpCents: 1_000,
  /** Days a spent organization's parked disks are kept… */
  graceDays: 3,
  /** …unless they would cost this much compute (at tavya's prices) past the credit first… */
  overrunCapMicros: 10_000_000,
  /** …but never less than this many hours. */
  minGraceHours: 1,
});

/** Managed compute is charged at the provider's own list price times this:
 * it covers the payment provider's fee, idle capacity and abuse, and is the
 * one number behind every compute price tavya shows. */
export const COMPUTE_PRICE_MULTIPLIER = 2;

/** What tavya charges for compute the provider prices at `costMicros`. */
export function computeChargeMicros(costMicros: number): number {
  return Math.round(Math.max(0, Number(costMicros) || 0) * COMPUTE_PRICE_MULTIPLIER);
}

/** Launch-plan catalog and pricing source of truth. */
export const HOSTED_PLANS: Readonly<Record<HostedPlanId, HostedPlan>> = Object.freeze({
  free: Object.freeze({
    id: 'free', name: 'Free', monthlyBasePriceCents: 0, includedActiveUsers: 1,
    monthlyAdditionalActiveUserPriceCents: 0, maxMembers: 1,
    maxActiveAgentRuns: 5, additionalActiveUserAgentRuns: 0,
    storageBytes: 5 * GIB, additionalActiveUserStorageBytes: 0,
    computeCreditMicros: 0, additionalActiveUserComputeCreditMicros: 0, unlimitedProjects: true,
  }),
  individual: Object.freeze({
    id: 'individual', name: 'Individual', monthlyBasePriceCents: 900, includedActiveUsers: 1,
    monthlyAdditionalActiveUserPriceCents: 0, maxMembers: 1,
    maxActiveAgentRuns: 10, additionalActiveUserAgentRuns: 0,
    storageBytes: 50 * GIB, additionalActiveUserStorageBytes: 0,
    computeCreditMicros: 5_000_000, additionalActiveUserComputeCreditMicros: 0, unlimitedProjects: true,
  }),
  team: Object.freeze({
    id: 'team', name: 'Team', monthlyBasePriceCents: 1_900, includedActiveUsers: 1,
    monthlyAdditionalActiveUserPriceCents: 500, maxMembers: null,
    maxActiveAgentRuns: 20, additionalActiveUserAgentRuns: 5,
    storageBytes: 100 * GIB, additionalActiveUserStorageBytes: 10 * GIB,
    computeCreditMicros: 10_000_000, additionalActiveUserComputeCreditMicros: 3_000_000, unlimitedProjects: true,
  }),
});

export interface OrganizationEntitlements {
  deployment: 'hosted' | 'private';
  plan: HostedPlanId | null;
  planName: string;
  monthlyBasePriceCents: number | null;
  includedActiveUsers: number | null;
  monthlyAdditionalActiveUserPriceCents: number | null;
  maxMembers: number | null;
  currentMemberCount: number;
  overMemberLimit: boolean;
  memberAdmissionAllowed: boolean;
  agentRunAdmissionAllowed: boolean;
  maxActiveAgentRuns: number | null;
  /** Managed-storage quota: the plan's storage plus packs. Null means unmetered
   * (private installations, whose operator may still cap managed storage). */
  storageQuotaBytes: number | null;
  /** The plan's own storage for its active users, before any packs. */
  includedStorageBytes: number | null;
  /** Paid packs in effect (billing-verified; none on Free). */
  storagePacks: number;
  /** Operator-gifted packs, which apply on any plan until removed. */
  giftedStoragePacks: number;
  /** Bytes one storage pack adds. */
  storagePackBytes: number;
  /** Managed compute credit each month: the plan's plus packs. Null means
   * unmetered (private installations). */
  computeCreditMicros: number | null;
  /** The plan's own compute credit for its active users, before any packs. */
  includedComputeCreditMicros: number | null;
  /** Paid compute packs in effect (billing-verified; none on Free). */
  computePacks: number;
  /** Operator-gifted compute packs, which apply on any plan until removed. */
  giftedComputePacks: number;
  /** Credit one compute pack adds each month. */
  computePackCreditMicros: number;
  unlimitedProjects: true;
}

export function isHostedPlanId(value: unknown): value is HostedPlanId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HOSTED_PLANS, value);
}

export function hostedPlan(plan: HostedPlanId): HostedPlan {
  return HOSTED_PLANS[plan];
}

/** Billing calls this helper rather than duplicating per-seat pricing rules.
 * Storage packs are billed only on a paid plan, like their storage. */
export function hostedMonthlyPriceCents(plan: HostedPlanId, activeUsers: number, storagePacks = 0, computePacks = 0): number {
  const definition = hostedPlan(plan);
  const users = Math.max(0, Math.floor(Number(activeUsers) || 0));
  const additional = Math.max(0, users - definition.includedActiveUsers);
  const count = (packs: number) => plan === 'free' ? 0 : Math.max(0, Math.floor(Number(packs) || 0));
  return definition.monthlyBasePriceCents
    + additional * definition.monthlyAdditionalActiveUserPriceCents
    + count(storagePacks) * STORAGE_PACK.monthlyPriceCents + count(computePacks) * COMPUTE_PACK.monthlyPriceCents;
}

/** Shared agent concurrency for the organization's current active-user count. */
export function hostedActiveAgentRuns(plan: HostedPlanId, activeUsers: number): number {
  const definition = hostedPlan(plan);
  const users = Math.max(0, Math.floor(Number(activeUsers) || 0));
  const additional = Math.max(0, users - definition.includedActiveUsers);
  return definition.maxActiveAgentRuns + additional * definition.additionalActiveUserAgentRuns;
}

/** The plan's own managed storage for its active users, before packs. */
export function hostedIncludedStorageBytes(plan: HostedPlanId, activeUsers: number): number {
  const definition = hostedPlan(plan);
  const users = Math.max(0, Math.floor(Number(activeUsers) || 0));
  const additional = Math.max(0, users - definition.includedActiveUsers);
  return definition.storageBytes + additional * definition.additionalActiveUserStorageBytes;
}

/** Managed storage for the plan, its active users and its storage packs. Paid
 * packs count only on a paid plan, so a lapsed subscription falls back to
 * Free's; packs the operator gifted count on any plan. */
export function hostedStorageQuotaBytes(plan: HostedPlanId, activeUsers: number, storagePacks = 0, giftedStoragePacks = 0): number {
  const packs = plan === 'free' ? 0 : Math.max(0, Math.floor(Number(storagePacks) || 0));
  const gifted = Math.max(0, Math.floor(Number(giftedStoragePacks) || 0));
  return hostedIncludedStorageBytes(plan, activeUsers) + (packs + gifted) * STORAGE_PACK.bytes;
}

/** The plan's own compute credit each month for its active users, before packs. */
export function hostedIncludedComputeCreditMicros(plan: HostedPlanId, activeUsers: number): number {
  const definition = hostedPlan(plan);
  const users = Math.max(0, Math.floor(Number(activeUsers) || 0));
  const additional = Math.max(0, users - definition.includedActiveUsers);
  return definition.computeCreditMicros + additional * definition.additionalActiveUserComputeCreditMicros;
}

/** Compute credit each month for the plan, its active users and its packs.
 * Like storage, paid packs count only on a paid plan; gifted ones on any. */
export function hostedComputeCreditMicros(plan: HostedPlanId, activeUsers: number, computePacks = 0, giftedComputePacks = 0): number {
  const packs = plan === 'free' ? 0 : Math.max(0, Math.floor(Number(computePacks) || 0));
  const gifted = Math.max(0, Math.floor(Number(giftedComputePacks) || 0));
  return hostedIncludedComputeCreditMicros(plan, activeUsers) + (packs + gifted) * COMPUTE_PACK.creditMicros;
}

/** Packs an organization holds: paid ones on the subscription, gifted ones from the operator. */
export interface OrganizationPacks {
  storagePacks?: number;
  giftedStoragePacks?: number;
  computePacks?: number;
  giftedComputePacks?: number;
}

/** Private installations deliberately have no monetization limits. */
export function organizationEntitlements(plan: HostedPlanId, hosted: boolean,
  currentMemberCount = 0, held: OrganizationPacks = {}): OrganizationEntitlements {
  const members = Math.max(0, Math.floor(Number(currentMemberCount) || 0));
  const count = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0));
  const packs = count(held.storagePacks);
  const gifted = count(held.giftedStoragePacks);
  const computePacks = count(held.computePacks);
  const giftedCompute = count(held.giftedComputePacks);
  if (!hosted) return {
    deployment: 'private', plan: null, planName: 'Private installation',
    monthlyBasePriceCents: null, includedActiveUsers: null,
    monthlyAdditionalActiveUserPriceCents: null, maxMembers: null,
    currentMemberCount: members, overMemberLimit: false,
    memberAdmissionAllowed: true, agentRunAdmissionAllowed: true,
    maxActiveAgentRuns: null, storageQuotaBytes: null, includedStorageBytes: null, storagePacks: packs,
    giftedStoragePacks: gifted, storagePackBytes: STORAGE_PACK.bytes,
    computeCreditMicros: null, includedComputeCreditMicros: null, computePacks,
    giftedComputePacks: giftedCompute, computePackCreditMicros: COMPUTE_PACK.creditMicros, unlimitedProjects: true,
  };
  const definition = hostedPlan(plan);
  const overMemberLimit = definition.maxMembers != null && members > definition.maxMembers;
  return {
    deployment: 'hosted', plan, planName: definition.name,
    monthlyBasePriceCents: definition.monthlyBasePriceCents,
    includedActiveUsers: definition.includedActiveUsers,
    monthlyAdditionalActiveUserPriceCents: definition.monthlyAdditionalActiveUserPriceCents,
    maxMembers: definition.maxMembers,
    currentMemberCount: members,
    overMemberLimit,
    memberAdmissionAllowed: definition.maxMembers == null || members < definition.maxMembers,
    agentRunAdmissionAllowed: !overMemberLimit,
    maxActiveAgentRuns: hostedActiveAgentRuns(plan, members),
    storageQuotaBytes: hostedStorageQuotaBytes(plan, members, packs, gifted),
    includedStorageBytes: hostedIncludedStorageBytes(plan, members),
    storagePacks: plan === 'free' ? 0 : packs,
    giftedStoragePacks: gifted,
    storagePackBytes: STORAGE_PACK.bytes,
    computeCreditMicros: hostedComputeCreditMicros(plan, members, computePacks, giftedCompute),
    includedComputeCreditMicros: hostedIncludedComputeCreditMicros(plan, members),
    computePacks: plan === 'free' ? 0 : computePacks,
    giftedComputePacks: giftedCompute,
    computePackCreditMicros: COMPUTE_PACK.creditMicros,
    unlimitedProjects: true,
  };
}

export class EntitlementError extends Error {
  readonly status = 409;
  readonly code = 'plan_limit';

  constructor(message: string) {
    super(message);
    this.name = 'EntitlementError';
  }
}
