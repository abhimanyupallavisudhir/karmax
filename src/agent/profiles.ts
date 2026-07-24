import { AgentProfile, AgentRole, AgentSpec, Provider } from '../domain/types.js';
import { Store } from '../store/db.js';
import { allRoles } from '../contrib/manifests.js';

/**
 * The default per-role profiles, derived from the roles the active workflows
 * declare (SPEC §7.1) — not a hardcoded role list. A workflow that
 * declares a new role automatically gets a seeded default + a profiles-UI entry.
 */
export function makeDefaultProfiles(provider: Provider): AgentProfile[] {
  const model = defaultModel(provider);
  return allRoles().map((r) => ({
    id: `${r.name}-default`,
    name: r.label,
    provider,
    ...(model ? { model } : {}),
    role: r.name,
    capabilities: r.capabilities ?? [],
    ...(r.defaults?.effort ? { effort: r.defaults.effort } : {}),
    ...(r.defaults?.maxTurns ? { maxTurns: r.defaults.maxTurns } : {}),
    // no maxTurns unless declared ⇒ unlimited (runaway backstop only)
  }));
}

export function defaultModel(provider: Provider): string | undefined {
  if (provider === 'codex') return process.env.KARMAX_OPENAI_MODEL ?? 'gpt-5.5';
  if (provider === 'claude') return process.env.KARMAX_CLAUDE_MODEL ?? 'claude-sonnet-5';
  if (provider === 'opencode') return process.env.KARMAX_OPENCODE_MODEL ?? 'kimi/kimi-for-coding';
  if (provider === 'kimi') return process.env.KARMAX_KIMI_MODEL ?? 'kimi-for-coding';
  if (provider === 'grok') return process.env.KARMAX_GROK_MODEL ?? 'grok-build';
  return undefined;
}

/** The provider's default reasoning effort — shown as the inferred default in
 *  forms so the field reads a real value, not a bare "effort" placeholder. It is
 *  display-only: leaving a profile's effort unset still lets the provider pick. */
export function defaultEffort(provider: Provider): string | undefined {
  if (provider === 'codex' || provider === 'claude' || provider === 'opencode' || provider === 'kimi' || provider === 'grok') return 'medium';
  return undefined;
}

/** Apply a per-task agent spec without carrying provider-scoped settings across
 * providers. A profile's model/auth/account allow-list belongs to its provider:
 * changing Claude → Codex (or vice versa) must not leave the old provider's
 * model or credentials attached to the new adapter. */
export function applyAgentSpec(base: AgentProfile, spec?: AgentSpec): AgentProfile {
  if (!spec) return base;
  const provider = spec.provider ?? base.provider;
  const sameProvider = provider === base.provider;
  const modelProvider = spec.modelProvider ?? (sameProvider ? base.modelProvider : undefined);
  const model = spec.model ?? (sameProvider ? base.model : defaultModel(provider));
  const effort = spec.effort ?? (sameProvider ? base.effort : undefined);
  const {
    model: _model,
    modelProvider: _modelProvider,
    effort: _effort,
    auth: _auth,
    allowedAccounts: _allowedAccounts,
    ...common
  } = base;
  return {
    ...common,
    provider,
    ...(modelProvider ? { modelProvider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(sameProvider && base.auth ? { auth: base.auth } : {}),
    ...(sameProvider && base.allowedAccounts ? { allowedAccounts: base.allowedAccounts } : {}),
  };
}

/** Resolves the profile for a role, honoring explicit/task/default precedence. */
export class ProfileResolver {
  constructor(
    private store: Store,
    private fallbackProvider: Provider,
  ) {}

  resolve(role: AgentRole, taskProfiles?: Record<string, string>, explicitId?: string, projectId?: string): AgentProfile {
    const id = explicitId ?? taskProfiles?.[role];
    if (id) {
      const p = this.store.getProfile(id);
      if (p) return p;
    }
    // Project overlay (SPEC §9): a project-scoped role default overrides the global one.
    if (projectId) {
      const proj = this.store.getProfile(`${projectId}::${role}-default`);
      if (proj) return proj;
    }
    const def = this.store.getProfile(`${role}-default`);
    if (def) return def;
    // Synthesize a minimal default if the store has no profile yet.
    const model = defaultModel(this.fallbackProvider);
    return {
      id: `${role}-default`,
      name: `${role} agent`,
      provider: this.fallbackProvider,
      ...(model ? { model } : {}),
      role,
      capabilities: ['signal-completion'],
    };
  }
}

/** Seed the store with the default profiles for a provider (idempotent overwrite). */
export function seedProfiles(store: Store, provider: Provider) {
  for (const p of makeDefaultProfiles(provider)) {
    if (!store.getProfile(p.id)) store.upsertProfile(p);
  }
}
