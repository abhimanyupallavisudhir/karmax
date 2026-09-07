export type HostedOnboardingDisplay = 'expanded' | 'minimized';

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
}

export const HOSTED_ONBOARDING_KEY_PREFIX = 'hosted:onboarding:';

export const hostedOnboardingKey = (userId: string, organizationId: string) =>
  `${HOSTED_ONBOARDING_KEY_PREFIX}${userId}:${organizationId}`;

export function parseHostedOnboardingRecord(raw: string | undefined): HostedOnboardingRecord | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<HostedOnboardingRecord>;
    return {
      display: value.display === 'minimized' ? 'minimized' : 'expanded',
      ...(Number.isFinite(value.completedAt) ? { completedAt: Number(value.completedAt) } : {}),
    };
  } catch {
    return { display: 'expanded' };
  }
}

/** Operator reset: forget every enrolled account's sticky completion and
 * re-open a minimized guide, so the walkthrough shows again on each person's
 * next visit wherever a required step is genuinely missing. Only the enrollment
 * records change — an account that was never enrolled stays unburdened, and
 * nothing anyone built (projects, tasks, connections, settings) is touched.
 * Returns how many enrollments actually changed. */
export function resetHostedOnboarding(store: {
  kvEntries(prefix: string): Array<{ key: string; value: string }>;
  kvSet(key: string, value: string): void;
}): number {
  let changed = 0;
  for (const { key, value } of store.kvEntries(HOSTED_ONBOARDING_KEY_PREFIX)) {
    const record = parseHostedOnboardingRecord(value);
    if (!record || (!record.completedAt && record.display === 'expanded')) continue;
    store.kvSet(key, JSON.stringify({ display: 'expanded' } satisfies HostedOnboardingRecord));
    changed++;
  }
  return changed;
}

export function hostedOnboardingStatus(input: {
  hosted: boolean;
  organizationId: string;
  record?: HostedOnboardingRecord;
  facts: HostedOnboardingFacts;
}) {
  const requiredComplete = input.facts.github && input.facts.agentLogin && input.facts.e2b && input.facts.project;
  const complete = Boolean(input.record?.completedAt) || requiredComplete;
  return {
    organizationId: input.organizationId,
    eligible: input.hosted && Boolean(input.record),
    visible: input.hosted && Boolean(input.record) && !complete,
    complete,
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
