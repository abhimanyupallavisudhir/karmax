import type { TaskRecord, ProjectPrincipalRef } from '../domain/types.js';

export interface AudienceQuery { sql: string; params: unknown[] }
type Read<T> = Generator<AudienceQuery, T, any[]>;
export type AudienceTask = Pick<TaskRecord, 'id' | 'projectId' | 'createdBy' | 'lastView' | 'confirmationPolicy'>;
function* rows(sql: string, params: unknown[]): Read<any[]> { return yield { sql, params }; }

/** One audience policy for both legacy synchronous callers and async read models.
 * The generator describes reads; its driver owns database I/O and request-local
 * caching. It never caches authorization decisions across requests. */
function* projectMembers(id: string): Read<any[]> {
  return yield* rows('SELECT principal, role FROM project_memberships WHERE projectId=? ORDER BY joinedAt', [id]);
}
function* organizationMembers(id: string): Read<any[]> {
  return yield* rows('SELECT userId, role FROM organization_memberships WHERE organizationId=? ORDER BY joinedAt', [id]);
}
function* expand(principal: ProjectPrincipalRef): Read<string[]> {
  if (principal.kind === 'user') return [principal.userId];
  if (principal.kind === 'team') return (yield* rows('SELECT userId FROM team_memberships WHERE teamId=? ORDER BY joinedAt', [principal.teamId])).map(row => row.userId);
  if (principal.kind === 'organization') return (yield* organizationMembers(principal.organizationId)).map(row => row.userId);
  return [];
}
function* taskMetadata(id: string): Read<AudienceTask | undefined> {
  const [row] = yield* rows('SELECT id, projectId, createdBy, lastView FROM tasks WHERE id=?', [id]);
  return row ? { ...row, createdBy: row.createdBy ? JSON.parse(row.createdBy) : undefined,
    lastView: row.lastView ? JSON.parse(row.lastView) : undefined } : undefined;
}

export function* humanAudience(taskOrId: AudienceTask | string, requested?: string[]): Read<string[]> {
  const task = typeof taskOrId === 'string' ? yield* taskMetadata(taskOrId) : taskOrId;
  if (!task) return [];
  const [project] = yield* rows("SELECT COALESCE(organizationId, 'org_personal') AS organizationId FROM projects WHERE id=?", [task.projectId]);
  if (!project?.organizationId) return [];
  const audience = requested?.length ? requested : task.lastView?.waitingFor?.audience?.length
    ? task.lastView.waitingFor.audience : ['@creator'];
  const users = new Set<string>();
  for (const selector of audience) {
    if (selector === '@creator') {
      const before = users.size;
      let candidate: AudienceTask | undefined = task;
      const visited = new Set<string>();
      while (candidate && !visited.has(candidate.id)) {
        visited.add(candidate.id);
        const creator: TaskRecord['createdBy'] = candidate.createdBy;
        if (creator?.kind === 'user') { users.add(creator.userId); break; }
        if (creator?.kind === 'avatar') {
          const [avatar] = yield* rows('SELECT json FROM avatars WHERE id=? AND deletedAt IS NULL', [creator.avatarId]);
          const ownerUserId = avatar ? JSON.parse(avatar.json).ownerUserId : undefined;
          if (ownerUserId) users.add(ownerUserId);
          break;
        }
        candidate = creator?.kind === 'task-agent' ? yield* taskMetadata(creator.taskId) : undefined;
      }
      if (users.size === before) for (const member of yield* organizationMembers(project.organizationId))
        if (member.role === 'owner') users.add(member.userId);
    } else if (selector === '@all' || selector === '@owners') {
      for (const member of yield* organizationMembers(project.organizationId))
        if (selector === '@all' || member.role === 'owner') users.add(member.userId);
    } else if (selector === '@project') {
      for (const member of yield* projectMembers(task.projectId))
        for (const user of yield* expand(JSON.parse(member.principal))) users.add(user);
    } else if (selector.startsWith('user:')) {
      const userId = selector.slice(5);
      if ((yield* organizationMembers(project.organizationId)).some(member => member.userId === userId)) users.add(userId);
    } else if (selector.startsWith('@team:')) {
      const params = [project.organizationId, selector.slice(6), task.projectId, task.projectId];
      let [team] = yield* rows(`SELECT id FROM teams WHERE organizationId=? AND slug=? AND (projectId=? OR projectId IS NULL)
        ORDER BY CASE WHEN projectId=? THEN 0 ELSE 1 END, createdAt LIMIT 1`, params);
      if (!team) [team] = yield* rows(`SELECT t.id FROM team_aliases a JOIN teams t ON t.id=a.teamId
        WHERE a.organizationId=? AND a.slug=? AND (a.projectId=? OR a.projectId IS NULL)
        ORDER BY CASE WHEN a.projectId=? THEN 0 ELSE 1 END, a.createdAt DESC LIMIT 1`, params);
      if (team) for (const user of yield* expand({ kind: 'team', teamId: team.id })) users.add(user);
    } else if (selector.startsWith('team:')) {
      const [team] = yield* rows('SELECT id, organizationId FROM teams WHERE id=?', [selector.slice(5)]);
      if (team?.organizationId === project.organizationId)
        for (const user of yield* expand({ kind: 'team', teamId: team.id })) users.add(user);
    }
  }
  return [...users];
}

export function* reviewAudience(task: AudienceTask): Read<string[]> {
  if (task.lastView?.waitingFor?.kind === 'human') return yield* humanAudience(task, task.lastView.waitingFor.audience);
  const users = new Set<string>();
  for (const target of task.confirmationPolicy?.targets ?? []) {
    if (target.kind === 'project-role') {
      for (const member of yield* projectMembers(target.projectId)) if (member.role === target.role)
        for (const user of yield* expand(JSON.parse(member.principal))) users.add(user);
    } else for (const user of yield* expand(target)) users.add(user);
  }
  if (!users.size) for (const member of yield* projectMembers(task.projectId)) {
    if (['owner', 'admin', 'reviewer'].includes(member.role))
      for (const user of yield* expand(JSON.parse(member.principal))) users.add(user);
  }
  return [...users];
}

export function runAudience<T>(program: Read<T>, query: (sql: string, params: unknown[]) => any[]): T {
  let step = program.next();
  while (!step.done) step = program.next(query(step.value.sql, step.value.params));
  return step.value;
}
export async function runAudienceAsync<T>(program: Read<T>, query: (sql: string, params: unknown[]) => Promise<any[]>): Promise<T> {
  let step = program.next();
  while (!step.done) step = program.next(await query(step.value.sql, step.value.params));
  return step.value;
}
