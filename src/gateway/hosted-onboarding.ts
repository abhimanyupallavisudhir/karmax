/** `closed` hides the guide until the user restarts the walkthrough. */
export type HostedOnboardingDisplay = 'expanded' | 'minimized' | 'closed';

export const parseHostedOnboardingDisplay = (value: unknown): HostedOnboardingDisplay =>
  value === 'minimized' || value === 'closed' ? value : 'expanded';

export interface HostedOnboardingFacts {
  github: boolean;
  agentLogin: boolean;
  /** A compute provider account of the organization's own (E2B, Daytona, …). */
  ownCompute: boolean;
  /** tavya's computers: a paid plan, or compute credit from packs or a gift. */
  managedCompute: boolean;
  vault: boolean;
  card: boolean;
  project: boolean;
}

/** The facts every required step needs, in walkthrough order. */
export const hostedOnboardingRequired = (facts: HostedOnboardingFacts) =>
  [facts.github, facts.agentLogin, facts.ownCompute || facts.managedCompute, facts.project];

export interface HostedOnboardingRecord {
  display: HostedOnboardingDisplay;
  completedAt?: number;
  /** Operator-requested replay stays visible until the user selects Done. */
  replay?: boolean;
}

export const hostedOnboardingKey = (userId: string, organizationId: string) =>
  `hosted:onboarding:${userId}:${organizationId}`;

export function parseHostedOnboardingRecord(raw: string | undefined): HostedOnboardingRecord | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<HostedOnboardingRecord>;
    return {
      ...(value.replay === true ? { replay: true } : {}),
      display: parseHostedOnboardingDisplay(value.display),
      ...(Number.isFinite(value.completedAt) ? { completedAt: Number(value.completedAt) } : {}),
    };
  } catch {
    return { display: 'expanded' };
  }
}

export function hostedOnboardingStatus(input: {
  hosted: boolean;
  organizationId: string;
  record?: HostedOnboardingRecord;
  facts: HostedOnboardingFacts;
}) {
  const required = hostedOnboardingRequired(input.facts);
  const requiredComplete = required.every(Boolean);
  const complete = Boolean(input.record?.completedAt) || (requiredComplete && !input.record?.replay);
  return {
    organizationId: input.organizationId,
    eligible: input.hosted && Boolean(input.record),
    visible: input.hosted && Boolean(input.record) && !complete && input.record?.display !== 'closed',
    complete,
    replay: input.record?.replay === true,
    display: input.record?.display ?? 'expanded' as HostedOnboardingDisplay,
    completedRequired: required.filter(Boolean).length,
    totalRequired: required.length,
    steps: {
      github: { complete: input.facts.github },
      agentLogin: { complete: input.facts.agentLogin },
      // One step, two ways to satisfy it: tavya's computers or the organization's own.
      compute: {
        complete: input.facts.ownCompute || input.facts.managedCompute,
        managed: input.facts.managedCompute,
        own: input.facts.ownCompute,
      },
      optional: {
        complete: input.facts.vault && input.facts.card,
        blocking: false,
        vault: input.facts.vault,
        card: input.facts.card,
      },
      project: { complete: input.facts.project },
    },
  };
}
