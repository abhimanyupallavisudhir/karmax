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
  unlimitedProjects: true;
}

/** Launch-plan catalog and pricing source of truth. */
export const HOSTED_PLANS: Readonly<Record<HostedPlanId, HostedPlan>> = Object.freeze({
  free: Object.freeze({
    id: 'free', name: 'Free', monthlyBasePriceCents: 0, includedActiveUsers: 1,
    monthlyAdditionalActiveUserPriceCents: 0, maxMembers: 1,
    maxActiveAgentRuns: 5, additionalActiveUserAgentRuns: 0, unlimitedProjects: true,
  }),
  individual: Object.freeze({
    id: 'individual', name: 'Individual', monthlyBasePriceCents: 900, includedActiveUsers: 1,
    monthlyAdditionalActiveUserPriceCents: 0, maxMembers: 1,
    maxActiveAgentRuns: 10, additionalActiveUserAgentRuns: 0, unlimitedProjects: true,
  }),
  team: Object.freeze({
    id: 'team', name: 'Team', monthlyBasePriceCents: 1_900, includedActiveUsers: 1,
    monthlyAdditionalActiveUserPriceCents: 500, maxMembers: null,
    maxActiveAgentRuns: 20, additionalActiveUserAgentRuns: 5, unlimitedProjects: true,
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
  unlimitedProjects: true;
}

export function isHostedPlanId(value: unknown): value is HostedPlanId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HOSTED_PLANS, value);
}

export function hostedPlan(plan: HostedPlanId): HostedPlan {
  return HOSTED_PLANS[plan];
}

/** Billing calls this helper rather than duplicating per-seat pricing rules. */
export function hostedMonthlyPriceCents(plan: HostedPlanId, activeUsers: number): number {
  const definition = hostedPlan(plan);
  const users = Math.max(0, Math.floor(Number(activeUsers) || 0));
  const additional = Math.max(0, users - definition.includedActiveUsers);
  return definition.monthlyBasePriceCents
    + additional * definition.monthlyAdditionalActiveUserPriceCents;
}

/** Shared agent concurrency for the organization's current active-user count. */
export function hostedActiveAgentRuns(plan: HostedPlanId, activeUsers: number): number {
  const definition = hostedPlan(plan);
  const users = Math.max(0, Math.floor(Number(activeUsers) || 0));
  const additional = Math.max(0, users - definition.includedActiveUsers);
  return definition.maxActiveAgentRuns + additional * definition.additionalActiveUserAgentRuns;
}

/** Private installations deliberately have no monetization limits. */
export function organizationEntitlements(plan: HostedPlanId, hosted: boolean,
  currentMemberCount = 0): OrganizationEntitlements {
  const members = Math.max(0, Math.floor(Number(currentMemberCount) || 0));
  if (!hosted) return {
    deployment: 'private', plan: null, planName: 'Private installation',
    monthlyBasePriceCents: null, includedActiveUsers: null,
    monthlyAdditionalActiveUserPriceCents: null, maxMembers: null,
    currentMemberCount: members, overMemberLimit: false,
    memberAdmissionAllowed: true, agentRunAdmissionAllowed: true,
    maxActiveAgentRuns: null, unlimitedProjects: true,
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
