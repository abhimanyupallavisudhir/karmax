import { map as mapAsync } from '../util/async-collections.js';
import crypto from 'node:crypto';
import { Store, deleteRows, slugify } from '../store/db.js';
import { ProjectEnvironment } from '../store/project-environment.js';
import type { Project } from '../domain/types.js';
import { PermissionRequests } from './permission-requests.js';

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
    authorize: (capability: string, organizationId: string) => void | Promise<void>;
    workflowClosed: (taskId: string) => Promise<boolean>;
  }) {}

  private async authorize(source: string, destination: string) {
    (await this.actor.authorize('project:transfer-out', source));
    (await this.actor.authorize('project:transfer-in', destination));
  }

  private async plan(projectId: string, destinationOrganizationId: string): Promise<TransferPlan> {
    const s = this.store;
    const project = (await s.getProject(projectId));
    if (!project) throw new ProjectTransferError('Project not found.', 404);
    (await this.authorize(project.organizationId!, destinationOrganizationId));
    const destination = (await s.getOrganization(destinationOrganizationId));
    if (!destination) throw new ProjectTransferError('Destination organization not found.', 404);
    if (project.organizationId === destinationOrganizationId) throw new ProjectTransferError('Choose a different organization.', 400);
    const blockers: TransferBlocker[] = [];
    const block = (code: string, message: string, condition: unknown) => { if (condition) blockers.push({ code, message }); };
    const rows = async (table: string) => (await s.db.prepare(`SELECT * FROM ${table} WHERE projectId=?`).all(projectId)) as any[];
    const tasks = await mapAsync((await s.db.prepare('SELECT id FROM tasks WHERE projectId=? ORDER BY id').all(projectId)) as any[], async r => (await s.getTask(r.id))!);
    const environmentBuilds = (await new ProjectEnvironment(s).builds(projectId));
    block('environment-builds', 'Finish environment builds, or recover abandoned builds in Project settings → Environment, before moving.', environmentBuilds.some(b => b.status === 'building'));
    const owners = (await s.listOrganizationMemberships(destinationOrganizationId)).filter(m => m.role === 'owner').map(m => m.userId).sort();
    block('owner', 'The destination needs an organization owner.', !owners.length);
    block('name-conflict', 'A project with this name already exists in the destination. Rename this project first.',
      (await s.listProjects()).some(p => p.organizationId === destinationOrganizationId && slugify(p.name) === slugify(project.name)));
    block('active-tasks', 'Finish or cancel active tasks and disarm scheduled tasks before moving.', tasks.some(t =>
      t.params.triggerState === 'armed' || t.params.repeatable && !t.params.draft ||
      (!t.params.draft || t.lastView) && !['done', 'cancelled', 'failed'].includes(t.lastView?.status ?? '')));
    block('worlds', 'Release retained task worlds before moving. Worlds cannot move between organizations.', (await s.projectResources(projectId)).worlds.length);
    block('worlds', 'Release task worlds before moving; a historical world has not been recorded as released.',
      (await mapAsync(tasks, async t => !!(t.lastView?.world || t.lastView?.worldPath)
        && !(await s.db.prepare("SELECT 1 FROM world_instances WHERE worldId=? AND state='released'").get(t.id)))).some(Boolean));
    block('checkpoints', 'This project has retained world checkpoints that require a storage migration.', (await rows('world_checkpoints')).length);
    block('resources', 'This project has data, secret, or service attachments that require a separate migration.', (await rows('resource_attachments')).length);
    block('avatars', 'Remove project Avatars before moving; their delegated authority belongs to the source organization.', (await rows('avatars')).some(r => !r.deletedAt));
    block('executions', 'Stop running terminals, previews, and other executions before moving.', (await rows('executions')).some(r => !r.endedAt));
    block('leases', 'Wait for compute and usage reservations to be released.',
      (await rows('world_leases')).some(r => r.state !== 'released') || (await rows('usage_admissions')).some(r => r.state === 'active'));
    block('previews', 'Revoke live preview links before moving.', (await rows('preview_leases')).some(r => !r.revokedAt && r.expiresAt > Date.now()));
    block('cards', 'Remove project payment cards before moving.', (await s.db.prepare('SELECT 1 FROM cards WHERE scopeId=?').get(projectId)));
    block('spending', 'Resolve pending spending requests before moving.', (await rows('payment_spend_requests')).some(r => ['authorizing', 'authorized', 'pending_approval', 'needs_funding'].includes(r.status)));
    block('deletion', 'Wait for deletion to finish before moving this project.',
      (await s.kvGet(`organization-deleting:${project.organizationId}`)) || (await s.kvGet(`organization-deleting:${destinationOrganizationId}`))
      || JSON.parse((await s.kvGet(transferLockKey(projectId))) ?? '{}').kind === 'delete');
    const taskIds = new Set(tasks.map(t => t.id));
    block('collaboration', 'Finish or cancel pending collaboration requests before moving.',
      ((await s.db.prepare("SELECT requesterTaskId, targetTaskId FROM collaboration_requests WHERE status='pending'").all()) as any[])
        .some(r => taskIds.has(r.requesterTaskId) || taskIds.has(r.targetTaskId)));
    const services = JSON.parse((await s.kvGet(`project-services:${projectId}`)) ?? '[]');
    block('services', 'Remove or migrate project services before moving.', services.length);
    // Source repository credentials never cross the boundary. An existing
    // destination catalogue entry is the same authority used by Attach repository.
    const destinationRepos = (await s.listRepositories(destinationOrganizationId));
    const linked = (await s.listProjectRepositories(projectId));
    const wiki = (await s.projectWiki(projectId));
    const sourceRepos = [...linked.map(r => r.repository), ...(wiki?.repository ? [wiki.repository] : [])];
    const repositories: TransferPlan['repositories'] = [];
    for (const repo of sourceRepos) {
      const target = destinationRepos.find(r => r.provider === repo.provider && r.owner === repo.owner && r.name === repo.name
        && (!repo.providerId || r.providerId === repo.providerId));
      const connection = target?.gitConnectionId ? (await s.getGitConnection(target.gitConnectionId)) : undefined;
      if (!target || target.gitConnectionId && (!connection || connection.suspendedAt)) {
        block('repository', `Connect ${repo.owner}/${repo.name} in the destination organization first.`, true);
      } else if (!repositories.some(r => r.from === repo.id)) repositories.push({ from: repo.id, to: target.id });
    }
    block('unmanaged-repositories', 'Attach configured repositories through the repository catalog before moving.',
      project.config.repos?.some(repo => !sourceRepos.some(r => r.sshUrl === repo)));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      project, destination, environmentBuilds, generation: (await s.kvGet(`project-transfer-current:${projectId}`)), owners, tasks, repositories, destinationRepos, linked, wiki,
      memberships: (await s.listProjectMemberships(projectId)),
      profiles: (await s.db.prepare('SELECT * FROM authorization_profiles WHERE scopeKey=?').all(`project:${projectId}`)),
      grants: (await s.db.prepare('SELECT * FROM principal_grants WHERE scopeKey=?').all(`project:${projectId}`)),
      settings: (await s.db.prepare('SELECT * FROM settings WHERE scopeKey IN (?, ?, ?)').all(projectId, `quick:${projectId}`, `organization:${destinationOrganizationId}`)),
      executionPolicy: (await s.getOrganizationExecutionPolicy(destinationOrganizationId)),
      identityPolicies: [(await s.getOrganizationIdentityPolicy(project.organizationId!)), (await s.getOrganizationIdentityPolicy(destinationOrganizationId))],
      projectProfiles: (await s.listProfiles()).filter(p => p.id.startsWith(`${projectId}::`)),
      environment: (await s.kvGet(`project-environment:${projectId}`)),
      policies: [(await s.kvGet(`credpolicy:project:${projectId}`)), (await s.kvGet(`conversation-sharing:project:${projectId}`))],

      blockers,
    })).digest('hex');
    return { project, destinationOrganizationId, owners, repositories, blockers, taskCount: tasks.length, fingerprint };
  }

  async preview(projectId: string, destinationOrganizationId: string) {
    return this.store.transaction(async () => {
    const plan = (await this.plan(projectId, destinationOrganizationId));
    // Previews contain no secret material. Expire abandoned previews and bounded
    // retry receipts without growing the key/value store indefinitely.
    for (const entry of (await this.store.kvEntries('project-transfer:'))) {
      const prior = JSON.parse(entry.value) as SavedPreview;
      if (prior.expiresAt < Date.now()) (await this.store.kvDelete(entry.key));
    }
    const preview: SavedPreview = { id: crypto.randomUUID(), principal: this.actor.principal, projectId,
      sourceOrganizationId: plan.project.organizationId!, destinationOrganizationId, fingerprint: plan.fingerprint, expiresAt: Date.now() + 10 * 60_000 };
    (await this.store.kvSet(`project-transfer:${preview.id}`, JSON.stringify(preview)));
    return { id: preview.id, projectId, destinationOrganizationId, blockers: plan.blockers, taskCount: plan.taskCount,
      ownerUserIds: plan.owners, expiresAt: preview.expiresAt,
      changes: [
        'Project identity, tasks, conversations, wiki, and files are preserved.',
        'Existing project access is replaced by destination organization owners. Add other members after moving.',
        'The project moves to the destination’s top level. Task defaults and compute settings inherit from the destination.',
        'Credentials, connections, payment authority, and public conversation links do not carry over.',
        'Completed tasks remain readable history; start new tasks for further work. Drafts need new authorization; unavailable creators are replaced by destination owners for decisions.',
      ] };
    });
  }

  async move(projectId: string, destinationOrganizationId: string, previewId: string): Promise<Project> {
    const s = this.store;
    const raw = (await s.kvGet(`project-transfer:${previewId}`));
    const preview: SavedPreview | undefined = raw ? JSON.parse(raw) : undefined;
    if (!preview || preview.principal !== this.actor.principal || preview.projectId !== projectId
      || preview.destinationOrganizationId !== destinationOrganizationId) throw new ProjectTransferError('Create a new transfer preview.');
    (await this.authorize(preview.sourceOrganizationId, destinationOrganizationId));
    if (preview.result) {
      if ((await s.getProject(projectId))?.organizationId !== destinationOrganizationId || (await s.kvGet(`project-transfer-current:${projectId}`)) !== previewId) throw new ProjectTransferError('Project has moved again. Create a new preview.');
      return preview.result;
    }
    if (preview.expiresAt < Date.now()) throw new ProjectTransferError('The preview expired. Preview the move again.');
    const lockKey = transferLockKey(projectId);
    const lock = JSON.stringify({ id: previewId, expiresAt: Date.now() + 120_000 });
    await s.transaction(async () => {
      // PostgreSQL needs an explicit row lock; SQLite BEGIN IMMEDIATE already
      // serializes writers. No transaction is held over network I/O.
      if (s.db.dialect === 'postgres') (await s.db.prepare('SELECT id FROM projects WHERE id=? FOR UPDATE').get(projectId));
      const existing = (await s.kvGet(lockKey));
      if (existing && JSON.parse(existing).expiresAt > Date.now()) throw new ProjectTransferError('A move is already in progress.');
      (await this.validate(preview));
      (await s.kvSet(lockKey, lock));
    });
    try {
      const tasks = await mapAsync((await s.db.prepare('SELECT id FROM tasks WHERE projectId=?').all(projectId)) as Array<{ id: string }>, async r => (await s.getTask(r.id))!);
      for (const task of tasks) {
        if (!(await this.actor.workflowClosed(task.id))) throw new ProjectTransferError('A task workflow is still running. Wait for it to finish, then retry.');
        if (Date.now() > JSON.parse(lock).expiresAt) throw new ProjectTransferError('Checking task workflows timed out. Retry the move.');
      }
      return await s.transaction(async () => {
        // Both organizations' administration (slugs, members, projects), the
        // source's credential and authorization requests rewritten below, then
        // the rows: whatever adds to the project holds its row FOR KEY SHARE.
        const organizations = [preview.sourceOrganizationId, destinationOrganizationId].sort();
        (await s.lock(...organizations.map(org => `org:${org}`), `vault:${preview.sourceOrganizationId}`,
          `kv:authorization:requests:${preview.sourceOrganizationId}`));
        if (s.db.dialect === 'postgres') {
          for (const org of organizations)
            (await s.db.prepare('SELECT id FROM organizations WHERE id=? FOR UPDATE').get(org));
          (await s.db.prepare('SELECT id FROM projects WHERE id=? FOR UPDATE').get(projectId));
        }
        if ((await s.kvGet(lockKey)) !== lock) throw new ProjectTransferError('The transfer lease changed. Preview the move again.');
        const plan = (await this.validate(preview));
        (await this.commit(plan));
        const result = (await s.getProject(projectId))!;
        (await s.kvSet(`project-transfer:${previewId}`, JSON.stringify({ ...preview, result, expiresAt: Date.now() + 24 * 60 * 60_000 })));
        (await s.kvSet(`project-transfer-current:${projectId}`, previewId));
        (await s.kvDelete(lockKey));
        return result;
      });
    } finally {
      (await s.db.prepare('DELETE FROM kv WHERE k=? AND v=?').run(lockKey, lock));
    }
  }

  private async validate(preview: SavedPreview) {
    (await this.authorize(preview.sourceOrganizationId, preview.destinationOrganizationId));
    const plan = (await this.plan(preview.projectId, preview.destinationOrganizationId));
    if (plan.blockers.length) throw new ProjectTransferError(plan.blockers.map(b => b.message).join(' '));
    if (plan.fingerprint !== preview.fingerprint) throw new ProjectTransferError('The project or destination changed. Preview the move again.');
    return plan;
  }

  private async commit(plan: TransferPlan) {
    const s = this.store, id = plan.project.id, destination = plan.destinationOrganizationId;
    const taskIds = ((await s.db.prepare('SELECT id FROM tasks WHERE projectId=?').all(id)) as any[]).map(r => String(r.id));
    (await s.revokeScopedTokens({ projectId: id }));
    (await s.revokeHumanDelegations({ projectId: id }));
    for (const taskId of taskIds) {
      (await s.revokeHumanDelegations({ taskId }));
      const task = (await s.getTask(taskId))!;
      if (!task.params.draft || task.params._workflowRunId || task.lastView)
        (await s.kvSet(transferredTaskKey(taskId), plan.project.organizationId!));
      if (task.lastView) {
        const { world, worldPath, worldAvailable, worldDesktop, worldProvider, ...history } = task.lastView;
        (await s.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify({ ...history, actions: [], stageTransitions: [] }), taskId));
      }
      const { _authorization, _githubAccountId, profiles, ...params } = task.params;
      if (task.params.draft) {
        for (const key of Object.keys(params)) if (key.startsWith('agent:') || ['confirm', 'confirmer', 'responder', 'confirmation', 'gitProfile', 'runnerPoolId', 'environment', 'worldProvider', 'copyGlobs', 'paymentPolicy'].includes(key))
          delete params[key];
        // Creator identity is historical provenance, not permission. If that
        // person is absent from the receiving org, route new draft decisions
        // to its owners instead of leaving @creator as an unanswerable gate.
        if (task.createdBy?.kind !== 'user' || !(await s.organizationMembership(destination, task.createdBy.userId))) {
          params.confirm = { layers: [{ kind: 'human', audience: ['@owners'] }] };
          params.responder = { kind: 'human', audience: ['@owners'] };
        }
        (await s.db.prepare('UPDATE task_intents SET confirmer=NULL WHERE id=?').run(task.intentId));
      }
      (await s.updateTaskParams(taskId, { ...params, _authorization: {
        profileId: 'developer', level: 'developer', scope: 'projects', projectIds: [id], organizationId: destination,
        capabilities: [], principal: 'system:project-transfer', profileAttenuated: true, attenuationAccepted: false,
      } }));
      for (const key of [`vault:grant:${taskId}`, `vault:pass:${taskId}`, `vault:task-policy:${taskId}`, `credpolicy:task:${taskId}`, `permission:grant:${taskId}`]) (await s.kvDelete(key));
      for (const share of (await s.kvEntries(`conversation-share-index:${taskId}:`)).filter(e => e.key.startsWith(`conversation-share-index:${taskId}:`))) {
        (await s.kvDelete(`conversation-share:${share.value}`)); (await s.kvDelete(share.key));
      }
    }
    // Cancel outstanding grants and remove app sharing; keeping these keyed by
    // stable task/project IDs would resurrect source authority on a later move.
    const movedTasks = new Set(taskIds);
    for (const prefix of ['vault:requests:', 'authorization:requests:']) {
      const key = prefix + plan.project.organizationId;
      const requests = JSON.parse((await s.kvGet(key)) ?? '[]');
      (await s.kvSet(key, JSON.stringify(requests.filter((r: any) => !movedTasks.has(r.taskId)
        && !movedTasks.has(r.target?.taskId) && r.projectId !== id))));
    }
    const permissions = new PermissionRequests(s, plan.project.organizationId ?? 'org_personal');
    for (const request of (await permissions.requests()))
      if (movedTasks.has(request.taskId) || request.projectId === id) (await permissions.remove(request));
    for (const listed of (await s.kvEntries('service-connection:'))) {
      if (JSON.parse(listed.value).organizationId !== plan.project.organizationId) continue;
      (await s.lock(`kv:${listed.key}`));
      const value = (await s.kvGet(listed.key));
      if (!value) continue;
      const entry = { key: listed.key, value };
      const connection = JSON.parse(entry.value);
      if (connection.projectIds?.includes(id)) {
        connection.projectIds = connection.projectIds.filter((projectId: string) => projectId !== id);
        (await s.kvSet(entry.key, JSON.stringify(connection)));
      }
    }
    const inboxIds = ((await s.db.prepare('SELECT id FROM inbox WHERE taskId IN (SELECT id FROM tasks WHERE projectId=?)').all(id)) as any[]).map(r => String(r.id));
    inboxIds.push(...((await s.db.prepare("SELECT id FROM inbox WHERE json_extract(subject, '$.projectId')=?").all(id)) as any[]).map(r => String(r.id)));
    (await deleteRows(s.db, 'delivery_outbox', 'inboxId', inboxIds));
    (await deleteRows(s.db, 'inbox', 'id', inboxIds));
    (await deleteRows(s.db, 'world_instances', 'worldId', taskIds));
    (await deleteRows(s.db, 'task_subscribers', 'taskId', taskIds));
    (await deleteRows(s.db, 'task_confirmation', 'taskId', taskIds));
    (await deleteRows(s.db, 'confirmation_votes', 'taskId', taskIds));
    (await s.db.prepare('UPDATE tasks SET assignee=NULL, delegate=NULL, confirmationPolicy=NULL WHERE projectId=?').run(id));
    (await s.db.prepare('DELETE FROM project_memberships WHERE projectId=?').run(id));
    (await s.db.prepare('DELETE FROM principal_grants WHERE scopeKey=?').run(`project:${id}`));
    (await s.db.prepare('DELETE FROM authorization_profiles WHERE scopeKey=?').run(`project:${id}`));
    const teamIds = ((await s.db.prepare('SELECT id FROM teams WHERE projectId=?').all(id)) as any[]).map(r => String(r.id));
    (await deleteRows(s.db, 'team_memberships', 'teamId', teamIds));
    (await deleteRows(s.db, 'team_aliases', 'teamId', teamIds));
    (await deleteRows(s.db, 'teams', 'id', teamIds));
    (await s.db.prepare('DELETE FROM settings WHERE scopeKey IN (?, ?)').run(id, `quick:${id}`));
    const profilePrefix = `${id}::`;
    (await s.db.prepare('DELETE FROM profiles WHERE substr(id, 1, length(?))=?').run(profilePrefix, profilePrefix));
    for (const key of [`authz:default:project:${id}`, `credpolicy:project:${id}`, `project-environment-builds:${id}`, `avatars:project:${id}`]) (await s.kvDelete(key));
    for (const entry of (await s.kvEntries(`wfpin:${id}:`)).filter(e => e.key.startsWith(`wfpin:${id}:`))) (await s.kvDelete(entry.key));
    (await s.kvSet(`conversation-sharing:project:${id}`, 'disabled'));
    // Retain only portable code/branch policy. Compute and profile selectors are
    // organization-owned; the preview explicitly describes their reset.
    const { repos, defaultBase, defaultTarget, remote, landingAuthority, multiPr } = plan.project.config;
    const config = { repos, defaultBase, defaultTarget, remote, landingAuthority, multiPr };
    const order = Number(((await s.db.prepare('SELECT COALESCE(MAX(ord), -1)+1 n FROM projects WHERE organizationId=?').get(destination)) as any).n);
    (await s.db.prepare('UPDATE projects SET organizationId=?, folder=NULL, ord=?, config=? WHERE id=?')
      .run(destination, order, JSON.stringify(config), id));
    for (const repo of plan.repositories) {
      (await s.db.prepare('UPDATE project_repositories SET repositoryId=? WHERE projectId=? AND repositoryId=?').run(repo.to, id, repo.from));
      (await s.db.prepare('UPDATE project_wikis SET repositoryId=?, updatedAt=? WHERE projectId=? AND repositoryId=?').run(repo.to, Date.now(), id, repo.from));
    }
    for (const owner of plan.owners) (await s.setProjectMembership(id, { kind: 'user', userId: owner }, 'owner'));
    // Object keys are immutable, project-scoped managed artifacts. Their access
    // follows the project; billing and execution provenance stay in the source.
    (await s.db.prepare('UPDATE promoted_artifacts SET organizationId=? WHERE projectId=?').run(destination, id));
    for (const org of [plan.project.organizationId!, destination]) (await s.appendAudit({ principalId: this.actor.principal,
      action: 'project.transferred', scopeKey: `organization:${org}`, detail: { projectId: id,
        sourceOrganizationId: plan.project.organizationId, destinationOrganizationId: destination } }));
  }
}
