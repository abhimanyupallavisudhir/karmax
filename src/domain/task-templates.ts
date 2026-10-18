import type { AuthorizationSelection, TaskTemplate } from './types.js';
import { ValidationError } from '../platform/errors.js';

/** What a template holds besides its name: a task form's contents. */
export type TaskTemplateContent = Pick<TaskTemplate, 'workflow' | 'params' | 'notes' | 'authorization'
  | 'credentialGrants' | 'credentialPolicies' | 'tags' | 'priority'>;

export const TEMPLATE_NAME_MAX = 120;

// Task state rather than form contents: lifecycle and dispatcher bookkeeping,
// and references that only mean something for the task they were made for
// (its attachments, its series).
const NOT_CONTENT = new Set(['draft', 'archived', 'triggerState', 'triggerLastFiredAt', 'triggerPending', 'runOf',
  'images', 'files', 'priority', 'title']);

export function templateName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) throw new ValidationError('a template needs a name');
  if (value.length > TEMPLATE_NAME_MAX) throw new ValidationError(`a template name is at most ${TEMPLATE_NAME_MAX} characters`);
  return value;
}

/** A task's params as a template keeps them: internal (`_…`) keys, task state
 *  and task-specific references (dependencies on other tasks, a forked agent
 *  session) dropped. Used both for what a form saves and what a task copies. */
export function templateParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (key.startsWith('_') || NOT_CONTENT.has(key) || value === undefined) continue;
    if (key === 'triggers') {
      const kept = Array.isArray(value) ? value.filter((trigger) => trigger && (trigger as { kind?: string }).kind !== 'dependency') : [];
      if (kept.length) out.triggers = kept;
      continue;
    }
    if (key.startsWith('agent:') && value && typeof value === 'object' && !Array.isArray(value) && 'resumeFrom' in value) {
      const { resumeFrom: _fork, ...agent } = value as Record<string, unknown>;
      out[key] = agent;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The task's own project is what a `projects` scope listing only it means
 *  in a template, so an organization's template travels to every project. */
export function templateAuthorization(selection: unknown, ownProjectId?: string): AuthorizationSelection | undefined {
  if (!selection || typeof selection !== 'object') return undefined;
  const { level, scope, projectIds } = selection as Partial<AuthorizationSelection> & { profileId?: string };
  const chosen = level || (selection as { profileId?: string }).profileId;
  if (typeof chosen !== 'string' || !chosen) return undefined;
  if (scope === 'organization' || scope === 'global') return { level: chosen, scope };
  const ids = [...new Set((Array.isArray(projectIds) ? projectIds : []).filter((id): id is string => typeof id === 'string' && !!id))];
  const own = ids.length === 0 || (ids.length === 1 && ids[0] === ownProjectId);
  return { level: chosen, scope: 'projects', ...(own ? {} : { projectIds: ids }) };
}

/** Validates and normalizes a template's contents from an API body. */
export function templateContent(input: Record<string, unknown>, ownProjectId?: string): TaskTemplateContent {
  const workflow = typeof input.workflow === 'string' && input.workflow ? input.workflow : 'software-dev';
  const params = templateParams(input.params);
  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes : undefined;
  const authorization = templateAuthorization(input.authorization, ownProjectId);
  const credentialGrants = Array.isArray(input.credentialGrants)
    ? [...new Set(input.credentialGrants.filter((grant): grant is string => typeof grant === 'string' && grant.startsWith('use-credential:')))]
    : undefined;
  const credentialPolicies = input.credentialPolicies && typeof input.credentialPolicies === 'object' && !Array.isArray(input.credentialPolicies)
    ? input.credentialPolicies as Record<string, unknown> : undefined;
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()).map((tag) => tag.trim()))]
    : undefined;
  const priority = Number.isInteger(input.priority) && (input.priority as number) > 0 && (input.priority as number) <= 4
    ? input.priority as number : undefined;
  return {
    workflow, params,
    ...(notes ? { notes } : {}),
    ...(authorization ? { authorization } : {}),
    ...(credentialGrants ? { credentialGrants } : {}),
    ...(credentialPolicies ? { credentialPolicies } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(priority ? { priority } : {}),
  };
}

/** Templates as a project offers them: its organization's and its own, in the
 *  order they were added (their numbers, after the Task defaults' 0). */
export function templateOrder(a: TaskTemplate, b: TaskTemplate): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}
