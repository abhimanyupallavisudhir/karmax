import type { Store } from '../store/db.js';
import type { TokenAuthority } from './tokens.js';
import type { KarmaxApi } from './api.js';
import type { AuthorizationSelection, ConfirmLayer, ResponderConfig } from '../domain/types.js';
import { BRAND } from '../domain/brand.js';
import { COMMON_SETTINGS_WORKFLOW } from '../domain/shared-settings.js';
import { DEFAULT_COORDINATOR_WAKE_HOURS } from '../domain/coordinator.js';
import {
  AUTONOMY_AVATAR_ROLES, AUTONOMY_DEFAULT_BUDGET, AUTONOMY_KEY, AUTONOMY_WIKI_PATH, type AutonomyBudget, autonomyAvatarPrompt, autonomyResponderInstructions, autonomyReviewerInstructions,
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
 * - **Avatār** (draft, never run): the judge. A project's holds Project
 *   maintainer on this project and every vault credential; an organization's,
 *   Super-administrator of the organization. Every task in the project may call
 *   it, only as Responder or Reviewer; requests it can decide are routed to it
 *   (permission, authorization and vault requests: `autonomyRoute`).
 * - **Task defaults:** the Responder and a single agent Review layer fork it;
 *   a $50 budget where none is set.
 * - **Wiki:** a `default` page saying there is no human — in the project's
 *   wiki, or the organization's for an organization (skipped when the
 *   organization already has one).
 * - **Co-ordinator:** a permanent co-ordinator draft holding the same authority.
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
  let budgetWritten: { scopeKey: string; previous: Record<string, unknown> } | undefined;
  const defaultBudget = async (...args: Parameters<typeof writeDefaultBudget>) => {
    const written = await writeDefaultBudget(...args);
    if (written) budgetWritten = written.undo;
    return written?.budget;
  };
  try {
    // The judge: everyone's tasks in the project may call it, but only to
    // answer and to review — never as an agent someone directs.
    const avatar = await api.createTask(token, {
      projectId, draft: true, title: scope === 'organization' ? 'Organization Avatār' : 'Project Avatār',
      prompt: autonomyAvatarPrompt(scope), authorization, credentialGrants: ['use-credential:*'],
      params: { avatar: { callableBy: ['@project'], roles: [...AUTONOMY_AVATAR_ROLES] } },
    });
    created.push(avatar.id);
    const fork = { resumeFrom: { taskId: avatar.id, role: 'do' } };
    const budgeted = await defaultBudget(store, tokens, token, projectId, organizationId, scope);


    // The co-ordinator holds the same authority itself, and its budget (the
    // default above) is the pool of everything it starts.
    const coordinator = await api.createTask(token, {
      projectId, draft: true, title: 'Co-ordinator',
      prompt: scope === 'organization' ? organizationCoordinatorPrompt() : '',
      authorization, credentialGrants: ['use-credential:*'],
      params: { coordinator: { wakeHours: DEFAULT_COORDINATOR_WAKE_HOURS } },
    });
    created.push(coordinator.id);

    const wikiPage = await writeAutonomyPage(api, token, scope, scope === 'organization' ? organizationId : projectId, organizationId);

    // Task defaults: nobody is asked. Other shared defaults stay as they were.
    const responder: ResponderConfig = { kind: 'agent', ...fork, prompt: autonomyResponderInstructions(scope) };
    const reviewer: ConfirmLayer = { kind: 'agent', ...fork, prompt: autonomyReviewerInstructions(scope) };
    await store.setSettings(projectId, COMMON_SETTINGS_WORKFLOW, { ...common, responder, confirm: { layers: [reviewer] } });
    defaultsWritten = true;
    const record: ProjectAutonomy = { scope, avatarTaskId: avatar.id, coordinatorTaskId: coordinator.id, wikiPage,
      ...(budgeted ? { budget: budgeted } : {}), at: Date.now() };
    await store.kvSet(AUTONOMY_KEY(projectId), JSON.stringify(record));
    return record;
  } catch (error) {
    if (budgetWritten) await store.setSettings(budgetWritten.scopeKey, 'payments', budgetWritten.previous).catch(() => undefined);
    // Nothing half made is left behind: the drafts go and the Task defaults are
    // as they were, so a retry starts clean.
    if (defaultsWritten) await store.setSettings(projectId, COMMON_SETTINGS_WORKFLOW, common).catch(() => undefined);
    for (const id of created.reverse()) await store.deleteTask(id).catch(() => undefined);
    throw error;
  }
}

/**
 * The default budget ($50) where none is set yet: the project's payment
 * defaults (an organization's: the organization's, for every project in it),
 * so the co-ordinator gets it, and with it the pool everything it starts
 * spends from (Store.paymentBudgetFamily). A budget someone already chose
 * stays. An organization's needs payment authority, as its Payments settings do.
 */
async function writeDefaultBudget(store: Store, tokens: TokenAuthority, token: string, projectId: string,
  organizationId: string, scope: AutonomyScope): Promise<{ budget: AutonomyBudget; undo: { scopeKey: string; previous: Record<string, unknown> } } | undefined> {
  const scopeKey = scope === 'organization' ? `organization:${organizationId}` : projectId;
  if (scope === 'organization' && !(await tokens.check(token, 'payment:write', { projectId, organizationId })).ok) return undefined;
  const previous = (await store.getSettings(scopeKey, 'payments')) ?? {};
  if (Object.hasOwn(previous, 'budget') || previous.allowance != null) return undefined;
  const budget: AutonomyBudget = { scope: scope === 'organization' ? 'organization' : 'project', ...AUTONOMY_DEFAULT_BUDGET };
  await store.setSettings(scopeKey, 'payments', { ...previous, budget: budget.amount, currency: budget.currency });
  return { budget, undo: { scopeKey, previous } };
}

/** The autonomous project's Avatār, as a request route (`avatar:<id>`), when it
 * is among those that may decide it. */
export async function autonomyRoute(store: Store, projectId: string, eligibleAvatarIds: string[]): Promise<string | undefined> {
  const autonomy = await projectAutonomy(store, projectId);
  return autonomy && eligibleAvatarIds.includes(autonomy.avatarTaskId) ? `avatar:${autonomy.avatarTaskId}` : undefined;
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
