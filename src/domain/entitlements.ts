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
  unlimitedProjects: true;
}

const GIB = 1024 ** 3;

/** A storage pack adds managed storage to a paid plan, billed monthly per pack.
 * A Free organization cannot hold packs: they ride on a paid subscription. */
export const STORAGE_PACK = Object.freeze({ bytes: 100 * GIB, monthlyPriceCents: 400 });

/** Launch-plan catalog and pricing source of truth. */
export const HOSTED_PLANS: Readonly<Record<HostedPlanId, HostedPlan>> = Object.freeze({
  free: Object.freeze({
    id: 'free', name: 'Free', monthlyBasePriceCents: 0, includedActiveUsers: 1,
    monthlyAdditionalActiveUserPriceCents: 0, maxMembers: 1,
    maxActiveAgentRuns: 5, additionalActiveUserAgentRuns: 0,
    storageBytes: 5 * GIB, additionalActiveUserStorageBytes: 0, unlimitedProjects: true,
  }),
  individual: Object.freeze({
    id: 'individual', name: 'Individual', monthlyBasePriceCents: 900, includedActiveUsers: 1,
    monthlyAdditionalActiveUserPriceCents: 0, maxMembers: 1,
    maxActiveAgentRuns: 10, additionalActiveUserAgentRuns: 0,
    storageBytes: 50 * GIB, additionalActiveUserStorageBytes: 0, unlimitedProjects: true,
  }),
  team: Object.freeze({
    id: 'team', name: 'Team', monthlyBasePriceCents: 1_900, includedActiveUsers: 1,
    monthlyAdditionalActiveUserPriceCents: 500, maxMembers: null,
    maxActiveAgentRuns: 20, additionalActiveUserAgentRuns: 5,
    storageBytes: 100 * GIB, additionalActiveUserStorageBytes: 10 * GIB, unlimitedProjects: true,
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
  storagePacks: number;
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
export function hostedMonthlyPriceCents(plan: HostedPlanId, activeUsers: number, storagePacks = 0): number {
  const definition = hostedPlan(plan);
  const users = Math.max(0, Math.floor(Number(activeUsers) || 0));
  const additional = Math.max(0, users - definition.includedActiveUsers);
  const packs = plan === 'free' ? 0 : Math.max(0, Math.floor(Number(storagePacks) || 0));
  return definition.monthlyBasePriceCents
    + additional * definition.monthlyAdditionalActiveUserPriceCents + packs * STORAGE_PACK.monthlyPriceCents;
}

/** Shared agent concurrency for the organization's current active-user count. */
export function hostedActiveAgentRuns(plan: HostedPlanId, activeUsers: number): number {
  const definition = hostedPlan(plan);
  const users = Math.max(0, Math.floor(Number(activeUsers) || 0));
  const additional = Math.max(0, users - definition.includedActiveUsers);
  return definition.maxActiveAgentRuns + additional * definition.additionalActiveUserAgentRuns;
}

/** Managed storage for the plan, its active users and its storage packs. Packs
 * count only on a paid plan, so a lapsed subscription falls back to Free's. */
export function hostedStorageQuotaBytes(plan: HostedPlanId, activeUsers: number, storagePacks = 0): number {
  const definition = hostedPlan(plan);
  const users = Math.max(0, Math.floor(Number(activeUsers) || 0));
  const additional = Math.max(0, users - definition.includedActiveUsers);
  const packs = plan === 'free' ? 0 : Math.max(0, Math.floor(Number(storagePacks) || 0));
  return definition.storageBytes + additional * definition.additionalActiveUserStorageBytes + packs * STORAGE_PACK.bytes;
}

/** Private installations deliberately have no monetization limits. */
export function organizationEntitlements(plan: HostedPlanId, hosted: boolean,
  currentMemberCount = 0, storagePacks = 0): OrganizationEntitlements {
  const members = Math.max(0, Math.floor(Number(currentMemberCount) || 0));
  const packs = Math.max(0, Math.floor(Number(storagePacks) || 0));
  if (!hosted) return {
    deployment: 'private', plan: null, planName: 'Private installation',
    monthlyBasePriceCents: null, includedActiveUsers: null,
    monthlyAdditionalActiveUserPriceCents: null, maxMembers: null,
    currentMemberCount: members, overMemberLimit: false,
    memberAdmissionAllowed: true, agentRunAdmissionAllowed: true,
    maxActiveAgentRuns: null, storageQuotaBytes: null, storagePacks: packs, unlimitedProjects: true,
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
    storageQuotaBytes: hostedStorageQuotaBytes(plan, members, packs),
    storagePacks: plan === 'free' ? 0 : packs,
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
