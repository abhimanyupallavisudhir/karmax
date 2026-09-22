import { validateMcpSelection } from '../mcp/connections/store.js';
import { AgentProfile, AgentRole, AgentSpec, Provider } from '../domain/types.js';
import { Store } from '../store/db.js';
import { allRoles } from '../contrib/manifests.js';
import { CLAUDE_DEFAULT_MODEL } from './effort.js';

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
  // Must stay identical to CLAUDE_DEFAULT_MODEL in src/agent/claude.ts: this one
  // is stamped onto every role by seedProfiles(), that one is the fallback for a
  // model-less profile on the metered rail. They used to disagree (`claude-sonnet-5`
  // — which never existed — vs `claude-sonnet-4-5`, which fails the effort gate),
  // so a model-less profile silently lost its reasoning effort. Imported rather
  // than duplicated so they cannot drift again.
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
    if (id) {
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
}
