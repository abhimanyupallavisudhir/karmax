import type { Store } from '../store/db.js';
import type { TokenAuthority } from './tokens.js';
import type { KarmaxApi } from './api.js';
import type { AuthorizationSelection, PrincipalRef, TaskRecord } from '../domain/types.js';
import { AUTONOMY_KEY, type ProjectAutonomy } from '../domain/autonomous-projects.js';
import { CEO_KEY, ceoTitle, DEFAULT_COORDINATOR_WAKE_HOURS, LEGACY_CEO_PROJECT_NAME, type CeoScope } from '../domain/coordinator.js';
import { NotFoundError } from './errors.js';

/**
 * Every project's CEO, and every organization's in its CEO project (wiki
 * features/coordinator § CEOs): a permanent co-ordinator that starts as a
 * draft named for what it is and nothing else. Made with the project or
 * organization, and for those from before at boot (`ensureEveryCeo`).
 *
 * Its authority is fixed, as an autonomous project's (wiki features/autonomy):
 * an organization's CEO is Super-administrator of the organization, a
 * project's Project maintainer of its project, each with every vault
 * credential. The draft asks for it and holds none of it: whoever starts the
 * CEO grants it, and someone who cannot is asked to have it approved by someone
 * who can — as any task asking for more than its starter holds (owner,
 * 2026-11-25).
 */
export interface CeoDeps { api: KarmaxApi; store: Store; tokens: TokenAuthority }

/** Who made a draft the platform made for a project. */
export const CEO_PRINCIPAL = 'system:ceo';

/** What a CEO acts with: the same as an autonomous project's or organization's Avatār. */
export function ceoAuthorization(scope: CeoScope, projectId: string): AuthorizationSelection {
  return scope === 'organization' ? { level: 'superadmin', scope: 'organization' }
    : { level: 'maintainer', scope: 'projects', projectIds: [projectId] };
}
export const CEO_CREDENTIAL_GRANTS = ['use-credential:*'];
/** An organization's CEO lives in its CEO project; every other project's is the project's own. */
export const ceoScopeOf = (project: { coordinator?: true }): CeoScope => (project.coordinator ? 'organization' : 'project');
/** How long a claim to make a CEO counts as someone making it (a crash leaves one). */
const CLAIM_STALE_MS = 2 * 60_000;
const CLAIM_WAIT_MS = 15_000;

const live = (task: TaskRecord | undefined): task is TaskRecord =>
  !!task && task.lastView?.status !== 'cancelled';

/** The project's CEO, if it has one: the recorded one, else (projects made
 * autonomous before CEOs) the co-ordinator its autonomy started, which is then
 * recorded and given the CEO's name. A cancelled or deleted CEO is none. */
export async function projectCeo(store: Store, projectId: string): Promise<TaskRecord | undefined> {
  const recorded = await store.kvGet(CEO_KEY(projectId));
  if (recorded && !recorded.startsWith('creating:')) {
    const task = await store.getTask(recorded);
    if (live(task) && task.projectId === projectId) return task;
  }
  const raw = await store.kvGet(AUTONOMY_KEY(projectId));
  let autonomy: ProjectAutonomy | undefined;
  try { autonomy = raw ? JSON.parse(raw) as ProjectAutonomy : undefined; } catch { autonomy = undefined; }
  const legacy = autonomy?.coordinatorTaskId ? await store.getTask(autonomy.coordinatorTaskId) : undefined;
  if (!live(legacy) || legacy.projectId !== projectId) return undefined;
  if (legacy.title === LEGACY_CEO_PROJECT_NAME) {
    const project = await store.getProject(projectId);
    const title = ceoTitle(project?.coordinator ? 'organization' : 'project');
    await store.setTaskTitle(legacy.id, title);
    legacy.title = title;
  }
  await store.kvSet(CEO_KEY(projectId), legacy.id);
  return legacy;
}

/** Whether the CEO is still the draft the platform made: nobody has written to
 * it or started it, so whoever starts it decides what it is told and with whose
 * authority. */
export function untouchedCeoDraft(task: TaskRecord): boolean {
  const authorization = task.params?._authorization as { principal?: string } | undefined;
  return !!task.params?.draft && !String(task.params?.prompt ?? '').trim() && authorization?.principal === CEO_PRINCIPAL;
}

/** The project's CEO, made now as a draft if it has none. `createdBy` is whom
 * it is for (default: the organization's owner), who hears when it fails. */
export async function ensureCeo(deps: CeoDeps, projectId: string, options: { createdBy?: PrincipalRef } = {}): Promise<TaskRecord> {
  const { store } = deps;
  const deadline = Date.now() + CLAIM_WAIT_MS;
  for (;;) {
    const existing = await projectCeo(store, projectId);
    if (existing) return existing;
    const key = CEO_KEY(projectId);
    const current = await store.kvGet(key);
    const claim = `creating:${Date.now()}`;
    const claimed = current === undefined ? await store.kvClaim(key, claim)
      // A dead CEO, or a claim a crash left behind, is replaced.
      : (!current.startsWith('creating:') || Date.now() - Number(current.slice(9)) > CLAIM_STALE_MS)
        && await store.kvCompareAndSet(key, current, claim);
    if (claimed) {
      try {
        const task = await createCeoDraft(deps, projectId, options.createdBy);
        await store.kvSet(key, task.id);
        return task;
      } catch (error) {
        await store.kvCompareAndSet(key, claim, undefined);
        throw error;
      }
    }
    // Someone else is making it.
    if (Date.now() > deadline) throw new Error(`the CEO of ${projectId} is still being made; try again`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function createCeoDraft(deps: CeoDeps, projectId: string, createdBy?: PrincipalRef): Promise<TaskRecord> {
  const { api, store, tokens } = deps;
  const project = await store.getProject(projectId);
  if (!project) throw new NotFoundError(`no project ${projectId}`);
  const organizationId = project.organizationId ?? 'org_personal';
  const scope = ceoScopeOf(project);
  const owner = createdBy ?? await organizationOwner(store, organizationId);
  // The platform makes the draft and can grant it nothing: it asks for its
  // authority, granted only by whoever starts it (queueStoredTask).
  // Organization-scoped, as asking for organization-wide authority must be.
  const { token } = await tokens.mintPrincipal(CEO_PRINCIPAL, ['task:create', 'task:read', 'project:read'],
    scope === 'organization' ? undefined : projectId, 10 * 60_000, organizationId);
  try {
    return await api.createTask(token, { projectId, draft: true, allowAttenuation: true, title: ceoTitle(scope), prompt: '',
      authorization: ceoAuthorization(scope, projectId), credentialGrants: CEO_CREDENTIAL_GRANTS,
      params: { coordinator: { wakeHours: DEFAULT_COORDINATOR_WAKE_HOURS } }, ...(owner ? { createdBy: owner } : {}) });
  } finally {
    await tokens.revoke(token);
  }
}

async function organizationOwner(store: Store, organizationId: string): Promise<PrincipalRef | undefined> {
  const owner = (await store.listOrganizationMemberships(organizationId)).find((membership) => membership.role === 'owner');
  return owner ? { kind: 'user', userId: owner.userId } : undefined;
}

/** Boot: every organization has its CEO project, and every project its CEO.
 * One that fails is logged and tried again at the next boot or when needed. */
export async function ensureEveryCeo(deps: CeoDeps, log: (message: string) => void = console.warn): Promise<void> {
  for (const organization of await deps.store.listOrganizations()) {
    await deps.store.ensureOrganizationCoordinatorProject(organization.id).catch((error) =>
      log(`  • Could not give ${organization.id} its CEO project: ${error instanceof Error ? error.message : String(error)}`));
  }
  for (const project of await deps.store.listProjects()) {
    await ensureCeo(deps, project.id).catch((error) =>
      log(`  • Could not give ${project.id} its CEO: ${error instanceof Error ? error.message : String(error)}`));
  }
}
