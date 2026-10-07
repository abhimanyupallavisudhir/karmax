import type { Store } from '../store/db.js';
import type { OrganizationExecutionPolicy, Project } from '../domain/types.js';
import type { WorldProviderConnectionService } from '../world/connections.js';
import { computerConfig, computerOf, normalizeComputer, type ComputerSpec } from '../domain/computer.js';

/**
 * The Computer field in Task defaults (wiki features/computers). Its values are
 * the execution policy, not a settings row: the organization's policy and the
 * project's sparse override already decide what every task world runs on, and
 * the gateway, runner admission and the MCP `set_execution_policy` tool all
 * read and write them. Task defaults is one more editor of that one value.
 */

const LOCAL = ['worktree', 'container', 'memory'];

/** Own/inherited Computer values per Task-defaults layer, for `/api/defaults`. */
export async function computerDefaults(store: Store, organizationId: string | undefined, project: Project | undefined) {
  const organization = organizationId ? (await store.getOrganizationExecutionPolicy(organizationId)) : undefined;
  const fallback = store.defaultOrganizationExecutionPolicy();
  return {
    global: { own: computerOf(organization), inherited: computerOf(fallback) },
    project: { own: computerOf(project?.config), inherited: computerOf(organization ?? fallback) },
    task: { inherited: computerOf(project ? (await store.effectiveProjectConfig(project)) : organization ?? fallback) },
  };
}

async function assertProvider(providerConnections: WorldProviderConnectionService | undefined, organizationId: string,
  provider: string | undefined, hosted: boolean): Promise<void> {
  if (!provider) return;
  if (LOCAL.includes(provider)) {
    if (hosted) throw new Error('hosted tasks run on a cloud computer (E2B or Daytona)');
    return;
  }
  if (providerConnections && !(await providerConnections.available(organizationId, provider)))
    throw new Error(`${provider} is not connected. Connect it under Settings → Computers first.`);
}

/** Replace the organization's Computer with `raw` (a sparse value over the
 * built-in default; null resets it). Keys outside the Computer — budget, runner
 * pool, provider templates — are untouched. */
export async function saveOrganizationComputer(store: Store, organizationId: string, raw: unknown,
  options: { hosted: boolean; providerConnections?: WorldProviderConnectionService }): Promise<OrganizationExecutionPolicy> {
  const spec = normalizeComputer(raw) ?? {};
  await assertProvider(options.providerConnections, organizationId, spec.provider, options.hosted);
  const fallback = store.defaultOrganizationExecutionPolicy();
  const current = (await store.getOrganizationExecutionPolicy(organizationId));
  const chosen = computerConfig(spec);
  return store.setOrganizationExecutionPolicy(organizationId, {
    worldProvider: chosen.worldProvider ?? fallback.worldProvider,
    // `undefined` drops a size the organization no longer sets (JSON omits it).
    resources: { ...current.resources, cpu: spec.cpu ?? fallback.resources?.cpu, memoryMb: spec.memoryMb ?? fallback.resources?.memoryMb,
      diskGb: spec.diskGb },
    environment: { ...current.environment, flavor: spec.flavor ?? fallback.environment?.flavor },
    network: chosen.network ?? fallback.network,
    hibernateAfterMs: chosen.hibernateAfterMs ?? fallback.hibernateAfterMs,
  });
}

/** Replace the project's Computer override with `raw` (null inherits the
 * organization's). Non-Computer resource and environment keys a project set
 * through the API (a GPU, a pinned template) are kept. */
export async function saveProjectComputer(store: Store, project: Project, raw: unknown,
  options: { hosted: boolean; providerConnections?: WorldProviderConnectionService }): Promise<Project> {
  const spec: ComputerSpec = normalizeComputer(raw) ?? {};
  await assertProvider(options.providerConnections, project.organizationId ?? 'org_personal', spec.provider, options.hosted);
  const chosen = computerConfig(spec);
  const { cpu: _cpu, memoryMb: _memoryMb, diskGb: _diskGb, ...otherResources } = project.config.resources ?? {};
  const { flavor: _flavor, ...otherEnvironment } = project.config.environment ?? {};
  const resources = { ...otherResources, ...chosen.resources };
  const environment = { ...otherEnvironment, ...chosen.environment };
  return store.setProjectExecutionPolicy(project.id, {
    worldProvider: chosen.worldProvider ?? null,
    resources: Object.keys(resources).length ? resources : null,
    environment: Object.keys(environment).length ? environment : null,
    network: chosen.network ?? null,
    hibernateAfterMs: chosen.hibernateAfterMs ?? null,
  });
}

/** Settings-row values with the Computer taken out: it is stored above, and a
 * stale copy in a row would only mislead its readers. The legacy
 * `worldProvider` row value is dropped, never applied: other forms read-merge-
 * write the row, and replaying an old copy would undo a newer Computer. */
export function splitComputerValues(values: Record<string, unknown>): { rest: Record<string, unknown>; computer?: { value: unknown } } {
  const { computer, worldProvider: _legacy, ...rest } = values;
  return Object.prototype.hasOwnProperty.call(values, 'computer') ? { rest, computer: { value: computer } } : { rest };
}
