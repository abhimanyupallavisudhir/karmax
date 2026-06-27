/**
 * Auto-resolve cases (SPEC §5.2 Resolve). Scripted handlers keyed on an error
 * signature. A hit returns a vetted action (e.g. retry); a miss falls through to
 * the Resolve agent. Agents extend this list through the reviewed PR path.
 */
export interface ResolveOutcome {
  resolved: boolean;
  action?: 'retry';
  note?: string;
}

interface ResolveCase {
  name: string;
  match: (stage: string, error: string) => boolean;
  outcome: ResolveOutcome;
}

const CASES: ResolveCase[] = [
  {
    name: 'transient-network',
    match: (_s, e) => /ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|fetch failed|network/i.test(e),
    outcome: { resolved: true, action: 'retry', note: 'transient network error — retrying' },
  },
  {
    name: 'rate-limit',
    match: (_s, e) => /429|rate limit|too many requests|quota/i.test(e),
    outcome: { resolved: true, action: 'retry', note: 'rate limited — retrying after backoff' },
  },
];

export function autoResolve(stage: string, error: string): ResolveOutcome {
  for (const c of CASES) {
    if (c.match(stage, error)) return c.outcome;
  }
  return { resolved: false };
}
