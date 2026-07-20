/**
 * Credential policy (SPEC §7 auth + §9 overlays): the user orders every auth source
 * — specific config-home logins, the ambient login, and API keys — by precedence
 * and can enable/disable each, at global / project / task scope with the lower scope
 * overriding the higher. The account coordinator (§6.2) then leases in that order,
 * skipping disabled (and exhausted) credentials.
 *
 * Pure module: enumeration takes plain data (gathered by the caller from
 * ConfigHomeManager / env / the broker) and resolution is a pure function, so both
 * are trivially testable and safe to import anywhere.
 */
export type Provider = 'claude' | 'codex';
export type CredKind = 'login' | 'ambient' | 'key';

export interface Credential {
  /** Stable id: login:<prov>:<acct> | ambient:<prov> | key:<prov> | key:handle:<h>. */
  key: string;
  provider: Provider;
  kind: CredKind;
  label: string;
  /** For login/ambient — the CLAUDE_CONFIG_DIR / CODEX_HOME to run under. */
  configHome?: string;
  /** For a broker-backed API key — the handle to resolve JIT. */
  apiKeyHandle?: string;
  /** For a login — the account name. */
  account?: string;
}

/** A per-scope policy layer. `order` (partial or full) sets precedence; `on`/`off`
 *  flip a credential's enablement, overriding higher scopes + the default. */
export interface CredPolicy {
  order?: string[];
  on?: string[];
  off?: string[];
}

export interface CredentialSources {
  /** ConfigHomeManager.list() output. */
  logins: { provider: string; account: string; path: string; loggedIn: boolean }[];
  /** Ambient (~/.claude / ~/.codex) login present? */
  ambient: { claude: boolean; codex: boolean };
  /** Resolved ambient homes. Optional keeps pure callers/tests backwards compatible. */
  ambientHomes?: { claude?: string; codex?: string };
  /** ANTHROPIC_API_KEY / OPENAI_API_KEY present in the environment? */
  envKeys: { claude: boolean; codex: boolean };
  /** Broker-registered API-key handles (e.g. "claude:work"). */
  handles: string[];
}

const isProvider = (p: string): p is Provider => p === 'claude' || p === 'codex';

/** Enumerate every usable credential from the gathered sources. */
export function enumerateCredentials(s: CredentialSources): Credential[] {
  const out: Credential[] = [];
  for (const l of s.logins) {
    if (!l.loggedIn || !isProvider(l.provider)) continue;
    out.push({ key: `login:${l.provider}:${l.account}`, provider: l.provider, kind: 'login', label: `${l.provider}:${l.account}`, configHome: l.path, account: l.account });
  }
  if (s.ambient.claude) out.push({ key: 'ambient:claude', provider: 'claude', kind: 'ambient', label: 'claude (ambient ~/.claude)', configHome: s.ambientHomes?.claude });
  if (s.ambient.codex) out.push({ key: 'ambient:codex', provider: 'codex', kind: 'ambient', label: 'codex (ambient ~/.codex)', configHome: s.ambientHomes?.codex });
  if (s.envKeys.claude) out.push({ key: 'key:claude', provider: 'claude', kind: 'key', label: 'ANTHROPIC_API_KEY' });
  if (s.envKeys.codex) out.push({ key: 'key:codex', provider: 'codex', kind: 'key', label: 'OPENAI_API_KEY' });
  for (const h of s.handles) {
    const prov = h.split(':')[0] ?? '';
    if (!isProvider(prov)) continue;
    out.push({ key: `key:handle:${h}`, provider: prov, kind: 'key', label: `API key: ${h}`, apiKeyHandle: h });
  }
  return out;
}

/** Default enablement, given the full set: subscriptions/logins ON; API keys OFF
 *  *when a subscription exists for that provider* (so a stray/dead env key never
 *  shadows a working subscription) — but ON when a key is the ONLY credential for
 *  its provider (so a key-only setup still works out of the box). */
export function defaultEnabled(c: Credential, all: Credential[]): boolean {
  if (c.kind !== 'key') return true;
  const hasSubscription = all.some((x) => x.provider === c.provider && x.kind !== 'key');
  return !hasSubscription;
}

/** Default precedence: specific logins first, then the ambient login, then keys —
 *  and within a kind, stable by label. */
function defaultRank(c: Credential): number {
  return c.kind === 'login' ? 0 : c.kind === 'ambient' ? 1 : 2;
}

/** Is a credential enabled under the resolved policy (task → project → global →
 *  default)? A lower scope's on/off overrides a higher one. */
export function isEnabled(key: string, layers: { global?: CredPolicy; project?: CredPolicy; task?: CredPolicy }, def: boolean): boolean {
  for (const L of [layers.task, layers.project, layers.global]) {
    if (L?.on?.includes(key)) return true;
    if (L?.off?.includes(key)) return false;
  }
  return def;
}

/**
 * The effective, ENABLED credentials in precedence order (highest first). `order`
 * from the lowest scope that sets it wins; enablement resolves per-credential with
 * the lower scope overriding. Credentials not named in `order` keep the default rank
 * (appended after ordered ones, stable by kind then label).
 */
export function resolveCredentials(
  all: Credential[],
  layers: { global?: CredPolicy; project?: CredPolicy; task?: CredPolicy },
): Credential[] {
  const order = layers.task?.order ?? layers.project?.order ?? layers.global?.order;
  const rankOf = (c: Credential): [number, number, string] => {
    const idx = order ? order.indexOf(c.key) : -1;
    // ordered keys first (by their position), then unordered by default rank + label
    return idx >= 0 ? [0, idx, c.key] : [1, defaultRank(c), c.label];
  };
  return all
    .filter((c) => isEnabled(c.key, layers, defaultEnabled(c, all)))
    .sort((a, b) => {
      const [ra0, ra1, ra2] = rankOf(a);
      const [rb0, rb1, rb2] = rankOf(b);
      return ra0 - rb0 || ra1 - rb1 || (typeof ra2 === 'string' ? ra2.localeCompare(rb2 as string) : 0);
    });
}

/** The ordered, enabled credentials for one provider (the lease allow-list). */
export function credentialsForProvider(
  all: Credential[],
  provider: Provider,
  layers: { global?: CredPolicy; project?: CredPolicy; task?: CredPolicy },
): Credential[] {
  return resolveCredentials(all, layers).filter((c) => c.provider === provider);
}
