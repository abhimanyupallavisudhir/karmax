import type { Store } from '../store/db.js';
import type { TokenAuthority } from './tokens.js';
import type { KarmaxApi } from './api.js';
import type { AuthorizationSelection, ConfirmLayer, ResponderConfig } from '../domain/types.js';
import { BRAND } from '../domain/brand.js';
import { COMMON_SETTINGS_WORKFLOW } from '../domain/shared-settings.js';
import { DEFAULT_COORDINATOR_WAKE_HOURS } from '../domain/coordinator.js';
import {
  AUTONOMY_KEY, AUTONOMY_WIKI_PATH, autonomyAvatarPrompt, autonomyResponderInstructions, autonomyReviewerInstructions,
  autonomyWikiPage, organizationCoordinatorPrompt, type AutonomyScope, type ProjectAutonomy,
} from '../domain/autonomous-projects.js';
import { CapabilityError, NotFoundError } from './errors.js';

/**
 * Make a project run itself (wiki features/autonomy). Everything goes through
 * the caller's own authority, as if they had filled in the forms: the Avatār
 * is a task they save as Avatār (refused, like any task, when they cannot grant
 * its authorization), the Task defaults are theirs to write, the wiki page is
 * written through the wiki API, and the co-ordinator is a draft they then run.
 *
 * - **Avatār** (draft, never run): a project's holds Project maintainer on this
 *   project and every vault credential; an organization's, Super-administrator
 *   of the organization (its forks may be Avatārs, so the projects its
 *   co-ordinator makes autonomous can have their own).
 * - **Task defaults:** the Responder and a single agent Review layer fork it.
 * - **Wiki:** a `default` page saying there is no human — in the project's
 *   wiki, or the organization's for an organization (skipped when the
 *   organization already has one).
 * - **Co-ordinator:** a permanent co-ordinator draft whose agent forks the Avatār.
 *
 * Idempotent: a project already set up returns what it has.
 */
export async function setUpAutonomy(
  deps: { api: KarmaxApi; store: Store; tokens: TokenAuthority },
  token: string,
  projectId: string,
  scope: AutonomyScope = 'project',
): Promise<ProjectAutonomy> {
  const { api, store, tokens } = deps;
  const project = await store.getProject(projectId);
  if (!project) throw new NotFoundError(`no project ${projectId}`);
  const organizationId = project.organizationId ?? 'org_personal';
  const allowed = await tokens.check(token, 'project:settings:write', { projectId, organizationId });
  if (!allowed.ok) throw new CapabilityError(allowed.reason ?? 'denied: project:settings:write');
  const existing = await projectAutonomy(store, projectId);
  if (existing) return existing;

  const authorization: AuthorizationSelection = scope === 'organization'
    ? { level: 'superadmin', scope: 'organization' }
    : { level: 'maintainer', scope: 'projects', projectIds: [projectId] };
  const created: string[] = [];
  const common = (await store.getSettings(projectId, COMMON_SETTINGS_WORKFLOW)) ?? {};
  let defaultsWritten = false;
  try {
    const avatar = await api.createTask(token, {
      projectId, draft: true, title: scope === 'organization' ? 'Organization Avatār' : 'Project Avatār',
      prompt: autonomyAvatarPrompt(scope), authorization, credentialGrants: ['use-credential:*'],
      params: { avatar: scope === 'organization'
        ? { callableBy: ['@superadmins'], forksMayBeAvatars: true }
        : { callableBy: ['@maintainers'] } },
    });
    created.push(avatar.id);
    const fork = { resumeFrom: { taskId: avatar.id, role: 'do' } };


    const coordinator = await api.createTask(token, {
      projectId, draft: true, title: 'Co-ordinator',
      prompt: scope === 'organization' ? organizationCoordinatorPrompt() : '',
      params: { coordinator: { wakeHours: DEFAULT_COORDINATOR_WAKE_HOURS }, 'agent:do': fork },
    });
    created.push(coordinator.id);

    const wikiPage = await writeAutonomyPage(api, token, scope, scope === 'organization' ? organizationId : projectId, organizationId);

    // Task defaults: nobody is asked. Other shared defaults stay as they were.
    const responder: ResponderConfig = { kind: 'agent', ...fork, prompt: autonomyResponderInstructions(scope) };
    const reviewer: ConfirmLayer = { kind: 'agent', ...fork, prompt: autonomyReviewerInstructions(scope) };
    await store.setSettings(projectId, COMMON_SETTINGS_WORKFLOW, { ...common, responder, confirm: { layers: [reviewer] } });
    defaultsWritten = true;
    const record: ProjectAutonomy = { scope, avatarTaskId: avatar.id, coordinatorTaskId: coordinator.id, wikiPage, at: Date.now() };
    await store.kvSet(AUTONOMY_KEY(projectId), JSON.stringify(record));
    return record;
  } catch (error) {
    // Nothing half made is left behind: the drafts go and the Task defaults are
    // as they were, so a retry starts clean.
    if (defaultsWritten) await store.setSettings(projectId, COMMON_SETTINGS_WORKFLOW, common).catch(() => undefined);
    for (const id of created.reverse()) await store.deleteTask(id).catch(() => undefined);
    throw error;
  }
}

/** The `default` page, unless one at its path is already delivered to this
 * project (an autonomous organization's covers all its projects). */
async function writeAutonomyPage(api: KarmaxApi, token: string, scope: AutonomyScope, id: string,
  organizationId: string): Promise<ProjectAutonomy['wikiPage']> {
  const wikiScope = scope === 'organization' ? 'organization' : 'project';
  if (wikiScope === 'project') {
    if (await hasPage(api, token, 'organization', organizationId)) return { scope: 'organization', path: AUTONOMY_WIKI_PATH };
  }
  if (!(await hasPage(api, token, wikiScope, id))) await api.saveWikiPageResolved(token, wikiScope, id,
    { path: AUTONOMY_WIKI_PATH, content: autonomyWikiPage(scope, BRAND), kind: 'skill', create: true });
  return { scope: wikiScope, path: AUTONOMY_WIKI_PATH };
}

async function hasPage(api: KarmaxApi, token: string, scope: 'project' | 'organization', id: string): Promise<boolean> {
  const read = await api.readWikiResolved(token, scope, id, AUTONOMY_WIKI_PATH).catch(() => undefined);
  return !!(read && 'page' in read && read.page);
}

/** What a project was set up with, while its Avatār and co-ordinator still exist. */
export async function projectAutonomy(store: Store, projectId: string): Promise<ProjectAutonomy | undefined> {
  const raw = await store.kvGet(AUTONOMY_KEY(projectId));
  if (!raw) return undefined;
  try {
    const record = JSON.parse(raw) as ProjectAutonomy;
    if (!(await store.getTask(record.avatarTaskId)) || !(await store.getTask(record.coordinatorTaskId))) return undefined;
    return record;
  } catch { return undefined; }
}
