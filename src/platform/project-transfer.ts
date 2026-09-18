import crypto from 'node:crypto';
import { Store, deleteRows, slugify } from '../store/db.js';
import { ProjectEnvironment } from '../store/project-environment.js';
import type { Project } from '../domain/types.js';

export class ProjectTransferError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export interface TransferBlocker { code: string; message: string }
interface TransferPlan {
  project: Project;
  destinationOrganizationId: string;
  owners: string[];
  repositories: Array<{ from: string; to: string }>;
  blockers: TransferBlocker[];
  taskCount: number;
  fingerprint: string;
}
interface SavedPreview {
  id: string; principal: string; projectId: string; sourceOrganizationId: string;
  destinationOrganizationId: string; fingerprint: string; expiresAt: number; result?: Project;
}
export const transferLockKey = (projectId: string) => `project-transfer-lock:${projectId}`;
export const transferredTaskKey = (taskId: string) => `project-transfer-history:${taskId}`;

/** Transfer is deliberately a metadata transaction. External resources that
 * need data-plane migration are blockers, never silently detached or re-owned.
 * The execution fence covers the asynchronous Temporal liveness check; the
 * fingerprint is revalidated inside the final transaction. */
export class ProjectTransfers {
  constructor(private store: Store, private actor: {
    principal: string;
    authorize: (capability: string, organizationId: string) => void;
    workflowClosed: (taskId: string) => Promise<boolean>;
  }) {}

  private authorize(source: string, destination: string) {
    this.actor.authorize('project:transfer-out', source);
    this.actor.authorize('project:transfer-in', destination);
  }

  private plan(projectId: string, destinationOrganizationId: string): TransferPlan {
    const s = this.store;
    const project = s.getProject(projectId);
    if (!project) throw new ProjectTransferError('Project not found.', 404);
    this.authorize(project.organizationId!, destinationOrganizationId);
    const destination = s.getOrganization(destinationOrganizationId);
    if (!destination) throw new ProjectTransferError('Destination organization not found.', 404);
    if (project.organizationId === destinationOrganizationId) throw new ProjectTransferError('Choose a different organization.', 400);
    const blockers: TransferBlocker[] = [];
    const block = (code: string, message: string, condition: unknown) => { if (condition) blockers.push({ code, message }); };
    const rows = (table: string) => s.db.prepare(`SELECT * FROM ${table} WHERE projectId=?`).all(projectId) as any[];
    const tasks = (s.db.prepare('SELECT id FROM tasks WHERE projectId=? ORDER BY id').all(projectId) as any[]).map(r => s.getTask(r.id)!);
    const environmentBuilds = new ProjectEnvironment(s).builds(projectId);
    block('environment-builds', 'Finish environment builds, or recover abandoned builds in Project settings → Environment, before moving.', environmentBuilds.some(b => b.status === 'building'));
    const owners = s.listOrganizationMemberships(destinationOrganizationId).filter(m => m.role === 'owner').map(m => m.userId).sort();
    block('owner', 'The destination needs an organization owner.', !owners.length);
    block('name-conflict', 'A project with this name already exists in the destination. Rename this project first.',
      s.listProjects().some(p => p.organizationId === destinationOrganizationId && slugify(p.name) === slugify(project.name)));
    block('active-tasks', 'Finish or cancel active tasks and disarm scheduled tasks before moving.', tasks.some(t =>
      t.params.triggerState === 'armed' || t.params.repeatable && !t.params.draft ||
      (!t.params.draft || t.lastView) && !['done', 'cancelled', 'failed'].includes(t.lastView?.status ?? '')));
    block('worlds', 'Release retained task worlds before moving. Worlds cannot move between organizations.', s.projectResources(projectId).worlds.length);
    block('worlds', 'Release task worlds before moving; a historical world has not been recorded as released.',
      tasks.some(t => (t.lastView?.world || t.lastView?.worldPath)
        && !s.db.prepare("SELECT 1 FROM world_instances WHERE worldId=? AND state='released'").get(t.id)));
    block('checkpoints', 'This project has retained world checkpoints that require a storage migration.', rows('world_checkpoints').length);
    block('resources', 'This project has data, secret, or service attachments that require a separate migration.', rows('resource_attachments').length);
    block('avatars', 'Remove project Avatars before moving; their delegated authority belongs to the source organization.', rows('avatars').some(r => !r.deletedAt));
    block('executions', 'Stop running terminals, previews, and other executions before moving.', rows('executions').some(r => !r.endedAt));
    block('leases', 'Wait for compute and usage reservations to be released.',
      rows('world_leases').some(r => r.state !== 'released') || rows('usage_admissions').some(r => r.state === 'active'));
    block('previews', 'Revoke live preview links before moving.', rows('preview_leases').some(r => !r.revokedAt && r.expiresAt > Date.now()));
    block('cards', 'Remove project payment cards before moving.', s.db.prepare('SELECT 1 FROM cards WHERE scopeId=?').get(projectId));
    block('spending', 'Resolve pending spending requests before moving.', rows('payment_spend_requests').some(r => ['authorized', 'pending_approval', 'needs_funding'].includes(r.status)));
    block('deletion', 'Wait for deletion to finish before moving this project.',
      s.kvGet(`organization-deleting:${project.organizationId}`) || s.kvGet(`organization-deleting:${destinationOrganizationId}`)
      || JSON.parse(s.kvGet(transferLockKey(projectId)) ?? '{}').kind === 'delete');
    const taskIds = new Set(tasks.map(t => t.id));
    block('collaboration', 'Finish or cancel pending collaboration requests before moving.',
      (s.db.prepare("SELECT requesterTaskId, targetTaskId FROM collaboration_requests WHERE status='pending'").all() as any[])
        .some(r => taskIds.has(r.requesterTaskId) || taskIds.has(r.targetTaskId)));
    const services = JSON.parse(s.kvGet(`project-services:${projectId}`) ?? '[]');
    block('services', 'Remove or migrate project services before moving.', services.length);
    // Source repository credentials never cross the boundary. An existing
    // destination catalogue entry is the same authority used by Attach repository.
    const destinationRepos = s.listRepositories(destinationOrganizationId);
    const linked = s.listProjectRepositories(projectId);
    const wiki = s.projectWiki(projectId);
    const sourceRepos = [...linked.map(r => r.repository), ...(wiki?.repository ? [wiki.repository] : [])];
    const repositories: TransferPlan['repositories'] = [];
    for (const repo of sourceRepos) {
      const target = destinationRepos.find(r => r.provider === repo.provider && r.owner === repo.owner && r.name === repo.name
        && (!repo.providerId || r.providerId === repo.providerId));
      const connection = target?.gitConnectionId ? s.getGitConnection(target.gitConnectionId) : undefined;
      if (!target || target.gitConnectionId && (!connection || connection.suspendedAt)) {
        block('repository', `Connect ${repo.owner}/${repo.name} in the destination organization first.`, true);
      } else if (!repositories.some(r => r.from === repo.id)) repositories.push({ from: repo.id, to: target.id });
    }
    block('unmanaged-repositories', 'Attach configured repositories through the repository catalog before moving.',
      project.config.repos?.some(repo => !sourceRepos.some(r => r.sshUrl === repo)));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      project, destination, environmentBuilds, generation: s.kvGet(`project-transfer-current:${projectId}`), owners, tasks, repositories, destinationRepos, linked, wiki,
      memberships: s.listProjectMemberships(projectId),
      profiles: s.db.prepare('SELECT * FROM authorization_profiles WHERE scopeKey=?').all(`project:${projectId}`),
      grants: s.db.prepare('SELECT * FROM principal_grants WHERE scopeKey=?').all(`project:${projectId}`),
      settings: s.db.prepare('SELECT * FROM settings WHERE scopeKey IN (?, ?, ?)').all(projectId, `quick:${projectId}`, `organization:${destinationOrganizationId}`),
      executionPolicy: s.getOrganizationExecutionPolicy(destinationOrganizationId),
      identityPolicies: [s.getOrganizationIdentityPolicy(project.organizationId!), s.getOrganizationIdentityPolicy(destinationOrganizationId)],
      projectProfiles: s.listProfiles().filter(p => p.id.startsWith(`${projectId}::`)),
      environment: s.kvGet(`project-environment:${projectId}`),
      policies: [s.kvGet(`credpolicy:project:${projectId}`), s.kvGet(`conversation-sharing:project:${projectId}`)],

      blockers,
    })).digest('hex');
    return { project, destinationOrganizationId, owners, repositories, blockers, taskCount: tasks.length, fingerprint };
  }

  preview(projectId: string, destinationOrganizationId: string) {
    const plan = this.plan(projectId, destinationOrganizationId);
    // Previews contain no secret material. Expire abandoned previews and bounded
    // retry receipts without growing the key/value store indefinitely.
    for (const entry of this.store.kvEntries('project-transfer:')) {
      const prior = JSON.parse(entry.value) as SavedPreview;
      if (prior.expiresAt < Date.now()) this.store.kvDelete(entry.key);
    }
    const preview: SavedPreview = { id: crypto.randomUUID(), principal: this.actor.principal, projectId,
      sourceOrganizationId: plan.project.organizationId!, destinationOrganizationId, fingerprint: plan.fingerprint, expiresAt: Date.now() + 10 * 60_000 };
    this.store.kvSet(`project-transfer:${preview.id}`, JSON.stringify(preview));
    return { id: preview.id, projectId, destinationOrganizationId, blockers: plan.blockers, taskCount: plan.taskCount,
      ownerUserIds: plan.owners, expiresAt: preview.expiresAt,
      changes: [
        'Project identity, tasks, conversations, wiki, and files are preserved.',
        'Existing project access is replaced by destination organization owners. Add other members after moving.',
        'The project moves to the destination’s top level. Task defaults and compute settings inherit from the destination.',
        'Credentials, connections, payment authority, and public conversation links do not carry over.',
        'Completed tasks remain readable history; start new tasks for further work. Drafts need new authorization; unavailable creators are replaced by destination owners for decisions.',
      ] };
  }

  async move(projectId: string, destinationOrganizationId: string, previewId: string): Promise<Project> {
    const s = this.store;
    const raw = s.kvGet(`project-transfer:${previewId}`);
    const preview: SavedPreview | undefined = raw ? JSON.parse(raw) : undefined;
    if (!preview || preview.principal !== this.actor.principal || preview.projectId !== projectId
      || preview.destinationOrganizationId !== destinationOrganizationId) throw new ProjectTransferError('Create a new transfer preview.');
    this.authorize(preview.sourceOrganizationId, destinationOrganizationId);
    if (preview.result) {
      if (s.getProject(projectId)?.organizationId !== destinationOrganizationId || s.kvGet(`project-transfer-current:${projectId}`) !== previewId) throw new ProjectTransferError('Project has moved again. Create a new preview.');
      return preview.result;
    }
    if (preview.expiresAt < Date.now()) throw new ProjectTransferError('The preview expired. Preview the move again.');
    const lockKey = transferLockKey(projectId);
    const lock = JSON.stringify({ id: previewId, expiresAt: Date.now() + 120_000 });
    s.db.exec('BEGIN IMMEDIATE');
    try {
      // PostgreSQL needs an explicit row lock; SQLite BEGIN IMMEDIATE already
      // serializes writers. No transaction is held over network I/O.
      if (s.db.dialect === 'postgres') s.db.prepare('SELECT id FROM projects WHERE id=? FOR UPDATE').get(projectId);
      const existing = s.kvGet(lockKey);
      if (existing && JSON.parse(existing).expiresAt > Date.now()) throw new ProjectTransferError('A move is already in progress.');
      this.validate(preview);
      s.kvSet(lockKey, lock);
      s.db.exec('COMMIT');
    } catch (error) { s.db.exec('ROLLBACK'); throw error; }
    try {
      const tasks = (s.db.prepare('SELECT id FROM tasks WHERE projectId=?').all(projectId) as Array<{ id: string }>).map(r => s.getTask(r.id)!);
      for (const task of tasks) {
        if (!(await this.actor.workflowClosed(task.id))) throw new ProjectTransferError('A task workflow is still running. Wait for it to finish, then retry.');
        if (Date.now() > JSON.parse(lock).expiresAt) throw new ProjectTransferError('Checking task workflows timed out. Retry the move.');
      }
      s.db.exec('BEGIN IMMEDIATE');
      try {
        if (s.db.dialect === 'postgres') {
          // Moves are rare administration operations. Briefly serialize project
          // writes so slug validation also excludes concurrent create/rename.
          s.db.exec('LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE');
          for (const org of [preview.sourceOrganizationId, destinationOrganizationId].sort())
            s.db.prepare('SELECT id FROM organizations WHERE id=? FOR UPDATE').get(org);
          s.db.prepare('SELECT id FROM projects WHERE id=? FOR UPDATE').get(projectId);
        }
        if (s.kvGet(lockKey) !== lock) throw new ProjectTransferError('The transfer lease changed. Preview the move again.');
        const plan = this.validate(preview);
        this.commit(plan);
        const result = s.getProject(projectId)!;
        s.kvSet(`project-transfer:${previewId}`, JSON.stringify({ ...preview, result, expiresAt: Date.now() + 24 * 60 * 60_000 }));
        s.kvSet(`project-transfer-current:${projectId}`, previewId);
        s.kvDelete(lockKey);
        s.db.exec('COMMIT');
        return result;
      } catch (error) { s.db.exec('ROLLBACK'); throw error; }
    } finally {
      s.db.prepare('DELETE FROM kv WHERE k=? AND v=?').run(lockKey, lock);
    }
  }

  private validate(preview: SavedPreview) {
    this.authorize(preview.sourceOrganizationId, preview.destinationOrganizationId);
    const plan = this.plan(preview.projectId, preview.destinationOrganizationId);
    if (plan.blockers.length) throw new ProjectTransferError(plan.blockers.map(b => b.message).join(' '));
    if (plan.fingerprint !== preview.fingerprint) throw new ProjectTransferError('The project or destination changed. Preview the move again.');
    return plan;
  }

  private commit(plan: TransferPlan) {
    const s = this.store, id = plan.project.id, destination = plan.destinationOrganizationId;
    const taskIds = (s.db.prepare('SELECT id FROM tasks WHERE projectId=?').all(id) as any[]).map(r => String(r.id));
    s.revokeScopedTokens({ projectId: id });
    s.revokeHumanDelegations({ projectId: id });
    for (const taskId of taskIds) {
      s.revokeHumanDelegations({ taskId });
      const task = s.getTask(taskId)!;
      if (!task.params.draft || task.params._workflowRunId || task.lastView)
        s.kvSet(transferredTaskKey(taskId), plan.project.organizationId!);
      if (task.lastView) {
        const { world, worldPath, worldAvailable, worldDesktop, worldProvider, ...history } = task.lastView;
        s.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ ...history, actions: [], stageTransitions: [] }), taskId);
      }
      const { _authorization, _githubAccountId, profiles, ...params } = task.params;
      if (task.params.draft) {
        for (const key of Object.keys(params)) if (key.startsWith('agent:') || ['confirm', 'confirmer', 'responder', 'confirmation', 'gitProfile', 'runnerPoolId', 'environment', 'worldProvider', 'copyGlobs'].includes(key))
          delete params[key];
        // Creator identity is historical provenance, not permission. If that
        // person is absent from the receiving org, route new draft decisions
        // to its owners instead of leaving @creator as an unanswerable gate.
        if (task.createdBy?.kind !== 'user' || !s.organizationMembership(destination, task.createdBy.userId)) {
          params.confirm = { layers: [{ kind: 'human', audience: ['@owners'] }] };
          params.responder = { kind: 'human', audience: ['@owners'] };
        }
        s.db.prepare('UPDATE task_intents SET confirmer=NULL WHERE id=?').run(task.intentId);
      }
      s.updateTaskParams(taskId, { ...params, _authorization: {
        profileId: 'developer', level: 'developer', scope: 'projects', projectIds: [id], organizationId: destination,
        capabilities: [], principal: 'system:project-transfer', profileAttenuated: true, attenuationAccepted: false,
      } });
      for (const key of [`vault:grant:${taskId}`, `vault:pass:${taskId}`, `vault:task-policy:${taskId}`, `credpolicy:task:${taskId}`, `permission:grant:${taskId}`]) s.kvDelete(key);
      for (const share of s.kvEntries(`conversation-share-index:${taskId}:`).filter(e => e.key.startsWith(`conversation-share-index:${taskId}:`))) {
        s.kvDelete(`conversation-share:${share.value}`); s.kvDelete(share.key);
      }
    }
    // Cancel outstanding grants and remove app sharing; keeping these keyed by
    // stable task/project IDs would resurrect source authority on a later move.
    const movedTasks = new Set(taskIds);
    for (const prefix of ['vault:requests:', 'permission:requests:', 'authorization:requests:']) {
      const key = prefix + plan.project.organizationId;
      const requests = JSON.parse(s.kvGet(key) ?? '[]');
      s.kvSet(key, JSON.stringify(requests.filter((r: any) => !movedTasks.has(r.taskId)
        && !movedTasks.has(r.target?.taskId) && r.projectId !== id)));
    }
    for (const entry of s.kvEntries('service-connection:')) {
      const connection = JSON.parse(entry.value);
      if (connection.organizationId !== plan.project.organizationId) continue;
      if (connection.projectIds?.includes(id)) {
        connection.projectIds = connection.projectIds.filter((projectId: string) => projectId !== id);
        s.kvSet(entry.key, JSON.stringify(connection));
      }
    }
    const inboxIds = (s.db.prepare('SELECT id FROM inbox WHERE taskId IN (SELECT id FROM tasks WHERE projectId=?)').all(id) as any[]).map(r => String(r.id));
    inboxIds.push(...(s.db.prepare("SELECT id FROM inbox WHERE json_extract(subject, '$.projectId')=?").all(id) as any[]).map(r => String(r.id)));
    deleteRows(s.db, 'delivery_outbox', 'inboxId', inboxIds);
    deleteRows(s.db, 'inbox', 'id', inboxIds);
    deleteRows(s.db, 'world_instances', 'worldId', taskIds);
    deleteRows(s.db, 'task_subscribers', 'taskId', taskIds);
    deleteRows(s.db, 'task_confirmation', 'taskId', taskIds);
    deleteRows(s.db, 'confirmation_votes', 'taskId', taskIds);
    s.db.prepare('UPDATE tasks SET assignee=NULL, delegate=NULL, confirmationPolicy=NULL WHERE projectId=?').run(id);
    s.db.prepare('DELETE FROM project_memberships WHERE projectId=?').run(id);
    s.db.prepare('DELETE FROM principal_grants WHERE scopeKey=?').run(`project:${id}`);
    s.db.prepare('DELETE FROM authorization_profiles WHERE scopeKey=?').run(`project:${id}`);
    const teamIds = (s.db.prepare('SELECT id FROM teams WHERE projectId=?').all(id) as any[]).map(r => String(r.id));
    deleteRows(s.db, 'team_memberships', 'teamId', teamIds);
    deleteRows(s.db, 'team_aliases', 'teamId', teamIds);
    deleteRows(s.db, 'teams', 'id', teamIds);
    s.db.prepare('DELETE FROM settings WHERE scopeKey IN (?, ?)').run(id, `quick:${id}`);
    const profilePrefix = `${id}::`;
    s.db.prepare('DELETE FROM profiles WHERE substr(id, 1, length(?))=?').run(profilePrefix, profilePrefix);
    for (const key of [`authz:default:project:${id}`, `credpolicy:project:${id}`, `project-environment-builds:${id}`, `avatars:project:${id}`]) s.kvDelete(key);
    for (const entry of s.kvEntries(`wfpin:${id}:`).filter(e => e.key.startsWith(`wfpin:${id}:`))) s.kvDelete(entry.key);
    s.kvSet(`conversation-sharing:project:${id}`, 'disabled');
    // Retain only portable code/branch policy. Compute and profile selectors are
    // organization-owned; the preview explicitly describes their reset.
    const { repos, defaultBase, defaultTarget, remote, landingAuthority, multiPr } = plan.project.config;
    const config = { repos, defaultBase, defaultTarget, remote, landingAuthority, multiPr };
    const order = Number((s.db.prepare('SELECT COALESCE(MAX(ord), -1)+1 n FROM projects WHERE organizationId=?').get(destination) as any).n);
    s.db.prepare('UPDATE projects SET organizationId=?, folder=NULL, ord=?, config=? WHERE id=?')
      .run(destination, order, JSON.stringify(config), id);
    for (const repo of plan.repositories) {
      s.db.prepare('UPDATE project_repositories SET repositoryId=? WHERE projectId=? AND repositoryId=?').run(repo.to, id, repo.from);
      s.db.prepare('UPDATE project_wikis SET repositoryId=?, updatedAt=? WHERE projectId=? AND repositoryId=?').run(repo.to, Date.now(), id, repo.from);
    }
    for (const owner of plan.owners) s.setProjectMembership(id, { kind: 'user', userId: owner }, 'owner');
    // Object keys are immutable, project-scoped managed artifacts. Their access
    // follows the project; billing and execution provenance stay in the source.
    s.db.prepare('UPDATE promoted_artifacts SET organizationId=? WHERE projectId=?').run(destination, id);
    for (const org of [plan.project.organizationId!, destination]) s.appendAudit({ principalId: this.actor.principal,
      action: 'project.transferred', scopeKey: `organization:${org}`, detail: { projectId: id,
        sourceOrganizationId: plan.project.organizationId, destinationOrganizationId: destination } });
  }
}
