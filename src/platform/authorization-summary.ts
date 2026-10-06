import { CAPABILITIES, Capability, allows, capMatches, normalizeCapability } from './capabilities.js';
import { DEFAULT_AUTHORIZATION_PROFILES, type AuthorizationService } from './authorization.js';
import type { Store } from '../store/db.js';

/**
 * What a caller may do, in the terms it acts and asks in (SPEC §8.1): its
 * level, its scope, the capabilities it holds and the exact ones it lacks.
 * The gateway serves it at `GET /api/authorization/me` and every agent turn's
 * prompt states it, so an agent neither asks a person to do what it may do
 * itself nor has to discover a refusal by trying.
 */
export interface AuthorizationSummary {
  level?: { id: string; name: string; description?: string };
  scope: {
    kind: 'projects' | 'organization' | 'global';
    organization?: { id: string; name?: string };
    projects?: { id: string; name?: string }[];
  };
  /** Held capabilities; a namespace held completely is folded to `ns:*`. */
  held: Capability[];
  /** Catalogue capabilities not held, exact so they can be requested as written. */
  missing: Capability[];
}

const namespace = (capability: string) => capability.split(':')[0]!;

/** Split the catalogue into what `caps` allows and what it does not. */
export function summarizeCapabilities(caps: Capability[]): Pick<AuthorizationSummary, 'held' | 'missing'> {
  const normalized = caps.map(normalizeCapability);
  if (normalized.includes('*')) return { held: ['*'], missing: [] };
  const catalogue: readonly string[] = CAPABILITIES;
  const allowed = new Set(catalogue.filter((capability) => allows(normalized, capability)));
  const held: Capability[] = [];
  const folded = new Set<string>();
  for (const capability of catalogue) {
    if (!allowed.has(capability)) continue;
    const ns = namespace(capability);
    const pattern = `${ns}:*`;
    // Fold only what `ns:*` really covers: `credential:*` is not vault read access.
    const covered = catalogue.filter((candidate) => namespace(candidate) === ns && capMatches(pattern, candidate));
    if (covered.length > 1 && covered.every((candidate) => allowed.has(candidate)) && covered.includes(capability)) {
      if (!folded.has(pattern)) held.push(pattern);
      folded.add(pattern);
    } else held.push(capability);
  }
  // Grants the catalogue does not already show: a concrete card, credential or
  // merge target, or a family such as `use-credential:*`. A wildcard over
  // catalogue entries (`project:settings:*`) is already expanded above.
  for (const capability of normalized)
    if (!catalogue.includes(capability) && !held.includes(capability)
      && !catalogue.some((entry) => capability.includes('*') ? capMatches(capability, entry) : allowed.has(entry) && capMatches(entry, capability)))
      held.push(capability);
  // `use-card:*`/`merge-into:*` are families, requested only as concrete members.
  return { held, missing: catalogue.filter((capability) => !allowed.has(capability) && !capability.includes('*')) };
}

const named = (entry: { id: string; name?: string }) => entry.name ? `${entry.name} (${entry.id})` : entry.id;

export function describeScope(scope: AuthorizationSummary['scope']): string {
  const organization = scope.organization ? named(scope.organization) : undefined;
  if (scope.kind === 'global') return 'across the whole installation';
  if (scope.kind === 'organization') return `across organization ${organization ?? '(unknown)'}`;
  const projects = (scope.projects ?? []).map(named);
  const list = `${projects.length === 1 ? 'project' : 'projects'} ${projects.join(', ') || '(none)'}`;
  return organization ? `in ${list} of organization ${organization}` : `in ${list}`;
}

/** The prompt section every agent turn receives. */
export function authorizationPromptContext(summary: AuthorizationSummary): string {
  const who = summary.level ? `${summary.level.name}${summary.level.description ? ` (${summary.level.description.replace(/\.$/, '')})` : ''}` : 'a custom authorization';
  return [
    '# Authorization',
    `You are authorized as ${who} ${describeScope(summary.scope)}. This is the same authority a person at that level has in the UI: when it covers something (a project setting, a secret, a review action…), do it yourself through the tools or platform_request — never ask a person to do it for you.`,
    `You hold: ${summary.held.join(', ') || 'nothing beyond your own task'}.`,
    ...(summary.missing.length ? [`You lack: ${summary.missing.join(', ')}.`] : []),
    'For anything you lack — a capability or another project — ask with request_permission(capabilities, projectIds?) instead of asking a person to do the work. my_authorization(method?, path?) shows your current authorization (it grows when a request is approved) and whether a platform_request would be allowed, without making it.',
  ].join('\n');
}

/** Resolve level and scope names for a capability set (a token's, or a turn's). */
export async function resolveAuthorizationSummary(
  store: Pick<Store, 'getProject' | 'getOrganization'>,
  authorization: Pick<AuthorizationService, 'profile'> | undefined,
  input: { caps: Capability[]; level?: string; projectId?: string; projectIds?: string[]; organizationId?: string },
): Promise<AuthorizationSummary> {
  const projectIds = input.projectIds?.length ? input.projectIds : input.projectId ? [input.projectId] : [];
  const organizationId = input.organizationId
    ?? (projectIds[0] ? (await store.getProject(projectIds[0]))?.organizationId : undefined);
  const profile = input.level
    ? (await authorization?.profile(input.level, projectIds[0], organizationId).catch(() => undefined))
      ?? DEFAULT_AUTHORIZATION_PROFILES.find((candidate) => candidate.id === input.level)
    : undefined;
  const organization = organizationId ? { id: organizationId, name: (await store.getOrganization(organizationId))?.name } : undefined;
  const scope: AuthorizationSummary['scope'] = projectIds.length
    ? { kind: 'projects', ...(organization ? { organization } : {}),
      projects: await Promise.all(projectIds.map(async (id) => ({ id, name: (await store.getProject(id))?.name }))) }
    : organization ? { kind: 'organization', organization } : { kind: 'global' };
  return {
    ...(profile ? { level: { id: profile.id, name: profile.name, description: profile.description } } : {}),
    scope,
    ...summarizeCapabilities(input.caps),
  };
}
