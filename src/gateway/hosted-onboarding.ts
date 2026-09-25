/** `closed` hides the guide until the user restarts the walkthrough. */
export type HostedOnboardingDisplay = 'expanded' | 'minimized' | 'closed';

export const parseHostedOnboardingDisplay = (value: unknown): HostedOnboardingDisplay =>
  value === 'minimized' || value === 'closed' ? value : 'expanded';

export interface HostedOnboardingFacts {
  github: boolean;
  agentLogin: boolean;
  e2b: boolean;
  vault: boolean;
  card: boolean;
  project: boolean;
}

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
  const requiredComplete = input.facts.github && input.facts.agentLogin && input.facts.e2b && input.facts.project;
  const complete = Boolean(input.record?.completedAt) || (requiredComplete && !input.record?.replay);
  return {
    organizationId: input.organizationId,
    eligible: input.hosted && Boolean(input.record),
    visible: input.hosted && Boolean(input.record) && !complete && input.record?.display !== 'closed',
    complete,
    replay: input.record?.replay === true,
    display: input.record?.display ?? 'expanded' as HostedOnboardingDisplay,
    completedRequired: [input.facts.github, input.facts.agentLogin, input.facts.e2b, input.facts.project]
      .filter(Boolean).length,
    totalRequired: 4,
    steps: {
      github: { complete: input.facts.github },
      agentLogin: { complete: input.facts.agentLogin },
      e2b: { complete: input.facts.e2b },
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
