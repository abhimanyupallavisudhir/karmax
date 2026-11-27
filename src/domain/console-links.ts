import { slug } from '../cli/refs.js';

/**
 * Where the console shows a task, a project or an organization (web/app.js
 * parseRoute is the reader): `/<org>/<project>/tasks/<n>`. One builder for
 * every message that links into the console — agents' prompts, push
 * notifications, chat replies — so they all agree with the router.
 */
export interface LinkOrganization { name: string; slug?: string }
export interface LinkProject { name: string }
export interface LinkTask { id: string; num?: number }

/** The console's address: the installation's public URL, else the gateway's; '' leaves paths relative. */
export function consoleOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return (env.KARMAX_PUBLIC_URL?.trim() || env.KARMAX_GATEWAY_URL?.trim() || '').replace(/\/+$/, '');
}

export function organizationPath(organization: LinkOrganization): string {
  return `/${encodeURIComponent(organization.slug || slug(organization.name))}`;
}

/** A project without an organization keeps the pre-organization form the router still reads. */
export function projectPath(project: LinkProject, organization?: LinkOrganization): string {
  const name = encodeURIComponent(slug(project.name));
  return organization ? `${organizationPath(organization)}/${name}` : `/projects/${name}`;
}

export function taskPath(task: LinkTask, project: LinkProject, organization?: LinkOrganization): string {
  return `${projectPath(project, organization)}/tasks/${task.num ?? encodeURIComponent(task.id)}`;
}
