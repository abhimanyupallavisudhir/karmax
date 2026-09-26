/**
 * Auto-resolve cases (SPEC §5.2 Resolve). Scripted handlers keyed on an error
 * signature. A hit returns a vetted action (e.g. retry); a miss falls through to
 * the Resolve agent. Agents extend this list through the reviewed PR path.
 */
import { isSafeSearchPattern } from '../wiki/wiki.js';
import { classifyLimitError, isResourceKill, isTransportError } from '../agent/limits.js';

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
    name: 'transient-infrastructure',
    // Most agent-turn failures are tagged `agent-infra` before they get here. This
    // shared fallback covers legacy histories plus setup/merge activities without
    // maintaining a second, inevitably divergent list of network/process strings.
    match: (_s, e) => isTransportError(e) || isResourceKill(e),
    outcome: { resolved: true, action: 'retry', note: 'transient infrastructure error — retrying' },
  },
  {
    name: 'rate-limit',
    // Compatibility fallback for old histories and non-turn errors. Current agent
    // turns carry provider metadata into autoResolve directly; this message parser
    // covers stable legacy strings without enabling fuzzy matching for arbitrary
    // build/setup errors.
    match: (_s, e) => {
      const limit = classifyLimitError(e);
      return limit.limited;
    },
    outcome: { resolved: true, action: 'retry', note: 'usage limit reached — retrying without a Resolve agent' },
  },
];

export function autoResolve(stage: string, error: string, rules?: ResolveRuleDecl[]): ResolveOutcome {
  // Workflow-declared rules first (more specific), then the platform defaults.
  for (const r of (rules ?? []).slice(0, 100)) {
    // Declared rules run on the shared worker thread. Keep a conservative
    // grammar and bounded input; complex patterns fall through to Resolve.
    if (r.match.length > 512 || !isSafeSearchPattern(r.match)
      || /[(){}]/.test(r.match) || (r.match.match(/[*+?]/g)?.length ?? 0) > 1) continue;
    try {
      if (new RegExp(r.match, r.flags ?? 'i').test(error.slice(0, 2048))) return { resolved: true, action: r.action, note: r.note ?? r.name };
    } catch {
      /* a bad regex in a declared rule shouldn't wedge resolve */
    }
  }
  for (const c of CASES) {
    if (c.match(stage, error)) return c.outcome;
  }
  return { resolved: false };
}
