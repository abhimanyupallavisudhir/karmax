import type { Api } from './api.js';
import { CliError, EXIT } from './util.js';

export interface Project { id: string; name: string; organizationId?: string }
export interface Organization { id: string; name: string; slug?: string }
export interface Target { project: Project; organization?: Organization; taskId?: string; taskNumber?: number; server?: string }

/** The same slug the console puts in URLs (web/app.js `slugify`). */
export function slug(value: string): string {
  return String(value || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}

export interface ParsedRef { server?: string; organization?: string; project?: string; task?: string }

/**
 * `acme/site`, `acme/site#123`, `site#123`, `#123` (in a workspace), a task
 * or project id, or any console URL (`https://tavya.io/acme/site/tasks/123`).
 */
export function parseRef(ref: string): ParsedRef {
  const value = ref.trim();
  if (/^https?:\/\//.test(value)) {
    const url = new URL(value);
    const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    const at = segments.indexOf('tasks');
    const head = at >= 0 ? segments.slice(0, at) : segments.slice(0, 2);
    const task = at >= 0 ? segments[at + 1] : undefined;
    if (head[0] === 'projects') return { server: url.origin, project: head[1], ...(task ? { task } : {}) };
    return { server: url.origin, organization: head[0], project: head[1], ...(task ? { task } : {}) };
  }
  const [path, task] = value.split('#') as [string, string | undefined];
  if (/^task[_-]/.test(path)) return { task: path };
  const parts = path.split('/').filter(Boolean);
  const parsed: ParsedRef = parts.length >= 2 ? { organization: parts[0], project: parts.slice(1).join('/') }
    : parts.length === 1 ? (/^\d+$/.test(parts[0]!) && task === undefined ? { task: parts[0] } : { project: parts[0] }) : {};
  return task ? { ...parsed, task } : parsed;
}

export async function resolveTarget(api: Api, ref: string, fallbackProjectId?: string): Promise<Target> {
  const parsed = parseRef(ref);
  if (parsed.task && /^task[_-]/.test(parsed.task) && !parsed.project) {
    const task = await api.get<{ id: string; projectId: string; num?: number }>(`/api/tasks/${encodeURIComponent(parsed.task)}`);
    const project = await api.get<Project>(`/api/projects/${encodeURIComponent(task.projectId)}`);
    return { project, taskId: task.id, ...(task.num != null ? { taskNumber: task.num } : {}) };
  }
  let project: Project | undefined;
  let organization: Organization | undefined;
  if (parsed.project) {
    if (/^proj[_-]/.test(parsed.project)) project = await api.get<Project>(`/api/projects/${encodeURIComponent(parsed.project)}`);
    else {
      // A login limited to projects cannot list organizations; its project list is then the whole scope.
      const [organizations, projects] = await Promise.all([api.get<Organization[]>('/api/organizations').catch(() => undefined), api.get<Project[]>('/api/projects')]);
      const orgMatches = parsed.organization && organizations
        ? organizations.filter((entry) => (entry.slug ?? slug(entry.name)) === parsed.organization || entry.id === parsed.organization)
        : organizations ?? [];
      if (parsed.organization && organizations && !orgMatches.length) throw new CliError(`no organization "${parsed.organization}" that you can access`, EXIT.notFound);
      const allowed = new Set(orgMatches.map((entry) => entry.id));
      const matches = projects.filter((entry) => (!parsed.organization || !organizations || allowed.has(entry.organizationId ?? 'org_personal'))
        && (slug(entry.name) === slug(parsed.project!) || entry.id === parsed.project));
      if (!matches.length) throw new CliError(`no project "${parsed.organization ? `${parsed.organization}/` : ''}${parsed.project}" that you can access`, EXIT.notFound);
      if (matches.length > 1) throw new CliError(`"${parsed.project}" names ${matches.length} projects; say which organization: ${matches
        .map((entry) => `${orgSlug(organizations?.find((o) => o.id === entry.organizationId))}/${slug(entry.name)}`).join(', ')}`, EXIT.usage);
      project = matches[0]!;
      organization = organizations?.find((entry) => entry.id === project!.organizationId);
    }
  } else if (fallbackProjectId) project = await api.get<Project>(`/api/projects/${encodeURIComponent(fallbackProjectId)}`);
  else throw new CliError(`"${ref}" does not name a project; use <organization>/<project>[#<task>]`, EXIT.usage);
  if (!parsed.task) return { project, ...(organization ? { organization } : {}) };
  if (/^task[_-]/.test(parsed.task)) return { project, ...(organization ? { organization } : {}), taskId: parsed.task };
  const number = Number(parsed.task);
  if (!Number.isInteger(number) || number < 1) throw new CliError(`"${parsed.task}" is not a task number`, EXIT.usage);
  const task = await api.get<{ id: string }>(`/api/projects/${encodeURIComponent(project.id)}/tasks/by-num/${number}`);
  return { project, ...(organization ? { organization } : {}), taskId: task.id, taskNumber: number };
}

function orgSlug(organization: Organization | undefined): string {
  return organization ? organization.slug ?? slug(organization.name) : '?';
}
