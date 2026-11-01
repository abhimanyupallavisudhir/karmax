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
import type { AgentProfile } from '../domain/types.js';
import type { Store } from '../store/db.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { ConfigHomeManager } from '../autonomy/config-homes.js';
import { credentialServesProfile, mockAgentEnabled } from '../agent/provider-registry.js';
import { managedModelRailAvailable } from '../agent/managed-models.js';
import { enumerateCredentials, resolveCredentials, type Credential } from './credentials.js';
import { gatherCredentialSources, readPolicyLayers } from './credential-sources.js';
import { ComputeRouter, type RouterConnections } from '../world/compute-router.js';

export interface ReadinessDeps {
  store: Store;
  hosted: boolean;
  configHomes?: ConfigHomeManager;
  broker?: CredentialBroker;
  providerConnections?: RouterConnections;
}

export interface Readiness {
  /** One entry per asked-about agent: whether some enabled login or key (or a
   * model tavya pays for) can run it. */
  agents: Array<{ provider: string; model?: string; ready: boolean }>;
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
  };
}

/** The organization's enabled agent credentials, in policy order: the
 * credentials the account coordinator would lease from. A hosted cell never
 * offers its own environment's keys to tenants. */
export async function usableAgentCredentials(deps: ReadinessDeps,
  scope: { organizationId: string; projectId?: string }): Promise<Credential[]> {
  const all = enumerateCredentials(await gatherCredentialSources({
    configHomes: deps.configHomes, broker: deps.broker, organizationId: scope.organizationId,
  })).filter((credential) => !deps.hosted || credential.kind === 'login' || Boolean(credential.apiKeyHandle));
  const layers = await readPolicyLayers(async (key) => (await deps.store.kvGet(key)), scope);
  return resolveCredentials(all, { global: layers.global, project: layers.project });
}

export async function projectReadiness(deps: ReadinessDeps,
  scope: { organizationId: string; projectId?: string },
  agents: Array<Pick<AgentProfile, 'provider' | 'model'>> = []): Promise<Readiness> {
  const credentials = await usableAgentCredentials(deps, scope);
  const policy = agents.length ? await deps.store.getOrganizationUsagePolicy(scope.organizationId) : undefined;
  return {
    agents: agents.map((agent) => ({ ...agent, ready: agent.provider === 'mock' ? mockAgentEnabled()
      : credentials.some((credential) => credentialServesProfile(agent, credential, credentials))
        || managedModelRailAvailable(deps.hosted, policy!, agent) })),
    agentLogin: credentials.length > 0,
    compute: await computeReadiness(deps, scope.organizationId),
  };
}

async function computeReadiness(deps: ReadinessDeps, organizationId: string): Promise<Readiness['compute']> {
  // A self-hosted installation runs tasks on its own machine.
  if (!deps.hosted) return { ready: true, local: true, managed: false, own: false };
  if (!deps.providerConnections) return { ready: false, local: false, managed: false, own: false };
  const options = await new ComputeRouter(deps.store, deps.providerConnections).options(organizationId);
  const managed = options.some((option) => option.funding === 'managed' && !option.outOfCredit);
  const own = options.some((option) => option.funding === 'own');
  const outOfCredit = !managed && !own ? options.find((option) => option.outOfCredit)?.outOfCredit : undefined;
  return { ready: managed || own, local: false, managed, own, ...(outOfCredit ? { outOfCredit } : {}) };
}
