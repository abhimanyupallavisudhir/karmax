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

/**
 * A workflow-declared resolve rule (SPEC §5.2). Data-only (a regex source, not a
 * function) so it rides in the manifest. Its `match` is tested against the error;
 * declared rules are checked before the platform defaults.
 */
export interface ResolveRuleDecl {
  name: string;
  match: string;
  flags?: string;
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

export function autoResolve(stage: string, error: string, rules?: ResolveRuleDecl[]): ResolveOutcome {
  // Workflow-declared rules first (more specific), then the platform defaults.
  for (const r of rules ?? []) {
    try {
      if (new RegExp(r.match, r.flags ?? 'i').test(error)) return { resolved: true, action: r.action, note: r.note ?? r.name };
    } catch {
      /* a bad regex in a declared rule shouldn't wedge resolve */
    }
  }
  for (const c of CASES) {
    if (c.match(stage, error)) return c.outcome;
  }
  return { resolved: false };
}
