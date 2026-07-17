import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isIP } from 'node:net';

// node:sqlite is a newer builtin that bundlers (vite/vitest) cannot statically
// resolve, so load it through createRequire at runtime.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import {
  Project,
  ProjectConfig,
  TaskList,
  TaskRecord,
  TaskParams,
  AgentProfile,
  TaskView,
  KarmaxEvent,
  Tag,
  SavedView,
  TaskQuery,
  Organization,
  OrganizationExecutionPolicy,
  OrganizationMembership,
  OrganizationInvitation,
  Team,
  TeamMembership,
  ProjectMembership,
  PrincipalRef,
  ProjectPrincipalRef,
  ConfirmationPolicy,
  Repository,
  ProjectRepository,
  GitConnection,
  InboxItem,
  DeliveryPreferences,
  OrganizationIdentityPolicy,
  WorldCheckpoint,
  RunnerPool,
  WorldProviderConnection,
  UsageEvent,
  PromotedArtifact,
  ExecutionRecord,
  ExecutionFrame,
  PreviewLease,
  WorldHandleRef,
} from '../domain/types.js';
import { newId } from '../util/id.js';

/**
 * Terminal statuses that auto-archive a task when it first reaches one (see
 * `Store.saveView`). Only fully-resolved outcomes — a failed task stays visible
 * because it usually needs attention.
 */
const AUTO_ARCHIVE_STATUS = new Set<string>(['done', 'cancelled']);

/**
 * The metadata index. Temporal holds the authoritative live workflow state;
 * this store is the searchable index of projects/lists/tasks/profiles plus an
 * append-only event log that powers the live UI stream.
 */
export class Store {
  readonly db: DatabaseSyncType;

  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // busy_timeout first: waiting (up to 5s) on a locked database beats failing
    // the caller outright. tsx-watch restarts overlap the outgoing and incoming
    // app for a few seconds, and the newcomer's boot writes (migrations,
    // credential registration) must not instantly kill a long agent turn's
    // event append with "database is locked" (that error cost a merge-agent
    // turn mid-conflict-resolution — the 05f9802 postmortem).
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.migrateData();
  }

  /** One-time data migrations (idempotent; run every boot). */
  private migrateData() {
    // Turn caps are now optional (unlimited by default). Strip the legacy caps
    // that older builds seeded onto the role-default profiles so existing installs
    // match the new "no limit unless you set one" behavior.
    const rows = this.db.prepare("SELECT id, json FROM profiles WHERE id LIKE '%-default'").all() as any[];
    for (const r of rows) {
      const p = JSON.parse(r.json);
      if (p.maxTurns !== undefined) {
        delete p.maxTurns;
        this.db.prepare('UPDATE profiles SET json = ? WHERE id = ?').run(JSON.stringify(p), r.id);
      }
    }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, organizationId TEXT, name TEXT NOT NULL, createdAt INTEGER NOT NULL, config TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_lists (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
        createdAt INTEGER NOT NULL, ord INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, listId TEXT NOT NULL,
        title TEXT NOT NULL, workflow TEXT NOT NULL, workflowVersion TEXT NOT NULL,
        params TEXT NOT NULL, createdAt INTEGER NOT NULL, ord INTEGER NOT NULL,
        parentTaskId TEXT, lastView TEXT, createdBy TEXT, assignee TEXT,
        delegate TEXT, confirmationPolicy TEXT
      );
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organization_memberships (
        organizationId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL,
        joinedAt INTEGER NOT NULL, PRIMARY KEY (organizationId, userId)
      );
      CREATE TABLE IF NOT EXISTS organization_invitations (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, email TEXT NOT NULL,
        role TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE, invitedBy TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, acceptedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT,
        name TEXT NOT NULL, slug TEXT NOT NULL, createdAt INTEGER NOT NULL,
        UNIQUE (organizationId, projectId, slug)
      );
      CREATE TABLE IF NOT EXISTS team_memberships (
        teamId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL,
        joinedAt INTEGER NOT NULL, PRIMARY KEY (teamId, userId)
      );
      CREATE TABLE IF NOT EXISTS team_aliases (
        teamId TEXT NOT NULL, organizationId TEXT NOT NULL, projectId TEXT,
        slug TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY (teamId, slug)
      );
      CREATE TABLE IF NOT EXISTS project_memberships (
        projectId TEXT NOT NULL, principalKey TEXT NOT NULL, principal TEXT NOT NULL,
        role TEXT NOT NULL, joinedAt INTEGER NOT NULL, PRIMARY KEY (projectId, principalKey)
      );
      CREATE TABLE IF NOT EXISTS task_subscribers (
        taskId TEXT NOT NULL, principalKey TEXT NOT NULL, principal TEXT NOT NULL,
        createdAt INTEGER NOT NULL, PRIMARY KEY (taskId, principalKey)
      );
      CREATE TABLE IF NOT EXISTS task_confirmation (
        taskId TEXT PRIMARY KEY, cycle INTEGER NOT NULL, policy TEXT NOT NULL,
        createdAt INTEGER NOT NULL, satisfiedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS confirmation_votes (
        taskId TEXT NOT NULL, cycle INTEGER NOT NULL, userId TEXT NOT NULL,
        votedAt INTEGER NOT NULL, PRIMARY KEY (taskId, cycle, userId)
      );
      CREATE TABLE IF NOT EXISTS git_connections (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, provider TEXT NOT NULL,
        installationId TEXT NOT NULL, accountLogin TEXT NOT NULL, accountType TEXT,
        createdAt INTEGER NOT NULL, suspendedAt INTEGER,
        UNIQUE (provider, installationId)
      );
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, provider TEXT NOT NULL,
        providerId TEXT, owner TEXT NOT NULL, name TEXT NOT NULL, sshUrl TEXT NOT NULL,
        defaultBranch TEXT NOT NULL, private INTEGER NOT NULL, gitConnectionId TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE (organizationId, provider, owner, name)
      );
      CREATE TABLE IF NOT EXISTS project_repositories (
        projectId TEXT NOT NULL, repositoryId TEXT NOT NULL, baseBranch TEXT,
        targetBranch TEXT, ord INTEGER NOT NULL,
        PRIMARY KEY (projectId, repositoryId)
      );
      CREATE TABLE IF NOT EXISTS repository_deploy_keys (
        repositoryId TEXT PRIMARY KEY, cloneKeyId TEXT NOT NULL, writeKeyId TEXT NOT NULL,
        cloneHandle TEXT NOT NULL, writeHandle TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
        deliveryId TEXT PRIMARY KEY, event TEXT NOT NULL, receivedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_install_states (
        tokenHash TEXT PRIMARY KEY, organizationId TEXT NOT NULL, userId TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS world_instances (
        worldId TEXT NOT NULL, generation INTEGER NOT NULL, handle TEXT NOT NULL,
        state TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY (worldId, generation)
      );
      CREATE TABLE IF NOT EXISTS world_checkpoints (
        id TEXT PRIMARY KEY, worldId TEXT NOT NULL, generation INTEGER NOT NULL,
        projectId TEXT NOT NULL, manifest TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_pools (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, name TEXT NOT NULL,
        provider TEXT NOT NULL, region TEXT, mode TEXT NOT NULL, capacity TEXT NOT NULL,
        enabled INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS world_provider_connections (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, provider TEXT NOT NULL,
        name TEXT NOT NULL, credentialHandle TEXT NOT NULL, config TEXT NOT NULL,
        enabled INTEGER NOT NULL, status TEXT NOT NULL, lastCheckedAt INTEGER,
        lastError TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE(organizationId, provider)
      );
      CREATE TABLE IF NOT EXISTS world_leases (
        id TEXT PRIMARY KEY, runnerPoolId TEXT NOT NULL, organizationId TEXT NOT NULL,
        projectId TEXT NOT NULL, taskId TEXT NOT NULL, worldId TEXT NOT NULL,
        cpu INTEGER NOT NULL, memoryMb INTEGER NOT NULL, gpu INTEGER NOT NULL,
        priority INTEGER NOT NULL, state TEXT NOT NULL, createdAt INTEGER NOT NULL,
        acquiredAt INTEGER, releasedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT, taskId TEXT,
        worldId TEXT, provider TEXT NOT NULL, kind TEXT NOT NULL, quantity REAL NOT NULL,
        unit TEXT NOT NULL, costMicros INTEGER NOT NULL, startedAt INTEGER NOT NULL,
        endedAt INTEGER NOT NULL, metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS promoted_artifacts (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT NOT NULL,
        taskId TEXT NOT NULL, objectKey TEXT NOT NULL, sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL, mediaType TEXT NOT NULL, name TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT NOT NULL,
        taskId TEXT NOT NULL, worldId TEXT NOT NULL, generation INTEGER NOT NULL,
        kind TEXT NOT NULL, label TEXT NOT NULL, command TEXT, server INTEGER NOT NULL,
        openUrls TEXT NOT NULL, state TEXT NOT NULL, startedAt INTEGER NOT NULL,
        heartbeatAt INTEGER NOT NULL, endedAt INTEGER, exitCode INTEGER, runnerLeaseId TEXT
      );
      CREATE TABLE IF NOT EXISTS execution_frames (
        executionId TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
        stream TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (executionId, seq)
      );
      CREATE TABLE IF NOT EXISTS preview_leases (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT NOT NULL,
        taskId TEXT NOT NULL, worldId TEXT NOT NULL, generation INTEGER NOT NULL,
        port INTEGER NOT NULL, public INTEGER NOT NULL, tokenHash TEXT, runnerLeaseId TEXT,
        provider TEXT NOT NULL, createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL, revokedAt INTEGER, hostname TEXT
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, userId TEXT NOT NULL,
        eventSeq INTEGER NOT NULL, taskId TEXT NOT NULL, kind TEXT NOT NULL,
        unread INTEGER NOT NULL, actionable INTEGER NOT NULL, createdAt INTEGER NOT NULL,
        readAt INTEGER, UNIQUE (userId, eventSeq, kind)
      );
      CREATE TABLE IF NOT EXISTS delivery_preferences (
        userId TEXT NOT NULL, organizationId TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (userId, organizationId)
      );
      CREATE TABLE IF NOT EXISTS delivery_outbox (
        id TEXT PRIMARY KEY, inboxId TEXT NOT NULL, channel TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL, nextAt INTEGER NOT NULL,
        claimedAt INTEGER, lastError TEXT, createdAt INTEGER NOT NULL, deliveredAt INTEGER,
        UNIQUE (inboxId, channel)
      );
      CREATE TABLE IF NOT EXISTS organization_identity_policy (
        organizationId TEXT PRIMARY KEY, oidcProviderId TEXT, verifiedDomains TEXT NOT NULL,
        enforceSso INTEGER NOT NULL, scimTokenId TEXT, scimTokenHash TEXT, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scoped_tokens (
        tokenHash TEXT PRIMARY KEY, tokenId TEXT NOT NULL UNIQUE, json TEXT NOT NULL,
        expiresAt INTEGER NOT NULL, revokedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS task_intents (
        id TEXT PRIMARY KEY, principalAttemptId TEXT NOT NULL,
        committedAttemptId TEXT, confirmer TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL,
        type TEXT NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY, v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        scopeKey TEXT NOT NULL, workflow TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (scopeKey, workflow)
      );
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, scope TEXT NOT NULL,
        scopeId TEXT, label TEXT NOT NULL, cap INTEGER NOT NULL,
        available INTEGER NOT NULL, merchantLock TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
        parentId TEXT, color TEXT, kind TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_tags (
        taskId TEXT NOT NULL, tagId TEXT NOT NULL, PRIMARY KEY (taskId, tagId)
      );
      CREATE TABLE IF NOT EXISTS saved_views (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
        query TEXT NOT NULL, icon TEXT, ord INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authorization_profiles (
        scopeKey TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY(scopeKey, id)
      );
      CREATE TABLE IF NOT EXISTS principal_grants (
        principalId TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY(principalId, scopeKey)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        principalId TEXT NOT NULL,
        action TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attachment_scopes (
        attachmentId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        PRIMARY KEY(attachmentId, projectId)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId);
      CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_memberships(userId, organizationId);
      CREATE INDEX IF NOT EXISTS idx_project_members_principal ON project_memberships(principalKey, projectId);
      CREATE INDEX IF NOT EXISTS idx_inbox_user ON inbox(userId, unread, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_repositories_org ON repositories(organizationId, owner, name);
      CREATE INDEX IF NOT EXISTS idx_github_install_states_expiry ON github_install_states(expiresAt, usedAt);
      CREATE INDEX IF NOT EXISTS idx_scoped_tokens_expiry ON scoped_tokens(expiresAt);
      CREATE INDEX IF NOT EXISTS idx_world_instances_current ON world_instances(worldId, generation DESC);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_world ON world_checkpoints(worldId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_runner_pools_org ON runner_pools(organizationId, enabled);
      CREATE INDEX IF NOT EXISTS idx_world_provider_connections_org ON world_provider_connections(organizationId, enabled);
      CREATE INDEX IF NOT EXISTS idx_world_leases_pool ON world_leases(runnerPoolId, state, priority DESC, createdAt);
      CREATE INDEX IF NOT EXISTS idx_usage_org_time ON usage_events(organizationId, startedAt);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON promoted_artifacts(taskId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(taskId, startedAt);
      CREATE INDEX IF NOT EXISTS idx_execution_frames ON execution_frames(executionId, seq);
      CREATE INDEX IF NOT EXISTS idx_preview_expiry ON preview_leases(expiresAt, revokedAt);
      CREATE INDEX IF NOT EXISTS idx_delivery_pending ON delivery_outbox(state, nextAt);
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(taskId, seq);
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts, seq);
      CREATE INDEX IF NOT EXISTS idx_tags_project ON tags(projectId);
      CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tagId);
      CREATE INDEX IF NOT EXISTS idx_saved_views_project ON saved_views(projectId);
    `);
    // Free-form human notes, added after the initial schema. Guarded so existing
    // installs pick it up without a re-create.
    const cols = this.db.prepare('PRAGMA table_info(tasks)').all() as any[];
    const projectCols = this.db.prepare('PRAGMA table_info(projects)').all() as any[];
    const invitationCols = this.db.prepare('PRAGMA table_info(organization_invitations)').all() as any[];
    if (!invitationCols.some((c) => c.name === 'profileId')) this.db.exec('ALTER TABLE organization_invitations ADD COLUMN profileId TEXT');
    const previewCols = this.db.prepare('PRAGMA table_info(preview_leases)').all() as any[];
    if (!previewCols.some((c) => c.name === 'hostname')) this.db.exec('ALTER TABLE preview_leases ADD COLUMN hostname TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_preview_hostname ON preview_leases(hostname) WHERE hostname IS NOT NULL');
    if (!projectCols.some((c) => c.name === 'organizationId')) this.db.exec('ALTER TABLE projects ADD COLUMN organizationId TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organizationId)');
    if (!cols.some((c) => c.name === 'intentId')) this.db.exec('ALTER TABLE tasks ADD COLUMN intentId TEXT');
    if (!cols.some((c) => c.name === 'attemptNumber')) this.db.exec('ALTER TABLE tasks ADD COLUMN attemptNumber INTEGER');
    // Existing rows become single-attempt intents. This is deliberately idempotent.
    this.db.exec(`
      UPDATE tasks SET intentId = id WHERE intentId IS NULL;
      UPDATE tasks SET attemptNumber = 1 WHERE attemptNumber IS NULL;
      INSERT OR IGNORE INTO task_intents (id, principalAttemptId, createdAt)
        SELECT id, id, createdAt FROM tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_intent ON tasks(intentId, attemptNumber);
    `);
    if (!cols.some((c) => c.name === 'notes')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN notes TEXT');
    }
    if (!cols.some((c) => c.name === 'createdBy')) this.db.exec('ALTER TABLE tasks ADD COLUMN createdBy TEXT');
    if (!cols.some((c) => c.name === 'assignee')) this.db.exec('ALTER TABLE tasks ADD COLUMN assignee TEXT');
    if (!cols.some((c) => c.name === 'delegate')) this.db.exec('ALTER TABLE tasks ADD COLUMN delegate TEXT');
    if (!cols.some((c) => c.name === 'confirmationPolicy')) this.db.exec('ALTER TABLE tasks ADD COLUMN confirmationPolicy TEXT');

    // Existing installs become one personal organization. The fixed id makes the
    // migration idempotent and gives bootstrapping code a stable tenant to claim.
    const now = Date.now();
    this.db.prepare(`INSERT OR IGNORE INTO organizations (id, name, slug, kind, createdAt)
      VALUES ('org_personal', 'Personal', 'personal', 'personal', ?)`).run(now);
    // Early collaboration builds exposed decorative Billing and team Lead
    // labels that carried no distinct policy. Collapse them to the one behavior
    // they actually had before the simplified UI reads the rows.
    this.db.exec("UPDATE organization_memberships SET role='member' WHERE role='billing'");
    this.db.exec("UPDATE organization_invitations SET role='member' WHERE role='billing'");
    this.db.exec("UPDATE team_memberships SET role='member' WHERE role='lead'");
    this.db.exec("UPDATE projects SET organizationId = 'org_personal' WHERE organizationId IS NULL");
    // Simple human-facing sequential id, numbered PER PROJECT (SPEC §10.6): each
    // project's tasks run #1, #2, … A separate integer alongside the opaque `id`
    // (which stays the Temporal workflowId and must never change). The per-project
    // unique index doubles as the migration marker: if it isn't present yet, we
    // (re)assign numbers per project in creation order — this both backfills fresh
    // installs and re-numbers any install that briefly had the earlier global scheme.
    if (!cols.some((c) => c.name === 'num')) this.db.exec('ALTER TABLE tasks ADD COLUMN num INTEGER');
    const hasPerProjectIdx = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_tasks_num_project'")
      .get();
    if (!hasPerProjectIdx) {
      this.db.exec('DROP INDEX IF EXISTS idx_tasks_num'); // retire the old global-unique index
      const projects = this.db.prepare('SELECT DISTINCT projectId FROM tasks').all() as any[];
      const upd = this.db.prepare('UPDATE tasks SET num = ? WHERE id = ?');
      for (const { projectId } of projects) {
        // Creation order within the project (createdAt, rowid as a stable tiebreak).
        const rows = this.db
          .prepare('SELECT id FROM tasks WHERE projectId = ? ORDER BY createdAt, rowid')
          .all(projectId) as any[];
        let n = 0;
        for (const r of rows) upd.run(++n, r.id);
      }
      this.db.exec('CREATE UNIQUE INDEX idx_tasks_num_project ON tasks(projectId, num)');
    }
  }

  /** Next task number within a project: MAX(num)+1 scoped to that project. node:sqlite
   *  is synchronous and single-threaded, so read-then-write within one createTask
   *  call cannot race. */
  private nextTaskNum(projectId: string): number {
    return (
      (this.db.prepare('SELECT COALESCE(MAX(num), 0) AS m FROM tasks WHERE projectId = ?').get(projectId) as any)
        .m as number
    ) + 1;
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  createProject(name: string, config: ProjectConfig = {}, organizationId = 'org_personal'): Project {
    if (!this.getOrganization(organizationId)) throw new Error(`no organization ${organizationId}`);
    validateProjectExecutionConfig(config);
    const p: Project = { id: newId('proj'), organizationId, name, createdAt: Date.now(), config };
    this.db
      .prepare('INSERT INTO projects (id, organizationId, name, createdAt, config) VALUES (?, ?, ?, ?, ?)')
      .run(p.id, organizationId, p.name, p.createdAt, JSON.stringify(p.config));
    // every project gets a default task list
    this.createList(p.id, 'Tasks');
    return p;
  }

  getProject(id: string): Project | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    return r ? rowToProject(r) : undefined;
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY createdAt').all() as any[]).map(
      rowToProject,
    );
  }

  /** One organization-level execution policy. Provider-specific template/image
   * details stay with the provider connection; this is the provider-neutral
   * policy every project inherits. */
  getOrganizationExecutionPolicy(organizationId: string): OrganizationExecutionPolicy {
    if (!this.getOrganization(organizationId)) throw new Error(`no organization ${organizationId}`);
    const fallback: OrganizationExecutionPolicy = {
      worldProvider: process.env.KARMAX_DEPLOYMENT === 'hosted'
        ? process.env.KARMAX_CLOUD_WORLD_PROVIDER ?? 'e2b'
        : 'worktree',
      resources: { cpu: 2, memoryMb: 2048, gpu: 0 },
      // General-purpose coding agents need package registries, documentation,
      // web search, and arbitrary APIs. Restriction is an explicit hardening mode.
      network: { unrestricted: true },
      hibernateAfterMs: 7 * 24 * 60 * 60 * 1000,
    };
    const raw = this.kvGet(`organization-execution:${organizationId}`);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as OrganizationExecutionPolicy;
    return {
      ...fallback,
      ...saved,
      resources: { ...fallback.resources, ...saved.resources },
      network: saved.network ? { ...saved.network } : fallback.network,
    };
  }

  setOrganizationExecutionPolicy(organizationId: string, policy: OrganizationExecutionPolicy): OrganizationExecutionPolicy {
    if (!this.getOrganization(organizationId)) throw new Error(`no organization ${organizationId}`);
    const current = this.getOrganizationExecutionPolicy(organizationId);
    const next: OrganizationExecutionPolicy = {
      ...current, ...policy,
      resources: policy.resources ? { ...current.resources, ...policy.resources } : current.resources,
      network: policy.network ? { ...policy.network } : current.network,
    };
    validateProjectExecutionConfig(next as ProjectConfig);
    if (process.env.KARMAX_DEPLOYMENT === 'hosted' && ['worktree', 'container', 'memory'].includes(next.worldProvider ?? 'e2b'))
      throw new Error('hosted organizations require a remote world provider');
    for (const project of this.listProjects().filter((candidate) => candidate.organizationId === organizationId)) {
      if (next.monthlyBudgetMicros != null && project.config.monthlyBudgetMicros != null
        && project.config.monthlyBudgetMicros > next.monthlyBudgetMicros)
        throw new Error(`project "${project.name}" has a cloud budget above the new organization budget`);
      const provider = project.config.worldProvider ?? next.worldProvider;
      const providerChanged = Boolean(project.config.worldProvider && project.config.worldProvider !== next.worldProvider);
      const runnerPoolId = project.config.runnerPoolId ?? (providerChanged ? undefined : next.runnerPoolId);
      if (runnerPoolId) {
        const pool = this.getRunnerPool(runnerPoolId);
        if (!pool || pool.organizationId !== organizationId || pool.provider !== provider)
          throw new Error(`project "${project.name}" would inherit an incompatible runner pool`);
      }
    }
    this.kvSet(`organization-execution:${organizationId}`, JSON.stringify(next));
    return this.getOrganizationExecutionPolicy(organizationId);
  }

  /** Effective config used by workflows and provider activities. Project values
   * are sparse overrides; nested resource/network objects remain atomic enough
   * that choosing "organization default" really removes project infrastructure. */
  effectiveProjectConfig(project: Project | string): ProjectConfig {
    const value = typeof project === 'string' ? this.getProject(project) : project;
    if (!value) throw new Error(`no project ${project}`);
    const organization = this.getOrganizationExecutionPolicy(value.organizationId ?? 'org_personal');
    const providerChanged = Boolean(value.config.worldProvider
      && value.config.worldProvider !== organization.worldProvider);
    return {
      ...organization,
      ...value.config,
      // A pool belongs to one provider. Selecting a different provider at the
      // project level therefore falls back to that provider's managed pool
      // unless the project explicitly selects a compatible pool of its own.
      runnerPoolId: value.config.runnerPoolId ?? (providerChanged ? undefined : organization.runnerPoolId),
      resources: { ...organization.resources, ...value.config.resources },
      network: value.config.network ? { ...value.config.network } : organization.network,
    };
  }

  setProjectExecutionPolicy(id: string, override: Partial<Record<keyof OrganizationExecutionPolicy, unknown>>): Project {
    const existing = this.getProject(id);
    if (!existing) throw new Error(`no project ${id}`);
    const config: Record<string, unknown> = { ...existing.config };
    for (const key of ['worldProvider', 'runnerPoolId', 'resources', 'network', 'monthlyBudgetMicros', 'hibernateAfterMs'] as const) {
      if (!Object.prototype.hasOwnProperty.call(override, key)) continue;
      const value = override[key];
      if (value == null) delete config[key];
      else config[key] = value;
    }
    const candidate = { ...existing, config: config as ProjectConfig };
    const effective = this.effectiveProjectConfig(candidate);
    validateProjectExecutionConfig(effective);
    const organizationBudget = this.getOrganizationExecutionPolicy(existing.organizationId ?? 'org_personal').monthlyBudgetMicros;
    if (organizationBudget != null && effective.monthlyBudgetMicros != null && effective.monthlyBudgetMicros > organizationBudget)
      throw new Error('project cloud budget cannot exceed the organization budget');
    if (process.env.KARMAX_DEPLOYMENT === 'hosted' && ['worktree', 'container', 'memory'].includes(effective.worldProvider ?? 'e2b'))
      throw new Error('hosted projects require a remote world provider');
    this.db.prepare('UPDATE projects SET config = ? WHERE id = ?').run(JSON.stringify(config), id);
    return candidate;
  }

  updateProjectConfig(id: string, config: ProjectConfig): Project {
    const existing = this.getProject(id);
    if (!existing) throw new Error(`no project ${id}`);
    const merged = { ...existing.config, ...config };
    validateProjectExecutionConfig(merged);
    if (process.env.KARMAX_DEPLOYMENT === 'hosted' && ['worktree', 'container', 'memory'].includes(merged.worldProvider ?? 'e2b'))
      throw new Error('hosted projects require a remote world provider');
    this.db.prepare('UPDATE projects SET config = ? WHERE id = ?').run(JSON.stringify(merged), id);
    return { ...existing, config: merged };
  }

  /** Delete project metadata after its workflows, worlds, leases, and objects
   * have been removed by the service layer. Billing rows are retained but
   * detached from deleted resource identifiers. */
  deleteProject(id: string): void {
    if (!this.getProject(id)) throw new Error('project not found');
    const tasks = selectRows(this.db, 'tasks', 'projectId=?', [id]);
    const taskIds = tasks.map((row) => String(row.id));
    const intentIds = tasks.map((row) => String(row.intentId)).filter(Boolean);
    const executionIds = (this.db.prepare('SELECT id FROM executions WHERE projectId=?').all(id) as any[])
      .map((row) => String(row.id));
    const inboxIds = rowsFor(this.db, 'inbox', 'taskId', taskIds).map((row) => String(row.id));
    const teamIds = (this.db.prepare('SELECT id FROM teams WHERE projectId=?').all(id) as any[])
      .map((row) => String(row.id));
    const scopeKey = `project:${id}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.revokeScopedTokens({ projectId: id });
      deleteRows(this.db, 'delivery_outbox', 'inboxId', inboxIds);
      deleteRows(this.db, 'execution_frames', 'executionId', executionIds);
      deleteRows(this.db, 'team_memberships', 'teamId', teamIds);
      deleteRows(this.db, 'team_aliases', 'teamId', teamIds);
      deleteRows(this.db, 'task_subscribers', 'taskId', taskIds);
      deleteRows(this.db, 'task_confirmation', 'taskId', taskIds);
      deleteRows(this.db, 'confirmation_votes', 'taskId', taskIds);
      deleteRows(this.db, 'task_tags', 'taskId', taskIds);
      deleteRows(this.db, 'events', 'taskId', taskIds);
      deleteRows(this.db, 'world_instances', 'worldId', taskIds);
      deleteRows(this.db, 'task_intents', 'id', intentIds);
      this.db.prepare('DELETE FROM inbox WHERE taskId IN (SELECT id FROM tasks WHERE projectId=?)').run(id);
      this.db.prepare('DELETE FROM preview_leases WHERE projectId=?').run(id);
      this.db.prepare('DELETE FROM executions WHERE projectId=?').run(id);
      this.db.prepare('DELETE FROM promoted_artifacts WHERE projectId=?').run(id);
      this.db.prepare('DELETE FROM world_leases WHERE projectId=?').run(id);
      this.db.prepare('UPDATE usage_events SET projectId=NULL, taskId=NULL, worldId=NULL, metadata=NULL WHERE projectId=?').run(id);
      this.db.prepare('DELETE FROM settings WHERE scopeKey IN (?, ?)').run(id, `quick:${id}`);
      this.db.prepare('DELETE FROM cards WHERE scopeId=?').run(id);
      this.db.prepare('DELETE FROM authorization_profiles WHERE scopeKey=?').run(scopeKey);
      this.db.prepare('DELETE FROM principal_grants WHERE scopeKey=?').run(scopeKey);
      this.db.prepare('DELETE FROM audit_log WHERE scopeKey=?').run(scopeKey);
      this.db.prepare('DELETE FROM attachment_scopes WHERE projectId=?').run(id);
      this.deleteProjectKv([id], taskIds);
      for (const table of ['project_memberships', 'project_repositories', 'task_lists', 'tags', 'saved_views', 'world_checkpoints'] as const)
        this.db.prepare(`DELETE FROM ${table} WHERE projectId=?`).run(id);
      deleteRows(this.db, 'teams', 'id', teamIds);
      deleteRows(this.db, 'tasks', 'id', taskIds);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ─── Organizations, teams, and repository catalogue ───────────────────

  createOrganization(input: { name: string; slug?: string; kind?: Organization['kind']; ownerUserId?: string }): Organization {
    const slug = uniqueSlug(input.slug ?? input.name, (candidate) => !!this.db.prepare('SELECT 1 FROM organizations WHERE slug = ?').get(candidate));
    const organization: Organization = {
      id: newId('org'), name: input.name.trim() || 'Untitled organization', slug,
      kind: input.kind ?? 'team', createdAt: Date.now(),
    };
    this.db.prepare('INSERT INTO organizations (id, name, slug, kind, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(organization.id, organization.name, organization.slug, organization.kind, organization.createdAt);
    if (input.ownerUserId) this.setOrganizationMembership(organization.id, input.ownerUserId, 'owner');
    return organization;
  }

  getOrganization(id: string): Organization | undefined {
    const r = this.db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as any;
    return r ? rowToOrganization(r) : undefined;
  }

  listOrganizations(userId?: string): Organization[] {
    const rows = userId
      ? this.db.prepare(`SELECT o.* FROM organizations o JOIN organization_memberships m
          ON m.organizationId=o.id WHERE m.userId=? ORDER BY o.createdAt`).all(userId)
      : this.db.prepare('SELECT * FROM organizations ORDER BY createdAt').all();
    return (rows as any[]).map(rowToOrganization);
  }

  /** Complete, secret-redacted tenant export. The table-oriented envelope is
   * intentionally stable and lossless: future import/migration tools can retain
   * records they do not yet understand without flattening the task model. */
  exportOrganization(organizationId: string): Record<string, unknown> {
    const organization = this.getOrganization(organizationId);
    if (!organization) throw new Error('organization not found');
    const projectIds = (this.db.prepare('SELECT id FROM projects WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const taskIds = rowsFor(this.db, 'tasks', 'projectId', projectIds).map((r) => String(r.id));
    const teamIds = (this.db.prepare('SELECT id FROM teams WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const repositoryIds = (this.db.prepare('SELECT id FROM repositories WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const executionIds = (this.db.prepare('SELECT id FROM executions WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const inboxIds = (this.db.prepare('SELECT id FROM inbox WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const intentIds = rowsFor(this.db, 'tasks', 'projectId', projectIds).map((r) => String(r.intentId)).filter(Boolean);
    const identityPolicy = this.getOrganizationIdentityPolicy(organizationId);
    const projectSettingKeys = [
      `organization:${organizationId}`, `quick:organization:${organizationId}`,
      ...projectIds, ...projectIds.map((id) => `quick:${id}`),
    ];
    const tables: Record<string, unknown[]> = {
      organization_memberships: selectRows(this.db, 'organization_memberships', 'organizationId=?', [organizationId]),
      organization_invitations: selectRows(this.db, 'organization_invitations', 'organizationId=?', [organizationId])
        .map(({ tokenHash: _secret, ...row }) => row),
      teams: selectRows(this.db, 'teams', 'organizationId=?', [organizationId]),
      team_memberships: rowsFor(this.db, 'team_memberships', 'teamId', teamIds),
      team_aliases: rowsFor(this.db, 'team_aliases', 'teamId', teamIds),
      projects: rowsFor(this.db, 'projects', 'id', projectIds),
      project_memberships: rowsFor(this.db, 'project_memberships', 'projectId', projectIds),
      task_lists: rowsFor(this.db, 'task_lists', 'projectId', projectIds),
      tasks: rowsFor(this.db, 'tasks', 'projectId', projectIds),
      task_intents: rowsFor(this.db, 'task_intents', 'id', intentIds),
      task_subscribers: rowsFor(this.db, 'task_subscribers', 'taskId', taskIds),
      task_confirmation: rowsFor(this.db, 'task_confirmation', 'taskId', taskIds),
      confirmation_votes: rowsFor(this.db, 'confirmation_votes', 'taskId', taskIds),
      events: rowsFor(this.db, 'events', 'taskId', taskIds),
      tags: rowsFor(this.db, 'tags', 'projectId', projectIds),
      task_tags: rowsFor(this.db, 'task_tags', 'taskId', taskIds),
      saved_views: rowsFor(this.db, 'saved_views', 'projectId', projectIds),
      git_connections: selectRows(this.db, 'git_connections', 'organizationId=?', [organizationId]),
      repositories: rowsFor(this.db, 'repositories', 'id', repositoryIds),
      project_repositories: rowsFor(this.db, 'project_repositories', 'projectId', projectIds),
      // Public key IDs make external cleanup auditable; credential-broker handles
      // and private material never belong in an export.
      repository_deploy_keys: rowsFor(this.db, 'repository_deploy_keys', 'repositoryId', repositoryIds)
        .map(({ cloneHandle: _clone, writeHandle: _write, ...row }) => row),
      world_instances: rowsFor(this.db, 'world_instances', 'worldId', taskIds)
        .map(({ handle, ...row }) => ({ ...row, handle: redactWorldHandle(handle) })),
      world_checkpoints: rowsFor(this.db, 'world_checkpoints', 'projectId', projectIds),
      runner_pools: selectRows(this.db, 'runner_pools', 'organizationId=?', [organizationId]),
      world_provider_connections: selectRows(this.db, 'world_provider_connections', 'organizationId=?', [organizationId])
        .map(({ credentialHandle: _credential, ...row }) => row),
      world_leases: selectRows(this.db, 'world_leases', 'organizationId=?', [organizationId]),
      usage_events: selectRows(this.db, 'usage_events', 'organizationId=?', [organizationId]),
      promoted_artifacts: selectRows(this.db, 'promoted_artifacts', 'organizationId=?', [organizationId]),
      executions: selectRows(this.db, 'executions', 'organizationId=?', [organizationId]),
      execution_frames: rowsFor(this.db, 'execution_frames', 'executionId', executionIds),
      preview_leases: selectRows(this.db, 'preview_leases', 'organizationId=?', [organizationId])
        .map(({ tokenHash: _secret, ...row }) => row),
      inbox: selectRows(this.db, 'inbox', 'organizationId=?', [organizationId]),
      delivery_preferences: selectRows(this.db, 'delivery_preferences', 'organizationId=?', [organizationId]),
      delivery_outbox: rowsFor(this.db, 'delivery_outbox', 'inboxId', inboxIds),
      settings: rowsFor(this.db, 'settings', 'scopeKey', projectSettingKeys),
      cards: rowsFor(this.db, 'cards', 'scopeId', projectIds),
      authorization_profiles: rowsFor(this.db, 'authorization_profiles', 'scopeKey', [`organization:${organizationId}`, ...projectIds.map((id) => `project:${id}`)]),
      principal_grants: rowsFor(this.db, 'principal_grants', 'scopeKey', [`organization:${organizationId}`, ...projectIds.map((id) => `project:${id}`)]),
      audit_log: rowsFor(this.db, 'audit_log', 'scopeKey', [`organization:${organizationId}`, ...projectIds.map((id) => `project:${id}`)]),
      attachment_scopes: rowsFor(this.db, 'attachment_scopes', 'projectId', projectIds),
    };
    return { format: 'karmax-organization-export', version: 1, exportedAt: new Date().toISOString(),
      organization, executionPolicy: this.getOrganizationExecutionPolicy(organizationId),
      identityPolicy: { ...identityPolicy, scimTokenId: undefined }, tables };
  }

  projectResources(projectId: string): { worlds: WorldHandleRef[]; objectKeys: string[];
    attachmentIds: string[]; leases: Array<{ id: string; provider: string }> } {
    const taskIds = (this.db.prepare('SELECT id FROM tasks WHERE projectId=?').all(projectId) as any[]).map((r) => String(r.id));
    const worlds: WorldHandleRef[] = [];
    for (const row of rowsFor(this.db, 'world_instances', 'worldId', taskIds)) {
      if (row.state === 'released') continue;
      try { worlds.push(JSON.parse(row.handle) as WorldHandleRef); } catch {}
    }
    const objectKeys = new Set<string>();
    for (const row of this.db.prepare('SELECT manifest FROM world_checkpoints WHERE projectId=?').all(projectId) as any[]) {
      try { const checkpoint = JSON.parse(row.manifest) as WorldCheckpoint; if (checkpoint.filesystemDelta?.objectKey) objectKeys.add(checkpoint.filesystemDelta.objectKey); } catch {}
    }
    for (const row of this.db.prepare('SELECT objectKey FROM promoted_artifacts WHERE projectId=?').all(projectId) as any[])
      objectKeys.add(String(row.objectKey));
    const attachmentIds = (this.db.prepare('SELECT attachmentId FROM attachment_scopes WHERE projectId=?').all(projectId) as any[])
      .map((row) => String(row.attachmentId));
    const leases = (this.db.prepare(`SELECT l.id, COALESCE(p.provider, 'unknown') provider
      FROM world_leases l LEFT JOIN runner_pools p ON p.id=l.runnerPoolId
      WHERE l.projectId=? AND l.state!='released'`).all(projectId) as any[])
      .map((row) => ({ id: String(row.id), provider: String(row.provider) }));
    return { worlds, objectKeys: [...objectKeys], attachmentIds, leases };
  }

  organizationResources(organizationId: string): { worlds: WorldHandleRef[]; objectKeys: string[];
    attachmentIds: string[]; leases: Array<{ id: string; provider: string }> } {
    const projectIds = (this.db.prepare('SELECT id FROM projects WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const worlds: WorldHandleRef[] = [];
    const objectKeys = new Set<string>();
    const attachmentIds = new Set<string>();
    const leases = new Map<string, { id: string; provider: string }>();
    for (const projectId of projectIds) {
      const resources = this.projectResources(projectId);
      worlds.push(...resources.worlds);
      for (const key of resources.objectKeys) objectKeys.add(key);
      for (const id of resources.attachmentIds) attachmentIds.add(id);
      for (const lease of resources.leases) leases.set(lease.id, lease);
    }
    return { worlds, objectKeys: [...objectKeys], attachmentIds: [...attachmentIds], leases: [...leases.values()] };
  }

  /** Metadata deletion is one transaction and is called only after the gateway
   * has terminated workflows and removed provider/object/Git resources. */
  deleteOrganization(organizationId: string): void {
    if (organizationId === 'org_personal') throw new Error('the installation personal organization cannot be deleted');
    if (!this.getOrganization(organizationId)) throw new Error('organization not found');
    const projectIds = (this.db.prepare('SELECT id FROM projects WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const tasks = rowsFor(this.db, 'tasks', 'projectId', projectIds);
    const taskIds = tasks.map((r) => String(r.id));
    const intentIds = tasks.map((r) => String(r.intentId)).filter(Boolean);
    const teamIds = (this.db.prepare('SELECT id FROM teams WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const repositoryIds = (this.db.prepare('SELECT id FROM repositories WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const executionIds = (this.db.prepare('SELECT id FROM executions WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const inboxIds = (this.db.prepare('SELECT id FROM inbox WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const scopeKeys = [`organization:${organizationId}`, ...projectIds.map((id) => `project:${id}`)];
    const projectSettingKeys = [
      `organization:${organizationId}`, `quick:organization:${organizationId}`,
      ...projectIds, ...projectIds.map((id) => `quick:${id}`),
    ];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.revokeScopedTokens({ organizationId });
      for (const projectId of projectIds) this.revokeScopedTokens({ projectId });
      deleteRows(this.db, 'delivery_outbox', 'inboxId', inboxIds);
      deleteRows(this.db, 'execution_frames', 'executionId', executionIds);
      deleteRows(this.db, 'team_memberships', 'teamId', teamIds);
      deleteRows(this.db, 'team_aliases', 'teamId', teamIds);
      deleteRows(this.db, 'repository_deploy_keys', 'repositoryId', repositoryIds);
      deleteRows(this.db, 'task_subscribers', 'taskId', taskIds);
      deleteRows(this.db, 'task_confirmation', 'taskId', taskIds);
      deleteRows(this.db, 'confirmation_votes', 'taskId', taskIds);
      deleteRows(this.db, 'task_tags', 'taskId', taskIds);
      deleteRows(this.db, 'events', 'taskId', taskIds);
      deleteRows(this.db, 'world_instances', 'worldId', taskIds);
      deleteRows(this.db, 'task_intents', 'id', intentIds);
      deleteRows(this.db, 'settings', 'scopeKey', projectSettingKeys);
      deleteRows(this.db, 'cards', 'scopeId', projectIds);
      deleteRows(this.db, 'authorization_profiles', 'scopeKey', scopeKeys);
      deleteRows(this.db, 'principal_grants', 'scopeKey', scopeKeys);
      deleteRows(this.db, 'audit_log', 'scopeKey', scopeKeys);
      deleteRows(this.db, 'attachment_scopes', 'projectId', projectIds);
      this.deleteProjectKv(projectIds, taskIds);
      for (const table of ['project_memberships', 'project_repositories', 'task_lists', 'tags', 'saved_views', 'world_checkpoints'] as const)
        deleteRows(this.db, table, 'projectId', projectIds);
      this.db.prepare('DELETE FROM preview_leases WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM executions WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM promoted_artifacts WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM usage_events WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM world_leases WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM runner_pools WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM world_provider_connections WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM delivery_preferences WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM inbox WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM organization_identity_policy WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM organization_invitations WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM organization_memberships WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM git_connections WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM github_install_states WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM kv WHERE k=?').run(`organization-execution:${organizationId}`);
      deleteRows(this.db, 'repositories', 'id', repositoryIds);
      deleteRows(this.db, 'teams', 'id', teamIds);
      deleteRows(this.db, 'tasks', 'id', taskIds);
      deleteRows(this.db, 'projects', 'id', projectIds);
      this.db.prepare('DELETE FROM organizations WHERE id=?').run(organizationId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Claim the migration-created personal tenant for the installation owner. */
  claimPersonalOrganization(userId: string, name?: string): Organization {
    const organization = this.getOrganization('org_personal')!;
    this.setOrganizationMembership(organization.id, userId, 'owner');
    if (name && organization.name === 'Personal') {
      const next = `${name.trim() || 'Personal'}'s workspace`;
      this.db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(next, organization.id);
      return { ...organization, name: next };
    }
    return organization;
  }

  setOrganizationMembership(organizationId: string, userId: string, role: OrganizationMembership['role']): OrganizationMembership {
    if (!this.getOrganization(organizationId)) throw new Error(`no organization ${organizationId}`);
    const existing = this.organizationMembership(organizationId, userId);
    if (existing?.role === 'owner' && role !== 'owner') {
      const owners = Number((this.db.prepare("SELECT COUNT(*) n FROM organization_memberships WHERE organizationId=? AND role='owner'")
        .get(organizationId) as any).n);
      if (owners <= 1) throw new Error('an organization must retain at least one owner');
    }
    const joinedAt = Date.now();
    this.db.prepare(`INSERT INTO organization_memberships (organizationId, userId, role, joinedAt)
      VALUES (?, ?, ?, ?) ON CONFLICT(organizationId, userId) DO UPDATE SET role=excluded.role`).run(organizationId, userId, role, joinedAt);
    return { organizationId, userId, role, joinedAt };
  }

  organizationMembership(organizationId: string, userId: string): OrganizationMembership | undefined {
    const r = this.db.prepare('SELECT * FROM organization_memberships WHERE organizationId=? AND userId=?').get(organizationId, userId) as any;
    return r ? r as OrganizationMembership : undefined;
  }

  listOrganizationMemberships(organizationId: string): OrganizationMembership[] {
    return this.db.prepare('SELECT * FROM organization_memberships WHERE organizationId=? ORDER BY joinedAt').all(organizationId) as any[];
  }

  removeOrganizationMembership(organizationId: string, userId: string): void {
    const membership = this.organizationMembership(organizationId, userId);
    if (membership?.role === 'owner') {
      const owners = Number((this.db.prepare("SELECT COUNT(*) n FROM organization_memberships WHERE organizationId=? AND role='owner'").get(organizationId) as any).n);
      if (owners <= 1) throw new Error('an organization must retain at least one owner');
    }
    this.db.prepare('DELETE FROM organization_memberships WHERE organizationId=? AND userId=?').run(organizationId, userId);
  }

  getOrganizationIdentityPolicy(organizationId: string): OrganizationIdentityPolicy {
    const row = this.db.prepare('SELECT * FROM organization_identity_policy WHERE organizationId=?').get(organizationId) as any;
    return row ? { organizationId, oidcProviderId: row.oidcProviderId ?? undefined,
      verifiedDomains: JSON.parse(row.verifiedDomains), enforceSso: Boolean(row.enforceSso),
      scimTokenId: row.scimTokenId ?? undefined, updatedAt: Number(row.updatedAt) }
      : { organizationId, verifiedDomains: [], enforceSso: false, updatedAt: 0 };
  }

  setOrganizationIdentityPolicy(input: { organizationId: string; oidcProviderId?: string;
    verifiedDomains?: string[]; enforceSso?: boolean }): OrganizationIdentityPolicy {
    if (!this.getOrganization(input.organizationId)) throw new Error('organization not found');
    const current = this.getOrganizationIdentityPolicy(input.organizationId);
    const verifiedDomains = (input.verifiedDomains ?? current.verifiedDomains).map((domain) => domain.trim().toLowerCase())
      .filter((domain) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain));
    const oidcProviderId = input.oidcProviderId ?? current.oidcProviderId;
    const enforceSso = input.enforceSso ?? current.enforceSso;
    if (enforceSso && !oidcProviderId) throw new Error('an OIDC provider is required before enforcing SSO');
    const updatedAt = Date.now();
    this.db.prepare(`INSERT INTO organization_identity_policy
      (organizationId, oidcProviderId, verifiedDomains, enforceSso, scimTokenId, scimTokenHash, updatedAt)
      VALUES (?, ?, ?, ?, ?, (SELECT scimTokenHash FROM organization_identity_policy WHERE organizationId=?), ?)
      ON CONFLICT(organizationId) DO UPDATE SET oidcProviderId=excluded.oidcProviderId,
      verifiedDomains=excluded.verifiedDomains, enforceSso=excluded.enforceSso, updatedAt=excluded.updatedAt`)
      .run(input.organizationId, oidcProviderId ?? null, JSON.stringify([...new Set(verifiedDomains)]), enforceSso ? 1 : 0,
        current.scimTokenId ?? null, input.organizationId, updatedAt);
    return this.getOrganizationIdentityPolicy(input.organizationId);
  }

  rotateScimToken(organizationId: string): { token: string; policy: OrganizationIdentityPolicy } {
    if (!this.getOrganization(organizationId)) throw new Error('organization not found');
    const token = `ks_${crypto.randomBytes(32).toString('base64url')}`;
    const tokenId = newId('scim');
    const current = this.getOrganizationIdentityPolicy(organizationId);
    this.db.prepare(`INSERT INTO organization_identity_policy
      (organizationId, oidcProviderId, verifiedDomains, enforceSso, scimTokenId, scimTokenHash, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(organizationId) DO UPDATE SET
      scimTokenId=excluded.scimTokenId, scimTokenHash=excluded.scimTokenHash, updatedAt=excluded.updatedAt`)
      .run(organizationId, current.oidcProviderId ?? null, JSON.stringify(current.verifiedDomains), current.enforceSso ? 1 : 0,
        tokenId, sha256(token), Date.now());
    return { token, policy: this.getOrganizationIdentityPolicy(organizationId) };
  }

  verifyScimToken(organizationId: string, token: string): boolean {
    const row = this.db.prepare('SELECT scimTokenHash FROM organization_identity_policy WHERE organizationId=?').get(organizationId) as any;
    if (!row?.scimTokenHash || !token) return false;
    const actual = Buffer.from(sha256(token), 'hex');
    const expected = Buffer.from(row.scimTokenHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  deprovisionOrganizationUser(organizationId: string, userId: string): void {
    const projectIds = this.listProjects().filter((project) => project.organizationId === organizationId).map((project) => project.id);
    const teamIds = this.listTeams(organizationId).map((team) => team.id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const projectId of projectIds) {
        if (this.db.prepare('SELECT 1 FROM project_memberships WHERE projectId=? AND principalKey=?').get(projectId, `user:${userId}`))
          this.removeProjectMembership(projectId, { kind: 'user', userId });
      }
      this.removeOrganizationMembership(organizationId, userId);
      for (const teamId of teamIds) this.removeTeamMembership(teamId, userId);
      for (const projectId of projectIds)
        this.db.prepare('DELETE FROM principal_grants WHERE principalId=? AND scopeKey=?').run(`user:${userId}`, `project:${projectId}`);
      this.db.prepare('DELETE FROM principal_grants WHERE principalId=? AND scopeKey=?').run(`user:${userId}`, `organization:${organizationId}`);
      for (const row of this.db.prepare('SELECT tokenHash, json FROM scoped_tokens WHERE revokedAt IS NULL').all() as any[]) {
        try { if (JSON.parse(row.json).principal === `user:${userId}`) this.revokeScopedToken({ tokenHash: row.tokenHash }); } catch {}
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createOrganizationInvitation(input: { organizationId: string; email: string; role?: OrganizationMembership['role']; profileId?: string; invitedBy: string; ttlMs?: number }): { invitation: OrganizationInvitation; token: string } {
    if (!this.getOrganization(input.organizationId)) throw new Error(`no organization ${input.organizationId}`);
    const token = `ki_${crypto.randomBytes(24).toString('base64url')}`;
    const invitation: OrganizationInvitation = {
      id: newId('invite'), organizationId: input.organizationId, email: input.email.trim().toLowerCase(),
      role: input.role ?? 'member', profileId: input.profileId ?? 'developer', invitedBy: input.invitedBy, createdAt: Date.now(),
      expiresAt: Date.now() + (input.ttlMs ?? 7 * 24 * 60 * 60 * 1000),
    };
    this.db.prepare(`INSERT INTO organization_invitations
      (id, organizationId, email, role, profileId, tokenHash, invitedBy, createdAt, expiresAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        invitation.id, invitation.organizationId, invitation.email, invitation.role,
        invitation.profileId ?? 'developer', sha256(token), invitation.invitedBy, invitation.createdAt, invitation.expiresAt,
      );
    return { invitation, token };
  }

  acceptOrganizationInvitation(token: string, userId: string, email: string): OrganizationMembership & { profileId?: string } {
    const r = this.db.prepare('SELECT * FROM organization_invitations WHERE tokenHash=?').get(sha256(token)) as any;
    if (!r || r.acceptedAt) throw new Error('invitation is invalid or already used');
    if (r.expiresAt <= Date.now()) throw new Error('invitation has expired');
    if (String(r.email).toLowerCase() !== email.trim().toLowerCase()) throw new Error('invitation belongs to a different email address');
    const membership = this.setOrganizationMembership(r.organizationId, userId, r.role);
    this.db.prepare('UPDATE organization_invitations SET acceptedAt=? WHERE id=?').run(Date.now(), r.id);
    return { ...membership, profileId: r.profileId ?? 'developer' };
  }

  listOrganizationInvitations(organizationId: string): OrganizationInvitation[] {
    return (this.db.prepare('SELECT * FROM organization_invitations WHERE organizationId=? ORDER BY createdAt DESC').all(organizationId) as any[])
      .map((r) => ({ id: r.id, organizationId: r.organizationId, email: r.email, role: r.role, profileId: r.profileId ?? 'developer', invitedBy: r.invitedBy,
        createdAt: r.createdAt, expiresAt: r.expiresAt, acceptedAt: r.acceptedAt ?? undefined }));
  }

  createTeam(input: { organizationId: string; projectId?: string; name: string; slug?: string }): Team {
    const organization = this.getOrganization(input.organizationId);
    if (!organization) throw new Error(`no organization ${input.organizationId}`);
    if (input.projectId && this.getProject(input.projectId)?.organizationId !== organization.id) throw new Error('team project belongs to another organization');
    const name = input.name.trim();
    if (!name) throw new Error('team name is required');
    const slug = slugify(input.slug ?? input.name);
    // SQLite UNIQUE treats NULLs as distinct, so the table constraint alone
    // does not protect organization-wide teams (whose projectId is NULL). Make
    // creation idempotent and prevent double-click/network retries from drawing
    // the same team twice.
    const existing = this.db.prepare(`SELECT * FROM teams WHERE organizationId=?
      AND ((projectId IS NULL AND ? IS NULL) OR projectId=?) AND slug=? LIMIT 1`)
      .get(organization.id, input.projectId ?? null, input.projectId ?? null, slug) as any;
    if (existing) return rowToTeam(existing);
    const team: Team = { id: newId('team'), organizationId: organization.id, projectId: input.projectId,
      name, slug, createdAt: Date.now() };
    this.db.prepare('INSERT INTO teams (id, organizationId, projectId, name, slug, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(team.id, team.organizationId, team.projectId ?? null, team.name, team.slug, team.createdAt);
    return team;
  }

  listTeams(organizationId: string, projectId?: string): Team[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM teams WHERE organizationId=? AND (projectId IS NULL OR projectId=?) ORDER BY name, createdAt, rowid').all(organizationId, projectId)
      : this.db.prepare('SELECT * FROM teams WHERE organizationId=? ORDER BY name, createdAt, rowid').all(organizationId);
    // Deduplicate legacy organization-wide rows created before createTeam was
    // idempotent. Keep the oldest stable id so existing workflow routes remain
    // valid; hidden duplicates are harmless and can still resolve by id.
    const unique = new Map<string, Team>();
    for (const row of rows as any[]) {
      const team = rowToTeam(row);
      const key = `${team.projectId ?? ''}:${team.slug}`;
      if (!unique.has(key)) unique.set(key, team);
    }
    return [...unique.values()];
  }

  getTeam(id: string): Team | undefined {
    const r = this.db.prepare('SELECT * FROM teams WHERE id=?').get(id) as any;
    return r ? rowToTeam(r) : undefined;
  }

  updateTeam(id: string, input: { name: string }): Team {
    const team = this.getTeam(id);
    if (!team) throw new Error('team not found');
    const name = input.name.trim();
    if (!name) throw new Error('team name is required');
    const slug = slugify(name);
    const conflict = this.db.prepare(`SELECT id FROM teams WHERE organizationId=? AND id<>?
      AND ((projectId IS NULL AND ? IS NULL) OR projectId=?) AND slug=? LIMIT 1`)
      .get(team.organizationId, team.id, team.projectId ?? null, team.projectId ?? null, slug) as any;
    const aliasConflict = this.db.prepare(`SELECT teamId FROM team_aliases WHERE organizationId=? AND teamId<>?
      AND ((projectId IS NULL AND ? IS NULL) OR projectId=?) AND slug=? LIMIT 1`)
      .get(team.organizationId, team.id, team.projectId ?? null, team.projectId ?? null, slug) as any;
    if (conflict || aliasConflict) throw new Error(`a team already uses @team:${slug}`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (slug !== team.slug) this.db.prepare(`INSERT OR IGNORE INTO team_aliases
        (teamId, organizationId, projectId, slug, createdAt) VALUES (?, ?, ?, ?, ?)`)
        .run(team.id, team.organizationId, team.projectId ?? null, team.slug, Date.now());
      this.db.prepare('UPDATE teams SET name=?, slug=? WHERE id=?').run(name, slug, team.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ...team, name, slug };
  }

  deleteTeam(id: string): void {
    const team = this.getTeam(id);
    if (!team) throw new Error('team not found');
    const selectors = [`team:${team.id}`, `@team:${team.slug}`,
      ...(this.db.prepare('SELECT slug FROM team_aliases WHERE teamId=?').all(team.id) as any[])
        .map((row) => `@team:${String(row.slug)}`)];
    const projectUse = this.db.prepare('SELECT COUNT(*) count FROM project_memberships WHERE principalKey=?')
      .get(`team:${team.id}`) as any;
    const projectIds = (this.db.prepare('SELECT id FROM projects WHERE organizationId=?').all(team.organizationId) as any[])
      .map((row) => String(row.id));
    const settingScopes = new Set([`organization:${team.organizationId}`, `quick:organization:${team.organizationId}`,
      ...projectIds, ...projectIds.map((projectId) => `quick:${projectId}`)]);
    const settingUse = (this.db.prepare('SELECT scopeKey, json FROM settings').all() as any[])
      .some((row) => settingScopes.has(String(row.scopeKey)) && selectors.some((selector) => String(row.json).includes(selector)));
    const unfinishedUse = (this.db.prepare(`SELECT params, lastView FROM tasks t JOIN projects p ON p.id=t.projectId
      WHERE p.organizationId=?`).all(team.organizationId) as any[]).some((row) => {
        let done = false;
        try { done = ['done', 'failed', 'cancelled'].includes(String(JSON.parse(row.lastView ?? '{}').status)); } catch {}
        return !done && selectors.some((selector) => String(row.params).includes(selector) || String(row.lastView).includes(selector));
      });
    if (Number(projectUse?.count ?? 0) || settingUse || unfinishedUse)
      throw new Error('This team is still used by project access or a workflow route. Remove those references before deleting it.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM task_subscribers WHERE principalKey=?').run(`team:${team.id}`);
      this.db.prepare('DELETE FROM team_memberships WHERE teamId=?').run(team.id);
      this.db.prepare('DELETE FROM team_aliases WHERE teamId=?').run(team.id);
      this.db.prepare('DELETE FROM teams WHERE id=?').run(team.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private teamByRoute(organizationId: string, projectId: string, slug: string): Team | undefined {
    const current = this.db.prepare(`SELECT * FROM teams WHERE organizationId=? AND slug=? AND (projectId=? OR projectId IS NULL)
      ORDER BY CASE WHEN projectId=? THEN 0 ELSE 1 END, createdAt LIMIT 1`)
      .get(organizationId, slug, projectId, projectId) as any;
    if (current) return rowToTeam(current);
    const alias = this.db.prepare(`SELECT t.* FROM team_aliases a JOIN teams t ON t.id=a.teamId
      WHERE a.organizationId=? AND a.slug=? AND (a.projectId=? OR a.projectId IS NULL)
      ORDER BY CASE WHEN a.projectId=? THEN 0 ELSE 1 END, a.createdAt DESC LIMIT 1`)
      .get(organizationId, slug, projectId, projectId) as any;
    return alias ? rowToTeam(alias) : undefined;
  }

  setTeamMembership(teamId: string, userId: string): TeamMembership {
    const team = this.getTeam(teamId);
    if (!team) throw new Error(`no team ${teamId}`);
    if (!this.organizationMembership(team.organizationId, userId))
      throw new Error('a team member must belong to the organization');
    const joinedAt = Date.now();
    this.db.prepare(`INSERT INTO team_memberships (teamId, userId, role, joinedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(teamId, userId) DO UPDATE SET role=excluded.role`).run(teamId, userId, 'member', joinedAt);
    return { teamId, userId, role: 'member', joinedAt };
  }

  listTeamMemberships(teamId: string): TeamMembership[] {
    return this.db.prepare('SELECT * FROM team_memberships WHERE teamId=? ORDER BY joinedAt').all(teamId) as any[];
  }

  removeTeamMembership(teamId: string, userId: string): void {
    this.db.prepare('DELETE FROM team_memberships WHERE teamId=? AND userId=?').run(teamId, userId);
  }

  setProjectMembership(projectId: string, principal: ProjectPrincipalRef, role: ProjectMembership['role']): ProjectMembership {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    this.assertPrincipalInOrganization(principal, project.organizationId!);
    const key = principalKey(principal);
    const existing = this.db.prepare('SELECT role FROM project_memberships WHERE projectId=? AND principalKey=?').get(projectId, key) as any;
    if (existing?.role === 'owner' && role !== 'owner') {
      const owners = Number((this.db.prepare("SELECT COUNT(*) n FROM project_memberships WHERE projectId=? AND role='owner'")
        .get(projectId) as any).n);
      if (owners <= 1) throw new Error('a project must retain at least one owner');
    }
    const joinedAt = Date.now();
    this.db.prepare(`INSERT INTO project_memberships (projectId, principalKey, principal, role, joinedAt)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(projectId, principalKey) DO UPDATE SET role=excluded.role`)
      .run(projectId, key, JSON.stringify(principal), role, joinedAt);
    return { projectId, principal, role, joinedAt };
  }

  listProjectMemberships(projectId: string): ProjectMembership[] {
    return (this.db.prepare('SELECT * FROM project_memberships WHERE projectId=? ORDER BY joinedAt').all(projectId) as any[])
      .map((r) => ({ projectId: r.projectId, principal: JSON.parse(r.principal), role: r.role, joinedAt: r.joinedAt }));
  }

  removeProjectMembership(projectId: string, principal: ProjectPrincipalRef): void {
    const key = principalKey(principal);
    const row = this.db.prepare('SELECT role FROM project_memberships WHERE projectId=? AND principalKey=?')
      .get(projectId, key) as any;
    if (row?.role === 'owner') {
      const owners = Number((this.db.prepare("SELECT COUNT(*) n FROM project_memberships WHERE projectId=? AND role='owner'")
        .get(projectId) as any).n);
      if (owners <= 1) throw new Error('a project must retain at least one owner');
    }
    this.db.prepare('DELETE FROM project_memberships WHERE projectId=? AND principalKey=?').run(projectId, key);
  }

  userIsProjectMember(projectId: string, userId: string): boolean {
    if (this.db.prepare('SELECT 1 FROM project_memberships WHERE projectId=? AND principalKey=?').get(projectId, `user:${userId}`)) return true;
    const organizationId = this.getProject(projectId)?.organizationId;
    if (organizationId && this.organizationMembership(organizationId, userId)
      && this.db.prepare('SELECT 1 FROM project_memberships WHERE projectId=? AND principalKey=?').get(projectId, `organization:${organizationId}`)) return true;
    return !!this.db.prepare(`SELECT 1 FROM project_memberships p JOIN team_memberships tm
      ON p.principalKey=('team:' || tm.teamId) WHERE p.projectId=? AND tm.userId=? LIMIT 1`).get(projectId, userId);
  }

  private assertPrincipalInOrganization(principal: ProjectPrincipalRef, organizationId: string): void {
    if (principal.kind === 'user' && !this.organizationMembership(organizationId, principal.userId))
      throw new Error('user is not a member of the project organization');
    if (principal.kind === 'team' && this.getTeam(principal.teamId)?.organizationId !== organizationId)
      throw new Error('team belongs to another organization');
    if (principal.kind === 'organization' && principal.organizationId !== organizationId)
      throw new Error('organization principal belongs to another organization');
    if (principal.kind === 'task-agent') {
      const project = this.getProject(this.getTask(principal.taskId)?.projectId ?? '');
      if (project?.organizationId !== organizationId) throw new Error('task agent belongs to another organization');
    }
  }

  upsertGitConnection(input: Omit<GitConnection, 'id' | 'createdAt'> & { id?: string }): GitConnection {
    const existing = this.db.prepare('SELECT id, organizationId, createdAt FROM git_connections WHERE provider=? AND installationId=?')
      .get(input.provider, input.installationId) as any;
    if (existing && existing.organizationId !== input.organizationId)
      throw new Error('GitHub installation is already connected to another organization');
    const connection: GitConnection = { ...input, id: input.id ?? existing?.id ?? newId('gitconn'), createdAt: existing?.createdAt ?? Date.now() };
    this.db.prepare(`INSERT INTO git_connections (id, organizationId, provider, installationId, accountLogin, accountType, createdAt, suspendedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, installationId) DO UPDATE SET
      organizationId=excluded.organizationId, accountLogin=excluded.accountLogin, accountType=excluded.accountType, suspendedAt=excluded.suspendedAt`)
      .run(connection.id, connection.organizationId, connection.provider, connection.installationId, connection.accountLogin,
        connection.accountType ?? null, connection.createdAt, connection.suspendedAt ?? null);
    return connection;
  }

  getGitConnection(id: string): GitConnection | undefined {
    const r = this.db.prepare('SELECT * FROM git_connections WHERE id=?').get(id) as any;
    return r ? rowToGitConnection(r) : undefined;
  }

  listGitConnections(organizationId: string): GitConnection[] {
    return (this.db.prepare('SELECT * FROM git_connections WHERE organizationId=? ORDER BY createdAt').all(organizationId) as any[]).map(rowToGitConnection);
  }

  upsertRepository(input: Omit<Repository, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Repository {
    if (!/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(input.sshUrl)) throw new Error('repository must use a GitHub SSH URL');
    const existing = this.db.prepare('SELECT id, createdAt FROM repositories WHERE organizationId=? AND provider=? AND owner=? AND name=?')
      .get(input.organizationId, input.provider, input.owner, input.name) as any;
    const now = Date.now();
    const repository: Repository = { ...input, id: input.id ?? existing?.id ?? newId('repo'), createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.db.prepare(`INSERT INTO repositories (id, organizationId, provider, providerId, owner, name, sshUrl, defaultBranch, private, gitConnectionId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(organizationId, provider, owner, name) DO UPDATE SET
      providerId=excluded.providerId, sshUrl=excluded.sshUrl, defaultBranch=excluded.defaultBranch,
      private=excluded.private, gitConnectionId=excluded.gitConnectionId, updatedAt=excluded.updatedAt`)
      .run(repository.id, repository.organizationId, repository.provider, repository.providerId ?? null, repository.owner, repository.name,
        repository.sshUrl, repository.defaultBranch, repository.private ? 1 : 0, repository.gitConnectionId ?? null,
        repository.createdAt, repository.updatedAt);
    return repository;
  }

  getRepository(id: string): Repository | undefined {
    const r = this.db.prepare('SELECT * FROM repositories WHERE id=?').get(id) as any;
    return r ? rowToRepository(r) : undefined;
  }

  listRepositories(organizationId: string): Repository[] {
    return (this.db.prepare('SELECT * FROM repositories WHERE organizationId=? ORDER BY owner, name').all(organizationId) as any[]).map(rowToRepository);
  }

  findRepositoryBySshUrl(organizationId: string, sshUrl: string): Repository | undefined {
    const r = this.db.prepare('SELECT * FROM repositories WHERE organizationId=? AND sshUrl=?').get(organizationId, sshUrl) as any;
    return r ? rowToRepository(r) : undefined;
  }

  deleteRepository(id: string): void {
    const projects = (this.db.prepare('SELECT DISTINCT projectId FROM project_repositories WHERE repositoryId=?').all(id) as any[])
      .map((r) => String(r.projectId));
    this.db.prepare('DELETE FROM project_repositories WHERE repositoryId=?').run(id);
    this.db.prepare('DELETE FROM repository_deploy_keys WHERE repositoryId=?').run(id);
    this.db.prepare('DELETE FROM repositories WHERE id=?').run(id);
    for (const projectId of projects) this.syncProjectRepositoryConfig(projectId);
  }

  setRepositoryDeployKeys(input: { repositoryId: string; cloneKeyId: string; writeKeyId: string; cloneHandle: string; writeHandle: string }): void {
    this.db.prepare(`INSERT INTO repository_deploy_keys
      (repositoryId, cloneKeyId, writeKeyId, cloneHandle, writeHandle, createdAt) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repositoryId) DO UPDATE SET cloneKeyId=excluded.cloneKeyId, writeKeyId=excluded.writeKeyId,
      cloneHandle=excluded.cloneHandle, writeHandle=excluded.writeHandle, createdAt=excluded.createdAt`)
      .run(input.repositoryId, input.cloneKeyId, input.writeKeyId, input.cloneHandle, input.writeHandle, Date.now());
  }

  repositoryDeployKeys(repositoryId: string): { repositoryId: string; cloneKeyId: string; writeKeyId: string; cloneHandle: string; writeHandle: string; createdAt: number } | undefined {
    return this.db.prepare('SELECT * FROM repository_deploy_keys WHERE repositoryId=?').get(repositoryId) as any;
  }

  recordGithubDelivery(deliveryId: string, event: string): boolean {
    const info = this.db.prepare('INSERT OR IGNORE INTO github_webhook_deliveries (deliveryId, event, receivedAt) VALUES (?, ?, ?)')
      .run(deliveryId, event, Date.now());
    return Number(info.changes) === 1;
  }

  /** One-time, user-bound state for GitHub's browser installation callback.
   * Only its SHA-256 digest is durable, so a database read cannot mint a valid
   * callback. The state is consumed atomically before any GitHub API call. */
  createGithubInstallState(organizationId: string, userId: string, ttlMs = 10 * 60_000): string {
    if (!this.organizationMembership(organizationId, userId)) throw new Error('user is not an organization member');
    const state = `kg_${crypto.randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    this.db.prepare('DELETE FROM github_install_states WHERE expiresAt<=? OR usedAt IS NOT NULL').run(now);
    this.db.prepare(`INSERT INTO github_install_states
      (tokenHash, organizationId, userId, createdAt, expiresAt, usedAt) VALUES (?, ?, ?, ?, ?, NULL)`)
      .run(sha256(state), organizationId, userId, now, now + Math.max(60_000, ttlMs));
    return state;
  }

  consumeGithubInstallState(state: string, userId: string): { organizationId: string } | undefined {
    const hash = sha256(state);
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT organizationId, userId FROM github_install_states
        WHERE tokenHash=? AND usedAt IS NULL AND expiresAt>?`).get(hash, now) as any;
      if (!row || row.userId !== userId) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      this.db.prepare('UPDATE github_install_states SET usedAt=? WHERE tokenHash=? AND usedAt IS NULL').run(now, hash);
      this.db.exec('COMMIT');
      return { organizationId: String(row.organizationId) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  attachProjectRepository(input: Omit<ProjectRepository, 'order'> & { order?: number }): ProjectRepository {
    const project = this.getProject(input.projectId);
    const repository = this.getRepository(input.repositoryId);
    if (!project || !repository || project.organizationId !== repository.organizationId) throw new Error('project and repository must belong to the same organization');
    const baseBranch = input.baseBranch?.trim() || undefined;
    const targetBranch = input.targetBranch?.trim() || undefined;
    if (baseBranch && !validGitBranch(baseBranch)) throw new Error('invalid repository base branch');
    if (targetBranch && !validGitBranch(targetBranch)) throw new Error('invalid repository target branch');
    const order = input.order ?? Number((this.db.prepare('SELECT COALESCE(MAX(ord),-1)+1 n FROM project_repositories WHERE projectId=?').get(input.projectId) as any).n);
    this.db.prepare(`INSERT INTO project_repositories (projectId, repositoryId, baseBranch, targetBranch, ord)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(projectId, repositoryId) DO UPDATE SET
      baseBranch=excluded.baseBranch, targetBranch=excluded.targetBranch, ord=excluded.ord`)
      .run(input.projectId, input.repositoryId, baseBranch ?? null, targetBranch ?? null, order);
    this.syncProjectRepositoryConfig(input.projectId);
    return { ...input, baseBranch, targetBranch, order };
  }

  listProjectRepositories(projectId: string): Array<ProjectRepository & { repository: Repository }> {
    return (this.db.prepare(`SELECT pr.*, r.*,
      pr.projectId AS prProjectId, pr.repositoryId AS prRepositoryId, pr.baseBranch AS prBaseBranch,
      pr.targetBranch AS prTargetBranch, pr.ord AS prOrd FROM project_repositories pr
      JOIN repositories r ON r.id=pr.repositoryId WHERE pr.projectId=? ORDER BY pr.ord`).all(projectId) as any[])
      .map((r) => ({ projectId: r.prProjectId, repositoryId: r.prRepositoryId, baseBranch: r.prBaseBranch ?? undefined,
        targetBranch: r.prTargetBranch ?? undefined, order: r.prOrd, repository: rowToRepository(r) }));
  }

  detachProjectRepository(projectId: string, repositoryId: string): void {
    this.db.prepare('DELETE FROM project_repositories WHERE projectId=? AND repositoryId=?').run(projectId, repositoryId);
    this.syncProjectRepositoryConfig(projectId);
  }

  /** Canonical local/self-hosted repository editor. Workflow settings retain a
   * repos field on the wire for old clients, but the product UI edits repository
   * sources once at project scope. Keep existing workflow rows synchronized so
   * a stale per-workflow overlay cannot override the project source list. */
  setProjectRepositorySources(projectId: string, repos: string[]): Project {
    const sources = [...new Set(repos.map((repo) => repo.trim()).filter(Boolean))];
    const projectBefore = this.getProject(projectId);
    if (!projectBefore) throw new Error(`no project ${projectId}`);
    // A catalog SSH URL carries its GitHub connection/deploy-key metadata. Keep
    // those attachments synchronized automatically; users edit one plain list.
    const catalog = projectBefore.organizationId ? this.listRepositories(projectBefore.organizationId) : [];
    const wanted = new Map(catalog.filter((repository) => sources.includes(repository.sshUrl)).map((repository) => [repository.id, repository]));
    for (const attachment of this.listProjectRepositories(projectId))
      if (!wanted.has(attachment.repositoryId)) this.db.prepare('DELETE FROM project_repositories WHERE projectId=? AND repositoryId=?').run(projectId, attachment.repositoryId);
    let order = 0;
    for (const repository of wanted.values()) this.db.prepare(`INSERT INTO project_repositories
      (projectId, repositoryId, baseBranch, targetBranch, ord) VALUES (?, ?, NULL, NULL, ?)
      ON CONFLICT(projectId, repositoryId) DO UPDATE SET ord=excluded.ord`).run(projectId, repository.id, order++);
    const project = this.updateProjectConfig(projectId, { repos: sources });
    this.syncProjectRepositorySettings(projectId, sources);
    return project;
  }

  private syncProjectRepositoryConfig(projectId: string): void {
    const linked = this.listProjectRepositories(projectId);
    const project = this.getProject(projectId);
    if (!project) return;
    const first = linked[0];
    const base = first?.baseBranch ?? first?.repository.defaultBranch;
    const target = first?.targetBranch ?? base;
    const { defaultBase: _oldBase, defaultTarget: _oldTarget, ...config } = project.config;
    const repos = linked.map((x) => x.repository.sshUrl);
    this.updateProjectConfig(projectId, {
      ...config,
      repos,
      ...(base ? { defaultBase: base } : {}),
      ...(target ? { defaultTarget: target } : {}),
    });
    this.syncProjectRepositorySettings(projectId, repos);
  }

  private syncProjectRepositorySettings(projectId: string, repos: string[]): void {
    for (const row of this.db.prepare('SELECT scopeKey, workflow, json FROM settings WHERE scopeKey IN (?, ?)')
      .all(projectId, `quick:${projectId}`) as any[]) {
      const values = JSON.parse(String(row.json)) as Record<string, unknown>;
      if (repos.length) values.repos = repos;
      else delete values.repos;
      this.db.prepare('UPDATE settings SET json=? WHERE scopeKey=? AND workflow=?')
        .run(JSON.stringify(values), String(row.scopeKey), String(row.workflow));
    }
  }

  // ─── Task lists ──────────────────────────────────────────────────────────────

  createList(projectId: string, name: string): TaskList {
    const ord =
      (this.db
        .prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM task_lists WHERE projectId = ?')
        .get(projectId) as any).m + 1;
    const l: TaskList = { id: newId('list'), projectId, name, createdAt: Date.now(), order: ord };
    this.db
      .prepare('INSERT INTO task_lists (id, projectId, name, createdAt, ord) VALUES (?, ?, ?, ?, ?)')
      .run(l.id, l.projectId, l.name, l.createdAt, l.order);
    return l;
  }

  listLists(projectId: string): TaskList[] {
    return (
      this.db
        .prepare('SELECT * FROM task_lists WHERE projectId = ? ORDER BY ord')
        .all(projectId) as any[]
    ).map(rowToList);
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────────

  createTask(input: {
    projectId: string;
    listId?: string;
    title: string;
    workflow: string;
    workflowVersion: string;
    params: TaskParams;
    parentTaskId?: string;
    createdBy?: PrincipalRef;
    assignee?: PrincipalRef;
    delegate?: PrincipalRef;
    confirmationPolicy?: ConfirmationPolicy;
    /** Existing logical task when creating an alternate attempt. */
    intentId?: string;
    /** Effective confirmer snapshot, recorded once for a new logical task. */
    confirmer?: unknown;
  }): TaskRecord {
    const listId =
      input.listId ?? this.listLists(input.projectId)[0]?.id ?? this.createList(input.projectId, 'Tasks').id;
    const ord =
      (this.db
        .prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM tasks WHERE listId = ?')
        .get(listId) as any).m + 1;
    const id = newId('task');
    const intentId = input.intentId ?? id;
    const attemptNumber = input.intentId
      ? Number((this.db.prepare('SELECT COALESCE(MAX(attemptNumber), 0) AS n FROM tasks WHERE intentId = ?').get(intentId) as any).n) + 1
      : 1;
    const t: TaskRecord = {
      id,
      intentId,
      attemptNumber,
      num: input.intentId ? undefined : this.nextTaskNum(input.projectId),
      projectId: input.projectId,
      listId,
      title: input.title,
      workflow: input.workflow,
      workflowVersion: input.workflowVersion,
      params: input.params,
      createdAt: Date.now(),
      order: ord,
      parentTaskId: input.parentTaskId,
      createdBy: input.createdBy,
      assignee: input.assignee,
      delegate: input.delegate,
      confirmationPolicy: input.confirmationPolicy,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, num, projectId, listId, title, workflow, workflowVersion, params, createdAt, ord, parentTaskId, lastView, notes, intentId, attemptNumber, createdBy, assignee, delegate, confirmationPolicy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.num ?? null,
        t.projectId,
        t.listId,
        t.title,
        t.workflow,
        t.workflowVersion,
        JSON.stringify(t.params),
        t.createdAt,
        t.order,
        t.parentTaskId ?? null,
        null,
        null,
        intentId,
        attemptNumber,
        jsonOrNull(t.createdBy),
        jsonOrNull(t.assignee),
        jsonOrNull(t.delegate),
        jsonOrNull(t.confirmationPolicy),
      );
    if (t.createdBy?.kind === 'user') this.subscribeTask(t.id, t.createdBy);
    if (t.assignee) this.subscribeTask(t.id, t.assignee);
    if (!input.intentId) {
      this.db.prepare('INSERT INTO task_intents (id, principalAttemptId, confirmer, createdAt) VALUES (?, ?, ?, ?)')
        .run(intentId, id, input.confirmer === undefined ? null : JSON.stringify(input.confirmer), t.createdAt);
    }
    return t;
  }

  attemptsOf(taskOrIntentId: string): TaskRecord[] {
    const t = this.getTask(taskOrIntentId);
    const intentId = t?.intentId ?? taskOrIntentId;
    return (this.db.prepare(`SELECT t.*, COALESCE(t.num, root.num) AS resolvedNum FROM tasks t
      LEFT JOIN tasks root ON root.id=t.intentId WHERE t.intentId = ? ORDER BY t.attemptNumber`).all(intentId) as any[]).map(rowToTask);
  }

  attemptGroup(taskOrIntentId: string): { intentId: string; principalAttemptId: string; committedAttemptId?: string; confirmer?: unknown; attempts: TaskRecord[] } | undefined {
    const t = this.getTask(taskOrIntentId);
    const intentId = t?.intentId ?? taskOrIntentId;
    const r = this.db.prepare('SELECT * FROM task_intents WHERE id = ?').get(intentId) as any;
    if (!r) return undefined;
    return { intentId, principalAttemptId: r.principalAttemptId, committedAttemptId: r.committedAttemptId ?? undefined,
      confirmer: r.confirmer == null ? undefined : JSON.parse(r.confirmer), attempts: this.attemptsOf(intentId) };
  }

  /** One row per logical task: only the current principal appears in list/search. */
  listPrincipalTasks(projectId: string): TaskRecord[] {
    const rows = this.db.prepare(`SELECT t.*, COALESCE(t.num, root.num) AS resolvedNum FROM tasks t
      JOIN task_intents i ON i.principalAttemptId=t.id JOIN tasks root ON root.id=i.id
      WHERE t.projectId=? ORDER BY root.ord,root.createdAt`).all(projectId) as any[];
    return this.attachTags(projectId, rows.map(rowToTask));
  }

  /** Atomically reserve the logical task at Merge entry. Returns siblings to cancel. */
  claimAttempt(taskId: string): { accepted: boolean; cancel: string[] } {
    const t = this.getTask(taskId);
    if (!t?.intentId) return { accepted: true, cancel: [] };
    const info = this.db.prepare('UPDATE task_intents SET committedAttemptId=?, principalAttemptId=? WHERE id=? AND committedAttemptId IS NULL')
      .run(taskId, taskId, t.intentId);
    const group = this.attemptGroup(t.intentId)!;
    if (!Number(info.changes) && group.committedAttemptId !== taskId) return { accepted: false, cancel: [taskId] };
    return { accepted: true, cancel: group.attempts.filter((a) => a.id !== taskId && a.lastView?.status !== 'cancelled').map((a) => a.id) };
  }

  markDraftSuperseded(taskId: string, winnerId: string) {
    const t = this.getTask(taskId);
    if (!t?.params.draft) return;
    const view: TaskView = {
      taskId, title: t.title, workflow: t.workflow, stage: 'cancelled', status: 'cancelled',
      messages: [], actions: [], state: { supersededBy: winnerId }, updatedAt: Date.now(),
    };
    this.updateTaskParams(taskId, { ...t.params, draft: false, archived: true });
    this.saveView(taskId, view);
  }

  /** Re-elect after principal cancellation. Drafts and live attempts are eligible. */
  electPrincipal(intentId: string) {
    const g = this.attemptGroup(intentId);
    if (!g || g.committedAttemptId) return;
    const eligible = g.attempts.find((a) => a.lastView?.status !== 'cancelled' && a.lastView?.status !== 'failed');
    if (eligible) this.db.prepare('UPDATE task_intents SET principalAttemptId=? WHERE id=?').run(eligible.id, intentId);
  }

  setIntentConfirmer(intentId: string, field: string, confirmer: unknown) {
    const attempts = this.attemptsOf(intentId);
    const group = this.attemptGroup(intentId);
    if (attempts.some((a) => !a.params.draft)) {
      // Full-form replacement includes disabled controls too. Re-sending the
      // existing shared value is harmless; only an actual divergence is locked.
      if (JSON.stringify(group?.confirmer) === JSON.stringify(confirmer)) return;
      throw new Error('the confirmer is shared and freezes when any attempt is queued');
    }
    this.db.prepare('UPDATE task_intents SET confirmer=? WHERE id=?').run(JSON.stringify(confirmer), intentId);
    for (const a of attempts) this.updateTaskParams(a.id, { ...a.params, [field]: confirmer });
  }

  getTask(id: string): TaskRecord | undefined {
    const r = this.db.prepare(`SELECT t.*, COALESCE(t.num, root.num) AS resolvedNum FROM tasks t
      LEFT JOIN tasks root ON root.id=t.intentId WHERE t.id = ?`).get(id) as any;
    if (!r) return undefined;
    const t = rowToTask(r);
    const tags = this.tagsFor(id);
    if (tags.length) t.tags = tags;
    t.subscribers = this.subscribersFor(id);
    if (t.confirmationPolicy) t.reviewers = this.reviewAudience(t);
    return t;
  }

  /** Resolve a task by its per-project sequential number (SPEC §10.6). */
  getTaskByNum(projectId: string, num: number): TaskRecord | undefined {
    const r = this.db.prepare(`SELECT i.principalAttemptId AS id FROM tasks root
      JOIN task_intents i ON i.id=root.intentId WHERE root.projectId=? AND root.num=?`).get(projectId, num) as any;
    return r ? this.getTask(r.id) : undefined;
  }

  listTasks(projectId: string): TaskRecord[] {
    const tasks = (
      this.db
        .prepare('SELECT * FROM tasks WHERE projectId = ? ORDER BY ord, createdAt')
        .all(projectId) as any[]
    ).map(rowToTask);
    return this.attachTags(projectId, tasks);
  }

  /** Tasks currently armed on a trigger (stored-not-started), across all projects.
   *  The durable source of truth the dispatcher re-arms from on boot (SPEC §3.3). */
  listArmedTasks(): TaskRecord[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY createdAt').all() as any[])
      .map(rowToTask)
      .filter((t) => t.params?.triggerState === 'armed');
  }

  /** Runs spawned from a series (repeatable template), newest first. */
  runsOf(seriesId: string): TaskRecord[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC').all() as any[])
      .map(rowToTask)
      .filter((t) => t.params?.runOf === seriesId);
  }

  childTasks(parentTaskId: string): TaskRecord[] {
    const tasks = (
      this.db.prepare('SELECT * FROM tasks WHERE parentTaskId = ? ORDER BY createdAt').all(parentTaskId) as any[]
    ).map(rowToTask);
    for (const t of tasks) {
      const tags = this.tagsFor(t.id);
      if (tags.length) t.tags = tags;
    }
    return tasks;
  }

  /** Hydrate `tags` onto a batch of a project's tasks with a single join query (no N+1). */
  private attachTags(projectId: string, tasks: TaskRecord[]): TaskRecord[] {
    if (!tasks.length) return tasks;
    const rows = this.db
      .prepare('SELECT tt.taskId AS taskId, tt.tagId AS tagId FROM task_tags tt JOIN tasks t ON t.id = tt.taskId WHERE t.projectId = ?')
      .all(projectId) as any[];
    const byTask = new Map<string, string[]>();
    for (const r of rows) (byTask.get(r.taskId) ?? byTask.set(r.taskId, []).get(r.taskId)!).push(r.tagId);
    for (const t of tasks) { const ids = byTask.get(t.id); if (ids?.length) t.tags = ids; }
    const subscribers = this.db.prepare(`SELECT s.taskId, s.principal FROM task_subscribers s
      JOIN tasks t ON t.id=s.taskId WHERE t.projectId=? ORDER BY s.createdAt`).all(projectId) as any[];
    const bySubscriber = new Map<string, PrincipalRef[]>();
    for (const r of subscribers) (bySubscriber.get(r.taskId) ?? bySubscriber.set(r.taskId, []).get(r.taskId)!).push(JSON.parse(r.principal));
    for (const t of tasks) {
      t.subscribers = bySubscriber.get(t.id) ?? [];
      if (t.confirmationPolicy) t.reviewers = this.reviewAudience(t);
    }
    return tasks;
  }

  saveView(taskId: string, view: TaskView) {
    // Auto-archive on resolution: the moment a task reaches a terminal, no-further-
    // action status (done or cancelled) it drops out of the default active list
    // without a manual archive step — the same effect the /archive endpoint has, but
    // automatic. Failed tasks are deliberately left visible (they usually need a look).
    // Fire only on the *transition* into that status (previous snapshot wasn't
    // already done/cancelled) so a later view re-save can't override a user who
    // deliberately un-archived a finished task.
    const prev = this.getTask(taskId);
    this.db.prepare('UPDATE tasks SET lastView = ? WHERE id = ?').run(JSON.stringify(view), taskId);
    if (view.stage === 'review' && view.status === 'waiting'
      && (prev?.lastView?.stage !== 'review' || prev.lastView.status !== 'waiting') && prev?.confirmationPolicy) {
      this.beginConfirmationCycle(taskId, prev.confirmationPolicy);
    }
    if (view.status === 'cancelled' || view.status === 'failed') {
      const t = this.getTask(taskId);
      if (t?.intentId) this.electPrincipal(t.intentId);
    }
    const resolvedNow =
      AUTO_ARCHIVE_STATUS.has(view.status) && !AUTO_ARCHIVE_STATUS.has(prev?.lastView?.status ?? '');
    if (prev && resolvedNow && !prev.params?.archived) {
      this.updateTaskParams(taskId, { ...prev.params, archived: true });
    }
  }

  reorderTask(taskId: string, ord: number) {
    this.db.prepare('UPDATE tasks SET ord = ? WHERE id = ?').run(ord, taskId);
  }

  updateTaskParams(taskId: string, params: TaskParams) {
    this.db.prepare('UPDATE tasks SET params = ? WHERE id = ?').run(JSON.stringify(params), taskId);
  }

  /** Re-pin a terminal task when recovery deliberately migrates it to a newer
   * compatible workflow implementation. Ordinary starts never rewrite pins. */
  setTaskWorkflowVersion(taskId: string, workflowVersion: string) {
    this.db.prepare('UPDATE tasks SET workflowVersion = ? WHERE id = ?').run(workflowVersion, taskId);
  }

  /** Update a task's display title (e.g. to track an edited prompt). */
  setTaskTitle(taskId: string, title: string) {
    if (title) this.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title, taskId);
  }

  /** Set the human notes on a task (cosmetic, UI-only; empty string clears them). */
  setTaskNotes(taskId: string, notes: string) {
    this.db.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run(notes === '' ? null : notes, taskId);
  }

  /**
   * Set the organizational priority (0–4) on a task's stored params. Purely for
   * search/sort/grouping — never sent to any agent, so it's editable at any point in
   * the lifecycle (unlike workflow params, which freeze at queue time). Writes the
   * record directly; the running workflow neither reads nor cares about it.
   */
  setTaskPriority(taskId: string, priority: number) {
    const t = this.getTask(taskId);
    if (!t) return;
    const p = Math.max(0, Math.min(4, Math.round(priority)));
    this.updateTaskParams(taskId, { ...t.params, priority: p });
  }

  /** Mark a draft task as queued (clear its draft flag). */
  clearDraft(taskId: string) {
    const t = this.getTask(taskId);
    if (!t) return;
    this.updateTaskParams(taskId, { ...t.params, draft: false });
  }

  /** Hard-delete a task row + its events (used for drafts, which never ran). */
  deleteTask(taskId: string) {
    const prior = this.getTask(taskId);
    const siblings = prior?.intentId ? this.attemptsOf(prior.intentId) : [];
    // The first attempt's id is also the permanent logical-task id/number. Once
    // alternates exist, preserve that anchor as cancelled history instead of
    // deleting it out from under the intent.
    if (prior && prior.id === prior.intentId && siblings.length > 1) {
      this.updateTaskParams(taskId, { ...prior.params, draft: false, archived: true });
      this.saveView(taskId, { taskId, title: prior.title, workflow: prior.workflow, stage: 'cancelled', status: 'cancelled', messages: [], actions: [], state: { deletedDraft: true }, updatedAt: Date.now() });
      return;
    }
    this.db.prepare('DELETE FROM events WHERE taskId = ?').run(taskId);
    this.db.prepare('DELETE FROM task_tags WHERE taskId = ?').run(taskId);
    this.db.prepare('DELETE FROM task_subscribers WHERE taskId = ?').run(taskId);
    this.db.prepare('DELETE FROM inbox WHERE taskId = ?').run(taskId);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    if (prior?.intentId) {
      const left = this.attemptsOf(prior.intentId);
      if (!left.length) this.db.prepare('DELETE FROM task_intents WHERE id = ?').run(prior.intentId);
      else this.electPrincipal(prior.intentId);
    }
  }

  // ─── Task responsibility and inbox ───────────────────────────────

  setTaskResponsibility(taskId: string, patch: {
    assignee?: PrincipalRef | null;
    delegate?: PrincipalRef | null;
    confirmationPolicy?: ConfirmationPolicy | null;
  }): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    const organizationId = this.getProject(task.projectId)?.organizationId!;
    if (patch.assignee) this.assertPrincipalInOrganization(patch.assignee, organizationId);
    if (patch.delegate) this.assertPrincipalInOrganization(patch.delegate, organizationId);
    if (patch.confirmationPolicy) {
      validateConfirmationPolicy(patch.confirmationPolicy);
      for (const target of patch.confirmationPolicy.targets) {
        if (target.kind === 'project-role') {
          if (target.projectId !== task.projectId) throw new Error('confirmation project role belongs to another project');
        } else this.assertPrincipalInOrganization(target, organizationId);
      }
    }
    const assignee = patch.assignee === undefined ? task.assignee : patch.assignee ?? undefined;
    const delegate = patch.delegate === undefined ? task.delegate : patch.delegate ?? undefined;
    const confirmationPolicy = patch.confirmationPolicy === undefined ? task.confirmationPolicy : patch.confirmationPolicy ?? undefined;
    this.db.prepare('UPDATE tasks SET assignee=?, delegate=?, confirmationPolicy=? WHERE id=?')
      .run(jsonOrNull(assignee), jsonOrNull(delegate), jsonOrNull(confirmationPolicy), taskId);
    if (assignee) this.subscribeTask(taskId, assignee);
    this.appendEvent({ taskId, type: 'task.responsibility-changed', ts: Date.now(), payload: {
      ...(assignee ? { assignee } : {}), ...(delegate ? { delegate } : {}), ...(confirmationPolicy ? { confirmationPolicy } : {}),
    } });
    return this.getTask(taskId)!;
  }

  beginConfirmationCycle(taskId: string, policy: ConfirmationPolicy): number {
    validateConfirmationPolicy(policy);
    const cycle = Number((this.db.prepare('SELECT COALESCE(cycle,0)+1 cycle FROM task_confirmation WHERE taskId=?').get(taskId) as any)?.cycle ?? 1);
    this.db.prepare(`INSERT INTO task_confirmation (taskId, cycle, policy, createdAt, satisfiedAt)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT(taskId) DO UPDATE SET cycle=excluded.cycle,
      policy=excluded.policy, createdAt=excluded.createdAt, satisfiedAt=NULL`)
      .run(taskId, cycle, JSON.stringify(policy), Date.now());
    return cycle;
  }

  voteConfirmation(taskId: string, userId: string): { authorized: boolean; satisfied: boolean; votes: number; required: number } {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    if (!task.confirmationPolicy) return { authorized: true, satisfied: true, votes: 1, required: 1 };
    let request = this.db.prepare('SELECT * FROM task_confirmation WHERE taskId=?').get(taskId) as any;
    if (!request) {
      this.beginConfirmationCycle(taskId, task.confirmationPolicy);
      request = this.db.prepare('SELECT * FROM task_confirmation WHERE taskId=?').get(taskId) as any;
    }
    const policy = JSON.parse(request.policy) as ConfirmationPolicy;
    const audiences = policy.targets.map((target) => target.kind === 'project-role'
      ? this.listProjectMemberships(target.projectId).filter((member) => member.role === target.role)
          .flatMap((member) => this.expandPrincipal(member.principal, task.projectId))
      : this.expandPrincipal(target, task.projectId));
    if (!audiences.some((users) => users.includes(userId))) return { authorized: false, satisfied: false, votes: 0, required: requiredTargets(policy) };
    this.db.prepare('INSERT OR IGNORE INTO confirmation_votes (taskId, cycle, userId, votedAt) VALUES (?, ?, ?, ?)')
      .run(taskId, request.cycle, userId, Date.now());
    const voters = new Set((this.db.prepare('SELECT userId FROM confirmation_votes WHERE taskId=? AND cycle=?').all(taskId, request.cycle) as any[])
      .map((row) => String(row.userId)));
    const satisfiedTargets = audiences.filter((users) => users.some((candidate) => voters.has(candidate))).length;
    const required = requiredTargets(policy);
    const satisfied = satisfiedTargets >= required;
    if (satisfied && !request.satisfiedAt) this.db.prepare('UPDATE task_confirmation SET satisfiedAt=? WHERE taskId=?').run(Date.now(), taskId);
    return { authorized: true, satisfied, votes: satisfiedTargets, required };
  }

  canReviewTask(taskId: string, userId: string): boolean {
    const task = this.getTask(taskId);
    if (!task?.confirmationPolicy) return true;
    return task.confirmationPolicy.targets.some((target) => {
      if (target.kind === 'project-role') return this.listProjectMemberships(target.projectId)
        .filter((member) => member.role === target.role).some((member) => this.expandPrincipal(member.principal, task.projectId).includes(userId));
      return this.expandPrincipal(target, task.projectId).includes(userId);
    });
  }

  subscribeTask(taskId: string, principal: PrincipalRef): void {
    const task = this.getTaskShallow(taskId);
    if (!task) throw new Error(`no task ${taskId}`);
    this.assertPrincipalInOrganization(principal, this.getProject(task.projectId)?.organizationId!);
    this.db.prepare(`INSERT OR IGNORE INTO task_subscribers (taskId, principalKey, principal, createdAt)
      VALUES (?, ?, ?, ?)`).run(taskId, principalKey(principal), JSON.stringify(principal), Date.now());
  }

  unsubscribeTask(taskId: string, principal: PrincipalRef): void {
    const task = this.getTaskShallow(taskId);
    if (!task) return;
    if (samePrincipal(task.createdBy, principal) || samePrincipal(task.assignee, principal))
      throw new Error('creators and assignees cannot unsubscribe while responsible');
    this.db.prepare('DELETE FROM task_subscribers WHERE taskId=? AND principalKey=?').run(taskId, principalKey(principal));
  }

  subscribersFor(taskId: string): PrincipalRef[] {
    return (this.db.prepare('SELECT principal FROM task_subscribers WHERE taskId=? ORDER BY createdAt, rowid').all(taskId) as any[])
      .map((r) => JSON.parse(r.principal));
  }

  listInbox(userId: string, organizationId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): InboxItem[] {
    const sql = `SELECT * FROM inbox WHERE userId=? AND organizationId=?${opts.unreadOnly ? ' AND unread=1' : ''} ORDER BY createdAt DESC LIMIT ?`;
    return (this.db.prepare(sql).all(userId, organizationId, Math.max(1, Math.min(opts.limit ?? 200, 1000))) as any[]).map(rowToInbox);
  }

  markInbox(userId: string, id: string, unread: boolean): InboxItem | undefined {
    this.db.prepare('UPDATE inbox SET unread=?, readAt=? WHERE id=? AND userId=?')
      .run(unread ? 1 : 0, unread ? null : Date.now(), id, userId);
    const r = this.db.prepare('SELECT * FROM inbox WHERE id=? AND userId=?').get(id, userId) as any;
    return r ? rowToInbox(r) : undefined;
  }

  getDeliveryPreferences(userId: string, organizationId: string): DeliveryPreferences {
    const r = this.db.prepare('SELECT json FROM delivery_preferences WHERE userId=? AND organizationId=?').get(userId, organizationId) as any;
    return r ? JSON.parse(r.json) : { userId, organizationId, browser: true, email: false, slack: false, routine: true };
  }

  setDeliveryPreferences(preferences: DeliveryPreferences): DeliveryPreferences {
    if (!this.organizationMembership(preferences.organizationId, preferences.userId)) throw new Error('user is not an organization member');
    this.db.prepare(`INSERT INTO delivery_preferences (userId, organizationId, json) VALUES (?, ?, ?)
      ON CONFLICT(userId, organizationId) DO UPDATE SET json=excluded.json`)
      .run(preferences.userId, preferences.organizationId, JSON.stringify(preferences));
    return preferences;
  }

  private getTaskShallow(id: string): TaskRecord | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as any;
    return r ? rowToTask(r) : undefined;
  }

  private expandPrincipal(principal: ProjectPrincipalRef, projectId: string): string[] {
    if (principal.kind === 'user') return [principal.userId];
    if (principal.kind === 'team') return (this.listTeamMemberships(principal.teamId)).map((m) => m.userId);
    if (principal.kind === 'organization') return this.listOrganizationMemberships(principal.organizationId).map((member) => member.userId);
    return [];
  }

  /** Resolve the audience declared by the workflow's current human wait. */
  humanAudience(taskId: string, requested?: string[]): string[] {
    const task = this.getTaskShallow(taskId);
    if (!task) return [];
    const project = this.getProject(task.projectId);
    if (!project?.organizationId) return [];
    const audience = requested?.length ? requested : task.lastView?.waitingFor?.audience?.length
      ? task.lastView.waitingFor.audience : ['@creator'];
    const users = new Set<string>();
    const addHumanCreator = (candidate: TaskRecord | undefined, visited = new Set<string>()): void => {
      if (!candidate || visited.has(candidate.id)) return;
      visited.add(candidate.id);
      if (candidate.createdBy?.kind === 'user') users.add(candidate.createdBy.userId);
      else if (candidate.createdBy?.kind === 'task-agent')
        addHumanCreator(this.getTaskShallow(candidate.createdBy.taskId), visited);
    };
    for (const selector of audience) {
      if (selector === '@creator') {
        // Agent-created subtasks route back through their parent chain to the
        // human who initiated the work, rather than creating an impossible gate.
        // A top-level task created by an automation has no human ancestor; its
        // organization's owners are the deterministic escalation destination.
        const before = users.size;
        addHumanCreator(task);
        if (users.size === before)
          for (const member of this.listOrganizationMemberships(project.organizationId))
            if (member.role === 'owner') users.add(member.userId);
      } else if (selector === '@all') {
        for (const member of this.listOrganizationMemberships(project.organizationId)) users.add(member.userId);
      } else if (selector === '@owners') {
        for (const member of this.listOrganizationMemberships(project.organizationId)) if (member.role === 'owner') users.add(member.userId);
      } else if (selector === '@project') {
        for (const member of this.listProjectMemberships(task.projectId))
          for (const userId of this.expandPrincipal(member.principal, task.projectId)) users.add(userId);
      } else if (selector.startsWith('user:')) {
        const userId = selector.slice(5);
        if (this.listOrganizationMemberships(project.organizationId).some((member) => member.userId === userId)) users.add(userId);
      } else if (selector.startsWith('@team:')) {
        const slug = selector.slice(6);
        const team = this.teamByRoute(project.organizationId, task.projectId, slug);
        if (team) for (const member of this.listTeamMemberships(team.id)) users.add(member.userId);
      } else if (selector.startsWith('team:')) {
        const team = this.getTeam(selector.slice(5));
        if (team?.organizationId === project.organizationId)
          for (const member of this.listTeamMemberships(team.id)) users.add(member.userId);
      }
    }
    return [...users];
  }

  humanMayAct(taskId: string, userId: string): boolean {
    return this.humanAudience(taskId).includes(userId);
  }

  private reviewAudience(task: TaskRecord): string[] {
    if (task.lastView?.waitingFor?.kind === 'human') return this.humanAudience(task.id, task.lastView.waitingFor.audience);
    const users = new Set<string>();
    for (const target of task.confirmationPolicy?.targets ?? []) {
      if (target.kind === 'project-role') {
        for (const member of this.listProjectMemberships(target.projectId)) {
          if (member.role === target.role) for (const userId of this.expandPrincipal(member.principal, task.projectId)) users.add(userId);
        }
      } else for (const userId of this.expandPrincipal(target, task.projectId)) users.add(userId);
    }
    // Compatibility for legacy human confirmation: project administrators are
    // an explicit, visible fallback rather than an installation-wide broadcast.
    if (!users.size) {
      for (const member of this.listProjectMemberships(task.projectId)) {
        if (member.role === 'owner' || member.role === 'admin' || member.role === 'reviewer')
          for (const userId of this.expandPrincipal(member.principal, task.projectId)) users.add(userId);
      }
    }
    return [...users];
  }

  private materializeInbox(eventSeq: number, ev: KarmaxEvent): void {
    const task = this.getTaskShallow(ev.taskId);
    const project = task && this.getProject(task.projectId);
    if (!task || !project?.organizationId) return;
    let kind: InboxItem['kind'] | undefined;
    let actionable = false;
    let users: string[] = [];
    if (ev.type === 'task.responsibility-changed' || ev.type === 'task.assigned') {
      kind = 'assigned'; actionable = true;
      if (task.assignee) users = this.expandPrincipal(task.assignee, task.projectId);
    } else if (ev.type === 'task.mentioned') {
      kind = 'mentioned';
      const mentioned = ev.payload.principal as PrincipalRef | undefined;
      if (mentioned) users = this.expandPrincipal(mentioned, task.projectId);
    } else if (ev.type.includes('review') || (ev.type === 'view.updated' && (ev.payload.status === 'waiting' || ev.payload.stage === 'review'))) {
      kind = 'review-requested'; actionable = true; users = this.reviewAudience(task);
    } else if (ev.type.includes('escalat') || ev.payload.waitingFor === 'human') {
      kind = 'escalated'; actionable = true;
      users = this.reviewAudience(task);
      if (!users.length && task.assignee) users = this.expandPrincipal(task.assignee, task.projectId);
    } else if (ev.type === 'view.updated' && ['done', 'failed', 'cancelled'].includes(String(ev.payload.status))) {
      kind = 'update';
      for (const subscriber of this.subscribersFor(task.id)) users.push(...this.expandPrincipal(subscriber, task.projectId));
    }
    if (!kind) return;
    for (const userId of new Set(users)) {
      const preferences = this.getDeliveryPreferences(userId, project.organizationId);
      if (!actionable && !preferences.routine) continue;
      const item: InboxItem = { id: newId('inbox'), organizationId: project.organizationId, userId, eventSeq,
        taskId: task.id, kind, unread: true, actionable, createdAt: ev.ts };
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO inbox
        (id, organizationId, userId, eventSeq, taskId, kind, unread, actionable, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(item.id, item.organizationId, item.userId, item.eventSeq,
          item.taskId, item.kind, item.actionable ? 1 : 0, item.createdAt);
      if (Number(inserted.changes)) {
        const channels = [preferences.browser && 'browser', preferences.email && 'email', preferences.slack && 'slack'].filter(Boolean) as string[];
        for (const channel of channels) this.db.prepare(`INSERT OR IGNORE INTO delivery_outbox
          (id, inboxId, channel, state, attempts, nextAt, createdAt) VALUES (?, ?, ?, 'pending', 0, ?, ?)`)
          .run(newId('delivery'), item.id, channel, item.createdAt, item.createdAt);
      }
    }
  }

  claimDelivery(now = Date.now()): { id: string; inbox: InboxItem; channel: 'browser' | 'email' | 'slack'; attempts: number } | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A crashed dispatcher releases its claim after one minute.
      this.db.prepare("UPDATE delivery_outbox SET state='pending', claimedAt=NULL WHERE state='sending' AND claimedAt<?")
        .run(now - 60_000);
      const row = this.db.prepare(`SELECT d.*, i.organizationId, i.userId, i.eventSeq, i.taskId, i.kind,
        i.unread, i.actionable, i.createdAt inboxCreatedAt, i.readAt FROM delivery_outbox d
        JOIN inbox i ON i.id=d.inboxId WHERE d.state='pending' AND d.nextAt<=? ORDER BY d.createdAt LIMIT 1`).get(now) as any;
      if (!row) { this.db.exec('COMMIT'); return undefined; }
      this.db.prepare("UPDATE delivery_outbox SET state='sending', claimedAt=? WHERE id=? AND state='pending'").run(now, row.id);
      this.db.exec('COMMIT');
      return { id: row.id, channel: row.channel, attempts: Number(row.attempts), inbox: rowToInbox({
        id: row.inboxId, organizationId: row.organizationId, userId: row.userId, eventSeq: row.eventSeq,
        taskId: row.taskId, kind: row.kind, unread: row.unread, actionable: row.actionable,
        createdAt: row.inboxCreatedAt, readAt: row.readAt,
      }) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  completeDelivery(id: string): void {
    this.db.prepare("UPDATE delivery_outbox SET state='delivered', deliveredAt=?, claimedAt=NULL, lastError=NULL WHERE id=?")
      .run(Date.now(), id);
  }

  failDelivery(id: string, message: string, attempts: number): void {
    const nextAttempts = attempts + 1;
    const delay = Math.min(24 * 60 * 60_000, 5_000 * 2 ** Math.min(nextAttempts, 10));
    this.db.prepare("UPDATE delivery_outbox SET state='pending', attempts=?, nextAt=?, claimedAt=NULL, lastError=? WHERE id=?")
      .run(nextAttempts, Date.now() + delay, message.slice(0, 500), id);
  }

  deliveryFailures(limit = 100): any[] {
    return this.db.prepare(`SELECT d.*, i.organizationId, i.userId, i.taskId FROM delivery_outbox d
      JOIN inbox i ON i.id=d.inboxId WHERE d.lastError IS NOT NULL ORDER BY d.nextAt DESC LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 1000))) as any[];
  }

  operationalSnapshot(): Record<string, unknown> {
    const grouped = (table: string, column: string) => Object.fromEntries(
      (this.db.prepare(`SELECT ${column} value, COUNT(*) count FROM ${table} GROUP BY ${column}`).all() as any[])
        .map((row) => [String(row.value), Number(row.count)]),
    );
    const tasks: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT lastView FROM tasks').all() as any[]) {
      let status = 'setup';
      try { status = String(JSON.parse(row.lastView ?? '{}').status ?? 'setup'); } catch {}
      tasks[status] = (tasks[status] ?? 0) + 1;
    }
    const artifact = this.db.prepare('SELECT COUNT(*) count, COALESCE(SUM(bytes),0) bytes FROM promoted_artifacts').get() as any;
    const database = this.db.prepare('SELECT page_count * page_size bytes FROM pragma_page_count(), pragma_page_size()').get() as any;
    const latestEvent = this.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM events').get() as any;
    return {
      organizations: Number((this.db.prepare('SELECT COUNT(*) count FROM organizations').get() as any).count),
      projects: Number((this.db.prepare('SELECT COUNT(*) count FROM projects').get() as any).count),
      tasks, worlds: grouped('world_instances', 'state'), runnerLeases: grouped('world_leases', 'state'),
      executions: grouped('executions', 'state'), deliveries: grouped('delivery_outbox', 'state'),
      artifacts: { count: Number(artifact.count), bytes: Number(artifact.bytes) },
      checkpoints: Number((this.db.prepare('SELECT COUNT(*) count FROM world_checkpoints').get() as any).count),
      eventCursor: Number(latestEvent.seq), databaseBytes: Number(database.bytes),
      deliveryFailures: this.deliveryFailures(20).map((row) => ({ id: row.id, organizationId: row.organizationId,
        taskId: row.taskId, channel: row.channel, attempts: Number(row.attempts), nextAt: Number(row.nextAt), error: row.lastError })),
    };
  }

  // ─── Tags (task organization — labels + topics, hierarchical) ────────────────

  listTags(projectId: string): Tag[] {
    return (
      this.db.prepare('SELECT * FROM tags WHERE projectId = ? ORDER BY name').all(projectId) as any[]
    ).map(rowToTag);
  }

  getTag(id: string): Tag | undefined {
    const r = this.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as any;
    return r ? rowToTag(r) : undefined;
  }

  createTag(input: { projectId: string; name: string; parentId?: string; color?: string; kind?: 'type' | 'topic' }): Tag {
    const raw = input.name.trim();
    if (!raw) throw new Error('tag name required');
    // A slash-separated name is a hierarchy path (`frontend/web`): find-or-create each
    // level under the previous, so the UI never needs a parent picker — the user just
    // types the path. `color`/`kind` apply to the leaf; ancestors created bare.
    const segments = raw.split('/').map((s) => s.trim()).filter(Boolean);
    if (segments.length > 1) {
      let parentId = input.parentId;
      let leaf: Tag | undefined;
      for (let i = 0; i < segments.length; i++) {
        const isLeaf = i === segments.length - 1;
        leaf = this.createOneTag({
          projectId: input.projectId,
          name: segments[i]!,
          parentId,
          ...(isLeaf ? { color: input.color, kind: input.kind } : {}),
        });
        parentId = leaf.id;
      }
      return leaf!;
    }
    return this.createOneTag({ ...input, name: raw });
  }

  /** Create-or-reuse a single tag under an explicit parent (no path parsing). */
  private createOneTag(input: { projectId: string; name: string; parentId?: string; color?: string; kind?: 'type' | 'topic' }): Tag {
    const name = input.name.trim();
    if (!name) throw new Error('tag name required');
    // Reuse an existing sibling with the same (case-insensitive) name rather than
    // minting a duplicate — tag catalogues should stay small and canonical.
    const existing = this.db
      .prepare("SELECT * FROM tags WHERE projectId = ? AND lower(name) = lower(?) AND IFNULL(parentId, '') = IFNULL(?, '')")
      .get(input.projectId, name, input.parentId ?? null) as any;
    if (existing) return rowToTag(existing);
    const t: Tag = {
      id: newId('tag'),
      projectId: input.projectId,
      name,
      parentId: input.parentId,
      color: input.color,
      kind: input.kind,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO tags (id, projectId, name, parentId, color, kind, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.projectId, t.name, t.parentId ?? null, t.color ?? null, t.kind ?? null, t.createdAt);
    return t;
  }

  updateTag(id: string, patch: { name?: string; parentId?: string | null; color?: string | null; kind?: 'type' | 'topic' | null }): Tag | undefined {
    const cur = this.getTag(id);
    if (!cur) return undefined;
    // Guard against a cycle: a tag can't be reparented under itself or a descendant.
    if (patch.parentId) {
      const all = this.listTags(cur.projectId);
      const byId = new Map(all.map((t) => [t.id, t]));
      let p: string | undefined = patch.parentId;
      const seen = new Set<string>();
      while (p) {
        if (p === id || seen.has(p)) throw new Error('tag cannot be its own ancestor');
        seen.add(p);
        p = byId.get(p)?.parentId;
      }
    }
    const next: Tag = {
      ...cur,
      name: patch.name?.trim() || cur.name,
      parentId: patch.parentId === null ? undefined : patch.parentId ?? cur.parentId,
      color: patch.color === null ? undefined : patch.color ?? cur.color,
      kind: patch.kind === null ? undefined : patch.kind ?? cur.kind,
    };
    this.db
      .prepare('UPDATE tags SET name = ?, parentId = ?, color = ?, kind = ? WHERE id = ?')
      .run(next.name, next.parentId ?? null, next.color ?? null, next.kind ?? null, id);
    return next;
  }

  /** Delete a tag: promote its children to its own parent, and drop its task assignments. */
  deleteTag(id: string) {
    const cur = this.getTag(id);
    if (!cur) return;
    this.db.prepare('UPDATE tags SET parentId = ? WHERE parentId = ?').run(cur.parentId ?? null, id);
    this.db.prepare('DELETE FROM task_tags WHERE tagId = ?').run(id);
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  }

  tagsFor(taskId: string): string[] {
    return (this.db.prepare('SELECT tagId FROM task_tags WHERE taskId = ?').all(taskId) as any[]).map((r) => r.tagId);
  }

  /** Replace the full tag set on a task (ignores unknown/foreign tag ids). */
  setTaskTags(taskId: string, tagIds: string[]) {
    const t = this.getTask(taskId);
    if (!t) return;
    const valid = new Set(this.listTags(t.projectId).map((x) => x.id));
    this.db.prepare('DELETE FROM task_tags WHERE taskId = ?').run(taskId);
    const ins = this.db.prepare('INSERT OR IGNORE INTO task_tags (taskId, tagId) VALUES (?, ?)');
    for (const id of new Set(tagIds)) if (valid.has(id)) ins.run(taskId, id);
  }

  addTaskTag(taskId: string, tagId: string) {
    const cur = new Set(this.tagsFor(taskId));
    cur.add(tagId);
    this.setTaskTags(taskId, [...cur]);
  }

  removeTaskTag(taskId: string, tagId: string) {
    this.db.prepare('DELETE FROM task_tags WHERE taskId = ? AND tagId = ?').run(taskId, tagId);
  }

  // ─── Saved views (a view is a saved query — PLAN-search-views) ───────────────

  listViews(projectId: string): SavedView[] {
    return (
      this.db.prepare('SELECT * FROM saved_views WHERE projectId = ? ORDER BY ord, createdAt').all(projectId) as any[]
    ).map(rowToView);
  }

  getView(id: string): SavedView | undefined {
    const r = this.db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id) as any;
    return r ? rowToView(r) : undefined;
  }

  createView(input: { projectId: string; name: string; query: TaskQuery; icon?: string }): SavedView {
    const ord =
      (this.db.prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM saved_views WHERE projectId = ?').get(input.projectId) as any).m + 1;
    const v: SavedView = {
      id: newId('view'),
      projectId: input.projectId,
      name: input.name.trim() || 'Untitled view',
      query: input.query ?? {},
      icon: input.icon,
      order: ord,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO saved_views (id, projectId, name, query, icon, ord, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(v.id, v.projectId, v.name, JSON.stringify(v.query), v.icon ?? null, v.order, v.createdAt);
    return v;
  }

  updateView(id: string, patch: { name?: string; query?: TaskQuery; icon?: string | null }): SavedView | undefined {
    const cur = this.getView(id);
    if (!cur) return undefined;
    const next: SavedView = {
      ...cur,
      name: patch.name?.trim() || cur.name,
      query: patch.query ?? cur.query,
      icon: patch.icon === null ? undefined : patch.icon ?? cur.icon,
    };
    this.db
      .prepare('UPDATE saved_views SET name = ?, query = ?, icon = ? WHERE id = ?')
      .run(next.name, JSON.stringify(next.query), next.icon ?? null, id);
    return next;
  }

  reorderView(id: string, ord: number) {
    this.db.prepare('UPDATE saved_views SET ord = ? WHERE id = ?').run(ord, id);
  }

  deleteView(id: string) {
    this.db.prepare('DELETE FROM saved_views WHERE id = ?').run(id);
  }

  // ─── Profiles ──────────────────────────────────────────────────────────────

  upsertProfile(p: AgentProfile) {
    this.db
      .prepare('INSERT INTO profiles (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(p.id, JSON.stringify(p));
  }

  getProfile(id: string): AgentProfile | undefined {
    const r = this.db.prepare('SELECT json FROM profiles WHERE id = ?').get(id) as any;
    return r ? (JSON.parse(r.json) as AgentProfile) : undefined;
  }

  listProfiles(): AgentProfile[] {
    return (this.db.prepare('SELECT json FROM profiles').all() as any[]).map((r) => JSON.parse(r.json));
  }

  deleteProfile(id: string) {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }

  // ── identities are owned by Better Auth; these rows contain only karmax policy ──
  listAuthorizationProfiles(scopeKey?: string): any[] {
    const rows = scopeKey
      ? (this.db.prepare('SELECT scopeKey, json FROM authorization_profiles WHERE scopeKey = ? ORDER BY id').all(scopeKey) as any[])
      : (this.db.prepare('SELECT scopeKey, json FROM authorization_profiles ORDER BY scopeKey, id').all() as any[]);
    return rows.map((r) => ({ ...JSON.parse(r.json), scopeKey: r.scopeKey }));
  }

  getAuthorizationProfile(scopeKey: string, id: string): any | undefined {
    const r = this.db.prepare('SELECT json FROM authorization_profiles WHERE scopeKey = ? AND id = ?').get(scopeKey, id) as any;
    return r ? { ...JSON.parse(r.json), scopeKey } : undefined;
  }

  setAuthorizationProfile(scopeKey: string, profile: { id: string; [key: string]: unknown }): void {
    const { scopeKey: _scope, ...json } = profile as any;
    this.db.prepare(
      'INSERT INTO authorization_profiles (scopeKey, id, json) VALUES (?, ?, ?) ON CONFLICT(scopeKey, id) DO UPDATE SET json = excluded.json',
    ).run(scopeKey, profile.id, JSON.stringify(json));
  }

  deleteAuthorizationProfile(scopeKey: string, id: string): void {
    this.db.prepare('DELETE FROM authorization_profiles WHERE scopeKey = ? AND id = ?').run(scopeKey, id);
  }

  listPrincipalGrants(principalId?: string): any[] {
    const rows = principalId
      ? (this.db.prepare('SELECT principalId, scopeKey, json FROM principal_grants WHERE principalId = ? ORDER BY scopeKey').all(principalId) as any[])
      : (this.db.prepare('SELECT principalId, scopeKey, json FROM principal_grants ORDER BY principalId, scopeKey').all() as any[]);
    return rows.map((r) => ({ ...JSON.parse(r.json), principalId: r.principalId, scopeKey: r.scopeKey }));
  }

  getPrincipalGrant(principalId: string, scopeKey: string): any | undefined {
    const r = this.db.prepare('SELECT json FROM principal_grants WHERE principalId = ? AND scopeKey = ?').get(principalId, scopeKey) as any;
    return r ? { ...JSON.parse(r.json), principalId, scopeKey } : undefined;
  }

  setPrincipalGrant(principalId: string, scopeKey: string, grant: Record<string, unknown>): void {
    const { principalId: _p, scopeKey: _s, ...json } = grant as any;
    this.db.prepare(
      'INSERT INTO principal_grants (principalId, scopeKey, json) VALUES (?, ?, ?) ON CONFLICT(principalId, scopeKey) DO UPDATE SET json = excluded.json',
    ).run(principalId, scopeKey, JSON.stringify(json));
  }

  deletePrincipalGrant(principalId: string, scopeKey: string): void {
    this.db.prepare('DELETE FROM principal_grants WHERE principalId = ? AND scopeKey = ?').run(principalId, scopeKey);
  }

  appendAudit(entry: { ts?: number; principalId: string; action: string; scopeKey?: string; detail?: Record<string, unknown> }): number {
    const r = this.db.prepare('INSERT INTO audit_log (ts, principalId, action, scopeKey, detail) VALUES (?, ?, ?, ?, ?)')
      .run(entry.ts ?? Date.now(), entry.principalId, entry.action, entry.scopeKey ?? 'global', JSON.stringify(entry.detail ?? {}));
    return Number(r.lastInsertRowid);
  }

  auditSince(seq = 0, limit = 500): any[] {
    return (this.db.prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, Math.max(1, Math.min(limit, 2000))) as any[])
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  grantAttachment(attachmentId: string, projectId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO attachment_scopes (attachmentId, projectId) VALUES (?, ?)').run(attachmentId, projectId);
  }

  attachmentAllowed(attachmentId: string, projectId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM attachment_scopes WHERE attachmentId = ? AND projectId = ?').get(attachmentId, projectId);
  }

  attachmentIsScoped(attachmentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM attachment_scopes WHERE attachmentId = ? LIMIT 1').get(attachmentId);
  }

  /** Remove legacy key/value overlays that belong to deleted projects/tasks.
   * Prefix comparison is literal (unlike SQL LIKE, where generated underscores
   * would be wildcards). */
  private deleteProjectKv(projectIds: string[], taskIds: string[]): void {
    const exact = this.db.prepare('DELETE FROM kv WHERE k=?');
    const prefix = this.db.prepare('DELETE FROM kv WHERE substr(k, 1, length(?))=?');
    for (const projectId of projectIds) {
      exact.run(`authz:default:project:${projectId}`);
      exact.run(`credpolicy:project:${projectId}`);
      const workflowPrefix = `wfpin:${projectId}:`;
      prefix.run(workflowPrefix, workflowPrefix);
    }
    for (const taskId of taskIds) {
      for (const key of [`task-agents:${taskId}`, `confirm-transcript:${taskId}`, `spent:${taskId}`, `credpolicy:task:${taskId}`]) exact.run(key);
      for (const value of [`session:${taskId}:`, `sessionmeta:${taskId}:`, `turnsession:${taskId}#`]) prefix.run(value, value);
    }
  }

  // ─── Event log (live stream) ─────────────────────────────────────────────────

  appendEvent(ev: KarmaxEvent): number {
    const info = this.db
      .prepare('INSERT INTO events (taskId, type, ts, payload) VALUES (?, ?, ?, ?)')
      .run(ev.taskId, ev.type, ev.ts, JSON.stringify(ev.payload));
    const seq = Number(info.lastInsertRowid);
    this.materializeInbox(seq, ev);
    return seq;
  }

  eventsSince(taskId: string, seq: number): (KarmaxEvent & { seq: number })[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE taskId = ? AND seq > ? ORDER BY seq')
        .all(taskId, seq) as any[]
    ).map((r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }));
  }

  allEventsSince(seq: number, limit?: number): (KarmaxEvent & { seq: number })[] {
    // Bound the read in SQL. Callers that want "the last N" would otherwise
    // materialize the ENTIRE append-only table before slicing — the events table
    // is the largest in the DB, so that is the dominant read-path allocation.
    // Grab the newest N (DESC + LIMIT), then return ascending as before.
    if (limit && limit > 0) {
      const rows = this.db
        .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq DESC LIMIT ?')
        .all(seq, limit) as any[];
      rows.reverse();
      return rows.map((r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }));
    }
    return (this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(seq) as any[]).map(
      (r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }),
    );
  }

  /** Retention: drop a task's high-volume live-output rows once it's done. The
   *  full agent text survives in the task's saved view/transcripts (saveView);
   *  these per-chunk `agent.output` rows are the biggest driver of table growth
   *  and are only useful for the live stream while the task runs. */
  pruneAgentOutput(taskId: string): number {
    const info = this.db
      .prepare("DELETE FROM events WHERE taskId = ? AND type = 'agent.output'")
      .run(taskId);
    return Number(info.changes);
  }

  // ─── Settings (per-scope × workflow parameter values; SPEC §10.4) ────────────

  /** scopeKey = 'global' or a projectId. Returns the stored field-value map (or undefined). */
  getSettings(scopeKey: string, workflow: string): Record<string, unknown> | undefined {
    const r = this.db.prepare('SELECT json FROM settings WHERE scopeKey = ? AND workflow = ?').get(scopeKey, workflow) as any;
    return r ? (JSON.parse(r.json) as Record<string, unknown>) : undefined;
  }

  setSettings(scopeKey: string, workflow: string, values: Record<string, unknown>) {
    this.db
      .prepare('INSERT INTO settings (scopeKey, workflow, json) VALUES (?, ?, ?) ON CONFLICT(scopeKey, workflow) DO UPDATE SET json = excluded.json')
      .run(scopeKey, workflow, JSON.stringify(values));
  }

  // ─── Worlds, checkpoints, runner leases, usage, and promoted artifacts ───

  registerWorld(handle: WorldHandleRef, projectId: string, defaults: { runnerPoolId?: string; environmentDigest?: string } = {}): WorldHandleRef {
    const latest = this.currentWorld(handle.id);
    const generation = handle.generation ?? ((latest?.generation ?? 0) + 1);
    if (latest && generation <= (latest.generation ?? 0)) throw new Error('world generation must increase monotonically');
    const registered: WorldHandleRef = { ...handle, version: 2, provider: handle.provider ?? handle.kind, generation,
      runnerPoolId: handle.runnerPoolId ?? defaults.runnerPoolId ?? 'local',
      environmentDigest: handle.environmentDigest ?? defaults.environmentDigest ?? 'karmax-local',
      meta: { ...handle.meta, projectId } };
    const now = Date.now();
    this.db.prepare("UPDATE world_instances SET state='superseded', updatedAt=? WHERE worldId=? AND state!='released'").run(now, handle.id);
    this.db.prepare(`INSERT INTO world_instances (worldId, generation, handle, state, createdAt, updatedAt)
      VALUES (?, ?, ?, 'ready', ?, ?)`).run(handle.id, generation, JSON.stringify(registered), now, now);
    return registered;
  }

  currentWorld(worldId: string): WorldHandleRef | undefined {
    const r = this.db.prepare(`SELECT handle FROM world_instances WHERE worldId=? AND state!='superseded'
      ORDER BY generation DESC LIMIT 1`).get(worldId) as any;
    return r ? JSON.parse(r.handle) : undefined;
  }

  worldState(worldId: string): string | undefined {
    return (this.db.prepare('SELECT state FROM world_instances WHERE worldId=? ORDER BY generation DESC LIMIT 1').get(worldId) as any)?.state;
  }

  setWorldState(handle: WorldHandleRef, state: 'ready' | 'parked' | 'hibernated' | 'degraded' | 'released'): void {
    this.db.prepare('UPDATE world_instances SET state=?, updatedAt=? WHERE worldId=? AND generation=?')
      .run(state, Date.now(), handle.id, handle.generation ?? 1);
  }

  attachWorldCheckpoint(handle: WorldHandleRef, checkpointId: string): WorldHandleRef {
    const current = this.currentWorld(handle.id);
    if (!current || (current.generation ?? 1) !== (handle.generation ?? 1)) throw new Error('cannot checkpoint a stale world generation');
    const next = { ...current, checkpointId };
    this.db.prepare('UPDATE world_instances SET handle=?, updatedAt=? WHERE worldId=? AND generation=?')
      .run(JSON.stringify(next), Date.now(), handle.id, handle.generation ?? 1);
    return next;
  }

  updateWorldMeta(handle: WorldHandleRef, patch: Record<string, unknown>): WorldHandleRef {
    const current = this.currentWorld(handle.id);
    if (!current || (current.generation ?? 1) !== (handle.generation ?? 1)) throw new Error('cannot update a stale world generation');
    const next = { ...current, meta: { ...current.meta, ...patch } };
    this.db.prepare('UPDATE world_instances SET handle=?, updatedAt=? WHERE worldId=? AND generation=?')
      .run(JSON.stringify(next), Date.now(), handle.id, handle.generation ?? 1);
    return next;
  }

  listWorldInstances(state: string, updatedBefore = Number.MAX_SAFE_INTEGER): Array<{ handle: WorldHandleRef; state: string; updatedAt: number }> {
    return (this.db.prepare('SELECT handle, state, updatedAt FROM world_instances WHERE state=? AND updatedAt<=? ORDER BY updatedAt')
      .all(state, updatedBefore) as any[]).map((r) => ({ handle: JSON.parse(r.handle), state: r.state, updatedAt: r.updatedAt }));
  }

  assertCurrentWorld(handle: WorldHandleRef): void {
    const current = this.currentWorld(handle.id);
    if (current && (handle.generation ?? 1) !== (current.generation ?? 1))
      throw new Error(`stale world generation ${handle.generation ?? 1}; current is ${current.generation ?? 1}`);
  }

  saveWorldCheckpoint(checkpoint: WorldCheckpoint): WorldCheckpoint {
    this.db.prepare(`INSERT INTO world_checkpoints (id, worldId, generation, projectId, manifest, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)`).run(checkpoint.id, checkpoint.worldId, checkpoint.generation,
        checkpoint.projectId, JSON.stringify(checkpoint), checkpoint.createdAt);
    return checkpoint;
  }

  getWorldCheckpoint(id: string): WorldCheckpoint | undefined {
    const r = this.db.prepare('SELECT manifest FROM world_checkpoints WHERE id=?').get(id) as any;
    return r ? JSON.parse(r.manifest) : undefined;
  }

  latestWorldCheckpoint(worldId: string): WorldCheckpoint | undefined {
    const r = this.db.prepare('SELECT manifest FROM world_checkpoints WHERE worldId=? ORDER BY createdAt DESC LIMIT 1').get(worldId) as any;
    return r ? JSON.parse(r.manifest) : undefined;
  }

  upsertWorldProviderConnection(input: {
    organizationId: string;
    provider: string;
    name?: string;
    credentialHandle: string;
    config?: WorldProviderConnection['config'];
    enabled?: boolean;
  }): WorldProviderConnection {
    if (!this.getOrganization(input.organizationId)) throw new Error('organization not found');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(input.provider)) throw new Error('invalid world provider');
    const existing = this.getWorldProviderConnection(input.organizationId, input.provider);
    const now = Date.now();
    const value: WorldProviderConnection = {
      id: existing?.id ?? newId('world-provider'),
      organizationId: input.organizationId,
      provider: input.provider,
      name: input.name?.trim() || existing?.name || providerDisplayName(input.provider),
      credentialHandle: input.credentialHandle,
      config: input.config ?? existing?.config ?? {},
      enabled: input.enabled ?? existing?.enabled ?? true,
      status: existing?.status ?? 'untested',
      lastCheckedAt: existing?.lastCheckedAt,
      lastError: existing?.lastError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.prepare(`INSERT INTO world_provider_connections
      (id, organizationId, provider, name, credentialHandle, config, enabled, status, lastCheckedAt, lastError, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organizationId, provider) DO UPDATE SET name=excluded.name,
      credentialHandle=excluded.credentialHandle, config=excluded.config, enabled=excluded.enabled,
      status='untested', lastError=NULL, updatedAt=excluded.updatedAt`)
      .run(value.id, value.organizationId, value.provider, value.name, value.credentialHandle,
        JSON.stringify(value.config), value.enabled ? 1 : 0, value.status,
        value.lastCheckedAt ?? null, value.lastError ?? null, value.createdAt, value.updatedAt);
    return this.getWorldProviderConnection(input.organizationId, input.provider)!;
  }

  getWorldProviderConnection(organizationId: string, provider: string): WorldProviderConnection | undefined {
    const row = this.db.prepare('SELECT * FROM world_provider_connections WHERE organizationId=? AND provider=?')
      .get(organizationId, provider) as any;
    return row ? rowToWorldProviderConnection(row) : undefined;
  }

  listWorldProviderConnections(organizationId: string): WorldProviderConnection[] {
    return (this.db.prepare('SELECT * FROM world_provider_connections WHERE organizationId=? ORDER BY createdAt')
      .all(organizationId) as any[]).map(rowToWorldProviderConnection);
  }

  setWorldProviderConnectionStatus(organizationId: string, provider: string,
    status: 'ready' | 'error', error?: string): WorldProviderConnection {
    const now = Date.now();
    this.db.prepare(`UPDATE world_provider_connections SET status=?, lastCheckedAt=?, lastError=?, updatedAt=?
      WHERE organizationId=? AND provider=?`).run(status, now, error?.slice(0, 1000) ?? null, now, organizationId, provider);
    const value = this.getWorldProviderConnection(organizationId, provider);
    if (!value) throw new Error('world provider connection not found');
    return value;
  }

  deleteWorldProviderConnection(organizationId: string, provider: string): WorldProviderConnection | undefined {
    const value = this.getWorldProviderConnection(organizationId, provider);
    if (value) this.db.prepare('DELETE FROM world_provider_connections WHERE organizationId=? AND provider=?')
      .run(organizationId, provider);
    return value;
  }

  createRunnerPool(input: Omit<RunnerPool, 'id' | 'createdAt'> & { id?: string }): RunnerPool {
    const pool: RunnerPool = { ...input, id: input.id ?? newId('pool'), createdAt: Date.now() };
    this.db.prepare(`INSERT INTO runner_pools (id, organizationId, name, provider, region, mode, capacity, enabled, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
      provider=excluded.provider, region=excluded.region, mode=excluded.mode, capacity=excluded.capacity, enabled=excluded.enabled`)
      .run(pool.id, pool.organizationId, pool.name, pool.provider, pool.region ?? null, pool.mode,
        JSON.stringify(pool.capacity), pool.enabled ? 1 : 0, pool.createdAt);
    return pool;
  }

  getRunnerPool(id: string): RunnerPool | undefined {
    const r = this.db.prepare('SELECT * FROM runner_pools WHERE id=?').get(id) as any;
    return r ? rowToRunnerPool(r) : undefined;
  }

  listRunnerPools(organizationId: string): RunnerPool[] {
    return (this.db.prepare('SELECT * FROM runner_pools WHERE organizationId=? ORDER BY createdAt').all(organizationId) as any[]).map(rowToRunnerPool);
  }

  deleteRunnerPool(id: string): RunnerPool | undefined {
    const value = this.getRunnerPool(id);
    if (!value) return undefined;
    const leases = Number((this.db.prepare("SELECT COUNT(*) n FROM world_leases WHERE runnerPoolId=? AND state!='released'")
      .get(id) as any).n);
    if (leases) throw new Error('runner pool still has active or queued leases');
    const projects = this.listProjects().filter((project) => this.effectiveProjectConfig(project).runnerPoolId === id);
    if (projects.length) throw new Error(`runner pool is selected by ${projects.length} project(s)`);
    this.db.prepare('DELETE FROM runner_pools WHERE id=?').run(id);
    return value;
  }

  requestWorldLease(input: { runnerPoolId: string; organizationId: string; projectId: string; taskId: string;
    worldId: string; cpu?: number; memoryMb?: number; gpu?: number; priority?: number }): { id: string; acquired: boolean } {
    const pool = this.getRunnerPool(input.runnerPoolId);
    if (!pool?.enabled || pool.organizationId !== input.organizationId) throw new Error('runner pool is unavailable');
    const resources = { cpu: Math.max(1, input.cpu ?? 2), memoryMb: Math.max(128, input.memoryMb ?? 2048), gpu: Math.max(0, input.gpu ?? 0) };
    if (resources.cpu > pool.capacity.cpu || resources.memoryMb > pool.capacity.memoryMb || resources.gpu > pool.capacity.gpu
      || pool.capacity.activeWorlds < 1) throw new Error('world resource request exceeds runner pool capacity');
    const id = newId('lease');
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(cpu),0) cpu, COALESCE(SUM(memoryMb),0) memoryMb,
        COALESCE(SUM(gpu),0) gpu FROM world_leases WHERE runnerPoolId=? AND state='active'`).get(pool.id) as any;
      const acquired = Number(active.n) < pool.capacity.activeWorlds && Number(active.cpu) + resources.cpu <= pool.capacity.cpu
        && Number(active.memoryMb) + resources.memoryMb <= pool.capacity.memoryMb && Number(active.gpu) + resources.gpu <= pool.capacity.gpu;
      this.db.prepare(`INSERT INTO world_leases (id, runnerPoolId, organizationId, projectId, taskId, worldId,
        cpu, memoryMb, gpu, priority, state, createdAt, acquiredAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, pool.id, input.organizationId, input.projectId, input.taskId, input.worldId, resources.cpu,
          resources.memoryMb, resources.gpu, input.priority ?? 0, acquired ? 'active' : 'queued', now, acquired ? now : null);
      this.db.exec('COMMIT');
      return { id, acquired };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reorderWorldLease(id: string, priority: number): void {
    this.db.prepare("UPDATE world_leases SET priority=? WHERE id=? AND state='queued'").run(priority, id);
  }

  releaseWorldLease(id: string): string[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.db.prepare('SELECT runnerPoolId FROM world_leases WHERE id=?').get(id) as any;
      if (!lease) { this.db.exec('COMMIT'); return []; }
      this.db.prepare("UPDATE world_leases SET state='released', releasedAt=? WHERE id=? AND state!='released'").run(Date.now(), id);
      const activated: string[] = [];
      for (const queued of this.db.prepare(`SELECT * FROM world_leases WHERE runnerPoolId=? AND state='queued'
        ORDER BY priority DESC, createdAt`).all(lease.runnerPoolId) as any[]) {
        const pool = this.getRunnerPool(lease.runnerPoolId)!;
        const active = this.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(cpu),0) cpu, COALESCE(SUM(memoryMb),0) memoryMb,
          COALESCE(SUM(gpu),0) gpu FROM world_leases WHERE runnerPoolId=? AND state='active'`).get(pool.id) as any;
        if (Number(active.n) >= pool.capacity.activeWorlds || Number(active.cpu) + queued.cpu > pool.capacity.cpu
          || Number(active.memoryMb) + queued.memoryMb > pool.capacity.memoryMb || Number(active.gpu) + queued.gpu > pool.capacity.gpu) continue;
        this.db.prepare("UPDATE world_leases SET state='active', acquiredAt=? WHERE id=? AND state='queued'").run(Date.now(), queued.id);
        activated.push(queued.id);
      }
      this.db.exec('COMMIT');
      return activated;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  worldLease(id: string): any {
    return this.db.prepare('SELECT * FROM world_leases WHERE id=?').get(id) as any;
  }

  listWorldLeases(runnerPoolId: string): any[] {
    return this.db.prepare(`SELECT * FROM world_leases WHERE runnerPoolId=? AND state!='released'
      ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, priority DESC, createdAt`).all(runnerPoolId) as any[];
  }

  recordUsage(event: Omit<UsageEvent, 'id'> & { id?: string }): UsageEvent {
    const value: UsageEvent = { ...event, id: event.id ?? newId('usage') };
    this.db.prepare(`INSERT OR IGNORE INTO usage_events (id, organizationId, projectId, taskId, worldId, provider,
      kind, quantity, unit, costMicros, startedAt, endedAt, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.organizationId, value.projectId ?? null, value.taskId ?? null, value.worldId ?? null,
        value.provider, value.kind, value.quantity, value.unit, value.costMicros, value.startedAt, value.endedAt,
        value.metadata ? JSON.stringify(value.metadata) : null);
    return value;
  }

  usageSummary(organizationId: string, from = 0, to = Date.now(), projectId?: string): { costMicros: number; events: number; byKind: Record<string, number> } {
    const rows = (projectId
      ? this.db.prepare('SELECT kind, costMicros FROM usage_events WHERE organizationId=? AND projectId=? AND startedAt>=? AND startedAt<?')
        .all(organizationId, projectId, from, to)
      : this.db.prepare('SELECT kind, costMicros FROM usage_events WHERE organizationId=? AND startedAt>=? AND startedAt<?')
        .all(organizationId, from, to)) as any[];
    const byKind: Record<string, number> = {};
    for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + Number(row.costMicros);
    return { costMicros: rows.reduce((sum, row) => sum + Number(row.costMicros), 0), events: rows.length, byKind };
  }

  savePromotedArtifact(artifact: PromotedArtifact): PromotedArtifact {
    this.db.prepare(`INSERT INTO promoted_artifacts (id, organizationId, projectId, taskId, objectKey, sha256,
      bytes, mediaType, name, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(artifact.id, artifact.organizationId, artifact.projectId, artifact.taskId, artifact.objectKey, artifact.sha256,
        artifact.bytes, artifact.mediaType, artifact.name, artifact.createdAt, artifact.expiresAt ?? null);
    return artifact;
  }

  getPromotedArtifact(id: string): PromotedArtifact | undefined {
    const r = this.db.prepare('SELECT * FROM promoted_artifacts WHERE id=?').get(id) as any;
    return r ? { ...r, expiresAt: r.expiresAt ?? undefined } : undefined;
  }

  listPromotedArtifacts(taskId: string): PromotedArtifact[] {
    return (this.db.prepare('SELECT * FROM promoted_artifacts WHERE taskId=? ORDER BY createdAt DESC').all(taskId) as any[])
      .map((row) => ({ ...row, expiresAt: row.expiresAt ?? undefined }));
  }

  deletePromotedArtifact(id: string): PromotedArtifact | undefined {
    const artifact = this.getPromotedArtifact(id);
    if (artifact) this.db.prepare('DELETE FROM promoted_artifacts WHERE id=?').run(id);
    return artifact;
  }

  expiredPromotedArtifacts(now = Date.now()): PromotedArtifact[] {
    return (this.db.prepare('SELECT * FROM promoted_artifacts WHERE expiresAt IS NOT NULL AND expiresAt<=?').all(now) as any[])
      .map((row) => ({ ...row, expiresAt: Number(row.expiresAt) }));
  }

  createExecution(input: Omit<ExecutionRecord, 'state' | 'startedAt' | 'heartbeatAt'>
    & Partial<Pick<ExecutionRecord, 'state' | 'startedAt' | 'heartbeatAt'>>): ExecutionRecord {
    const startedAt = input.startedAt ?? Date.now();
    const value: ExecutionRecord = { ...input, state: input.state ?? 'starting', startedAt,
      heartbeatAt: input.heartbeatAt ?? startedAt };
    this.db.prepare(`INSERT INTO executions (id, organizationId, projectId, taskId, worldId, generation,
      kind, label, command, server, openUrls, state, startedAt, heartbeatAt, endedAt, exitCode, runnerLeaseId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(value.id, value.organizationId,
        value.projectId, value.taskId, value.worldId, value.generation, value.kind, value.label,
        value.command ?? null, value.server ? 1 : 0, JSON.stringify(value.openUrls), value.state,
        value.startedAt, value.heartbeatAt, value.endedAt ?? null, value.exitCode ?? null, value.runnerLeaseId ?? null);
    return value;
  }

  execution(id: string): ExecutionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM executions WHERE id=?').get(id) as any;
    return row ? rowToExecution(row) : undefined;
  }

  listExecutions(taskId: string): ExecutionRecord[] {
    return (this.db.prepare('SELECT * FROM executions WHERE taskId=? ORDER BY startedAt DESC').all(taskId) as any[])
      .map(rowToExecution);
  }

  setExecutionRunning(id: string): void {
    this.db.prepare("UPDATE executions SET state='running', heartbeatAt=? WHERE id=? AND state='starting'").run(Date.now(), id);
  }

  heartbeatExecution(id: string): void {
    this.db.prepare("UPDATE executions SET heartbeatAt=? WHERE id=? AND state IN ('starting','running','stop-requested')")
      .run(Date.now(), id);
  }

  requestExecutionStop(id: string): boolean {
    const result = this.db.prepare("UPDATE executions SET state='stop-requested', heartbeatAt=? WHERE id=? AND state IN ('starting','running')")
      .run(Date.now(), id);
    return Number(result.changes) > 0;
  }

  finishExecution(id: string, exitCode: number | null, state?: ExecutionRecord['state']): void {
    const finalState = state ?? (exitCode === 0 ? 'succeeded' : 'failed');
    this.db.prepare(`UPDATE executions SET state=?, exitCode=?, endedAt=?, heartbeatAt=? WHERE id=?
      AND state NOT IN ('succeeded','failed','cancelled','lost')`).run(finalState, exitCode, Date.now(), Date.now(), id);
  }

  appendExecutionFrame(id: string, data: string, stream: ExecutionFrame['stream'] = 'stdout'): ExecutionFrame {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seq = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 seq FROM execution_frames WHERE executionId=?')
        .get(id) as any)?.seq ?? 1);
      const frame: ExecutionFrame = { executionId: id, seq, ts: Date.now(), stream, data };
      this.db.prepare('INSERT INTO execution_frames (executionId, seq, ts, stream, data) VALUES (?, ?, ?, ?, ?)')
        .run(id, seq, frame.ts, stream, data);
      this.db.prepare('UPDATE executions SET heartbeatAt=? WHERE id=?').run(frame.ts, id);
      // Bound reconnect storage per execution. Keep complete frame boundaries and
      // trim the oldest rows once their UTF-8 payload exceeds roughly 200 KiB.
      const rows = this.db.prepare('SELECT seq, length(CAST(data AS BLOB)) bytes FROM execution_frames WHERE executionId=? ORDER BY seq DESC')
        .all(id) as any[];
      let bytes = 0;
      let keepFrom = 1;
      for (const row of rows) {
        bytes += Number(row.bytes);
        if (bytes <= 200_000) keepFrom = Number(row.seq);
      }
      this.db.prepare('DELETE FROM execution_frames WHERE executionId=? AND seq<?').run(id, keepFrom);
      this.db.exec('COMMIT');
      return frame;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  executionFrames(id: string, since = 0): ExecutionFrame[] {
    return (this.db.prepare('SELECT * FROM execution_frames WHERE executionId=? AND seq>? ORDER BY seq').all(id, since) as any[])
      .map((row) => ({ executionId: row.executionId, seq: Number(row.seq), ts: Number(row.ts),
        stream: row.stream, data: row.data }));
  }

  markLostExecutions(staleBefore: number): string[] {
    const rows = this.db.prepare("SELECT id FROM executions WHERE state IN ('starting','running','stop-requested') AND heartbeatAt<?")
      .all(staleBefore) as any[];
    for (const row of rows) this.finishExecution(row.id, null, 'lost');
    return rows.map((row) => String(row.id));
  }

  createPreviewLease(lease: PreviewLease): PreviewLease {
    const value = { ...lease, hostname: lease.hostname ?? previewHostnameForLease(lease.id) };
    this.db.prepare(`INSERT INTO preview_leases (id, organizationId, projectId, taskId, worldId, generation,
      port, public, tokenHash, runnerLeaseId, provider, createdBy, createdAt, expiresAt, revokedAt, hostname)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(value.id, value.organizationId,
        value.projectId, value.taskId, value.worldId, value.generation, value.port, value.public ? 1 : 0,
        value.tokenHash ?? null, value.runnerLeaseId ?? null, value.provider, value.createdBy,
        value.createdAt, value.expiresAt, value.revokedAt ?? null, value.hostname ?? null);
    return value;
  }

  previewLease(id: string): PreviewLease | undefined {
    const row = this.db.prepare('SELECT * FROM preview_leases WHERE id=?').get(id) as any;
    return row ? rowToPreviewLease(row) : undefined;
  }

  listPreviewLeases(taskId: string): PreviewLease[] {
    return (this.db.prepare('SELECT * FROM preview_leases WHERE taskId=? ORDER BY createdAt DESC').all(taskId) as any[])
      .map(rowToPreviewLease);
  }

  revokePreviewLease(id: string): PreviewLease | undefined {
    const lease = this.previewLease(id);
    if (lease && !lease.revokedAt) this.db.prepare('UPDATE preview_leases SET revokedAt=? WHERE id=?').run(Date.now(), id);
    return lease;
  }

  expiredPreviewLeases(now = Date.now()): PreviewLease[] {
    return (this.db.prepare('SELECT * FROM preview_leases WHERE revokedAt IS NULL AND expiresAt<=?').all(now) as any[])
      .map(rowToPreviewLease);
  }

  previewHostnameAllowed(hostname: string, now = Date.now()): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM preview_leases
      WHERE hostname=? AND revokedAt IS NULL AND expiresAt>? LIMIT 1`).get(hostname.toLowerCase(), now));
  }

  // ─── Cards (payment resources; SPEC §7.6) ────────────────────────────────────

  createCard(c: { id: string; provider: string; scope: 'project' | 'global'; scopeId?: string; label: string; cap: number; available: number; merchantLock?: string[]; createdAt: number }) {
    this.db
      .prepare('INSERT INTO cards (id, provider, scope, scopeId, label, cap, available, merchantLock, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.provider, c.scope, c.scopeId ?? null, c.label, c.cap, c.available, c.merchantLock ? JSON.stringify(c.merchantLock) : null, c.createdAt);
  }
  getCard(id: string): any {
    const r = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as any;
    return r ? cardRow(r) : undefined;
  }
  /** Cards visible to a project: its own project-scope cards plus all global cards. */
  listCards(projectId?: string): any[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM cards WHERE scope='global' OR (scope='project' AND scopeId=?) ORDER BY createdAt").all(projectId) as any[])
      : (this.db.prepare('SELECT * FROM cards ORDER BY createdAt').all() as any[]);
    return rows.map(cardRow);
  }
  updateCard(id: string, patch: { available?: number; cap?: number }) {
    const c = this.getCard(id);
    if (!c) return;
    this.db.prepare('UPDATE cards SET available = ?, cap = ? WHERE id = ?').run(patch.available ?? c.available, patch.cap ?? c.cap, id);
  }

  // ─── KV (misc small state) ───────────────────────────────────────────────────

  /** The raw bearer never enters SQLite; replicas verify its SHA-256 digest. */
  putScopedToken(tokenHash: string, tokenId: string, record: Record<string, unknown>, expiresAt: number): void {
    this.db.prepare(`INSERT INTO scoped_tokens (tokenHash, tokenId, json, expiresAt, revokedAt)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT(tokenHash) DO UPDATE SET
      tokenId=excluded.tokenId, json=excluded.json, expiresAt=excluded.expiresAt, revokedAt=NULL`)
      .run(tokenHash, tokenId, JSON.stringify(record), expiresAt);
  }

  getScopedToken(tokenHash: string): Record<string, unknown> | undefined {
    const r = this.db.prepare('SELECT json FROM scoped_tokens WHERE tokenHash=? AND revokedAt IS NULL AND expiresAt>?')
      .get(tokenHash, Date.now()) as any;
    return r ? JSON.parse(r.json) : undefined;
  }

  revokeScopedToken(input: { tokenHash?: string; tokenId?: string }): void {
    if (input.tokenHash) this.db.prepare('UPDATE scoped_tokens SET revokedAt=? WHERE tokenHash=?').run(Date.now(), input.tokenHash);
    else if (input.tokenId) this.db.prepare('UPDATE scoped_tokens SET revokedAt=? WHERE tokenId=?').run(Date.now(), input.tokenId);
  }

  /** Revoke durable credentials whose serialized scope names a resource being
   * deleted. Parsing keeps this compatible with pre-JSON1 SQLite builds and
   * with historical token records that omitted newer scope fields. */
  revokeScopedTokens(scope: { projectId?: string; organizationId?: string }): number {
    const update = this.db.prepare('UPDATE scoped_tokens SET revokedAt=? WHERE tokenHash=? AND revokedAt IS NULL');
    const now = Date.now();
    let revoked = 0;
    for (const row of this.db.prepare('SELECT tokenHash, json FROM scoped_tokens WHERE revokedAt IS NULL').all() as any[]) {
      try {
        const record = JSON.parse(row.json) as { projectId?: string; organizationId?: string };
        if ((scope.projectId && record.projectId === scope.projectId)
          || (scope.organizationId && record.organizationId === scope.organizationId))
          revoked += Number(update.run(now, row.tokenHash).changes);
      } catch {}
    }
    return revoked;
  }

  purgeScopedTokens(now = Date.now()): number {
    return Number(this.db.prepare('DELETE FROM scoped_tokens WHERE expiresAt<=? OR revokedAt IS NOT NULL').run(now).changes);
  }

  kvGet(k: string): string | undefined {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as any;
    return r?.v;
  }

  kvSet(k: string, v: string) {
    this.db
      .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, v);
  }

  close() {
    this.db.close();
  }
}

function cardRow(r: any) {
  return {
    id: r.id,
    provider: r.provider,
    scope: r.scope,
    scopeId: r.scopeId ?? undefined,
    label: r.label,
    cap: r.cap,
    available: r.available,
    merchantLock: r.merchantLock ? JSON.parse(r.merchantLock) : undefined,
    createdAt: r.createdAt,
  };
}

function selectRows(db: DatabaseSyncType, table: string, where: string, args: any[]): any[] {
  return db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...args) as any[];
}

function rowsFor(db: DatabaseSyncType, table: string, column: string, values: string[]): any[] {
  if (!values.length) return [];
  return selectRows(db, table, `${column} IN (${values.map(() => '?').join(',')})`, values);
}

function deleteRows(db: DatabaseSyncType, table: string, column: string, values: string[]): void {
  if (values.length) db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${values.map(() => '?').join(',')})`).run(...values);
}

function redactWorldHandle(value: string): Record<string, unknown> {
  try {
    const handle = JSON.parse(value) as WorldHandleRef;
    return { version: handle.version ?? 1, id: handle.id, kind: handle.kind, provider: handle.provider ?? handle.kind,
      generation: handle.generation, runnerPoolId: handle.runnerPoolId, environmentDigest: handle.environmentDigest,
      checkpointId: handle.checkpointId };
  } catch { return { redacted: true }; }
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJsonOptional<T>(value: unknown): T | undefined {
  return typeof value === 'string' && value ? JSON.parse(value) as T : undefined;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workspace';
}

function uniqueSlug(value: string, used: (candidate: string) => boolean): string {
  const base = slugify(value);
  let candidate = base;
  for (let n = 2; used(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

function validateProjectExecutionConfig(config: ProjectConfig): void {
  const raw = config as any;
  const positive = (value: unknown, label: string, minimum = 0) => {
    if (value == null) return;
    if (!Number.isFinite(Number(value)) || Number(value) < minimum) throw new Error(`${label} must be at least ${minimum}`);
  };
  positive(raw.resources?.cpu, 'CPU', 1);
  positive(raw.resources?.memoryMb, 'memory', 128);
  positive(raw.resources?.gpu, 'GPU', 0);
  positive(raw.monthlyBudgetMicros, 'monthly budget', 0);
  // Zero is the explicit "hibernate on the next lifecycle sweep" value. It is
  // useful under hard budget pressure and in deterministic lifecycle tests;
  // positive intervals below one minute are almost certainly configuration
  // mistakes and would churn provider sandboxes.
  if (Number(raw.hibernateAfterMs) !== 0) positive(raw.hibernateAfterMs, 'hibernate interval', 60_000);
  for (const domain of raw.network?.allowDomains ?? []) {
    if (typeof domain !== 'string' || !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain))
      throw new Error(`invalid outbound domain: ${String(domain)}`);
  }
  for (const cidr of raw.network?.allowCidrs ?? []) {
    const [address, prefix, ...extra] = typeof cidr === 'string' ? cidr.split('/') : [];
    const family = address ? isIP(address) : 0;
    const bits = Number(prefix);
    if (extra.length || !family || !/^\d{1,3}$/.test(prefix ?? '') || bits < 0 || bits > (family === 4 ? 32 : 128))
      throw new Error(`invalid outbound CIDR: ${String(cidr)}`);
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validGitBranch(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(value)
    && !value.includes('..') && !value.includes('@{') && !value.includes('//')
    && !value.endsWith('/') && !value.endsWith('.') && !value.endsWith('.lock');
}

export function principalKey(principal: ProjectPrincipalRef): string {
  if (principal.kind === 'user') return `user:${principal.userId}`;
  if (principal.kind === 'team') return `team:${principal.teamId}`;
  if (principal.kind === 'organization') return `organization:${principal.organizationId}`;
  return `task-agent:${principal.taskId}:${principal.role}`;
}

function samePrincipal(a: PrincipalRef | undefined, b: PrincipalRef): boolean {
  return !!a && principalKey(a) === principalKey(b);
}

function validateConfirmationPolicy(policy: ConfirmationPolicy): void {
  if (!policy.targets.length) throw new Error('confirmation policy needs at least one target');
  if (typeof policy.rule === 'object') {
    const quorum = Math.floor(policy.rule.quorum);
    if (quorum < 1 || quorum > policy.targets.length) throw new Error('confirmation quorum is outside the target count');
  }
}

function requiredTargets(policy: ConfirmationPolicy): number {
  if (policy.rule === 'any') return 1;
  if (policy.rule === 'all') return policy.targets.length;
  return Math.floor(policy.rule.quorum);
}

function rowToOrganization(r: any): Organization {
  return { id: r.id, name: r.name, slug: r.slug, kind: r.kind, createdAt: r.createdAt };
}

function rowToTeam(r: any): Team {
  return { id: r.id, organizationId: r.organizationId, projectId: r.projectId ?? undefined,
    name: r.name, slug: r.slug, createdAt: r.createdAt };
}

function rowToGitConnection(r: any): GitConnection {
  return { id: r.id, organizationId: r.organizationId, provider: r.provider,
    installationId: r.installationId, accountLogin: r.accountLogin, accountType: r.accountType ?? undefined,
    createdAt: r.createdAt, suspendedAt: r.suspendedAt ?? undefined };
}

function rowToRepository(r: any): Repository {
  return { id: r.id, organizationId: r.organizationId, provider: r.provider, providerId: r.providerId ?? undefined,
    owner: r.owner, name: r.name, sshUrl: r.sshUrl, defaultBranch: r.defaultBranch,
    private: Boolean(r.private), gitConnectionId: r.gitConnectionId ?? undefined,
    createdAt: r.createdAt, updatedAt: r.updatedAt };
}

function rowToInbox(r: any): InboxItem {
  return { id: r.id, organizationId: r.organizationId, userId: r.userId, eventSeq: r.eventSeq,
    taskId: r.taskId, kind: r.kind, unread: Boolean(r.unread), actionable: Boolean(r.actionable),
    createdAt: r.createdAt, readAt: r.readAt ?? undefined };
}

function rowToExecution(row: any): ExecutionRecord {
  return {
    id: row.id, organizationId: row.organizationId, projectId: row.projectId, taskId: row.taskId,
    worldId: row.worldId, generation: Number(row.generation), kind: row.kind, label: row.label,
    command: row.command ?? undefined, server: Boolean(row.server), openUrls: JSON.parse(row.openUrls || '[]'),
    state: row.state, startedAt: Number(row.startedAt), heartbeatAt: Number(row.heartbeatAt),
    endedAt: row.endedAt == null ? undefined : Number(row.endedAt),
    exitCode: row.endedAt == null ? undefined : row.exitCode == null ? null : Number(row.exitCode),
    runnerLeaseId: row.runnerLeaseId ?? undefined,
  };
}

function rowToPreviewLease(row: any): PreviewLease {
  return {
    id: row.id, organizationId: row.organizationId, projectId: row.projectId, taskId: row.taskId,
    worldId: row.worldId, generation: Number(row.generation), port: Number(row.port), public: Boolean(row.public),
    tokenHash: row.tokenHash ?? undefined, runnerLeaseId: row.runnerLeaseId ?? undefined, provider: row.provider,
    createdBy: row.createdBy, createdAt: Number(row.createdAt), expiresAt: Number(row.expiresAt),
    revokedAt: row.revokedAt == null ? undefined : Number(row.revokedAt),
    hostname: row.hostname ?? undefined,
  };
}

function previewHostnameForLease(id: string): string | undefined {
  try {
    const base = new URL(process.env.KARMAX_PREVIEW_ORIGIN ?? '');
    return `p-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 24)}.${base.hostname}`.toLowerCase();
  } catch { return undefined; }
}

function rowToRunnerPool(r: any): RunnerPool {
  return { id: r.id, organizationId: r.organizationId, name: r.name, provider: r.provider,
    region: r.region ?? undefined, mode: r.mode, capacity: JSON.parse(r.capacity),
    createdAt: r.createdAt, enabled: Boolean(r.enabled) };
}

function rowToWorldProviderConnection(r: any): WorldProviderConnection {
  return {
    id: r.id,
    organizationId: r.organizationId,
    provider: r.provider,
    name: r.name,
    credentialHandle: r.credentialHandle,
    config: JSON.parse(r.config || '{}'),
    enabled: Boolean(r.enabled),
    status: r.status,
    lastCheckedAt: r.lastCheckedAt == null ? undefined : Number(r.lastCheckedAt),
    lastError: r.lastError ?? undefined,
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  };
}

function providerDisplayName(provider: string): string {
  if (provider === 'e2b') return 'E2B';
  if (provider === 'daytona') return 'Daytona';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function rowToProject(r: any): Project {
  return { id: r.id, organizationId: r.organizationId ?? 'org_personal', name: r.name, createdAt: r.createdAt, config: JSON.parse(r.config) };
}
function rowToTag(r: any): Tag {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    parentId: r.parentId ?? undefined,
    color: r.color ?? undefined,
    kind: r.kind ?? undefined,
    createdAt: r.createdAt,
  };
}
function rowToView(r: any): SavedView {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    query: JSON.parse(r.query),
    icon: r.icon ?? undefined,
    order: r.ord,
    createdAt: r.createdAt,
  };
}
function rowToList(r: any): TaskList {
  return { id: r.id, projectId: r.projectId, name: r.name, createdAt: r.createdAt, order: r.ord };
}
function rowToTask(r: any): TaskRecord {
  return {
    id: r.id,
    intentId: r.intentId ?? r.id,
    attemptNumber: r.attemptNumber ?? 1,
    num: r.resolvedNum ?? r.num ?? undefined,
    projectId: r.projectId,
    listId: r.listId,
    title: r.title,
    workflow: r.workflow,
    workflowVersion: r.workflowVersion,
    params: JSON.parse(r.params),
    createdAt: r.createdAt,
    order: r.ord,
    parentTaskId: r.parentTaskId ?? undefined,
    createdBy: parseJsonOptional<PrincipalRef>(r.createdBy),
    assignee: parseJsonOptional<PrincipalRef>(r.assignee),
    delegate: parseJsonOptional<PrincipalRef>(r.delegate),
    confirmationPolicy: parseJsonOptional<ConfirmationPolicy>(r.confirmationPolicy),
    subscribers: [],
    notes: r.notes ?? undefined,
    lastView: r.lastView ? JSON.parse(r.lastView) : undefined,
  };
}
