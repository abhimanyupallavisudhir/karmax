import type { Store } from '../store/db.js';
import type { TokenAuthority } from './tokens.js';
import type { KarmaxApi } from './api.js';
import type { AuthorizationSelection, FileRef, ImageRef, PrincipalRef, Project, TaskRecord } from '../domain/types.js';
import { AuthorizationRequests } from './authorization-requests.js';
import { parsePending, pendingMessagesKey } from './pending-messages.js';
import { AUTONOMY_KEY, type ProjectAutonomy } from '../domain/autonomous-projects.js';
import { CEO_KEY, ceoTitle, coordinatorRolePrompt, DEFAULT_COORDINATOR_WAKE_HOURS, LEGACY_CEO_PROJECT_NAME, readRolePromptMarker,
  refreshedRolePrompt, rolePromptHash, ROLE_PROMPT_PARAM, untouchedRolePrompt, COORDINATOR_ROLE_VERSION,
  type CeoScope, type CoordinatorRoleKind } from '../domain/coordinator.js';
import { taskUnstarted } from '../domain/triggers.js';
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

/** Whether the CEO is still the draft the platform made: its prompt is still
 * the role text (or, from before, empty), nobody has started it, asked to have
 * it started or left it a message, so whoever starts it decides with whose authority. */
export async function untouchedCeoDraft(store: Pick<Store, 'kvGet'>, task: TaskRecord): Promise<boolean> {
  const authorization = task.params?._authorization as { principal?: string } | undefined;
  return !!task.params?.draft && !task.params?._awaitingApproval && authorization?.principal === CEO_PRINCIPAL
    && (!String(task.params?.prompt ?? '').trim() || untouchedRolePrompt(task.params))
    && !parsePending(await store.kvGet(pendingMessagesKey(task.id))).length;
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
    // Its role is its prompt, shown and editable (wiki features/coordinator § Role prompt).
    return await api.createTask(token, { projectId, draft: true, allowAttenuation: true, title: ceoTitle(scope), prompt: coordinatorRolePrompt(scope),
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

/** Which role text a co-ordinator in this project starts with: the one its
 * prompt was marked with, else an organization's in the CEO project (an
 * autonomous organization's there, wiki features/autonomy), else a project's. */
export async function coordinatorRoleKind(store: Store, project: Pick<Project, 'id' | 'coordinator'>,
  params?: Record<string, unknown>): Promise<CoordinatorRoleKind> {
  const marked = readRolePromptMarker(params)?.kind;
  if (marked) return marked;
  if (!project.coordinator) return 'project';
  try {
    const raw = await store.kvGet(AUTONOMY_KEY(project.id));
    return raw && (JSON.parse(raw) as ProjectAutonomy).scope === 'organization' ? 'autonomous-organization' : 'organization';
  } catch { return 'organization'; }
}

/** Whether the task is its project's CEO (`ensureCeo`'s record), not a
 * co-ordinator someone made from the task form. */
async function isProjectCeo(store: Store, task: Pick<TaskRecord, 'id' | 'projectId'>): Promise<boolean> {
  return (await store.kvGet(CEO_KEY(task.projectId))) === task.id;
}

/** The kv record of the one-time migration below. */
export const ROLE_PROMPT_MIGRATION_KEY = 'migration:coordinator-role-prompt:v1';

/** Queue words as a person's first message to a task not started yet
 * (`KarmaxApi.keepMessageFromPerson`, the path an Ask takes). */
export type KeepMessage = (taskId: string, message: { text: string; images?: ImageRef[]; files?: FileRef[] },
  userId: string | undefined) => Promise<unknown>;

/** Who wrote into a CEO draft before the role was its prompt: the asker whose
 * Ask waits for approval (the old Ask wrote itself into the prompt, then asked),
 * else whom the CEO is for. Edits record no editor, so that is the fallback. */
async function writerOf(store: Store, task: { id: string; projectId: string; params: Record<string, unknown> }): Promise<string | undefined> {
  const awaiting = task.params?._awaitingApproval;
  if (typeof awaiting === 'string') {
    const organizationId = (await store.getProject(task.projectId))?.organizationId ?? 'org_personal';
    const request = (await new AuthorizationRequests(store, organizationId).requests({ taskId: task.id }))
      .find((candidate) => candidate.id === awaiting);
    if (request?.requestedBy.startsWith('user:')) return request.requestedBy.slice(5);
  }
  return store.taskCreatorUserId(task.id);
}

/**
 * Boot (wiki features/coordinator § Role prompt). Once: every co-ordinator from
 * before the role was its prompt gets it, keeping what it was told. A CEO draft
 * someone wrote in (nearly always Asks, which the old Ask wrote there) gets the
 * role as its prompt, untouched, and what was written — with its attachments —
 * becomes its first message, the writer's (`writerOf`), as an Ask is now. Any
 * other co-ordinator draft gets the role above its words, which stay its
 * creator's prompt as the form would do. One already started gets the role as
 * its shown prompt, marked `outsideConversation`: its conversation's first
 * message and its run keep what it started with, and its turns read the role
 * followed by that, as its brief used to say it (`coordinatorTurnPrompt`), so
 * it behaves the same. Every boot: a role prompt nobody edited takes the
 * current role text.
 */
export async function refreshCoordinatorPrompts(store: Store, options: { keepMessage: KeepMessage; log?: (message: string) => void }): Promise<{ migrated: number; refreshed: number }> {
  const { keepMessage, log = console.warn } = options;
  let migrated = 0, refreshed = 0;
  const migrate = !(await store.kvGet(ROLE_PROMPT_MIGRATION_KEY));
  const kinds = new Map<string, CoordinatorRoleKind>();
  const kindOf = async (projectId: string): Promise<CoordinatorRoleKind> => {
    if (!kinds.has(projectId)) {
      const project = await store.getProject(projectId);
      kinds.set(projectId, project ? await coordinatorRoleKind(store, project) : 'project');
    }
    return kinds.get(projectId)!;
  };
  for (const task of await store.coordinatorTasks()) {
    try {
      if (task.status === 'cancelled') continue;
      const marker = readRolePromptMarker(task.params);
      if (migrate && !marker) {
        const kind = await kindOf(task.projectId);
        const role = coordinatorRolePrompt(kind);
        const written = String(task.params.prompt ?? '').trim();
        const stamp = { kind, version: COORDINATOR_ROLE_VERSION, hash: rolePromptHash(role) };
        if (!taskUnstarted(task.params)) await store.patchTaskParams(task.id, { prompt: role, [ROLE_PROMPT_PARAM]: { ...stamp, outsideConversation: true } });
        else if (!written) await store.patchTaskParams(task.id, { prompt: role, [ROLE_PROMPT_PARAM]: stamp });
        else if (await isProjectCeo(store, task)) {
          // Queued first, so a failure leaves the words where they were.
          const images = (task.params.images as ImageRef[] | undefined) ?? [], files = (task.params.files as FileRef[] | undefined) ?? [];
          await keepMessage(task.id, { text: written, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) },
            await writerOf(store, task));
          await store.patchTaskParams(task.id, { prompt: role, [ROLE_PROMPT_PARAM]: stamp,
            ...(images.length ? { images: [] } : {}), ...(files.length ? { files: [] } : {}) });
        } else await store.patchTaskParams(task.id, { prompt: `${role}\n\n${written}` });
        migrated++;
        continue;
      }
      const next = refreshedRolePrompt(task.params);
      if (!next) continue;
      await store.patchTaskParams(task.id, { prompt: next.prompt, [ROLE_PROMPT_PARAM]: next.marker });
      refreshed++;
    } catch (error) {
      log(`  • Could not bring the role prompt of ${task.id} up to date: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (migrate) await store.kvSet(ROLE_PROMPT_MIGRATION_KEY, String(Date.now()));
  return { migrated, refreshed };
}
