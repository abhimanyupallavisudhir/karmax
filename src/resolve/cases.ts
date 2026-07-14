/**
 * Auto-resolve cases (SPEC §5.2 Resolve). Scripted handlers keyed on an error
 * signature. A hit returns a vetted action (e.g. retry); a miss falls through to
 * the Resolve agent. Agents extend this list through the reviewed PR path.
 */
import { classifyLimitError } from '../agent/limits.js';

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

// NOTE (karmax#4): a signal-9/SIGKILL agent kill is already classified upstream as a
// retryable `agent-infra` failure in src/activities/core.ts (via the shared
// `isResourceKill` predicate in src/agent/limits.ts), so it parks-and-retries and
// does not reach Resolve. The software-dev auto-resolve case for it is tracked as a
// separate task — when added here, reuse `isResourceKill` rather than a new regex so
// both paths agree on "is this a signal-9/OOM kill?". IMPORTANT: do NOT hard-code an
// "out of memory" note. The confirmed sender in the 2026-07 incident was karmax's own
// reapOrphans() reload sweep, not the kernel OOM killer (journalctl/oomd logged zero
// kills) — branch on live memory like signalKillMessage() does, or keep the note
// cause-neutral, so the resolve messaging doesn't encode a misdiagnosis.
const CASES: ResolveCase[] = [
  {
    name: 'transient-network',
    match: (_s, e) => /ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|fetch failed|network/i.test(e),
    outcome: { resolved: true, action: 'retry', note: 'transient network error — retrying' },
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
