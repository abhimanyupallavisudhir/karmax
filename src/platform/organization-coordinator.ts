import { AUTONOMY_KEY, ORGANIZATION_COORDINATOR_PROJECT, type ProjectAutonomy } from '../domain/autonomous-projects.js';
import type { Project } from '../domain/types.js';
import { slugify, type Store } from '../store/db.js';

/**
 * Every organization's co-ordinator project (wiki features/computerless-tasks,
 * "Ask"): where work for the organization as a whole lives — what is asked
 * with Ask, and an autonomous organization's co-ordinator. Made the first time
 * it is needed, so an organization that never asks has no extra project.
 */
export const ORGANIZATION_COORDINATOR_KEY = (organizationId: string) => `organization-coordinator:${organizationId}`;

type CoordinatorStore = Pick<Store, 'kvGet' | 'kvSet' | 'getProject' | 'listOrganizationProjects'>;

/** The organization's co-ordinator project, if it has one: the recorded one,
 * else (organizations made autonomous before the record) the project an
 * organization-wide autonomy runs from, which is then recorded. */
export async function organizationCoordinatorProject(store: CoordinatorStore, organizationId: string): Promise<Project | undefined> {
  const recorded = await store.kvGet(ORGANIZATION_COORDINATOR_KEY(organizationId));
  if (recorded) {
    const project = await store.getProject(recorded);
    if (project?.organizationId === organizationId) return project;
  }
  for (const project of await store.listOrganizationProjects(organizationId)) {
    const autonomy = await store.kvGet(AUTONOMY_KEY(project.id));
    if (!autonomy) continue;
    try {
      if ((JSON.parse(autonomy) as ProjectAutonomy).scope !== 'organization') continue;
    } catch { continue; }
    await store.kvSet(ORGANIZATION_COORDINATOR_KEY(organizationId), project.id);
    return project;
  }
  return undefined;
}

/** A name for a new co-ordinator project no project of the organization has (slugs are unique). */
export function freeCoordinatorName(taken: Iterable<string>): string {
  const slugs = new Set([...taken].map(slugify));
  for (let n = 1; ; n++) {
    const name = n === 1 ? ORGANIZATION_COORDINATOR_PROJECT : `${ORGANIZATION_COORDINATOR_PROJECT} ${n}`;
    if (!slugs.has(slugify(name))) return name;
  }
}
