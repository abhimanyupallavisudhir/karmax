import { validateMcpSelection } from '../mcp/connections/store.js';
import { AgentProfile, AgentRole, AgentSpec, Provider } from '../domain/types.js';
import { Store } from '../store/db.js';
import { allRoles } from '../contrib/manifests.js';
import { CLAUDE_DEFAULT_MODEL } from './effort.js';
import { mockAgentEnabled } from './provider-registry.js';

export const DEFAULT_MCP_CONNECTIONS = ['browser:chrome-devtools'];

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
    mcpConnections: [...DEFAULT_MCP_CONNECTIONS],
    ...(r.defaults?.effort ? { effort: r.defaults.effort } : {}),
    ...(r.defaults?.maxTurns ? { maxTurns: r.defaults.maxTurns } : {}),
    // no maxTurns unless declared ⇒ unlimited (runaway backstop only)
  }));
}

export function defaultModel(provider: Provider): string | undefined {
  if (provider === 'codex') return process.env.KARMAX_OPENAI_MODEL ?? 'gpt-5.5';
  // The same constant the metered rail falls back to for a model-less profile,
  // imported rather than duplicated so the two cannot drift again.
  if (provider === 'claude') return process.env.KARMAX_CLAUDE_MODEL ?? CLAUDE_DEFAULT_MODEL;
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
 * providers. A model belongs to its harness; credential routing is stripped
 * here and resolved independently by the scoped Credentials policy. */
export function applyAgentSpec(base: AgentProfile, spec?: AgentSpec): AgentProfile {
  // `modelProvider` used to be independently editable. It duplicated the
  // ordered Credentials policy and could disagree with it. Keep the wire/storage
  // member for replay compatibility, but never let persisted task/profile input
  // route a turn; core stamps the provider of the credential actually leased.
  const { modelProvider: _legacyModelProvider, ...cleanBase } = base;
  if (!spec) return cleanBase;
  const provider = spec.provider ?? base.provider;
  const sameProvider = provider === base.provider;
  const model = spec.model ?? (sameProvider ? base.model : defaultModel(provider));
  const effort = spec.effort ?? (sameProvider ? base.effort : undefined);
  const { model: _model, effort: _effort, auth: _auth, allowedAccounts: _allowedAccounts, ...common } = cleanBase;
  return {
    ...common,
    ...(spec.mcpConnections !== undefined ? { mcpConnections: validateMcpSelection(spec.mcpConnections) } : {}),
    provider,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

/** Stable ids for the two editable profile-default layers. The unprefixed
 * `<role>-default` records remain the bundled/legacy installation fallback. */
export const organizationProfileId = (organizationId: string, role: AgentRole | string) =>
  `organization:${organizationId}::${role}-default`;
export const projectProfileId = (projectId: string, role: AgentRole | string) =>
  `${projectId}::${role}-default`;

/** Profile ids are scoped by prefix: `<project>::…` and `organization:<org>::…`
 * belong to that project/organization; ids without `::` are installation-wide.
 * A task may name only profiles visible to its own project. */
export function profileVisibleTo(id: string, projectId: string | undefined, organizationId: string | undefined): boolean {
  if (!id.includes('::')) return true;
  return (!!projectId && id.startsWith(`${projectId}::`))
    || (!!organizationId && id.startsWith(`organization:${organizationId}::`));
}

/** Resolve the editable defaults without letting one organization's choice
 * become another's fallback: project → organization → bundled/legacy. */
export async function roleDefaultProfile(store: Store, role: AgentRole | string,
  projectId?: string, organizationId?: string): Promise<AgentProfile | undefined> {
  if (projectId) {
    const project = (await store.getProfile(projectProfileId(projectId, role)));
    if (project) {
      const parent = (await roleDefaultProfile(store, role, undefined, organizationId ?? (await store.getProject(projectId))?.organizationId));
      return { ...project, mcpConnections: project.mcpConnections ?? parent?.mcpConnections ?? [...DEFAULT_MCP_CONNECTIONS] };
    }
    organizationId ??= (await store.getProject(projectId))?.organizationId;
  }
  if (organizationId) {
    const organization = (await store.getProfile(organizationProfileId(organizationId, role)));
    if (organization) {
      const fallback = (await roleDefaultProfile(store, role));
      return { ...organization, mcpConnections: organization.mcpConnections ?? fallback?.mcpConnections ?? [...DEFAULT_MCP_CONNECTIONS] };
    }
  }
  const fallback = (await store.getProfile(`${role}-default`));
  return fallback ? { ...fallback, mcpConnections: fallback.mcpConnections ?? [...DEFAULT_MCP_CONNECTIONS] } : undefined;
}

/** Resolves the profile for a role, honoring explicit/task/default precedence. */
export class ProfileResolver {
  constructor(
    private store: Store,
    private fallbackProvider: Provider,
  ) {}

  async resolve(role: AgentRole, taskProfiles?: Record<string, string>, explicitId?: string, projectId?: string): Promise<AgentProfile> {
    const id = explicitId ?? taskProfiles?.[role];
    const organizationId = projectId ? (await this.store.getProject(projectId))?.organizationId ?? 'org_personal' : undefined;
    if (id && profileVisibleTo(id, projectId, organizationId)) {
      const p = (await this.store.getProfile(id));
      if (p) return { ...p, mcpConnections: p.mcpConnections ?? (await roleDefaultProfile(this.store, role, projectId))?.mcpConnections ?? [...DEFAULT_MCP_CONNECTIONS] };
    }
    const def = (await roleDefaultProfile(this.store, role, projectId));
    if (def) return def;
    // Synthesize a minimal default if the store has no profile yet.
    const model = defaultModel(this.fallbackProvider);
    return {
      id: `${role}-default`,
      name: `${role} agent`,
      provider: this.fallbackProvider,
      ...(model ? { model } : {}),
      role,
      mcpConnections: [...DEFAULT_MCP_CONNECTIONS],
    };
  }
}

/** Seed the store with the default profiles for a provider (idempotent overwrite). */
export async function seedProfiles(store: Store, provider: Provider) {
  for (const p of makeDefaultProfiles(provider)) {
    if (!(await store.getProfile(p.id))) (await store.upsertProfile(p));
  }
  (await repairMockProfiles(store, provider));
}

/** Move every stored profile and Avatar that names the mock agent onto the
 * installation's default agent, unless the mock is enabled here. An earlier
 * release seeded the mock as every role's default on a host that had no agent
 * credential at first boot (tavya.io), and every organization without defaults
 * of its own inherited it. Everything but the harness and model is kept.
 * Returns how many records changed. */
export async function repairMockProfiles(store: Store, provider: Provider): Promise<number> {
  if (mockAgentEnabled() || provider === 'mock') return 0;
  const model = defaultModel(provider);
  let changed = 0;
  for (const profile of await store.listProfiles()) {
    if (profile.provider !== 'mock') continue;
    const { model: _model, ...rest } = profile;
    (await store.upsertProfile({ ...rest, provider, ...(model ? { model } : {}) }));
    changed++;
  }
  for (const avatar of await store.listAvatars()) {
    if (avatar.runtime.provider !== 'mock') continue;
    const { model: _model, ...runtime } = avatar.runtime;
    try {
      (await store.upsertAvatar({ ...avatar, runtime: { ...runtime, provider, ...(model ? { model } : {}) } }));
      changed++;
    } catch { /* its owner's account is closed: it can no longer run */ }
  }
  if (changed) console.warn(`  • Moved ${changed} agent profile(s) off the mock agent onto ${provider}${model ? `:${model}` : ''}`);
  return changed;
}
