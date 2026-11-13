/**
 * Whether a project's tasks can run: an agent login or key for the model they
 * use, and a computer to run on. The task form asks before a task is created,
 * so a missing essential is named where it can be fixed instead of surfacing
 * later as a task waiting for a credential or out of compute.
 *
 * It answers with the same rules the run itself applies: the account
 * coordinator's credential filter (`credentialServesProfile`, policy layers
 * resolved global → project) and the compute router's options.
 */
import type { AgentProfile, Provider } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { ConfigHomeManager } from '../autonomy/config-homes.js';
import { credentialProvider, credentialServesProfile, mockAgentEnabled } from '../agent/provider-registry.js';
import { managedModelRailAvailable } from '../agent/managed-models.js';
import { includedAgentModel, includedModel, includedModelRelativeCost, isIncludedModel } from '../agent/included-model.js';
import { DEFAULT_MCP_CONNECTIONS, defaultEffort, defaultModel, roleDefaultProfile } from '../agent/profiles.js';
import { enumerateCredentials, resolveCredentials, type Credential } from './credentials.js';
import { gatherCredentialSources, readPolicyLayers } from './credential-sources.js';
import { ComputeRouter, type RouterConnections } from '../world/compute-router.js';
import { computeCredit } from '../world/managed-compute.js';

export interface ReadinessDeps {
  store: Store;
  hosted: boolean;
  configHomes?: ConfigHomeManager;
  broker?: CredentialBroker;
  providerConnections?: RouterConnections;
}

/** What an unready agent lacks: a login or key of `provider` — the harness for
 * Claude and Codex, the model's vendor for OpenCode (`openrouter/…` runs on an
 * OpenRouter key) — or, with `off`, only that one it could use is switched off
 * at that scope. */
export interface AgentNeed {
  provider: string;
  off?: 'project' | 'organization';
}

export interface Readiness {
  /** One entry per asked-about agent: whether some enabled login or key (or a
   * model tavya pays for: the included model, wiki features/included-model) can run it. */
  /** `cost`: an agent that runs on the compute credit (an OpenRouter model,
   * no login or key of the organization's own serving it) costs about this
   * many times the included model a task (wiki features/included-model). */
  /** `included`: it is the included model itself. */
  agents: Array<{ provider: string; model?: string; ready: boolean; need?: AgentNeed; cost?: number; included?: true }>;
  /** Any enabled login or key at all. */
  agentLogin: boolean;
  compute: {
    ready: boolean;
    /** Tasks run on this installation's own machine (self-hosted). */
    local: boolean;
    /** tavya's computers with credit left. */
    managed: boolean;
    /** A compute account of the organization's own. */
    own: boolean;
    /** Why tavya's computers can't take a task, when that is all there is. */
    outOfCredit?: string;
    /** What would let a task start, when nothing can: a paid plan (tavya's
     * computers, never bought), more credit (this month's is spent), or a
     * computer at all (no managed compute here, and none of its own). */
    need?: 'plan' | 'credit' | 'computer';
  };
  /** Managed storage over its quota (hosted): a task still starts, but new
   * project data it saves is refused. */
  storage?: { full: boolean; usedBytes: number; quotaBytes: number };
}

/** Every agent credential of the organization, enabled or not, and the policy
 * layers that decide which are on here. A hosted cell never offers its own
 * environment's keys to tenants. */
async function agentCredentials(deps: ReadinessDeps, scope: { organizationId: string; projectId?: string }) {
  const all = enumerateCredentials(await gatherCredentialSources({
    configHomes: deps.configHomes, broker: deps.broker, organizationId: scope.organizationId,
  })).filter((credential) => !deps.hosted || credential.kind === 'login' || Boolean(credential.apiKeyHandle));
  const layers = await readPolicyLayers(async (key) => (await deps.store.kvGet(key)), scope);
  return { all, layers: { global: layers.global, project: layers.project } };
}

/** The organization's enabled agent credentials, in policy order: the
 * credentials the account coordinator would lease from. */
export async function usableAgentCredentials(deps: ReadinessDeps,
  scope: { organizationId: string; projectId?: string }): Promise<Credential[]> {
  const { all, layers } = await agentCredentials(deps, scope);
  return resolveCredentials(all, layers);
}

export async function projectReadiness(deps: ReadinessDeps,
  scope: { organizationId: string; projectId?: string },
  agents: Array<Pick<AgentProfile, 'provider' | 'model' | 'effort'>> = []): Promise<Readiness> {
  const { all, layers } = await agentCredentials(deps, scope);
  const credentials = resolveCredentials(all, layers);
  const inOrganization = resolveCredentials(all, { global: layers.global });
  const policy = agents.length ? await deps.store.getOrganizationUsagePolicy(scope.organizationId) : undefined;
  // tavya's included model runs on the organization's credit, not a login of its own.
  const included = agents.length ? await includedModel(deps.store, deps.broker) : undefined;
  const serves = (agent: Pick<AgentProfile, 'provider' | 'model'>, pool: Credential[]) =>
    pool.some((credential) => credentialServesProfile(agent, credential, all));
  const need = (agent: Pick<AgentProfile, 'provider' | 'model'>): AgentNeed => {
    const provider = credentialProvider(agent);
    if (serves(agent, inOrganization)) return { provider, off: 'project' };
    if (serves(agent, all)) return { provider, off: 'organization' };
    return { provider };
  };
  return {
    agents: await Promise.all(agents.map(async (agent) => {
      if (agent.provider === 'mock') { const ready = mockAgentEnabled(); return { ...agent, ready, ...(ready ? {} : { need: need(agent) }) }; }
      const own = serves(agent, credentials);
      const credit = !own && isIncludedModel(agent, included);
      const ready = own || credit || managedModelRailAvailable(deps.hosted, policy!, agent);
      const cost = credit ? await includedModelRelativeCost(included!, agent.model!, agent.effort) : undefined;
      return { ...agent, ready, ...(ready ? {} : { need: need(agent) }), ...(cost !== undefined ? { cost: Math.round(cost * 10) / 10 } : {}),
        ...(credit && agent.model === includedAgentModel(included!) ? { included: true } : {}) };
    })),
    agentLogin: credentials.length > 0,
    compute: await computeReadiness(deps, scope.organizationId),
    ...(await storageReadiness(deps, scope.organizationId)),
  };
}

async function storageReadiness(deps: ReadinessDeps, organizationId: string): Promise<Pick<Readiness, 'storage'>> {
  if (!deps.hosted) return {};
  const location = (await deps.store.listStorageLocations(organizationId)).find((candidate) => candidate.kind === 'managed');
  if (!location) return {};
  const quotaBytes = await deps.store.storageLocationQuotaBytes(location);
  if (quotaBytes == null) return {};
  const { retainedBytes } = await deps.store.storageLocationUsage(location.id);
  return { storage: { full: retainedBytes >= quotaBytes, usedBytes: retainedBytes, quotaBytes } };
}

async function computeReadiness(deps: ReadinessDeps, organizationId: string): Promise<Readiness['compute']> {
  // A self-hosted installation runs tasks on its own machine.
  if (!deps.hosted) return { ready: true, local: true, managed: false, own: false };
  if (!deps.providerConnections) return { ready: false, local: false, managed: false, own: false, need: 'computer' };
  const options = await new ComputeRouter(deps.store, deps.providerConnections).options(organizationId);
  const managed = options.some((option) => option.funding === 'managed' && !option.outOfCredit);
  const own = options.some((option) => option.funding === 'own');
  const outOfCredit = !managed && !own ? options.find((option) => option.outOfCredit)?.outOfCredit : undefined;
  if (managed || own) return { ready: true, local: false, managed, own };
  if (!outOfCredit) return { ready: false, local: false, managed, own, need: 'computer' };
  // Spent, or never had any: no plan's credit, top-up or pack at all.
  const credit = await computeCredit(deps.store, organizationId);
  const never = !credit.creditMicros && !credit.topUpMicros;
  return { ready: false, local: false, managed, own, outOfCredit, need: never ? 'plan' : 'credit' };
}

/** The agent a role runs by default in this scope: its Task default (project →
 * organization → installation), unless nothing of the organization's own can
 * run that and tavya's included model is on — then the included model, so a
 * new organization's first task runs without a login, and connecting one
 * brings its model back as the default (wiki features/included-model § Default).
 * `included` says the default was replaced. An explicit choice is never
 * replaced: only what a task inherits. */
export async function defaultAgentProfile(deps: ReadinessDeps, role: string,
  scope: { organizationId: string; projectId?: string }, fallbackProvider: Provider): Promise<{ profile?: AgentProfile; included?: true }> {
  const profile = await roleDefaultProfile(deps.store, role, scope.projectId, scope.organizationId);
  // Without the config homes the organization's logins can't be seen: never guess.
  if (!deps.hosted || !deps.configHomes) return { profile };
  const settings = await includedModel(deps.store, deps.broker);
  if (!settings) return { profile };
  const provider = (profile?.provider ?? fallbackProvider) as Provider;
  const model = profile?.model ?? defaultModel(provider);
  const effort = (profile?.effort ?? defaultEffort(provider)) as AgentProfile['effort'];
  const [agent] = (await projectReadiness(deps, scope, [{ provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }])).agents;
  if (agent?.ready) return { profile };
  const { model: _model, effort: _effort, auth: _auth, allowedAccounts: _accounts, ...kept } = profile ?? { id: `${role}-default`, name: `${role} agent`, role } as AgentProfile;
  return { included: true, profile: { ...kept, provider: 'opencode', model: includedAgentModel(settings),
    ...(settings.effort ? { effort: settings.effort as AgentProfile['effort'] } : {}),
    mcpConnections: profile?.mcpConnections ?? [...DEFAULT_MCP_CONNECTIONS] } };
}
