import { decayVaultUsage, type VaultUsage } from '../util/vault-usage.js';
import { canonicalAccountName } from '../domain/account-names.js';
import { validGitBranch } from '../util/git-ref.js';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { sameRepository } from '../world/repository-identity.js';
import { isPostgresTarget, openSqlDatabase, type SqlDatabase } from './sql.js';
import { AsyncPostgres } from './async-sql.js';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { importSqliteDatabase, type SqliteImportResult } from './postgres-migration.js';
import { passEntryMetadata } from '../autonomy/pass-path.js';
import {
  Project,
  ProjectConfig,
  TaskList,
  TaskRecord,
  TaskParams,
  AgentProfile,
  TaskView,
  ReviewInfo,
  KarmaxEvent,
  Tag,
  SavedView,
  TaskQuery,
  Organization,
  OrganizationExecutionPolicy,
  OrganizationUsagePolicy,
  OrganizationMembership,
  OrganizationInvitation,
  AuthorizationSelection,
  Team,
  TeamMembership,
  ProjectMembership,
  PrincipalRef,
  ProjectPrincipalRef,
  ConfirmationPolicy,
  Avatar,
  AvatarAvailability,
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
  ResourceAttachment,
  ResourceRevision,
  ResourceLease,
  ResourceCandidate,
  StorageLocation,
  StorageLocationUsage,
  DEFAULT_URGENCY,
  URGENCY_LEVELS,
  normalizeUrgency,
  urgencyRank,
} from '../domain/types.js';
import { resourceDriver } from '../domain/resource-drivers.js';
import {
  EntitlementError,
  isHostedPlanId,
  organizationEntitlements,
  type HostedPlanId,
  type OrganizationEntitlements,
} from '../domain/entitlements.js';
import { newId } from '../util/id.js';

export type CollaborationRequestStatus = 'pending' | 'completed' | 'failed';

export interface CollaborationRequest {
  id: string;
  requesterTaskId: string;
  targetTaskId: string;
  targetRole: string;
  action: 'publish_branch';
  status: CollaborationRequestStatus;
  afterSeq: number;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
  result?: Record<string, unknown>;
  notifiedAt?: number;
}

/**
 * Terminal statuses that auto-archive a task when it first reaches one (see
 * `Store.saveView`). Only fully-resolved outcomes — a failed task stays visible
 * because it usually needs attention.
 */
const AUTO_ARCHIVE_STATUS = new Set<string>(['done', 'cancelled']);

/**
 * Statuses after which `agent.output` rows may be pruned (`saveView`).
 *
 * Deliberately NOT `failed`, for the same reason `AUTO_ARCHIVE_STATUS` above is
 * not: a failed task is the one a human actually has to read. Pruning is only safe
 * because the full agent text has already been written into the view/transcripts —
 * and that premise fails exactly here. `src/platform/reconcile.ts` synthesizes a
 * `failed` view for any task whose Temporal execution died, so a boot-time
 * reconcile after a crash used to wipe the streamed output of every task that was
 * mid-flight, destroying the only record of what the agent was doing when it broke.
 */
const PRUNE_OUTPUT_STATUS = new Set<string>(['done', 'cancelled']);

/**
 * Does an event type mean "a human is being asked to review this"? Such events
 * are routed to the review audience as an ACTIONABLE inbox item.
 *
 * The bar is a request, not the word "review". Event types are dotted
 * `namespace.action` paths, and the two earlier rules both spammed the inbox: a
 * substring match on `review` swept in every `preview.*` type, and matching any
 * `review` SEGMENT swept in `review.built` — which a task emits on every single
 * agent turn, so one task in review produced dozens of identical "review
 * requested" rows. Only a trailing `review-requested` (any separator) survives:
 * `software-dev.review-requested` and `review.requested` match, `review.built`,
 * `github.pr.review` and `preview.requested` do not.
 */
export const isReviewRequestEvent = (type: string): boolean =>
  /(^|-)review-requested$/.test(type.replace(/[._]/g, '-'));

/**
 * The metadata index. Temporal holds the authoritative live workflow state;
 * this store is the searchable index of projects/lists/tasks/profiles plus an
 * append-only event log that powers the live UI stream.
 */
export class Store {
  readonly db: SqlDatabase;
  readonly hosted: boolean;
  private asyncDatabase?: AsyncPostgres;
  private userNames?: () => Array<{ id: string; name: string }>;
  private organizationEntitlementListeners = new Set<(organizationId: string) => void>();

  constructor(private readonly dbPath = ':memory:', options: { hosted?: boolean } = {}) {
    this.hosted = options.hosted === true;
    if (dbPath !== ':memory:' && !isPostgresTarget(dbPath)) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = openSqlDatabase(dbPath);
    // busy_timeout first: waiting (up to 5s) on a locked database beats failing
    // the caller outright. tsx-watch restarts overlap the outgoing and incoming
    // app for a few seconds, and the newcomer's boot writes (migrations,
    // credential registration) must not instantly kill a long agent turn's
    // event append with "database is locked" (that error cost a merge-agent
    // turn mid-conflict-resolution — the 05f9802 postmortem).
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
    this.migrateData();
    this.migrateConversations();
    this.paymentTransaction(() => {
      if (this.kvGet('migration:unique-card-names')) return;
      const rows = this.db.prepare(`SELECT c.id, c.label, c.scope, c.scopeId, p.organizationId
        FROM cards c LEFT JOIN projects p ON c.scope='project' AND c.scopeId=p.id ORDER BY c.createdAt, c.id`).all() as any[];
      const seen = new Map<string, Set<string>>();
      for (const card of rows) {
        const org = card.scope === 'organization' ? card.scopeId : card.organizationId ?? 'org_personal';
        const names = seen.get(org) ?? new Set<string>();
        seen.set(org, names);
        const base = String(card.label).trim() || 'Card';
        let name = base, suffix = 2;
        while (names.has(name.toLowerCase())) name = `${base} (${suffix++})`;
        names.add(name.toLowerCase());
        if (name !== card.label) this.db.prepare('UPDATE cards SET label=? WHERE id=?').run(name, card.id);
      }
      this.kvSet('migration:unique-card-names', '1');
    });
  }

  /** Upgrade old snapshots in bounded pages before accepting traffic. The old
   * fields remain readable during imports; every new write uses the split form. */
  private migrateConversations(): void {
    let cursor = '';
    for (;;) {
      const rows = this.db.prepare(`SELECT id, lastView FROM tasks
        WHERE id > ? AND lastView IS NOT NULL AND conversation IS NULL ORDER BY id LIMIT 100`)
        .all(cursor) as Array<{ id: string; lastView: string }>;
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.id;
        const { messages, transcripts, ...status } = JSON.parse(row.lastView);
        this.db.prepare('UPDATE tasks SET lastView=?, conversation=? WHERE id=? AND conversation IS NULL')
          .run(JSON.stringify(status), JSON.stringify({ messages: messages ?? [], transcripts }), row.id);
      }
    }
  }

  /** One-time data migrations (idempotent; run every boot). */
  private migrateData() {
    // Notifications whose ask was already answered — the backlog older builds
    // never removed, and a net for any closing event this install missed.
    this.pruneStaleInbox();

    // Early organization-policy builds expanded their infrastructure defaults
    // into every project. Those records accidentally became permanent project
    // overrides when execution policy later switched to sparse inheritance. In
    // particular, the old restricted-by-default network object made existing
    // projects silently lose general internet access even though the current
    // organization default is unrestricted. Match the complete legacy tuple so
    // a deliberately customized project policy is never mistaken for a default.
    // Every JSON.parse below is guarded and every write is conditional. This runs
    // on EVERY boot, so one malformed row (a truncated write, a hand-edited value)
    // would otherwise throw out of the constructor and make the install
    // unbootable — a migration that cannot skip a row it does not understand is a
    // liveness bug, not a correctness one. The vault loop already worked this way.
    const projects = this.db.prepare('SELECT id, config FROM projects').all() as Array<{ id: string; config: string }>;
    for (const row of projects) {
      let config: Record<string, any>;
      try { config = JSON.parse(row.config) as Record<string, any>; } catch { continue; }
      if (!config || typeof config !== 'object') continue;
      let configChanged = false;
      const resources = config.resources;
      const network = config.network;
      const environment = config.environment;
      const legacyResources = resources && resources.cpu === 2 && resources.memoryMb === 2048
        && (resources.gpu === undefined || resources.gpu === 0)
        && Object.keys(resources).every((key) => ['cpu', 'memoryMb', 'gpu'].includes(key));
      const legacyNetwork = network?.unrestricted === false
        && Array.isArray(network.allowDomains) && network.allowDomains.length === 0
        && Array.isArray(network.allowCidrs) && network.allowCidrs.length === 0
        && Object.keys(network).every((key) => ['unrestricted', 'allowDomains', 'allowCidrs'].includes(key));
      const legacyEnvironment = environment && Object.keys(environment).length === 0;
      if (config.runnerPoolId === null && config.monthlyBudgetMicros === null
        && config.hibernateAfterMs === 7 * 24 * 60 * 60 * 1000
        && legacyResources && legacyNetwork && legacyEnvironment) {
        for (const key of ['runnerPoolId', 'resources', 'network', 'environment', 'monthlyBudgetMicros', 'hibernateAfterMs'])
          delete config[key];
        configChanged = true;
      }
      // A hosted world's local merge is not a durable delivery destination.
      // Migrate both an absent old default and an explicit old `none` choice.
      // Workflow inputs already recorded in Temporal are unaffected; only new
      // starts read this project/settings state.
      if (process.env.KARMAX_DEPLOYMENT === 'hosted'
        && (config.remote === undefined || config.remote === 'none')) {
        config.remote = 'pr';
        configChanged = true;
      }
      if (configChanged)
        this.db.prepare('UPDATE projects SET config=? WHERE id=?').run(JSON.stringify(config), row.id);
    }

    if (process.env.KARMAX_DEPLOYMENT === 'hosted') {
      const settings: Array<{ scopeKey: string; workflow: string; json: string }> =
        this.db.prepare('SELECT scopeKey, workflow, json FROM settings').all() as any;
      const update = this.db.prepare('UPDATE settings SET json=? WHERE scopeKey=? AND workflow=?');
      for (const row of settings) {
        let values: Record<string, unknown>;
        try { values = JSON.parse(row.json) as Record<string, unknown>; } catch { continue; }
        if (!values || typeof values !== 'object' || values.remote !== 'none') continue;
        update.run(JSON.stringify({ ...values, remote: 'pr' }), row.scopeKey, row.workflow);
      }
    }

    // Turn caps are now optional (unlimited by default). Strip the legacy caps
    // that older builds seeded onto the role-default profiles so existing installs
    // match the new "no limit unless you set one" behavior.
    const rows = this.db.prepare("SELECT id, json FROM profiles WHERE id LIKE '%-default'").all() as any[];
    for (const r of rows) {
      let p: any;
      try { p = JSON.parse(r.json); } catch { continue; }
      if (!p || typeof p !== 'object') continue;
      let profileChanged = false;
      const legacyDoCapabilities = ['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill'];
      const modernDoCapabilities = [
        ...legacyDoCapabilities, 'task:read', 'task:event:read', 'task:git:publish', 'task:git:import',
        'task:conversation:read', 'task:conversation:fork', 'task:conversation:message',
      ];
      if (p.role === 'do' && Array.isArray(p.capabilities)
        && p.capabilities.length === legacyDoCapabilities.length
        && legacyDoCapabilities.every((capability) => p.capabilities.includes(capability))) {
        p.capabilities = modernDoCapabilities;
        profileChanged = true;
      }
      // Direct cross-world file inspection was replaced by durable Git handoff.
      // Migrate existing profiles so the removed capability does not strand their
      // collaboration access or remain as an unrecognized settings value.
      if (Array.isArray(p.capabilities) && p.capabilities.includes('task:world:read')) {
        p.capabilities = [...new Set(p.capabilities.filter((capability: string) => capability !== 'task:world:read')
          .concat(['task:git:publish', 'task:git:import']))];
        profileChanged = true;
      }
      if (p.maxTurns !== undefined) {
        delete p.maxTurns;
        profileChanged = true;
      }
      // Only write when something actually changed: an unconditional UPDATE
      // rewrote every role-default profile row on every boot.
      if (profileChanged) this.db.prepare('UPDATE profiles SET json = ? WHERE id = ?').run(JSON.stringify(p), r.id);
    }

    // Older `pass`-connector mirrors stored `domains` as the entry's TOP FOLDER
    // (e.g. ['.wifi'] or ['services']) and no username — the pass-path metadata
    // parser landed after those items were first imported, and a plain re-sync
    // does not touch items the user has not re-selected. A folder name can never
    // match a page origin, so origin-checked blind fill (§5B) and domain grants
    // were impossible for every pre-existing mirrored login. Re-derive the real
    // domain/username from each item's pass path (its externalId) — deterministic,
    // secret-free (no `pass show`/GPG), and idempotent: a re-run derives the same
    // values already present and writes nothing. Conservative: an item that
    // already carries a real-looking domain is left untouched.
    const vaultRows = this.db.prepare("SELECT k, v FROM kv WHERE k LIKE 'vault:items:%'").all() as Array<{ k: string; v: string }>;
    for (const vrow of vaultRows) {
      let items: any[];
      try { items = JSON.parse(vrow.v); } catch { continue; }
      if (!Array.isArray(items)) continue;
      let changed = false;
      for (const item of items) {
        if (item?.provenance?.source !== 'connector:pass') continue;
        const { domain, username } = passEntryMetadata(String(item.provenance.externalId ?? item.label ?? ''));
        const hasRealDomain = Array.isArray(item.domains)
          && item.domains.some((d: unknown) => typeof d === 'string' && d.includes('.') && !d.startsWith('.'));
        if (domain && !hasRealDomain) { item.domains = [domain]; changed = true; }
        if (username && !item.username) { item.username = username; changed = true; }
      }
      if (changed) this.db.prepare('UPDATE kv SET v=? WHERE k=?').run(JSON.stringify(items), vrow.k);
    }

    // Tag `kind` used to be optional, surfaced as a "general" choice. That option is
    // gone — every tag is now type/topic/flag — so a kind-less row left behind by an
    // older build (or by an agent naming a tag through `tag_task`) is no longer
    // representable: the editor pre-selects `topic` and silently reclassifies it on
    // save, and kind-scoped sections (`group:tag-type`/`tag-topic`) bucket it under
    // Untagged. Adopt that same reading explicitly. Idempotent: creation now always
    // sets a kind, so a re-run matches nothing.
    this.db.prepare("UPDATE tags SET kind = 'topic' WHERE kind IS NULL OR kind = ''").run();

    // Before provider reconciliation, E2B cost was derived from runner-lease
    // wall time. Auto-paused sandboxes stop billing while those leases can remain
    // stale for days, so every such historical row is known-bad. Reconciled rows
    // carry their source explicitly and survive this idempotent cleanup.
    this.db.prepare(`DELETE FROM usage_events WHERE provider='e2b' AND kind='world.active'
      AND (metadata IS NULL OR json_extract(metadata, '$.source') IS NULL
        OR json_extract(metadata, '$.source') != 'provider-lifecycle')`).run();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, organizationId TEXT, name TEXT NOT NULL, createdAt INTEGER NOT NULL, config TEXT NOT NULL,
        ord INTEGER NOT NULL DEFAULT 0
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
        kind TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organization_memberships (
        organizationId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL,
        joinedAt INTEGER NOT NULL, PRIMARY KEY (organizationId, userId)
      );
      CREATE TABLE IF NOT EXISTS user_preferences (
        userId TEXT PRIMARY KEY, defaultOrganizationId TEXT
      );
      CREATE TABLE IF NOT EXISTS policy_acceptances (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, email TEXT,
        organizationId TEXT, context TEXT NOT NULL, versionsJson TEXT NOT NULL,
        acceptedAt INTEGER NOT NULL, checkoutRequestReference TEXT,
        checkoutSessionReference TEXT, commercialTermsJson TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_policy_acceptances_user
        ON policy_acceptances(userId, acceptedAt);
      CREATE TABLE IF NOT EXISTS organization_invitations (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, email TEXT NOT NULL,
        role TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE, invitedBy TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, acceptedAt INTEGER,
        authorizationJson TEXT
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
      CREATE TABLE IF NOT EXISTS project_wikis (
        projectId TEXT PRIMARY KEY, repositoryId TEXT, createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organization_wiki_versions (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, path TEXT NOT NULL,
        version INTEGER NOT NULL, operation TEXT NOT NULL, kind TEXT,
        content TEXT, principal TEXT, previousPath TEXT, createdAt INTEGER NOT NULL,
        UNIQUE (organizationId, path, version)
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
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER,
        returnTo TEXT, githubAccountId TEXT, githubLogin TEXT, selectAccount INTEGER
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
      CREATE TABLE IF NOT EXISTS resource_attachments (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT NOT NULL,
        name TEXT NOT NULL, driver TEXT NOT NULL, target TEXT NOT NULL,
        access TEXT NOT NULL, isolation TEXT NOT NULL, source TEXT NOT NULL,
        credentialHandles TEXT NOT NULL, currentRevisionId TEXT, publish TEXT NOT NULL,
        storageLocationId TEXT, enabled INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE(projectId, name)
      );
      CREATE TABLE IF NOT EXISTS resource_revisions (
        id TEXT PRIMARY KEY, attachmentId TEXT NOT NULL, parentRevisionId TEXT,
        engine TEXT NOT NULL, sealedRef TEXT NOT NULL, rootDigest TEXT NOT NULL,
        bytes INTEGER NOT NULL, files INTEGER, metadata TEXT, createdByTaskId TEXT,
        storageLocationId TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_leases (
        id TEXT PRIMARY KEY, attachmentId TEXT NOT NULL, revisionId TEXT,
        taskId TEXT NOT NULL, worldId TEXT NOT NULL, worldGeneration INTEGER NOT NULL,
        access TEXT NOT NULL, state TEXT NOT NULL, sealedDriverRef TEXT,
        createdAt INTEGER NOT NULL, expiresAt INTEGER, releasedAt INTEGER,
        UNIQUE(attachmentId, taskId, worldGeneration)
      );
      CREATE TABLE IF NOT EXISTS resource_snapshot_chunks (
        organizationId TEXT NOT NULL,
        chunkId TEXT NOT NULL,
        storageLocationId TEXT,
        refs INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        PRIMARY KEY(organizationId, chunkId)
      );
      CREATE TABLE IF NOT EXISTS storage_locations (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL, config TEXT NOT NULL, credentialHandle TEXT,
        isDefault INTEGER NOT NULL, status TEXT NOT NULL, lastCheckedAt INTEGER,
        lastError TEXT, quotaBytes INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE(organizationId, name)
      );
      CREATE TABLE IF NOT EXISTS storage_upload_reservations (
        uploadId TEXT PRIMARY KEY, organizationId TEXT NOT NULL, storageLocationId TEXT NOT NULL,
        bytes INTEGER NOT NULL, expiresAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resource_candidates (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT NOT NULL,
        taskId TEXT NOT NULL, worldId TEXT NOT NULL, worldGeneration INTEGER NOT NULL,
        attachmentId TEXT NOT NULL UNIQUE, sourceKind TEXT NOT NULL, sourcePath TEXT,
        vaultItemId TEXT, vaultField TEXT, state TEXT NOT NULL, createdAt INTEGER NOT NULL,
        resolvedAt INTEGER, resolvedBy TEXT
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
        endedAt INTEGER NOT NULL, metadata TEXT, fundingSource TEXT NOT NULL DEFAULT 'customer',
        costClassification TEXT NOT NULL DEFAULT 'none'
      );
      CREATE TABLE IF NOT EXISTS usage_admissions (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT NOT NULL, taskId TEXT NOT NULL,
        kind TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, fundingSource TEXT NOT NULL,
        state TEXT NOT NULL, reservedCostMicros INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, releasedAt INTEGER
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
        urgency INTEGER NOT NULL DEFAULT ${urgencyRank('normal')},
        unread INTEGER NOT NULL, actionable INTEGER NOT NULL, createdAt INTEGER NOT NULL,
        readAt INTEGER, subject TEXT, UNIQUE (userId, eventSeq, kind)
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
      CREATE TABLE IF NOT EXISTS human_delegations (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        revokedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS task_intents (
        id TEXT PRIMARY KEY, principalAttemptId TEXT NOT NULL,
        committedAttemptId TEXT, confirmer TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS avatars (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT NOT NULL,
        ownerUserId TEXT NOT NULL, json TEXT NOT NULL, createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, deletedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_avatars_project ON avatars(projectId, deletedAt);
      CREATE INDEX IF NOT EXISTS idx_avatars_owner ON avatars(ownerUserId, deletedAt);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL,
        type TEXT NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collaboration_requests (
        id TEXT PRIMARY KEY, requesterTaskId TEXT NOT NULL, targetTaskId TEXT NOT NULL,
        targetRole TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
        afterSeq INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        settledAt INTEGER, result TEXT, notifiedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_collaboration_requests_target_status
        ON collaboration_requests(targetTaskId, status);
      CREATE INDEX IF NOT EXISTS idx_collaboration_requests_requester_status
        ON collaboration_requests(requesterTaskId, status);
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
        available INTEGER NOT NULL, merchantLock TEXT, createdAt INTEGER NOT NULL,
        externalId TEXT, currency TEXT NOT NULL DEFAULT 'usd',
        status TEXT NOT NULL DEFAULT 'active', cardholderId TEXT, last4 TEXT
      );
      CREATE TABLE IF NOT EXISTS payment_connections (
        organizationId TEXT NOT NULL, provider TEXT NOT NULL, accountId TEXT NOT NULL,
        status TEXT NOT NULL, livemode INTEGER NOT NULL, details TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY (organizationId, provider), UNIQUE (provider, accountId)
      );
      CREATE TABLE IF NOT EXISTS payment_oauth_states (
        stateHash TEXT PRIMARY KEY, organizationId TEXT NOT NULL, userId TEXT,
        redirectUri TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
        usedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS payment_spend_requests (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT NOT NULL,
        taskId TEXT NOT NULL, cardId TEXT, amount INTEGER NOT NULL, currency TEXT NOT NULL,
        merchant TEXT, why TEXT, status TEXT NOT NULL, reason TEXT, shortfall INTEGER,
        providerAuthorizationId TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL, resolvedBy TEXT
      );
      CREATE TABLE IF NOT EXISTS payment_transactions (
        id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, projectId TEXT,
        taskId TEXT, cardId TEXT, spendRequestId TEXT, provider TEXT NOT NULL,
        providerId TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        amount INTEGER NOT NULL, currency TEXT NOT NULL, merchant TEXT,
        raw TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        UNIQUE (provider, providerId, kind)
      );
      CREATE TABLE IF NOT EXISTS payment_events (
        provider TEXT NOT NULL, eventId TEXT NOT NULL, organizationId TEXT,
        type TEXT NOT NULL, decision TEXT, createdAt INTEGER NOT NULL,
        PRIMARY KEY (provider, eventId)
      );
      -- Hosted SaaS subscriptions are a separate ledger from agent spending
      -- cards/payment_connections above. Only verified provider events update
      -- plan, status, and seat quantities in this table.
      CREATE TABLE IF NOT EXISTS subscription_billing_accounts (
        organizationId TEXT PRIMARY KEY, provider TEXT NOT NULL, customerId TEXT UNIQUE,
        subscriptionId TEXT UNIQUE, plan TEXT NOT NULL, status TEXT NOT NULL,
        seats INTEGER NOT NULL, itemsJson TEXT NOT NULL, currentPeriodEnd INTEGER,
        cancelAtPeriodEnd INTEGER NOT NULL, lastEventAt INTEGER NOT NULL,
        lastEventRank INTEGER NOT NULL DEFAULT 0,
        verifiedAt INTEGER, pastDueAt INTEGER, lastError TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscription_billing_events (
        provider TEXT NOT NULL, eventId TEXT NOT NULL, type TEXT NOT NULL,
        createdAt INTEGER NOT NULL, processedAt INTEGER,
        PRIMARY KEY (provider, eventId)
      );
      CREATE TABLE IF NOT EXISTS subscription_billing_requests (
        requestKey TEXT PRIMARY KEY, organizationId TEXT NOT NULL, operation TEXT NOT NULL,
        requestHash TEXT NOT NULL, responseJson TEXT, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
        parentId TEXT, color TEXT, kind TEXT, description TEXT, createdAt INTEGER NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_inbox_task ON inbox(taskId, kind);
      CREATE INDEX IF NOT EXISTS idx_repositories_org ON repositories(organizationId, owner, name);
      CREATE INDEX IF NOT EXISTS idx_github_install_states_expiry ON github_install_states(expiresAt, usedAt);
      CREATE INDEX IF NOT EXISTS idx_scoped_tokens_expiry ON scoped_tokens(expiresAt);
      CREATE INDEX IF NOT EXISTS idx_human_delegations_expiry ON human_delegations(expiresAt);
      CREATE INDEX IF NOT EXISTS idx_world_instances_current ON world_instances(worldId, generation DESC);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_world ON world_checkpoints(worldId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_resource_attachments_project ON resource_attachments(projectId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_resource_revisions_attachment ON resource_revisions(attachmentId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_resource_leases_world ON resource_leases(worldId, worldGeneration);
      CREATE INDEX IF NOT EXISTS idx_resource_candidates_task ON resource_candidates(taskId, state, createdAt);
      CREATE INDEX IF NOT EXISTS idx_storage_locations_org ON storage_locations(organizationId, isDefault DESC, createdAt);
      CREATE INDEX IF NOT EXISTS idx_storage_upload_expiry ON storage_upload_reservations(expiresAt);
      CREATE INDEX IF NOT EXISTS idx_runner_pools_org ON runner_pools(organizationId, enabled);
      CREATE INDEX IF NOT EXISTS idx_world_provider_connections_org ON world_provider_connections(organizationId, enabled);
      CREATE INDEX IF NOT EXISTS idx_world_leases_pool ON world_leases(runnerPoolId, state, priority DESC, createdAt);
      CREATE INDEX IF NOT EXISTS idx_usage_org_time ON usage_events(organizationId, startedAt);
      CREATE INDEX IF NOT EXISTS idx_usage_admissions_org ON usage_admissions(organizationId, kind, state, createdAt);
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
      CREATE INDEX IF NOT EXISTS idx_payment_requests_task_status ON payment_spend_requests(taskId, status, createdAt);
      CREATE INDEX IF NOT EXISTS idx_payment_requests_org_status ON payment_spend_requests(organizationId, status, createdAt);
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_org_time ON payment_transactions(organizationId, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_subscription_billing_requests_org
        ON subscription_billing_requests(organizationId, createdAt);
    `);
    // Organization names became a shared, case-insensitive account namespace
    // after organizations had already shipped. Old builds allowed duplicates,
    // so creating the index in the schema batch made those installs fail before
    // any compatibility migration could run. Preserve the oldest label and give
    // each later collision its already-unique slug; ids and every foreign-key-like
    // reference remain unchanged. Do the repair and index creation atomically so
    // a failed migration never leaves a partially renamed install.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_organizations_name_nocase'").get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const organizations = this.db.prepare(`SELECT id, name, slug, createdAt FROM organizations
          ORDER BY createdAt, id`).all() as LegacyOrganizationNameRow[];
        const rename = this.db.prepare('UPDATE organizations SET name=? WHERE id=?');
        const originalNames = new Map(organizations.map((organization) => [organization.id, organization.name]));
        for (const organization of disambiguateLegacyOrganizationNames(organizations))
          if (organization.name !== originalNames.get(organization.id)) rename.run(organization.name, organization.id);
        this.db.exec(`CREATE UNIQUE INDEX idx_organizations_name_nocase
          ON organizations(name COLLATE NOCASE); COMMIT`);
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    // Free-form human notes, added after the initial schema. Guarded so existing
    // installs pick it up without a re-create.
    const cols = this.db.prepare('PRAGMA table_info(tasks)').all() as any[];
    const projectCols = this.db.prepare('PRAGMA table_info(projects)').all() as any[];
    const cardCols = this.db.prepare('PRAGMA table_info(cards)').all() as { name: string }[];
    if (!cardCols.some((c) => c.name === 'externalId')) this.db.exec('ALTER TABLE cards ADD COLUMN externalId TEXT');
    if (!cardCols.some((c) => c.name === 'currency')) this.db.exec("ALTER TABLE cards ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'");
    if (!cardCols.some((c) => c.name === 'status')) this.db.exec("ALTER TABLE cards ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    if (!cardCols.some((c) => c.name === 'cardholderId')) this.db.exec('ALTER TABLE cards ADD COLUMN cardholderId TEXT');
    if (!cardCols.some((c) => c.name === 'last4')) this.db.exec('ALTER TABLE cards ADD COLUMN last4 TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_provider_external ON cards(provider, externalId) WHERE externalId IS NOT NULL');
    // One inbox row per (user, task, kind): a notification is a LIVE ask, not a
    // copy of the event log. Older builds keyed rows by EVENT, so a task sitting
    // in review minted a fresh row on every lifecycle tick — the real install
    // reached 2,492 unread rows across 216 tasks. Collapse each group onto its
    // OLDEST row (the ask's true age) before the invariant becomes an index.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_inbox_live'").get()) {
      const duplicates = `SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY userId, taskId, kind ORDER BY createdAt, id) AS duplicateRank
        FROM inbox
      ) ranked WHERE duplicateRank > 1`;
      this.db.exec(`DELETE FROM delivery_outbox WHERE inboxId IN (${duplicates});
        DELETE FROM inbox WHERE id IN (${duplicates});
        CREATE UNIQUE INDEX idx_inbox_live ON inbox(userId, taskId, kind);`);
    }
    // Urgency arrived after the inbox did. Existing asks are all "normal": the
    // column default backfills them, and nothing needs to guess a level for an
    // ask whose requester never had one to state.
    const inboxCols = this.db.prepare('PRAGMA table_info(inbox)').all() as { name: string }[];
    if (!inboxCols.some((c) => c.name === 'urgency'))
      this.db.exec(`ALTER TABLE inbox ADD COLUMN urgency INTEGER NOT NULL DEFAULT ${urgencyRank('normal')}`);
    if (!inboxCols.some((c) => c.name === 'subject')) this.db.exec('ALTER TABLE inbox ADD COLUMN subject TEXT');
    const invitationCols = this.db.prepare('PRAGMA table_info(organization_invitations)').all() as any[];
    if (!invitationCols.some((c) => c.name === 'profileId')) this.db.exec('ALTER TABLE organization_invitations ADD COLUMN profileId TEXT');
    if (!invitationCols.some((c) => c.name === 'authorizationJson')) this.db.exec('ALTER TABLE organization_invitations ADD COLUMN authorizationJson TEXT');
    const previewCols = this.db.prepare('PRAGMA table_info(preview_leases)').all() as any[];
    if (!previewCols.some((c) => c.name === 'hostname')) this.db.exec('ALTER TABLE preview_leases ADD COLUMN hostname TEXT');
    const usageCols = this.db.prepare('PRAGMA table_info(usage_events)').all() as { name: string }[];
    if (!usageCols.some((c) => c.name === 'fundingSource'))
      this.db.exec("ALTER TABLE usage_events ADD COLUMN fundingSource TEXT NOT NULL DEFAULT 'customer'");
    if (!usageCols.some((c) => c.name === 'costClassification'))
      this.db.exec("ALTER TABLE usage_events ADD COLUMN costClassification TEXT NOT NULL DEFAULT 'none'");
    this.db.exec("UPDATE usage_events SET costClassification='incurred' WHERE costMicros>0 AND costClassification='none'");
    const usageAdmissionCols = this.db.prepare('PRAGMA table_info(usage_admissions)').all() as { name: string }[];
    if (!usageAdmissionCols.some((c) => c.name === 'reservedCostMicros'))
      this.db.exec('ALTER TABLE usage_admissions ADD COLUMN reservedCostMicros INTEGER NOT NULL DEFAULT 0');
    const githubStateCols = this.db.prepare('PRAGMA table_info(github_install_states)').all() as { name: string }[];
    if (!githubStateCols.some((c) => c.name === 'returnTo'))
      this.db.exec('ALTER TABLE github_install_states ADD COLUMN returnTo TEXT');
    if (!githubStateCols.some((c) => c.name === 'githubAccountId'))
      this.db.exec('ALTER TABLE github_install_states ADD COLUMN githubAccountId TEXT');
    if (!githubStateCols.some((c) => c.name === 'githubLogin'))
      this.db.exec('ALTER TABLE github_install_states ADD COLUMN githubLogin TEXT');
    if (!githubStateCols.some((c) => c.name === 'selectAccount'))
      this.db.exec('ALTER TABLE github_install_states ADD COLUMN selectAccount INTEGER');
    const wikiVersionCols = this.db.prepare('PRAGMA table_info(organization_wiki_versions)').all() as any[];
    if (!wikiVersionCols.some((c) => c.name === 'previousPath'))
      this.db.exec('ALTER TABLE organization_wiki_versions ADD COLUMN previousPath TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_preview_hostname ON preview_leases(hostname) WHERE hostname IS NOT NULL');
    if (!projectCols.some((c) => c.name === 'organizationId')) this.db.exec('ALTER TABLE projects ADD COLUMN organizationId TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organizationId)');
    // Hand-picked sidebar order. Existing rows all land on 0, and `ORDER BY ord,
    // createdAt` then reproduces exactly the creation order they had before —
    // so no backfill pass is needed; the first drag densifies that organization.
    if (!projectCols.some((c) => c.name === 'ord')) this.db.exec('ALTER TABLE projects ADD COLUMN ord INTEGER NOT NULL DEFAULT 0');
    if (!projectCols.some((c) => c.name === 'folder')) this.db.exec('ALTER TABLE projects ADD COLUMN folder TEXT');
    if (!cols.some((c) => c.name === 'conversation')) this.db.exec('ALTER TABLE tasks ADD COLUMN conversation TEXT');
    if (!cols.some((c) => c.name === 'conversationRef')) this.db.exec('ALTER TABLE tasks ADD COLUMN conversationRef TEXT');
    if (!cols.some((c) => c.name === 'intentId')) this.db.exec('ALTER TABLE tasks ADD COLUMN intentId TEXT');
    if (!cols.some((c) => c.name === 'attemptNumber')) this.db.exec('ALTER TABLE tasks ADD COLUMN attemptNumber INTEGER');
    // Legacy rows become single-attempt intents. Alternate attempts already point
    // at their root intent and must never acquire an intent row of their own:
    // doing so makes the alternate look like a second top-level task after boot.
    this.db.exec(`
      UPDATE tasks SET intentId = id WHERE intentId IS NULL;
      UPDATE tasks SET attemptNumber = 1 WHERE attemptNumber IS NULL;
      INSERT OR IGNORE INTO task_intents (id, principalAttemptId, createdAt)
        SELECT id, id, createdAt FROM tasks WHERE id = intentId;
      DELETE FROM task_intents
        WHERE EXISTS (
          SELECT 1 FROM tasks
          WHERE tasks.id = task_intents.id AND tasks.intentId <> task_intents.id
        );
      CREATE INDEX IF NOT EXISTS idx_tasks_intent ON tasks(intentId, attemptNumber);
    `);
    if (!cols.some((c) => c.name === 'notes')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN notes TEXT');
    }
    if (!cols.some((c) => c.name === 'createdBy')) this.db.exec('ALTER TABLE tasks ADD COLUMN createdBy TEXT');
    if (!cols.some((c) => c.name === 'assignee')) this.db.exec('ALTER TABLE tasks ADD COLUMN assignee TEXT');
    if (!cols.some((c) => c.name === 'delegate')) this.db.exec('ALTER TABLE tasks ADD COLUMN delegate TEXT');
    if (!cols.some((c) => c.name === 'confirmationPolicy')) this.db.exec('ALTER TABLE tasks ADD COLUMN confirmationPolicy TEXT');
    const organizationCols = this.db.prepare('PRAGMA table_info(organizations)').all() as { name: string }[];
    if (!organizationCols.some((c) => c.name === 'plan'))
      this.db.exec("ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
    if (!organizationCols.some((c) => c.name === 'nameVisibility'))
      this.db.exec("ALTER TABLE organizations ADD COLUMN nameVisibility TEXT NOT NULL DEFAULT 'members'");
    const policyAcceptanceCols = this.db.prepare('PRAGMA table_info(policy_acceptances)').all() as { name: string }[];
    if (!policyAcceptanceCols.some((c) => c.name === 'organizationId'))
      this.db.exec('ALTER TABLE policy_acceptances ADD COLUMN organizationId TEXT');
    if (!policyAcceptanceCols.some((c) => c.name === 'checkoutRequestReference'))
      this.db.exec('ALTER TABLE policy_acceptances ADD COLUMN checkoutRequestReference TEXT');
    if (!policyAcceptanceCols.some((c) => c.name === 'checkoutSessionReference'))
      this.db.exec('ALTER TABLE policy_acceptances ADD COLUMN checkoutSessionReference TEXT');
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_acceptances_checkout_request
      ON policy_acceptances(organizationId, checkoutRequestReference)
      WHERE organizationId IS NOT NULL AND checkoutRequestReference IS NOT NULL`);
    const subscriptionBillingCols = this.db.prepare('PRAGMA table_info(subscription_billing_accounts)').all() as { name: string }[];
    if (!subscriptionBillingCols.some((c) => c.name === 'pastDueAt'))
      this.db.exec('ALTER TABLE subscription_billing_accounts ADD COLUMN pastDueAt INTEGER');
    if (!subscriptionBillingCols.some((c) => c.name === 'lastEventRank'))
      this.db.exec('ALTER TABLE subscription_billing_accounts ADD COLUMN lastEventRank INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`UPDATE subscription_billing_accounts SET lastEventRank=CASE status
      WHEN 'canceled' THEN 690 WHEN 'incomplete_expired' THEN 680
      WHEN 'unpaid' THEN 670 WHEN 'paused' THEN 660 WHEN 'incomplete' THEN 650
      WHEN 'past_due' THEN 640 WHEN 'active' THEN 630 WHEN 'trialing' THEN 620
      ELSE 610 END WHERE lastEventAt > 0 AND lastEventRank=0`);
    const tagCols = this.db.prepare('PRAGMA table_info(tags)').all() as { name: string }[];
    if (!tagCols.some((c) => c.name === 'description')) this.db.exec('ALTER TABLE tags ADD COLUMN description TEXT');
    const attachmentCols = this.db.prepare('PRAGMA table_info(resource_attachments)').all() as { name: string }[];
    if (!attachmentCols.some((c) => c.name === 'storageLocationId'))
      this.db.exec('ALTER TABLE resource_attachments ADD COLUMN storageLocationId TEXT');
    const revisionCols = this.db.prepare('PRAGMA table_info(resource_revisions)').all() as { name: string }[];
    if (!revisionCols.some((c) => c.name === 'storageLocationId'))
      this.db.exec('ALTER TABLE resource_revisions ADD COLUMN storageLocationId TEXT');
    const chunkCols = this.db.prepare('PRAGMA table_info(resource_snapshot_chunks)').all() as { name: string }[];
    if (!chunkCols.some((c) => c.name === 'storageLocationId'))
      this.db.exec('ALTER TABLE resource_snapshot_chunks ADD COLUMN storageLocationId TEXT');

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
    // A software-dev@1.3 execution can switch its user-facing mode to Goal (and
    // back) without replacing the Temporal workflow. Keep the actual execution
    // definition separately so replay/version-retirement accounting stays true.
    if (!cols.some((c) => c.name === 'executionWorkflow')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN executionWorkflow TEXT');
      this.db.exec('UPDATE tasks SET executionWorkflow = workflow WHERE executionWorkflow IS NULL');
    }
    // Simple human-facing sequential id, numbered PER PROJECT (SPEC §10.6): each
    // project's queued tasks run #1, #2, … A separate integer alongside the opaque `id`
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
        // Queue time was not recorded by old schemas, so preserve creation order
        // for work that had started and leave never-queued drafts unnumbered.
        const rows = this.db
          .prepare(`SELECT root.id FROM tasks root
            WHERE root.projectId = ? AND root.id = root.intentId
              AND EXISTS (SELECT 1 FROM tasks attempt WHERE attempt.intentId = root.intentId
                AND COALESCE(json_extract(attempt.params, '$.draft'), 0) = 0)
            ORDER BY root.createdAt, root.rowid`)
          .all(projectId) as any[];
        let n = 0;
        for (const r of rows) upd.run(++n, r.id);
      }
      this.db.exec('CREATE UNIQUE INDEX idx_tasks_num_project ON tasks(projectId, num)');
    }
  }

  /**
   * Allocate a task's per-project number atomically.
   *
   * A single UPDATE whose value is a MAX+1 subquery: SQLite evaluates it under
   * the statement's write lock, so two Store instances queuing into the same
   * database cannot read the same maximum. The read-then-insert version this
   * replaced computed MAX+1 in JS outside any transaction and could hand two
   * tasks the same number — which the `idx_tasks_num_project` unique index then
   * turns into a hard insert failure. `clearDraft` has always used this form;
   * this is the same statement, so the two allocation paths cannot diverge.
   */
  private allocateTaskNum(projectId: string, taskId: string): number | undefined {
    this.db.prepare(`UPDATE tasks SET num = (
      SELECT COALESCE(MAX(num), 0) + 1 FROM tasks WHERE projectId = ?
    ) WHERE id = ? AND num IS NULL`).run(projectId, taskId);
    const row = this.db.prepare('SELECT num FROM tasks WHERE id = ?').get(taskId) as any;
    return row?.num == null ? undefined : Number(row.num);
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  createProject(name: string, config: ProjectConfig = {}, organizationId = 'org_personal'): Project {
    if (!this.getOrganization(organizationId)) throw new Error(`no organization ${organizationId}`);
    const path = parseProjectPath(name);
    assertRoutableName('project', path.name);
    this.assertUniqueProjectName(organizationId, path.name);
    config = writableProjectConfig(config);
    validateProjectExecutionConfig(config);
    const ord = (this.db
      .prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM projects WHERE organizationId = ?')
      .get(organizationId) as any).m + 1;
    const p: Project = { id: newId('proj'), organizationId, name: path.name, createdAt: Date.now(), config, order: ord,
      ...(path.folder ? { folder: path.folder } : {}) };
    this.db
      .prepare('INSERT INTO projects (id, organizationId, name, createdAt, config, ord, folder) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, organizationId, p.name, p.createdAt, JSON.stringify(p.config), ord, p.folder ?? null);
    // every project gets a default task list
    this.createList(p.id, 'Tasks');
    return p;
  }

  getProject(id: string): Project | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    return r ? rowToProject(r) : undefined;
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY ord, createdAt').all() as any[]).map(
      rowToProject,
    );
  }

  renameProject(id: string, name: string): Project {
    const existing = this.getProject(id);
    if (!existing) throw new Error(`no project ${id}`);
    const path = parseProjectPath(name);
    assertRoutableName('project', path.name);
    this.assertUniqueProjectName(existing.organizationId ?? 'org_personal', path.name, id);
    this.db.prepare('UPDATE projects SET name = ?, folder = ? WHERE id = ?').run(path.name, path.folder ?? null, id);
    const { folder: _, ...rest } = existing;
    return { ...rest, name: path.name, ...(path.folder ? { folder: path.folder } : {}) };
  }

  /** Project URLs use the leaf name only, so the leaf's slug must be unique in
   * its organization even when projects live in different sidebar folders. */
  private assertUniqueProjectName(organizationId: string, name: string, exceptId?: string): void {
    const wanted = slugify(name);
    const conflict = this.listProjects().find((project) => project.id !== exceptId
      && (project.organizationId ?? 'org_personal') === organizationId && slugify(project.name) === wanted);
    if (conflict) throw new Error(`A project named "${name}" already exists in this organization.`);
  }

  /** Put a project in a sidebar folder ("Work/Clients"), or at the top level
   * when the path is empty. The folder needs no other existence: it appears in
   * the sidebar while a project names it and vanishes when the last one leaves. */
  setProjectFolder(id: string, folder: string): Project {
    const existing = this.getProject(id);
    if (!existing) throw new Error(`no project ${id}`);
    const next = normalizeFolder(folder);
    this.db.prepare('UPDATE projects SET folder = ? WHERE id = ?').run(next ?? null, id);
    const { folder: _, ...rest } = existing;
    return next ? { ...rest, folder: next } : rest;
  }

  /** Projects represented by one implicit sidebar folder, including its nested
   * folders. `id` anchors the lookup to an organization and must itself live in
   * the requested folder tree, so a caller cannot use a project from one part of
   * the sidebar to operate on an unrelated path. */
  projectFolderProjects(id: string, folder: string): Project[] {
    const anchor = this.getProject(id);
    if (!anchor) throw new Error(`no project ${id}`);
    const path = normalizeFolder(folder);
    if (!path) throw new Error('folder path is required');
    const inside = (candidate: Project) => candidate.folder === path || candidate.folder?.startsWith(`${path}/`);
    if (!inside(anchor)) throw new Error('project does not belong to this folder');
    const organizationId = anchor.organizationId ?? 'org_personal';
    return this.listProjects().filter((project) =>
      (project.organizationId ?? 'org_personal') === organizationId && inside(project));
  }

  /** Rename one segment of an implicit sidebar folder and carry every nested
   * project with it in one transaction. A rename never silently merges two
   * existing trees; moving individual projects remains the drag-and-drop job. */
  renameProjectFolder(id: string, folder: string, name: string): { folder: string; projects: Project[] } {
    const source = normalizeFolder(folder);
    if (!source) throw new Error('folder path is required');
    const segment = String(name ?? '').trim();
    if (!segment) throw new Error('folder name is required');
    if (segment.includes('/')) throw new Error('folder name cannot contain "/"');
    const projects = this.projectFolderProjects(id, source);
    const cut = source.lastIndexOf('/');
    const parent = cut < 0 ? '' : source.slice(0, cut);
    const target = normalizeFolder([parent, segment].filter(Boolean).join('/'))!;
    if (target === source) return { folder: source, projects };

    const organizationId = projects[0]!.organizationId ?? 'org_personal';
    const affected = new Set(projects.map((project) => project.id));
    const conflicts = this.listProjects().some((project) => {
      if (affected.has(project.id) || (project.organizationId ?? 'org_personal') !== organizationId) return false;
      return project.folder === target || project.folder?.startsWith(`${target}/`);
    });
    if (conflicts) throw new Error(`A folder named "${segment}" already exists here.`);

    const update = this.db.prepare('UPDATE projects SET folder = ? WHERE id = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const renamed = projects.map((project) => {
        const suffix = project.folder!.slice(source.length);
        const nextFolder = `${target}${suffix}`;
        update.run(nextFolder, project.id);
        return { ...project, folder: nextFolder };
      });
      this.db.exec('COMMIT');
      return { folder: target, projects: renamed };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Move a project so it sits immediately before `beforeProjectId` in the sidebar,
   * or last when that is omitted/unknown. Only the moved project's own organization
   * is touched, and its rows are re-densified to 0…n-1 so repeated drags stay stable.
   * A drop can also carry the folder the project now sits in — position and folder
   * are one gesture, so they persist as one move. Returns that organization's
   * projects in their new order. */
  reorderProject(id: string, beforeProjectId?: string, folder?: string): Project[] {
    let moving = this.getProject(id);
    if (!moving) throw new Error(`no project ${id}`);
    if (folder !== undefined) moving = this.setProjectFolder(id, folder);
    const organizationId = moving.organizationId ?? 'org_personal';
    const siblings = this.listProjects()
      .filter((p) => (p.organizationId ?? 'org_personal') === organizationId && p.id !== id);
    const at = beforeProjectId ? siblings.findIndex((p) => p.id === beforeProjectId) : -1;
    siblings.splice(at < 0 ? siblings.length : at, 0, moving);
    const upd = this.db.prepare('UPDATE projects SET ord = ? WHERE id = ?');
    return siblings.map((p, ord) => { upd.run(ord, p.id); return { ...p, order: ord }; });
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
      environment: { flavor: 'headless' },
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
      environment: { ...fallback.environment, ...saved.environment },
    };
  }

  setOrganizationExecutionPolicy(organizationId: string, policy: OrganizationExecutionPolicy): OrganizationExecutionPolicy {
    if (!this.getOrganization(organizationId)) throw new Error(`no organization ${organizationId}`);
    const current = this.getOrganizationExecutionPolicy(organizationId);
    const next: OrganizationExecutionPolicy = {
      ...current, ...policy,
      resources: policy.resources ? { ...current.resources, ...policy.resources } : current.resources,
      network: policy.network ? { ...policy.network } : current.network,
      environment: policy.environment ? { ...current.environment, ...policy.environment } : current.environment,
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

  getOrganizationUsagePolicy(organizationId: string): OrganizationUsagePolicy {
    if (!this.getOrganization(organizationId)) throw new Error(`no organization ${organizationId}`);
    const planLimit = this.organizationEntitlements(organizationId).maxActiveAgentRuns ?? 10_000;
    const fallback: Omit<OrganizationUsagePolicy, 'effectiveMaxActiveAgentTurns'> = {
      managedModelProviders: [],
      allowedModelProviders: [],
      allowedModels: [],
      maxAgentStartsPerMinute: this.hosted ? 60 : 10_000,
      maxRemoteStartsPerMinute: this.hosted ? 30 : 10_000,
      maxActiveWorlds: this.hosted ? planLimit : 10_000,
    };
    const raw = this.kvGet(`organization-usage-policy:${organizationId}`);
    let saved: Partial<OrganizationUsagePolicy> = {};
    if (raw) try { saved = JSON.parse(raw); } catch { saved = {}; }
    delete saved.effectiveMaxActiveAgentTurns;
    const ownerLimit = Number.isSafeInteger(saved.maxActiveAgentTurns) && saved.maxActiveAgentTurns! > 0
      ? saved.maxActiveAgentTurns : undefined;
    const effectiveAgentLimit = ownerLimit == null ? planLimit : Math.min(ownerLimit, planLimit);
    return { ...fallback, ...saved,
      managedModelProviders: [...(saved.managedModelProviders ?? [])],
      allowedModelProviders: [...(saved.allowedModelProviders ?? [])],
      allowedModels: [...(saved.allowedModels ?? [])],
      ...(ownerLimit == null ? {} : { maxActiveAgentTurns: ownerLimit }),
      effectiveMaxActiveAgentTurns: effectiveAgentLimit,
      // Customer-funded hosted worlds use the same marketed concurrency number
      // as agent turns. Ignore legacy/custom saved values so there is no second
      // SaaS capacity product hiding behind the plan entitlement.
      maxActiveWorlds: this.hosted ? effectiveAgentLimit : (saved.maxActiveWorlds ?? fallback.maxActiveWorlds),
    };
  }

  setOrganizationUsagePolicy(organizationId: string, patch: Partial<OrganizationUsagePolicy>): OrganizationUsagePolicy {
    const current = this.getOrganizationUsagePolicy(organizationId);
    const effectivePatch = { ...patch };
    if (this.hosted) delete effectivePatch.maxActiveWorlds;
    const next = { ...current, ...effectivePatch } as OrganizationUsagePolicy;
    delete (next as Partial<OrganizationUsagePolicy>).effectiveMaxActiveAgentTurns;
    if (Object.prototype.hasOwnProperty.call(patch, 'managedSpendCapMicros')
      && (patch as any).managedSpendCapMicros == null) delete next.managedSpendCapMicros;
    if (Object.prototype.hasOwnProperty.call(patch, 'maxActiveAgentTurns')
      && (patch as any).maxActiveAgentTurns == null) delete next.maxActiveAgentTurns;
    const normalized = (values: unknown, label: string): string[] => {
      if (!Array.isArray(values)) throw new Error(`${label} must be a list`);
      const out = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
      if (out.some((value) => value.length > 160 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(value)))
        throw new Error(`${label} contains an invalid value`);
      return out;
    };
    next.managedModelProviders = normalized(next.managedModelProviders, 'managed model providers');
    next.allowedModelProviders = normalized(next.allowedModelProviders, 'allowed model providers');
    next.allowedModels = normalized(next.allowedModels, 'allowed models');
    for (const [key, value] of Object.entries({
      maxAgentStartsPerMinute: next.maxAgentStartsPerMinute,
      maxRemoteStartsPerMinute: next.maxRemoteStartsPerMinute,
      ...(!this.hosted ? { maxActiveWorlds: next.maxActiveWorlds } : {}),
    })) if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error(`${key} must be an integer from 1 to 1000000`);
    if (next.maxActiveAgentTurns != null && (!Number.isSafeInteger(next.maxActiveAgentTurns)
      || next.maxActiveAgentTurns < 1 || next.maxActiveAgentTurns > 1_000_000))
      throw new Error('maxActiveAgentTurns must be an integer from 1 to 1000000');
    const planLimit = this.organizationEntitlements(organizationId).maxActiveAgentRuns;
    if (next.maxActiveAgentTurns != null && planLimit != null)
      next.maxActiveAgentTurns = Math.min(next.maxActiveAgentTurns, planLimit);
    if (next.managedSpendCapMicros != null && (!Number.isSafeInteger(next.managedSpendCapMicros) || next.managedSpendCapMicros < 1))
      throw new Error('managed spend cap must be a positive integer');
    const persisted: Partial<OrganizationUsagePolicy> = { ...next };
    delete persisted.effectiveMaxActiveAgentTurns;
    if (this.hosted) delete persisted.maxActiveWorlds;
    this.kvSet(`organization-usage-policy:${organizationId}`, JSON.stringify(persisted));
    this.reconcileHostedUsageCapacity(organizationId);
    return this.getOrganizationUsagePolicy(organizationId);
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
    const config = {
      ...organization,
      ...value.config,
      // A pool belongs to one provider. Selecting a different provider at the
      // project level therefore falls back to that provider's managed pool
      // unless the project explicitly selects a compatible pool of its own.
      runnerPoolId: value.config.runnerPoolId ?? (providerChanged ? undefined : organization.runnerPoolId),
      resources: { ...organization.resources, ...value.config.resources },
      network: value.config.network ? { ...value.config.network } : organization.network,
      environment: { ...organization.environment, ...value.config.environment },
    };
    // Hosted task worlds are disposable and GitHub is their durable development
    // authority. Historical projects/settings may still contain the old `none`
    // default, so resolve those as PR delivery without rewriting an in-flight
    // workflow's already-recorded input. Self-hosted projects retain local-only
    // delivery and its `none` default.
    if (process.env.KARMAX_DEPLOYMENT === 'hosted' && (config.remote === undefined || config.remote === 'none'))
      config.remote = 'pr';
    return config;
  }

  setProjectExecutionPolicy(id: string, override: Partial<Record<keyof OrganizationExecutionPolicy, unknown>>): Project {
    const existing = this.getProject(id);
    if (!existing) throw new Error(`no project ${id}`);
    const config: Record<string, unknown> = { ...existing.config };
    for (const key of ['worldProvider', 'runnerPoolId', 'resources', 'network', 'environment', 'monthlyBudgetMicros', 'hibernateAfterMs'] as const) {
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
    const merged = writableProjectConfig({ ...existing.config, ...config });
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
    const project = this.getProject(id);
    if (!project) throw new Error('project not found');
    const tasks = selectRows(this.db, 'tasks', 'projectId=?', [id]);
    const taskIds = tasks.map((row) => String(row.id));
    const intentIds = tasks.map((row) => String(row.intentId)).filter(Boolean);
    const executionIds = (this.db.prepare('SELECT id FROM executions WHERE projectId=?').all(id) as any[])
      .map((row) => String(row.id));
    const avatarIds = (this.db.prepare('SELECT id FROM avatars WHERE projectId=?').all(id) as any[])
      .map((row) => String(row.id));
    const authorizationInboxIds = (this.db.prepare("SELECT id FROM inbox WHERE json_extract(subject, '$.projectId')=?").all(id) as any[])
      .map((row) => String(row.id));
    const inboxIds = [...rowsFor(this.db, 'inbox', 'taskId', taskIds).map((row) => String(row.id)), ...authorizationInboxIds];
    const teamIds = (this.db.prepare('SELECT id FROM teams WHERE projectId=?').all(id) as any[])
      .map((row) => String(row.id));
    const scopeKey = `project:${id}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.revokeScopedTokens({ projectId: id });
      this.revokeHumanDelegations({ projectId: id });
      deleteRows(this.db, 'delivery_outbox', 'inboxId', inboxIds);
      deleteRows(this.db, 'execution_frames', 'executionId', executionIds);
      deleteRows(this.db, 'team_memberships', 'teamId', teamIds);
      deleteRows(this.db, 'team_aliases', 'teamId', teamIds);
      deleteRows(this.db, 'task_subscribers', 'taskId', taskIds);
      deleteRows(this.db, 'task_confirmation', 'taskId', taskIds);
      deleteRows(this.db, 'confirmation_votes', 'taskId', taskIds);
      deleteRows(this.db, 'task_tags', 'taskId', taskIds);
      deleteRows(this.db, 'collaboration_requests', 'requesterTaskId', taskIds);
      deleteRows(this.db, 'collaboration_requests', 'targetTaskId', taskIds);
      deleteRows(this.db, 'events', 'taskId', taskIds);
      deleteRows(this.db, 'events', 'taskId', avatarIds.map((avatarId) => `avatar:${avatarId}`));
      deleteRows(this.db, 'world_instances', 'worldId', taskIds);
      deleteRows(this.db, 'task_intents', 'id', intentIds);
      this.db.prepare('DELETE FROM inbox WHERE taskId IN (SELECT id FROM tasks WHERE projectId=?)').run(id);
      deleteRows(this.db, 'inbox', 'id', authorizationInboxIds);
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
      const resourceIds = (this.db.prepare('SELECT id FROM resource_attachments WHERE projectId=?').all(id) as any[])
        .map((row) => String(row.id));
      deleteRows(this.db, 'resource_leases', 'attachmentId', resourceIds);
      deleteRows(this.db, 'resource_revisions', 'attachmentId', resourceIds);
      this.db.prepare('DELETE FROM resource_candidates WHERE projectId=?').run(id);
      this.db.prepare('DELETE FROM resource_attachments WHERE projectId=?').run(id);
      this.db.prepare('DELETE FROM avatars WHERE projectId=?').run(id);
      this.deletePermissionRequestKv(project.organizationId, taskIds);
      this.deleteAuthorizationRequestKv(project.organizationId, { kind: 'avatar', ids: avatarIds });
      this.deleteProjectKv([id], taskIds);
      for (const table of ['project_memberships', 'project_repositories', 'project_wikis', 'task_lists', 'tags', 'saved_views', 'world_checkpoints'] as const)
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

  /**
   * Identity rows live in auth.db, while organizations live in karmax.db. The
   * gateway connects the two stores after both have run their own schema
   * migrations, giving every organization write the same cross-store guard.
   */
  connectUserNames(lookup: () => Array<{ id: string; name: string }>): void {
    this.userNames = lookup;
  }

  /**
   * Observe organization mutations that can change hosted admission. The store
   * remains the single synchronous billing/member write boundary; control-plane
   * services use this hook to reconcile derived durable coordinator state.
   */
  onOrganizationEntitlementsChanged(listener: (organizationId: string) => void): () => void {
    this.organizationEntitlementListeners.add(listener);
    return () => this.organizationEntitlementListeners.delete(listener);
  }

  private notifyOrganizationEntitlementsChanged(organizationId: string): void {
    // Run after the current synchronous write/transaction has completed. In
    // particular, deprovisionOrganizationUser removes the membership inside a
    // larger transaction and must never reconcile from an intermediate state.
    queueMicrotask(() => {
      for (const listener of this.organizationEntitlementListeners) {
        try { listener(organizationId); } catch { /* a periodic reconciler retries */ }
      }
    });
  }

  /** Keep hosted customer-world admission aligned with plan/member concurrency.
   * Agent queues are reconciled by EntitlementQueueReconciler through the
   * notification above; world leases are store-owned and can refresh here. */
  private reconcileHostedUsageCapacity(organizationId: string): void {
    if (!this.hosted || !this.getOrganization(organizationId)) return;
    const activeWorlds = this.getOrganizationUsagePolicy(organizationId).maxActiveWorlds;
    for (const pool of this.listRunnerPools(organizationId)) {
      if (pool.mode === 'customer' && !['worktree', 'container', 'memory'].includes(pool.provider))
        this.createRunnerPool({ ...pool, capacity: { ...pool.capacity, activeWorlds } });
    }
    this.reconcileWorldLeaseCapacity(organizationId);
  }

  /**
   * One-time bridge for installations that created users and organizations
   * before they shared an account-name namespace. A user's registered name wins;
   * a colliding organization keeps its identity and stable slug but adopts that
   * slug as its display name. The one valid overlap is a user's own personal
   * organization. Later writes go through the connected cross-store guards, so
   * this migration is deliberately marked complete instead of silently repairing
   * new corruption on every boot.
   */
  migrateLegacyAccountNameCollisions(users: Array<{ id: string; name: string }>): number {
    const marker = 'migration:account-name-namespace-v1';
    if (this.db.prepare('SELECT 1 FROM kv WHERE k=?').get(marker)) return 0;
    let changed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const usersByName = new Map<string, string>();
      for (const user of users) {
        const key = canonicalAccountName(user.name);
        const existing = usersByName.get(key);
        if (existing && existing !== user.id)
          throw new Error(`user name "${user.name.trim()}" is already used by another user`);
        usersByName.set(key, user.id);
      }
      const organizations = this.listOrganizations();
      const occupied = new Set([
        ...usersByName.keys(),
        ...organizations.map((organization) => canonicalAccountName(organization.name)),
      ]);
      for (const organization of organizations) {
        const userId = usersByName.get(canonicalAccountName(organization.name));
        if (!userId) continue;
        const isOwnersPersonalName = organization.kind === 'personal'
          && this.organizationMembership(organization.id, userId)?.role === 'owner';
        if (isOwnersPersonalName) continue;
        const base = organization.slug.trim() || 'organization';
        let candidate = base;
        for (let suffix = 2; occupied.has(canonicalAccountName(candidate)); suffix++)
          candidate = `${base}-${suffix}`;
        this.db.prepare('UPDATE organizations SET name=? WHERE id=?').run(candidate, organization.id);
        occupied.add(canonicalAccountName(candidate));
        changed++;
      }
      this.validateAccountNameNamespace(users);
      this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run(marker, String(Date.now()));
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private assertOrganizationNameAvailable(name: string, options: {
    excludeOrganizationId?: string;
    allowUserId?: string;
  } = {}): string {
    const value = name.trim();
    if (!value) throw new Error('organization name is required');
    const key = canonicalAccountName(value);
    const organization = this.listOrganizations().find((candidate) =>
      candidate.id !== options.excludeOrganizationId && canonicalAccountName(candidate.name) === key);
    if (organization) throw new Error(`name "${value}" is already used by an organization`);
    const user = this.userNames?.().find((candidate) =>
      candidate.id !== options.allowUserId && canonicalAccountName(candidate.name) === key);
    if (user) throw new Error(`name "${value}" is already used by a user`);
    return value;
  }

  createOrganization(input: { name: string; slug?: string; kind?: Organization['kind']; ownerUserId?: string }): Organization {
    assertRoutableName('organization', input.name, input.slug);
    const name = this.assertOrganizationNameAvailable(input.name,
      input.kind === 'personal' ? { allowUserId: input.ownerUserId } : undefined);
    const slug = uniqueSlug(input.slug ?? input.name, (candidate) => !!this.db.prepare('SELECT 1 FROM organizations WHERE slug = ?').get(candidate));
    const organization: Organization = {
      id: newId('org'), name, slug,
      kind: input.kind ?? 'team', plan: 'free', nameVisibility: 'members', createdAt: Date.now(),
    };
    this.db.prepare('INSERT INTO organizations (id, name, slug, kind, plan, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(organization.id, organization.name, organization.slug, organization.kind, organization.plan, organization.createdAt);
    if (input.ownerUserId) this.setOrganizationMembership(organization.id, input.ownerUserId, 'owner');
    return organization;
  }

  getOrganization(id: string): Organization | undefined {
    const r = this.db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as any;
    return r ? rowToOrganization(r) : undefined;
  }

  organizationEntitlements(organizationId: string): OrganizationEntitlements {
    const organization = this.getOrganization(organizationId);
    if (!organization) throw new Error(`no organization ${organizationId}`);
    return organizationEntitlements(organization.plan, this.hosted,
      this.listOrganizationMemberships(organizationId).length);
  }

  /** Billing's sole plan mutation boundary. Pricing and limits remain in the
   * domain catalog rather than being copied into billing-provider code. */
  setOrganizationPlan(organizationId: string, plan: HostedPlanId): Organization {
    if (!isHostedPlanId(plan)) throw new Error(`unknown hosted plan ${String(plan)}`);
    if (!this.getOrganization(organizationId)) throw new Error(`no organization ${organizationId}`);
    this.db.prepare('UPDATE organizations SET plan=? WHERE id=?').run(plan, organizationId);
    this.reconcileHostedUsageCapacity(organizationId);
    this.notifyOrganizationEntitlementsChanged(organizationId);
    return this.getOrganization(organizationId)!;
  }

  private assertOrganizationMemberCapacity(organizationId: string, userId?: string): void {
    if (!this.hosted || (userId && this.organizationMembership(organizationId, userId))) return;
    const entitlements = this.organizationEntitlements(organizationId);
    if (entitlements.maxMembers == null) return;
    const count = entitlements.currentMemberCount;
    if (entitlements.memberAdmissionAllowed) return;
    if (entitlements.overMemberLimit) {
      const extra = count - entitlements.maxMembers;
      throw new EntitlementError(
        `${entitlements.planName} allows ${entitlements.maxMembers} organization user${entitlements.maxMembers === 1 ? '' : 's'}, but this organization has ${count}. Remove ${extra} member${extra === 1 ? '' : 's'} or restore Team before adding another person.`,
      );
    }
    throw new EntitlementError(
      `${entitlements.planName} allows ${entitlements.maxMembers} organization user${entitlements.maxMembers === 1 ? '' : 's'}. Upgrade the plan before adding another person.`,
    );
  }

  renameOrganization(id: string, name: string): Organization {
    const existing = this.getOrganization(id);
    if (!existing) throw new Error(`no organization ${id}`);
    const personalOwner = existing.kind === 'personal'
      ? this.listOrganizationMemberships(id).find((membership) => membership.role === 'owner')?.userId
      : undefined;
    const nextName = this.assertOrganizationNameAvailable(name,
      { excludeOrganizationId: id, allowUserId: personalOwner });
    this.db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(nextName, id);
    return { ...existing, name: nextName };
  }

  listOrganizations(userId?: string): Organization[] {
    const rows = userId
      ? this.db.prepare(`SELECT o.* FROM organizations o JOIN organization_memberships m
          ON m.organizationId=o.id WHERE m.userId=? ORDER BY o.createdAt`).all(userId)
      : this.db.prepare('SELECT * FROM organizations ORDER BY createdAt').all();
    return (rows as any[]).map(rowToOrganization);
  }

  setOrganizationNameVisibility(id: string, visibility: Organization['nameVisibility']): Organization {
    if (visibility !== 'members' && visibility !== 'public') throw new Error('nameVisibility must be members or public');
    if (!this.getOrganization(id)) throw new Error('organization not found');
    this.db.prepare('UPDATE organizations SET nameVisibility=? WHERE id=?').run(visibility, id);
    return this.getOrganization(id)!;
  }

  /** Discovery deliberately returns names only, never tenant settings. */
  organizationDirectory(userId: string, operator = false): Array<{ id: string; name: string; accessible: boolean }> {
    const memberships = new Set(this.listOrganizations(userId).map((organization) => organization.id));
    return this.listOrganizations()
      .filter((organization) => operator || memberships.has(organization.id) || organization.nameVisibility === 'public')
      .map((organization) => ({ id: organization.id, name: organization.name, accessible: operator || memberships.has(organization.id) }));
  }

  /** The unclaimed migration placeholder is not a real namespace reservation. */
  organizationNameReservations(): Organization[] {
    return this.listOrganizations().filter((organization) => organization.id !== 'org_personal'
      || this.listOrganizationMemberships(organization.id).length > 0);
  }

  /** The workspace a person's neutral `/` route opens. Existing users predate
   * this preference, so initialize them lazily to the personal workspace they
   * own; joining or creating another organization must never change it. */
  defaultOrganization(userId: string, operator = false): Organization | undefined {
    const row = this.db.prepare('SELECT defaultOrganizationId FROM user_preferences WHERE userId=?').get(userId) as any;
    const organizations = this.listOrganizations(operator ? undefined : userId);
    const stored = organizations.find((organization) => organization.id === row?.defaultOrganizationId);
    if (stored) return stored;
    const fallback = organizations.find((organization) => organization.kind === 'personal'
      && this.organizationMembership(organization.id, userId)?.role === 'owner')
      ?? organizations.find((organization) => organization.kind === 'personal')
      ?? organizations[0];
    if (fallback) this.setDefaultOrganization(userId, fallback.id, operator);
    return fallback;
  }

  setDefaultOrganization(userId: string, organizationId: string, operator = false): Organization {
    const organization = this.getOrganization(organizationId);
    if (!organization || (!operator && !this.organizationMembership(organizationId, userId)))
      throw new Error('default organization must be one of your organizations');
    this.db.prepare(`INSERT INTO user_preferences (userId, defaultOrganizationId) VALUES (?, ?)
      ON CONFLICT(userId) DO UPDATE SET defaultOrganizationId=excluded.defaultOrganizationId`)
      .run(userId, organizationId);
    return organization;
  }

  /** Complete, secret-redacted tenant export. The table-oriented envelope is
   * intentionally stable, apart from declared redactions: future import/migration tools can retain
   * records they do not yet understand without flattening the task model. */
  exportOrganization(organizationId: string): Record<string, unknown> {
    const includeTiming = this.getSettings('global', 'timing')?.enabled === true;
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
      avatars: rowsFor(this.db, 'avatars', 'projectId', projectIds),
      resource_attachments: rowsFor(this.db, 'resource_attachments', 'projectId', projectIds)
        .map(({ credentialHandles: _handles, ...row }) => ({ ...row, credentialHandles: '[]' })),
      resource_revisions: rowsFor(this.db, 'resource_revisions', 'attachmentId',
        rowsFor(this.db, 'resource_attachments', 'projectId', projectIds).map((row) => String(row.id)))
        .map(({ sealedRef: _sealedRef, ...row }) => row),
      resource_leases: rowsFor(this.db, 'resource_leases', 'taskId', taskIds)
        .map(({ sealedDriverRef: _sealed, ...row }) => row),
      resource_candidates: rowsFor(this.db, 'resource_candidates', 'taskId', taskIds)
        .map(({ vaultItemId: _item, vaultField: _field, ...row }) => row),
      storage_locations: selectRows(this.db, 'storage_locations', 'organizationId=?', [organizationId])
        .map(({ credentialHandle: _credential, ...row }) => ({ ...row, credentialHandle: null })),
      project_memberships: rowsFor(this.db, 'project_memberships', 'projectId', projectIds),
      task_lists: rowsFor(this.db, 'task_lists', 'projectId', projectIds),
      tasks: rowsFor(this.db, 'tasks', 'projectId', projectIds),
      task_intents: rowsFor(this.db, 'task_intents', 'id', intentIds),
      task_subscribers: rowsFor(this.db, 'task_subscribers', 'taskId', taskIds),
      task_confirmation: rowsFor(this.db, 'task_confirmation', 'taskId', taskIds),
      confirmation_votes: rowsFor(this.db, 'confirmation_votes', 'taskId', taskIds),
      collaboration_requests: [
        ...new Map([
          ...rowsFor(this.db, 'collaboration_requests', 'requesterTaskId', taskIds),
          ...rowsFor(this.db, 'collaboration_requests', 'targetTaskId', taskIds),
        ].map((row) => [String(row.id), row])).values(),
      ],
      events: rowsFor(this.db, 'events', 'taskId', taskIds).filter(row => includeTiming || row.type !== 'timing'),
      tags: rowsFor(this.db, 'tags', 'projectId', projectIds),
      task_tags: rowsFor(this.db, 'task_tags', 'taskId', taskIds),
      saved_views: rowsFor(this.db, 'saved_views', 'projectId', projectIds),
      git_connections: selectRows(this.db, 'git_connections', 'organizationId=?', [organizationId]),
      repositories: rowsFor(this.db, 'repositories', 'id', repositoryIds),
      project_repositories: rowsFor(this.db, 'project_repositories', 'projectId', projectIds),
      project_wikis: rowsFor(this.db, 'project_wikis', 'projectId', projectIds),
      organization_wiki_versions: selectRows(this.db, 'organization_wiki_versions', 'organizationId=?', [organizationId]),
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
      usage_admissions: selectRows(this.db, 'usage_admissions', 'organizationId=?', [organizationId]),
      promoted_artifacts: selectRows(this.db, 'promoted_artifacts', 'organizationId=?', [organizationId]),
      executions: selectRows(this.db, 'executions', 'organizationId=?', [organizationId]),
      execution_frames: rowsFor(this.db, 'execution_frames', 'executionId', executionIds),
      preview_leases: selectRows(this.db, 'preview_leases', 'organizationId=?', [organizationId])
        .map(({ tokenHash: _secret, ...row }) => row),
      inbox: selectRows(this.db, 'inbox', 'organizationId=?', [organizationId]),
      delivery_preferences: selectRows(this.db, 'delivery_preferences', 'organizationId=?', [organizationId]),
      delivery_outbox: rowsFor(this.db, 'delivery_outbox', 'inboxId', inboxIds),
      settings: rowsFor(this.db, 'settings', 'scopeKey', projectSettingKeys),
      cards: rowsFor(this.db, 'cards', 'scopeId', [organizationId, ...projectIds]),
      payment_connections: selectRows(this.db, 'payment_connections', 'organizationId=?', [organizationId]),
      payment_spend_requests: selectRows(this.db, 'payment_spend_requests', 'organizationId=?', [organizationId]),
      payment_transactions: selectRows(this.db, 'payment_transactions', 'organizationId=?', [organizationId]),
      payment_events: selectRows(this.db, 'payment_events', 'organizationId=?', [organizationId]),
      subscription_billing_accounts: selectRows(this.db, 'subscription_billing_accounts', 'organizationId=?', [organizationId]),
      policy_acceptances: selectRows(this.db, 'policy_acceptances', 'organizationId=?', [organizationId]),
      authorization_profiles: rowsFor(this.db, 'authorization_profiles', 'scopeKey', [`organization:${organizationId}`, ...projectIds.map((id) => `project:${id}`)]),
      principal_grants: rowsFor(this.db, 'principal_grants', 'scopeKey', [`organization:${organizationId}`, ...projectIds.map((id) => `project:${id}`)]),
      audit_log: rowsFor(this.db, 'audit_log', 'scopeKey', [`organization:${organizationId}`, ...projectIds.map((id) => `project:${id}`)]),
      attachment_scopes: rowsFor(this.db, 'attachment_scopes', 'projectId', projectIds),
    };
    return {
      format: 'karmax-organization-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      security: {
        secretsIncluded: false,
        omitted: ['password hashes', 'session and API tokens', 'OAuth tokens and state',
          'credential values and handles', 'SCIM tokens', 'preview tokens',
          ...(!includeTiming ? ['response timing (installation disabled)'] : [])],
      },
      organization,
      executionPolicy: this.getOrganizationExecutionPolicy(organizationId),
      usagePolicy: this.getOrganizationUsagePolicy(organizationId),
      identityPolicy: { ...identityPolicy, scimTokenId: undefined },
      tables,
    };
  }

  /** A user-centered portability export. Unlike an organization export, this
   * follows only records that name the person directly: membership/access rows,
   * their tasks and notifications, and their own authorization history. It must
   * never become a shortcut for downloading every organization they belong to. */
  exportUserData(userId: string, email?: string): Record<string, unknown> {
    const includeTiming = this.getSettings('global', 'timing')?.enabled === true;
    const principalId = `user:${userId}`;
    const memberships = selectRows(this.db, 'organization_memberships', 'userId=?', [userId]);
    const invitations = email
      ? selectRows(this.db, 'organization_invitations', 'lower(email)=lower(?) OR invitedBy IN (?,?)', [email, userId, principalId])
      : selectRows(this.db, 'organization_invitations', 'invitedBy IN (?,?)', [userId, principalId]);
    const inbox = selectRows(this.db, 'inbox', 'userId=?', [userId]);
    const teamMemberships = selectRows(this.db, 'team_memberships', 'userId=?', [userId]);
    const teams = rowsFor(this.db, 'teams', 'id', teamMemberships.map((row) => String(row.teamId)));
    const projectMemberships = selectRows(this.db, 'project_memberships', 'principalKey=?', [principalId]);
    const wikiEdits = selectRows(this.db, 'organization_wiki_versions', 'principal IN (?,?)', [userId, principalId]);
    const previewLeases = selectRows(this.db, 'preview_leases', 'createdBy IN (?,?)', [userId, principalId])
      .map(({ tokenHash: _tokenHash, ...row }) => row);
    const ownedAvatars = selectRows(this.db, 'avatars', 'ownerUserId=?', [userId]);
    const spendRequests = selectRows(this.db, 'payment_spend_requests', 'resolvedBy IN (?,?)', [userId, principalId]);
    const subscribedTaskIds = selectRows(this.db, 'task_subscribers', 'principalKey=?', [principalId])
      .map((row) => String(row.taskId));
    const votes = selectRows(this.db, 'confirmation_votes', 'userId=?', [userId]);
    const directTaskIds = (this.db.prepare(`SELECT id FROM tasks WHERE
      (json_extract(createdBy, '$.kind')='user' AND json_extract(createdBy, '$.userId')=?) OR
      (json_extract(assignee, '$.kind')='user' AND json_extract(assignee, '$.userId')=?) OR
      (json_extract(delegate, '$.kind')='user' AND json_extract(delegate, '$.userId')=?)`).all(userId, userId, userId) as any[])
      .map((row) => String(row.id));
    const taskIds = [...new Set([
      ...directTaskIds,
      ...subscribedTaskIds,
      ...votes.map((row) => String(row.taskId)),
      ...inbox.map((row) => String(row.taskId)),
    ])];
    const tasks = taskIds.map((id) => this.getTask(id)).filter(Boolean) as TaskRecord[];
    const projectIds = [...new Set([
      ...tasks.map((task) => task.projectId),
      ...projectMemberships.map((row) => String(row.projectId)),
      ...ownedAvatars.map((row) => String(row.projectId)),
    ])];
    const projects = rowsFor(this.db, 'projects', 'id', projectIds);
    const projectById = new Map(projects.map((project) => [String(project.id), rowToProject(project)]));
    const organizationIds = [...new Set([
      ...memberships.map((row) => String(row.organizationId)),
      ...invitations.map((row) => String(row.organizationId)),
      ...teams.map((row) => String(row.organizationId)),
      ...projects.map((row) => String(row.organizationId)),
      ...inbox.map((row) => String(row.organizationId)),
      ...wikiEdits.map((row) => String(row.organizationId)),
      ...previewLeases.map((row) => String(row.organizationId)),
      ...spendRequests.map((row) => String(row.organizationId)),
      ...ownedAvatars.map((row) => String(row.organizationId)),
    ])];
    const organizations = organizationIds.map((organizationId) => {
      const organization = this.getOrganization(organizationId);
      if (!organization) return undefined;
      const organizationProjectIds = new Set(projects
        .filter((project) => project.organizationId === organizationId).map((project) => String(project.id)));
      const organizationInbox = inbox.filter((row) => row.organizationId === organizationId);
      const deliveryRow = this.db.prepare('SELECT json FROM delivery_preferences WHERE userId=? AND organizationId=?')
        .get(userId, organizationId) as any;
      return {
        organization,
        membership: memberships.find((row) => row.organizationId === organizationId) ?? null,
        invitations: invitations.filter((row) => row.organizationId === organizationId)
          .map(({ tokenHash: _tokenHash, ...row }) => row),
        teams: teamMemberships.flatMap((membership) => {
          const team = teams.find((candidate) => candidate.id === membership.teamId
            && candidate.organizationId === organizationId);
          return team ? [{ team: rowToTeam(team), membership }] : [];
        }),
        projectMemberships: projectMemberships.flatMap((membership) => {
          const project = projectById.get(String(membership.projectId));
          if (!project || project.organizationId !== organizationId) return [];
          return [{ project, membership: {
            projectId: membership.projectId,
            principal: parseJsonOptional<PrincipalRef>(membership.principal),
            role: membership.role,
            joinedAt: membership.joinedAt,
          } }];
        }),
        avatars: ownedAvatars.filter((avatar) => avatar.organizationId === organizationId),
        tasks: tasks.filter((task) => organizationProjectIds.has(task.projectId))
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
          .map((task) => ({
            project: projectById.get(task.projectId),
            task,
            events: this.eventsSince(task.id, 0, undefined, !includeTiming),
            inbox: organizationInbox.filter((row) => row.taskId === task.id).map(rowToInbox),
            confirmationVotes: votes.filter((row) => row.taskId === task.id),
          })),
        inbox: organizationInbox.map(rowToInbox),
        deliveryOutbox: rowsFor(this.db, 'delivery_outbox', 'inboxId',
          organizationInbox.map((row) => String(row.id))),
        deliveryPreferences: deliveryRow ? JSON.parse(deliveryRow.json) : null,
        activity: {
          wikiEdits: wikiEdits.filter((row) => row.organizationId === organizationId),
          previews: previewLeases.filter((row) => row.organizationId === organizationId),
          spendDecisions: spendRequests.filter((row) => row.organizationId === organizationId).map((request) => ({
            request,
            transactions: selectRows(this.db, 'payment_transactions', 'spendRequestId=?', [request.id]),
          })),
        },
      };
    }).filter(Boolean);
    const auditLog = selectRows(this.db, 'audit_log', 'principalId=?', [principalId])
      .map((row) => ({ ...row, detail: parseJsonOptional(row.detail) ?? {} }));
    return {
      format: 'karmax-user-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      // Export the stored preference without revalidating it under a member-only
      // scope: an operator may have selected an organization they do not belong to.
      preferences: { defaultOrganizationId: (this.db.prepare('SELECT defaultOrganizationId FROM user_preferences WHERE userId=?')
        .get(userId) as { defaultOrganizationId: string } | undefined)?.defaultOrganizationId ?? this.defaultOrganization(userId)?.id ?? null },
      security: {
        secretsIncluded: false,
        omitted: ['password hashes', 'session tokens', 'OAuth tokens and state', 'credential values and handles',
          ...(!includeTiming ? ['response timing (installation disabled)'] : [])],
      },
      organizations,
      authorization: {
        grants: this.listPrincipalGrants(principalId),
        auditLog,
      },
    };
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
    const avatarIds = (this.db.prepare('SELECT id FROM avatars WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const inboxIds = (this.db.prepare('SELECT id FROM inbox WHERE organizationId=?').all(organizationId) as any[]).map((r) => String(r.id));
    const scopeKeys = [`organization:${organizationId}`, ...projectIds.map((id) => `project:${id}`)];
    const projectSettingKeys = [
      `organization:${organizationId}`, `quick:organization:${organizationId}`,
      ...projectIds, ...projectIds.map((id) => `quick:${id}`),
    ];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.revokeScopedTokens({ organizationId });
      this.revokeHumanDelegations({ organizationId });
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
      deleteRows(this.db, 'collaboration_requests', 'requesterTaskId', taskIds);
      deleteRows(this.db, 'collaboration_requests', 'targetTaskId', taskIds);
      deleteRows(this.db, 'events', 'taskId', taskIds);
      deleteRows(this.db, 'events', 'taskId', avatarIds.map((avatarId) => `avatar:${avatarId}`));
      deleteRows(this.db, 'world_instances', 'worldId', taskIds);
      deleteRows(this.db, 'task_intents', 'id', intentIds);
      deleteRows(this.db, 'settings', 'scopeKey', projectSettingKeys);
      deleteRows(this.db, 'cards', 'scopeId', [organizationId, ...projectIds]);
      this.db.prepare('DELETE FROM payment_events WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM payment_transactions WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM payment_spend_requests WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM payment_oauth_states WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM payment_connections WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM subscription_billing_requests WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM subscription_billing_accounts WHERE organizationId=?').run(organizationId);
      deleteRows(this.db, 'authorization_profiles', 'scopeKey', scopeKeys);
      deleteRows(this.db, 'principal_grants', 'scopeKey', scopeKeys);
      deleteRows(this.db, 'audit_log', 'scopeKey', scopeKeys);
      deleteRows(this.db, 'attachment_scopes', 'projectId', projectIds);
      this.deletePermissionRequestKv(organizationId, taskIds);
      this.deleteProjectKv(projectIds, taskIds);
      for (const table of ['project_memberships', 'project_repositories', 'project_wikis', 'task_lists', 'tags', 'saved_views', 'world_checkpoints'] as const)
        deleteRows(this.db, table, 'projectId', projectIds);
      this.db.prepare('DELETE FROM preview_leases WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM executions WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM promoted_artifacts WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM usage_events WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM usage_admissions WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM world_leases WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM runner_pools WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM world_provider_connections WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM resource_snapshot_chunks WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM storage_upload_reservations WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM storage_locations WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM delivery_preferences WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM inbox WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM organization_identity_policy WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM avatars WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM organization_invitations WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM organization_memberships WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM organization_wiki_versions WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM git_connections WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM github_install_states WHERE organizationId=?').run(organizationId);
      this.db.prepare('DELETE FROM kv WHERE k=?').run(`organization-execution:${organizationId}`);
      this.db.prepare('DELETE FROM kv WHERE k=?').run(`authorization:requests:${organizationId}`);
      this.db.prepare('DELETE FROM kv WHERE k=?').run(`avatars:organization:${organizationId}`);
      this.db.prepare('DELETE FROM kv WHERE k=?').run(`conversation-sharing:organization:${organizationId}`);
      this.db.prepare('DELETE FROM kv WHERE k=?').run(`organization-usage-policy:${organizationId}`);
      this.db.prepare('DELETE FROM kv WHERE k IN (?, ?, ?)').run(
        `credpolicy:organization:${organizationId}`,
        `git:profiles:${organizationId}`,
        `git:default-profile:${organizationId}`,
      );
      deleteRows(this.db, 'repositories', 'id', repositoryIds);
      deleteRows(this.db, 'teams', 'id', teamIds);
      deleteRows(this.db, 'tasks', 'id', taskIds);
      deleteRows(this.db, 'projects', 'id', projectIds);
      this.db.prepare('DELETE FROM user_preferences WHERE defaultOrganizationId=?').run(organizationId);
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
    if (!this.db.prepare('SELECT 1 FROM user_preferences WHERE userId=?').get(userId))
      this.setDefaultOrganization(userId, organization.id);
    if (name && organization.name === 'Personal') {
      const next = this.assertOrganizationNameAvailable(name,
        { excludeOrganizationId: organization.id, allowUserId: userId });
      this.db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(next, organization.id);
      return { ...organization, name: next };
    }
    return organization;
  }

  /**
   * Boot migration for personal tenants created by the old "Name's workspace"
   * convention. Only recognizable generated labels are changed, so a person who
   * deliberately renamed their personal organization keeps that choice. All
   * updates are one transaction: a pre-existing namespace collision fails the
   * candidate boot without leaving a half-migrated deployment database.
   */
  migratePersonalOrganizationNames(users: Array<{ id: string; name: string }>): number {
    const names = new Map(users.map((user) => [user.id, user.name.trim()]));
    const rows = this.db.prepare(`SELECT o.id, o.name, m.userId
      FROM organizations o
      JOIN organization_memberships m ON m.organizationId=o.id AND m.role='owner'
      WHERE o.kind='personal'
        AND m.userId = (SELECT firstOwner.userId FROM organization_memberships firstOwner
          WHERE firstOwner.organizationId=o.id AND firstOwner.role='owner'
          ORDER BY firstOwner.joinedAt, firstOwner.userId LIMIT 1)
      ORDER BY o.createdAt, m.joinedAt`).all() as Array<{ id: string; name: string; userId: string }>;
    let changed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const userName = names.get(row.userId);
        if (!userName || row.name === userName) continue;
        if (!row.name.endsWith("'s workspace") && row.name !== 'Personal workspace') continue;
        const next = this.assertOrganizationNameAvailable(userName,
          { excludeOrganizationId: row.id, allowUserId: row.userId });
        this.db.prepare('UPDATE organizations SET name=? WHERE id=?').run(next, row.id);
        changed++;
      }
      this.validateAccountNameNamespace(users);
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private validateAccountNameNamespace(users: Array<{ id: string; name: string }>): void {
    const seenUsers = new Map<string, string>();
    for (const user of users) {
      const key = canonicalAccountName(user.name);
      const existing = seenUsers.get(key);
      if (existing && existing !== user.id)
        throw new Error(`user name "${user.name.trim()}" is already used by another user`);
      seenUsers.set(key, user.id);
    }
    const seenOrganizations = new Map<string, string>();
    for (const organization of this.listOrganizations()) {
      const key = canonicalAccountName(organization.name);
      const existing = seenOrganizations.get(key);
      if (existing && existing !== organization.id)
        throw new Error(`organization name "${organization.name}" is already used by another organization`);
      seenOrganizations.set(key, organization.id);
      const userId = seenUsers.get(key);
      if (!userId) continue;
      const isOwnersPersonalName = organization.kind === 'personal'
        && this.organizationMembership(organization.id, userId)?.role === 'owner';
      if (!isOwnersPersonalName)
        throw new Error(`name "${organization.name}" is used by both a user and an organization`);
    }
  }

  setOrganizationMembership(organizationId: string, userId: string, role: OrganizationMembership['role']): OrganizationMembership {
    if (!this.getOrganization(organizationId)) throw new Error(`no organization ${organizationId}`);
    const existing = this.organizationMembership(organizationId, userId);
    this.assertOrganizationMemberCapacity(organizationId, userId);
    if (existing?.role === 'owner' && role !== 'owner') {
      const owners = Number((this.db.prepare("SELECT COUNT(*) n FROM organization_memberships WHERE organizationId=? AND role='owner'")
        .get(organizationId) as any).n);
      if (owners <= 1) throw new Error('an organization must retain at least one owner');
    }
    const joinedAt = Date.now();
    this.db.prepare(`INSERT INTO organization_memberships (organizationId, userId, role, joinedAt)
      VALUES (?, ?, ?, ?) ON CONFLICT(organizationId, userId) DO UPDATE SET role=excluded.role`).run(organizationId, userId, role, joinedAt);
    if (!existing) {
      this.reconcileHostedUsageCapacity(organizationId);
      this.notifyOrganizationEntitlementsChanged(organizationId);
    }
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
    this.db.prepare('DELETE FROM user_preferences WHERE userId=? AND defaultOrganizationId=?').run(userId, organizationId);
    if (membership) {
      this.reconcileHostedUsageCapacity(organizationId);
      this.notifyOrganizationEntitlementsChanged(organizationId);
    }
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
      this.revokeHumanDelegations({ humanUserId: userId });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createOrganizationInvitation(input: { organizationId: string; email: string; role?: OrganizationMembership['role']; profileId?: string;
    authorization?: AuthorizationSelection; invitedBy: string; ttlMs?: number }): { invitation: OrganizationInvitation; token: string } {
    if (!this.getOrganization(input.organizationId)) throw new Error(`no organization ${input.organizationId}`);
    this.assertOrganizationMemberCapacity(input.organizationId);
    const token = `ki_${crypto.randomBytes(24).toString('base64url')}`;
    const invitation: OrganizationInvitation = {
      id: newId('invite'), organizationId: input.organizationId, email: input.email.trim().toLowerCase(),
      role: input.role ?? 'member', profileId: input.authorization?.level ?? input.profileId ?? 'developer',
      authorization: input.authorization, invitedBy: input.invitedBy, createdAt: Date.now(),
      expiresAt: Date.now() + (input.ttlMs ?? 7 * 24 * 60 * 60 * 1000),
    };
    this.db.prepare(`INSERT INTO organization_invitations
      (id, organizationId, email, role, profileId, tokenHash, invitedBy, createdAt, expiresAt, authorizationJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        invitation.id, invitation.organizationId, invitation.email, invitation.role,
        invitation.profileId ?? 'developer', sha256(token), invitation.invitedBy, invitation.createdAt, invitation.expiresAt,
        invitation.authorization ? JSON.stringify(invitation.authorization) : null,
      );
    return { invitation, token };
  }

  acceptOrganizationInvitation(token: string, userId: string, email: string): OrganizationMembership & { profileId?: string; authorization?: AuthorizationSelection } {
    const r = this.db.prepare('SELECT * FROM organization_invitations WHERE tokenHash=?').get(sha256(token)) as any;
    if (!r || r.acceptedAt) throw new Error('invitation is invalid or already used');
    if (r.expiresAt <= Date.now()) throw new Error('invitation has expired');
    if (String(r.email).toLowerCase() !== email.trim().toLowerCase()) throw new Error('invitation belongs to a different email address');
    const membership = this.setOrganizationMembership(r.organizationId, userId, r.role);
    this.db.prepare('UPDATE organization_invitations SET acceptedAt=? WHERE id=?').run(Date.now(), r.id);
    return { ...membership, profileId: r.profileId ?? 'developer',
      authorization: r.authorizationJson ? JSON.parse(r.authorizationJson) : undefined };
  }

  /** Server-only seat preflight. The raw invitation token is hashed before the
   * lookup and never returned by list APIs. */
  organizationInvitationForToken(token: string): { organizationId: string; acceptedAt?: number; expiresAt: number } | undefined {
    const row = this.db.prepare('SELECT organizationId, acceptedAt, expiresAt FROM organization_invitations WHERE tokenHash=?')
      .get(sha256(token)) as any;
    return row ? { organizationId: row.organizationId, acceptedAt: row.acceptedAt ?? undefined,
      expiresAt: Number(row.expiresAt) } : undefined;
  }

  listOrganizationInvitations(organizationId: string): OrganizationInvitation[] {
    return (this.db.prepare('SELECT * FROM organization_invitations WHERE organizationId=? ORDER BY createdAt DESC').all(organizationId) as any[])
      .map((r) => ({ id: r.id, organizationId: r.organizationId, email: r.email, role: r.role, profileId: r.profileId ?? 'developer',
        authorization: r.authorizationJson ? JSON.parse(r.authorizationJson) : undefined, invitedBy: r.invitedBy,
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
    if (principal.kind === 'avatar' && this.getAvatar(principal.avatarId)?.organizationId !== organizationId)
      throw new Error('avatar principal belongs to another organization');
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

  deleteGitConnection(id: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE repositories SET gitConnectionId=NULL WHERE gitConnectionId=?').run(id);
      this.db.prepare('DELETE FROM git_connections WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  projectIdsForRepository(repositoryId: string): string[] {
    return (this.db.prepare('SELECT projectId FROM project_repositories WHERE repositoryId=? ORDER BY projectId')
      .all(repositoryId) as Array<{ projectId: string }>).map((row) => String(row.projectId));
  }

  findRepositoryBySshUrl(organizationId: string, sshUrl: string): Repository | undefined {
    const r = this.db.prepare('SELECT * FROM repositories WHERE organizationId=? AND sshUrl=?').get(organizationId, sshUrl) as any;
    return r ? rowToRepository(r) : undefined;
  }

  deleteRepository(id: string): void {
    const projects = (this.db.prepare('SELECT DISTINCT projectId FROM project_repositories WHERE repositoryId=?').all(id) as any[])
      .map((r) => String(r.projectId));
    this.db.prepare('DELETE FROM project_repositories WHERE repositoryId=?').run(id);
    this.db.prepare('UPDATE project_wikis SET repositoryId=NULL, updatedAt=? WHERE repositoryId=?').run(Date.now(), id);
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

  clearRepositoryDeployKeys(repositoryId: string): void {
    this.db.prepare('DELETE FROM repository_deploy_keys WHERE repositoryId=?').run(repositoryId);
  }

  /** Claim a webhook delivery id. `false` ⇒ already consumed (a duplicate). The
   *  claim is provisional: a handler that fails must `releaseGithubDelivery` so
   *  GitHub's redelivery is not discarded as a duplicate. Rows age out via
   *  `retentionSweep`. */
  recordGithubDelivery(deliveryId: string, event: string): boolean {
    const info = this.db.prepare('INSERT OR IGNORE INTO github_webhook_deliveries (deliveryId, event, receivedAt) VALUES (?, ?, ?)')
      .run(deliveryId, event, Date.now());
    return Number(info.changes) === 1;
  }

  /** One-time, user-bound state for GitHub's browser installation callback.
   * Only its SHA-256 digest is durable, so a database read cannot mint a valid
   * callback. The state is consumed atomically before any GitHub API call. */
  createGithubInstallState(organizationId: string, userId: string,
    options: number | { ttlMs?: number; returnTo?: 'profile'; githubAccountId?: string;
      githubLogin?: string; selectAccount?: boolean } = {}): string {
    if (!this.organizationMembership(organizationId, userId)) throw new Error('user is not an organization member');
    const state = `kg_${crypto.randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const ttlMs = typeof options === 'number' ? options : options.ttlMs ?? 10 * 60_000;
    const returnTo = typeof options === 'object' && options.returnTo === 'profile' ? 'profile' : undefined;
    const githubAccountId = typeof options === 'object' ? options.githubAccountId?.trim() : undefined;
    const githubLogin = typeof options === 'object' ? options.githubLogin?.trim() : undefined;
    const selectAccount = typeof options === 'object' && options.selectAccount;
    this.db.prepare('DELETE FROM github_install_states WHERE expiresAt<=? OR usedAt IS NOT NULL').run(now);
    this.db.prepare(`INSERT INTO github_install_states
      (tokenHash, organizationId, userId, createdAt, expiresAt, usedAt, returnTo, githubAccountId, githubLogin, selectAccount)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
      .run(sha256(state), organizationId, userId, now, now + Math.max(60_000, ttlMs), returnTo ?? null,
        githubAccountId ?? null, githubLogin ?? null, selectAccount ? 1 : 0);
    return state;
  }

  consumeGithubInstallState(state: string, userId: string): { organizationId: string; returnTo?: 'profile';
    githubAccountId?: string; githubLogin?: string; selectAccount?: boolean } | undefined {
    const hash = sha256(state);
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT organizationId, userId, returnTo, githubAccountId, githubLogin, selectAccount FROM github_install_states
        WHERE tokenHash=? AND usedAt IS NULL AND expiresAt>?`).get(hash, now) as any;
      if (!row || row.userId !== userId) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      this.db.prepare('UPDATE github_install_states SET usedAt=? WHERE tokenHash=? AND usedAt IS NULL').run(now, hash);
      this.db.exec('COMMIT');
      return {
        organizationId: String(row.organizationId),
        ...(row.returnTo === 'profile' ? { returnTo: 'profile' as const } : {}),
        ...(row.githubAccountId ? { githubAccountId: String(row.githubAccountId) } : {}),
        ...(row.githubLogin ? { githubLogin: String(row.githubLogin) } : {}),
        ...(row.selectAccount ? { selectAccount: true } : {}),
      };
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

  projectWiki(projectId: string): { projectId: string; repository?: Repository; createdAt: number; updatedAt: number } | undefined {
    const row = this.db.prepare('SELECT * FROM project_wikis WHERE projectId=?').get(projectId) as any;
    if (!row) return undefined;
    return {
      projectId,
      repository: row.repositoryId ? this.getRepository(String(row.repositoryId)) : undefined,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  repositoryIsProjectWiki(repositoryId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM project_wikis WHERE repositoryId=? LIMIT 1').get(repositoryId);
  }

  setProjectWikiRepository(projectId: string, repositoryId?: string): void {
    if (!this.getProject(projectId)) throw new Error(`no project ${projectId}`);
    if (repositoryId && !this.getRepository(repositoryId)) throw new Error(`no repository ${repositoryId}`);
    const now = Date.now();
    this.db.prepare(`INSERT INTO project_wikis (projectId, repositoryId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?) ON CONFLICT(projectId) DO UPDATE SET
      repositoryId=excluded.repositoryId, updatedAt=excluded.updatedAt`)
      .run(projectId, repositoryId ?? null, now, now);
  }

  recordOrganizationWikiVersion(input: {
    organizationId: string;
    path: string;
    operation: 'baseline' | 'write' | 'delete' | 'move';
    kind?: 'skill' | 'memory';
    content?: string;
    principal?: string;
    previousPath?: string;
    /** Insert only when this path has no recorded history. Used to snapshot
     * pre-versioning content immediately before its first mutation. */
    ifEmpty?: boolean;
  }): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.ifEmpty && this.db.prepare(`SELECT 1 FROM organization_wiki_versions
          WHERE organizationId=? AND path=? LIMIT 1`).get(input.organizationId, input.path)) {
        this.db.exec('COMMIT');
        return false;
      }
      const version = Number((this.db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 n
        FROM organization_wiki_versions WHERE organizationId=? AND path=?`)
        .get(input.organizationId, input.path) as any).n);
      this.db.prepare(`INSERT INTO organization_wiki_versions
        (id, organizationId, path, version, operation, kind, content, principal, previousPath, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('wikiver'), input.organizationId, input.path, version, input.operation,
          input.kind ?? null, input.content ?? null, input.principal ?? null,
          input.previousPath ?? null, Date.now());
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  organizationWikiHistory(organizationId: string, wikiPath?: string): Array<{
    id: string; organizationId: string; path: string; version: number; operation: string;
    kind?: string; content?: string; principal?: string; previousPath?: string; createdAt: number;
  }> {
    const rows = wikiPath
      ? this.db.prepare(`SELECT * FROM organization_wiki_versions
          WHERE organizationId=? AND (path=? OR previousPath=?)
          ORDER BY createdAt DESC, rowid DESC`).all(organizationId, wikiPath, wikiPath)
      : this.db.prepare(`SELECT * FROM organization_wiki_versions WHERE organizationId=?
          ORDER BY createdAt DESC, rowid DESC`).all(organizationId);
    return (rows as any[]).map((row) => ({
      id: row.id, organizationId: row.organizationId, path: row.path, version: Number(row.version),
      operation: row.operation, kind: row.kind ?? undefined, content: row.content ?? undefined,
      principal: row.principal ?? undefined, previousPath: row.previousPath ?? undefined,
      createdAt: Number(row.createdAt),
    }));
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
    const catalog = projectBefore.organizationId
      ? this.listRepositories(projectBefore.organizationId).filter((repository) => !this.repositoryIsProjectWiki(repository.id))
      : [];
    const wanted = new Map(catalog
      .filter((repository) => sources.some((source) => sameRepository(source, repository.sshUrl)))
      .map((repository) => [repository.id, repository]));
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
      // Alternate attempts share the root's number. A new logical task receives
      // its number now only when it is being created directly into the queue;
      // drafts receive one in clearDraft(), at their queue transition. The value
      // is allocated by `allocateTaskNum` AFTER the insert so the allocation is a
      // single atomic statement rather than a read-then-write race.
      num: undefined,
      projectId: input.projectId,
      listId,
      title: input.title,
      workflow: input.workflow,
      executionWorkflow: input.workflow,
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
        `INSERT INTO tasks (id, num, projectId, listId, title, workflow, executionWorkflow, workflowVersion, params, createdAt, ord, parentTaskId, lastView, notes, intentId, attemptNumber, createdBy, assignee, delegate, confirmationPolicy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.num ?? null,
        t.projectId,
        t.listId,
        t.title,
        t.workflow,
        t.executionWorkflow!,
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
    if (!input.intentId && !input.params.draft) t.num = this.allocateTaskNum(t.projectId, t.id);
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
    const tasks = (this.db.prepare(`SELECT t.*, COALESCE(t.num, root.num) AS resolvedNum FROM tasks t
      LEFT JOIN tasks root ON root.id=t.intentId WHERE t.intentId = ? ORDER BY t.attemptNumber`).all(intentId) as any[]).map(rowToTask);
    const projectId = t?.projectId ?? tasks[0]?.projectId;
    return projectId ? this.attachTags(projectId, tasks) : tasks;
  }

  attemptGroup(taskOrIntentId: string): { intentId: string; principalAttemptId: string; committedAttemptId?: string; confirmer?: unknown; otherAttempts?: 'keep' | 'cancel'; attempts: TaskRecord[] } | undefined {
    const t = this.getTask(taskOrIntentId);
    const intentId = t?.intentId ?? taskOrIntentId;
    const r = this.db.prepare('SELECT * FROM task_intents WHERE id = ?').get(intentId) as any;
    if (!r) return undefined;
    return { intentId, principalAttemptId: r.principalAttemptId, committedAttemptId: r.committedAttemptId ?? undefined,
      otherAttempts: r.committedAttemptId ? (this.kvGet(`attempt-policy:${intentId}`) === 'keep' ? 'keep' : 'cancel') : undefined,
      confirmer: r.confirmer == null ? undefined : JSON.parse(r.confirmer), attempts: this.attemptsOf(intentId) };
  }

  /** One row per logical task: only the current principal appears in list/search. */
  listTasks(projectId: string): TaskRecord[] {
    const rows = this.db.prepare(`SELECT t.*, COALESCE(t.num, root.num) AS resolvedNum FROM tasks t
      JOIN task_intents i ON i.id=t.intentId AND i.principalAttemptId=t.id
      JOIN tasks root ON root.id=i.id
      WHERE t.projectId=? ORDER BY root.ord,root.createdAt`).all(projectId) as any[];
    return this.attachTags(projectId, rows.map(rowToTask));
  }

  /**
   * One compact row per logical task for list/search surfaces.
   *
   * Keep the projection inside SQLite. Selecting `t.*` and deleting messages after
   * rowToTask would still allocate and JSON.parse every transcript in Node — exactly
   * the high-water allocation that made a few hundred tasks consume >1 GiB RSS.
   */
  listTaskSummaries(projectId: string): TaskRecord[] {
    const rows = this.db.prepare(`SELECT
        t.id, t.num, t.projectId, t.listId, t.title, t.workflow,
        t.executionWorkflow, t.workflowVersion, t.params, t.createdAt, t.ord,
        t.parentTaskId, t.createdBy, t.assignee, t.delegate,
        t.confirmationPolicy, t.intentId, t.attemptNumber, t.notes,
        CASE WHEN t.lastView IS NULL THEN NULL ELSE json_remove(
          t.lastView, '$.messages', '$.transcripts', '$.reviewInfo'
        ) END AS lastView,
        COALESCE(t.num, root.num) AS resolvedNum
      FROM tasks t
      JOIN task_intents i ON i.id=t.intentId AND i.principalAttemptId=t.id
      JOIN tasks root ON root.id=i.id
      WHERE t.projectId=? ORDER BY root.ord,root.createdAt`).all(projectId) as any[];
    return this.attachTags(projectId, rows.map(rowToTask));
  }

  get asyncReadStats() { return this.asyncDatabase?.stats ?? { pending: 0, connections: 0, waiting: 0 }; }

  private async readRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (isPostgresTarget(this.dbPath)) {
      this.asyncDatabase ??= new AsyncPostgres(this.dbPath);
      return this.asyncDatabase.query(sql, params) as Promise<T[]>;
    }
    // Local SQLite reads are bounded by their SQL limit. Give sockets and
    // heartbeat timers a turn between pages even on the single-user backend.
    await yieldTurn();
    return this.db.prepare(sql).all(...params) as T[];
  }

  async taskSummaryPage(projectId: string, options: { includeArchived?: boolean; limit?: number; offset?: number } = {}) {
    const limit = options.limit ?? 200, offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error('limit must be 1–200 and offset must be a non-negative integer');
    const archived = options.includeArchived ? '' : this.db.dialect === 'postgres'
      ? " AND COALESCE((t.params::jsonb ->> 'archived')::boolean, false)=false"
      : " AND COALESCE(json_extract(t.params, '$.archived'), 0)=0";
    const from = `FROM tasks t JOIN task_intents i ON i.id=t.intentId AND i.principalAttemptId=t.id
      JOIN tasks root ON root.id=i.id WHERE t.projectId=?${archived}`;
    const rows = await this.readRows<any>(`SELECT t.id, t.num, t.projectId, t.listId, t.title, t.workflow,
      t.executionWorkflow, t.workflowVersion, t.params, t.createdAt, t.ord, t.parentTaskId,
      t.createdBy, t.assignee, t.delegate, t.confirmationPolicy, t.intentId, t.attemptNumber, t.notes,
      json_remove(t.lastView, '$.messages', '$.transcripts', '$.reviewInfo') AS lastView,
      COALESCE(t.num, root.num) AS resolvedNum ${from}
      ORDER BY root.ord, root.createdAt, root.id LIMIT ? OFFSET ?`, [projectId, limit, offset]);
    const [count] = await this.readRows<{ total: number }>(`SELECT COUNT(*) AS total ${from}`, [projectId]);
    const tasks = rows.map(rowToTask);
    if (tasks.length) {
      const ids = tasks.map(task => task.id), placeholders = ids.map(() => '?').join(',');
      const tags = await this.readRows<{ taskId: string; tagId: string }>(
        `SELECT taskId, tagId FROM task_tags WHERE taskId IN (${placeholders})`, ids);
      const subscribers = await this.readRows<{ taskId: string; principal: string }>(
        `SELECT taskId, principal FROM task_subscribers WHERE taskId IN (${placeholders}) ORDER BY createdAt`, ids);
      const byId = new Map(tasks.map(task => [task.id, task]));
      for (const row of tags) (byId.get(row.taskId)!.tags ??= []).push(row.tagId);
      for (const row of subscribers) byId.get(row.taskId)!.subscribers!.push(JSON.parse(row.principal));
      for (const task of tasks) if (task.confirmationPolicy) task.reviewers = this.reviewAudience(task);
    }
    return { tasks, total: Number(count?.total ?? 0), offset };
  }

  /** Project default is read at Review time, including for already-running tasks. */
  otherAttemptsDefault(taskId: string): 'ask' | 'keep' | 'cancel' {
    const task = this.getTask(taskId);
    const value = task && this.getSettings(task.projectId, '__common__')?.otherAttempts;
    return value === 'keep' || value === 'cancel' ? value : 'ask';
  }

  /** Freeze the group's disposition at first Merge admission. Old reservations
   * without an explicit policy retain their exclusive, cancel-siblings meaning. */
  claimAttempt(taskId: string): { accepted: boolean; cancel: string[] } {
    const t = this.getTask(taskId);
    if (!t?.intentId) return { accepted: true, cancel: [] };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let group = this.attemptGroup(t.intentId)!;
      if (!group.committedAttemptId) {
        const choice = this.kvGet(`attempt-choice:${taskId}`) ?? this.otherAttemptsDefault(taskId);
        const policy = choice === 'cancel' ? 'cancel' : 'keep';
        this.kvSet(`attempt-policy:${t.intentId}`, policy);
        this.db.prepare('UPDATE task_intents SET committedAttemptId=?, principalAttemptId=? WHERE id=?')
          .run(taskId, taskId, t.intentId);
        group = this.attemptGroup(t.intentId)!;
      }
      const accepted = group.otherAttempts === 'keep' || group.committedAttemptId === taskId;
      const cancel = group.otherAttempts === 'keep' ? [] : accepted
        ? group.attempts.filter((a) => a.id !== taskId && !['cancelled', 'done', 'failed'].includes(a.lastView?.status ?? '')).map((a) => a.id)
        : [taskId];
      this.db.exec('COMMIT');
      return { accepted, cancel };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  /** Select the list representative without changing the Merge commitment. */
  setPrincipalAttempt(taskId: string) {
    const task = this.getTask(taskId);
    if (!task?.intentId) throw new Error('attempt not found');
    const changed = this.db.prepare(`UPDATE task_intents SET principalAttemptId=?
      WHERE id=? AND committedAttemptId IS NULL
      AND EXISTS (SELECT 1 FROM tasks WHERE id=?
        AND COALESCE(json_extract(lastView, '$.status'), '') NOT IN ('cancelled', 'failed'))`)
      .run(taskId, task.intentId, taskId);
    if (!Number(changed.changes)) throw new Error('Only eligible attempts can be selected before Merge commitment');
  }

  /** Re-elect after principal cancellation. Drafts and live attempts are eligible. */
  electPrincipal(intentId: string) {
    const g = this.attemptGroup(intentId);
    if (!g || (g.committedAttemptId && g.otherAttempts !== 'keep')) return;
    // Preserve manual selection while healthy. Kept alternatives may also take
    // over from a failed/cancelled principal after admission, without changing policy.
    const principal = g.attempts.find((a) => a.id === g.principalAttemptId);
    if (principal && !['cancelled', 'failed'].includes(principal.lastView?.status ?? '')) return;
    const eligible = g.attempts.find((a) => a.lastView?.status !== 'cancelled' && a.lastView?.status !== 'failed');
    if (eligible) this.db.prepare('UPDATE task_intents SET principalAttemptId=? WHERE id=?').run(eligible.id, intentId);
  }

  /**
   * Write the shared Review route of a logical task. It is shared across attempts
   * (activities/core.ts) — never per-attempt — so this is the only writer.
   *
   * The draft-only guard exists because the *task form* has no idea whether a live
   * attempt's gate has already played. `inFlight` is the caller (KarmaxApi.updateParams)
   * saying the live workflow itself accepted the edit, which means it authoritatively
   * had not consumed the route yet: the route is `untilUsed`, not `queue` (SPEC §4.5/§5.5).
   */
  setIntentConfirmer(intentId: string, field: string, confirmer: unknown, opts?: { inFlight?: boolean }) {
    const attempts = this.attemptsOf(intentId);
    const group = this.attemptGroup(intentId);
    if (!opts?.inFlight && attempts.some((a) => !a.params.draft)) {
      // Full-form replacement includes disabled controls too. Re-sending the
      // existing shared value is harmless; only an actual divergence is locked.
      if (JSON.stringify(group?.confirmer) === JSON.stringify(confirmer)) return;
      throw new Error('the confirmer is shared; edit it on the task page while its Review gate is still open');
    }
    this.db.prepare('UPDATE task_intents SET confirmer=? WHERE id=?').run(JSON.stringify(confirmer), intentId);
    for (const a of attempts) this.updateTaskParams(a.id, { ...a.params, [field]: confirmer });
  }

  taskMetadata(id: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT id, num, projectId, listId, title, workflow,
      executionWorkflow, workflowVersion, params, createdAt, ord, parentTaskId,
      createdBy, assignee, delegate, confirmationPolicy, intentId, attemptNumber,
      notes, lastView FROM tasks WHERE id=?`).get(id) as any;
    return row ? rowToTask(row) : undefined;
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

  /** Every attempt execution. Internal lifecycle work must opt into this explicitly. */
  listTaskAttempts(projectId: string): TaskRecord[] {
    const tasks = (
      this.db
        .prepare('SELECT * FROM tasks WHERE projectId = ? ORDER BY ord, createdAt')
        .all(projectId) as any[]
    ).map(rowToTask);
    return this.attachTags(projectId, tasks);
  }

  /** Tasks currently armed on a trigger (stored-not-started), across all projects.
   *  The durable source of truth the dispatcher re-arms from on boot (SPEC §3.3).
   *
   *  Filtered in SQL. The predicate used to run in JS over `SELECT *` across the
   *  WHOLE tasks table, hydrating every row — including every full `lastView`
   *  transcript — at every boot, to find the handful of armed rows. */
  listArmedTasks(): TaskRecord[] {
    return (this.db.prepare(`SELECT * FROM tasks
      WHERE json_extract(params, '$.triggerState') = 'armed' ORDER BY createdAt`).all() as any[])
      .map(rowToTask);
  }

  /** Runs spawned from a series (repeatable template), newest first.
   *  Filtered in SQL — this is reachable unpaginated from an HTTP request, so the
   *  old whole-table scan + JS filter was a per-request full transcript hydration. */
  runsOf(seriesId: string): TaskRecord[] {
    return (this.db.prepare(`SELECT * FROM tasks
      WHERE json_extract(params, '$.runOf') = ? ORDER BY createdAt DESC`).all(seriesId) as any[])
      .map(rowToTask);
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

  /** Turn-local review tools must survive cancellation before TurnResult is returned.
   * Keep only explicitly supplied fields; workflow-owned completion/diffs stay intact. */
  checkpointReviewInfo(taskId: string, info: ReviewInfo): void {
    const previous = this.kvGet(`pending-review:${taskId}`);
    const supplied = Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined));
    this.kvSet(`pending-review:${taskId}`, JSON.stringify({ ...(previous ? JSON.parse(previous) : {}), ...supplied }));
    const view = this.taskMetadata(taskId)?.lastView;
    if (view) this.db.prepare('UPDATE tasks SET lastView = ? WHERE id = ?')
      .run(JSON.stringify(this.withPendingReviewInfo(taskId, view)), taskId);
  }

  withPendingReviewInfo(taskId: string, view: TaskView): TaskView {
    const raw = this.kvGet(`pending-review:${taskId}`);
    return raw ? { ...view, reviewInfo: { ...view.reviewInfo, ...JSON.parse(raw) } } : view;
  }

  saveView(taskId: string, view: TaskView, conversationReference?: string) {
    const pending = this.kvGet(`pending-review:${taskId}`);
    if (pending && Object.entries(JSON.parse(pending)).every(([key, value]) =>
      JSON.stringify(view.reviewInfo?.[key as keyof ReviewInfo]) === JSON.stringify(value))) {
      // The workflow has incorporated the checkpoint (normal turn completion or
      // lifecycle recovery). Future workflow updates own these fields again.
      this.kvDelete(`pending-review:${taskId}`);
    }
    view = this.withPendingReviewInfo(taskId, view);
    // Auto-archive on resolution: the moment a task reaches a terminal, no-further-
    // action status (done or cancelled) it drops out of the default active list
    // without a manual archive step — the same effect the /archive endpoint has, but
    // automatic. Failed tasks are deliberately left visible (they usually need a look).
    // Fire only on the *transition* into that status (previous snapshot wasn't
    // already done/cancelled) so a later view re-save can't override a user who
    // deliberately un-archived a finished task.
    const prev = this.taskMetadata(taskId);
    const { messages, transcripts, ...status } = view;
    if (conversationReference) {
      const key = `view-conversation:${taskId}:${conversationReference}`;
      if (!this.db.prepare('SELECT 1 FROM kv WHERE k=?').get(key)) throw new Error('Conversation publication snapshot is missing');
      const current = this.db.prepare('SELECT conversationRef FROM tasks WHERE id=?').get(taskId) as any;
      if (current?.conversationRef === conversationReference) {
        this.db.prepare('UPDATE tasks SET lastView=? WHERE id=?').run(JSON.stringify(status), taskId);
      } else {
        this.db.prepare('UPDATE tasks SET lastView=?, conversation=(SELECT v FROM kv WHERE k=?), conversationRef=? WHERE id=?')
          .run(JSON.stringify(status), key, conversationReference, taskId);
      }
    } else {
      this.db.prepare('UPDATE tasks SET lastView=?, conversation=?, conversationRef=NULL WHERE id=?')
        .run(JSON.stringify(status), JSON.stringify({ messages, transcripts }), taskId);
    }
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
    // Retention: a task that has just settled will never stream live output again,
    // so its per-chunk `agent.output` rows (the biggest driver of `events` growth)
    // have no remaining reader — the full agent text is in the view/transcripts
    // this call just wrote. Fire on the TRANSITION only, so a later view re-save of
    // an already-finished task is not a repeated delete over the same rows.
    const settledNow = PRUNE_OUTPUT_STATUS.has(view.status) && !PRUNE_OUTPUT_STATUS.has(prev?.lastView?.status ?? '');
    if (settledNow) this.pruneAgentOutput(taskId);
  }

  reorderTask(taskId: string, ord: number) {
    this.db.prepare('UPDATE tasks SET ord = ? WHERE id = ?').run(ord, taskId);
  }

  updateTaskParams(taskId: string, params: TaskParams) {
    this.db.prepare('UPDATE tasks SET params = ? WHERE id = ?').run(JSON.stringify(params), taskId);
  }

  /** Atomically replace only the supplied top-level fields. Use after awaits:
   * a whole-record write can restore a superseded execution or authorization. */
  patchTaskParams(taskId: string, patch: Record<string, unknown>) {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    if (this.db.dialect === 'postgres') {
      this.db.prepare('UPDATE tasks SET params = (params::jsonb || ?::jsonb)::text WHERE id = ?')
        .run(JSON.stringify(Object.fromEntries(entries)), taskId);
    } else {
      this.db.prepare(`UPDATE tasks SET params = json_set(params, ${entries.map(() => '?, json(?)').join(', ')}) WHERE id = ?`)
        .run(...entries.flatMap(([key, value]) => [`$.${JSON.stringify(key)}`, JSON.stringify(value)]), taskId);
    }
  }

  /** Archive/unarchive the logical task, regardless of which attempt initiated it.
   * List and search surfaces project only the current principal attempt, so letting
   * siblings carry different archive flags can put the same task in neither list
   * (or the wrong one) depending on which attempt happens to be principal. */
  setTaskArchived(taskOrIntentId: string, archived: boolean) {
    const task = this.getTask(taskOrIntentId);
    if (!task) return;
    this.db.prepare(`UPDATE tasks
      SET params = json_set(params, '$.archived', json(?))
      WHERE intentId = ?`).run(archived ? 'true' : 'false', task.intentId ?? task.id);
  }

  /** Re-pin a terminal task when recovery deliberately migrates it to a newer
   * compatible workflow implementation. Ordinary starts never rewrite pins. */
  setTaskWorkflowVersion(taskId: string, workflowVersion: string) {
    this.db.prepare('UPDATE tasks SET workflowVersion = ? WHERE id = ?').run(workflowVersion, taskId);
  }

  /** Change only the user-facing compatible workflow mode. The execution pin is
   * intentionally untouched; the running deterministic workflow owns the switch. */
  setTaskWorkflow(taskId: string, workflow: string) {
    this.db.prepare('UPDATE tasks SET workflow = ? WHERE id = ?').run(workflow, taskId);
  }

  /** Rebind an unqueued draft to another workflow definition. The API owns the
   * lifecycle guard; keeping all three columns in one statement prevents a draft
   * from ever carrying a mixed workflow/version plan. */
  setDraftWorkflow(taskId: string, workflow: string, workflowVersion: string) {
    this.db.prepare('UPDATE tasks SET workflow = ?, executionWorkflow = ?, workflowVersion = ? WHERE id = ?')
      .run(workflow, workflow, workflowVersion, taskId);
  }

  /** Record the workflow definition of a newly-started/recovered Temporal run. */
  setTaskExecutionWorkflow(taskId: string, workflow: string) {
    this.db.prepare('UPDATE tasks SET executionWorkflow = ? WHERE id = ?').run(workflow, taskId);
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

  /**
   * Mark a draft task as queued. The human-facing number belongs to the logical
   * task (the intent root), and is minted exactly once at this transition.
   * A previously queued task that was moved back to drafts keeps its permalink.
   */
  clearDraft(taskId: string) {
    const t = this.getTask(taskId);
    if (!t) return;
    // A single UPDATE makes MAX+1 allocation safe even if two Store instances
    // queue tasks concurrently against the same SQLite database.
    this.db.prepare(`UPDATE tasks SET num = (
      SELECT COALESCE(MAX(num), 0) + 1 FROM tasks WHERE projectId = ?
    ) WHERE id = ? AND num IS NULL`).run(t.projectId, t.intentId ?? t.id);
    this.updateTaskParams(taskId, { ...t.params, draft: false });
  }

  /** Compensate a queue failure. Numbers minted by that failed transition may be
   * released, but numbers from an earlier successful queue are permanent. */
  restoreDraft(taskId: string, releaseNumber = false) {
    const t = this.getTask(taskId);
    if (!t) return;
    this.updateTaskParams(taskId, { ...t.params, draft: true });
    if (!releaseNumber) return;
    const intentId = t.intentId ?? t.id;
    const stillQueued = this.attemptsOf(intentId).some((attempt) => !attempt.params.draft);
    if (!stillQueued) this.db.prepare('UPDATE tasks SET num = NULL WHERE id = ?').run(intentId);
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
    // One transaction, and the SAME table set `deleteProject` clears. Five loose
    // deletes left a half-erased task behind on any failure, and four tables were
    // missed outright: `task_confirmation` / `confirmation_votes` /
    // `collaboration_requests` / `world_instances` kept rows for a task that no
    // longer exists, and `delivery_outbox` rows were orphaned by the `inbox`
    // delete — permanently unclaimable, because `claimDelivery` inner-joins
    // `inbox`, so each one sat in the outbox forever.
    const inboxIds = (this.db.prepare('SELECT id FROM inbox WHERE taskId = ?').all(taskId) as any[])
      .map((row) => String(row.id));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.revokeHumanDelegationsForTask(taskId);
      deleteRows(this.db, 'delivery_outbox', 'inboxId', inboxIds);
      this.db.prepare('DELETE FROM inbox WHERE taskId = ?').run(taskId);
      this.db.prepare('DELETE FROM events WHERE taskId = ?').run(taskId);
      this.db.prepare('DELETE FROM task_tags WHERE taskId = ?').run(taskId);
      this.db.prepare('DELETE FROM task_subscribers WHERE taskId = ?').run(taskId);
      this.db.prepare('DELETE FROM task_confirmation WHERE taskId = ?').run(taskId);
      this.db.prepare('DELETE FROM confirmation_votes WHERE taskId = ?').run(taskId);
      this.db.prepare('DELETE FROM collaboration_requests WHERE requesterTaskId = ? OR targetTaskId = ?').run(taskId, taskId);
      this.db.prepare('DELETE FROM world_instances WHERE worldId = ?').run(taskId);
      this.deleteProjectKv([], [taskId]);
      this.deletePermissionRequestKv(
        prior ? this.getProject(prior.projectId)?.organizationId : undefined,
        [taskId],
      );
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  /** Urgency first, recency second: the most urgent ask is always at the top,
   * and the limit therefore truncates the least urgent tail rather than a
   * high-urgency ask that happens to be older. */
  listInbox(userId: string, organizationId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): InboxItem[] {
    const sql = `SELECT * FROM inbox WHERE userId=? AND organizationId=?${opts.unreadOnly ? ' AND unread=1' : ''} ORDER BY urgency DESC, createdAt DESC LIMIT ?`;
    return (this.db.prepare(sql).all(userId, organizationId, Math.max(1, Math.min(opts.limit ?? 200, 1000))) as any[]).map(rowToInbox);
  }

  /**
   * The task header an inbox row is about. `getTask` per row would JSON.parse
   * each task's FULL `lastView` — transcript included — on every inbox poll, the
   * exact allocation pattern `listTaskSummaries` documents as pushing a few
   * hundred tasks past 1 GiB RSS. Project the six fields the panel renders.
   */
  taskHeaders(taskIds: string[]): Map<string, { id: string; num?: number; title: string; projectId: string; status?: string; stage?: string }> {
    const out = new Map<string, { id: string; num?: number; title: string; projectId: string; status?: string; stage?: string }>();
    chunked([...new Set(taskIds)], (chunk) => {
      const rows = this.db.prepare(`SELECT id, num, title, projectId,
        json_extract(lastView, '$.status') status, json_extract(lastView, '$.stage') stage
        FROM tasks WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as any[];
      for (const row of rows) out.set(String(row.id), { id: String(row.id),
        ...(row.num == null ? {} : { num: Number(row.num) }), title: String(row.title), projectId: String(row.projectId),
        ...(row.status ? { status: String(row.status) } : {}), ...(row.stage ? { stage: String(row.stage) } : {}) });
    });
    return out;
  }

  markInbox(userId: string, id: string, unread: boolean): InboxItem | undefined {
    this.db.prepare('UPDATE inbox SET unread=?, readAt=? WHERE id=? AND userId=?')
      .run(unread ? 1 : 0, unread ? null : Date.now(), id, userId);
    const r = this.db.prepare('SELECT * FROM inbox WHERE id=? AND userId=?').get(id, userId) as any;
    return r ? rowToInbox(r) : undefined;
  }

  /** Deliver a resource-backed approval ask through the same inbox/outbox as
   * task events. The synthetic task key is namespaced and the structured subject
   * gives clients the real destination. */
  addAuthorizationInbox(
    organizationId: string,
    userIds: string[],
    subject: NonNullable<InboxItem['subject']>,
    createdAt = Date.now(),
  ): void {
    const requestOffset = [...subject.requestId].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 997, 0);
    const eventSeq = createdAt * 1000 + requestOffset;
    for (const userId of new Set(userIds)) {
      this.deleteInbox("userId=? AND taskId=? AND kind='approval-requested'", [userId, `avatar:${subject.avatarId}`]);
      const item: InboxItem = {
        id: newId('inbox'), organizationId, userId, eventSeq,
        taskId: `avatar:${subject.avatarId}`, kind: 'approval-requested', urgency: 'high',
        unread: true, actionable: true, createdAt, subject,
      };
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO inbox
        (id, organizationId, userId, eventSeq, taskId, kind, urgency, unread, actionable, createdAt, subject)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`).run(
        item.id, organizationId, userId, eventSeq, item.taskId, item.kind,
        urgencyRank(item.urgency), createdAt, JSON.stringify(subject));
      if (!Number(inserted.changes)) continue;
      const preferences = this.getDeliveryPreferences(userId, organizationId);
      const channels = [preferences.browser && 'browser', (preferences.emailUrgencies?.[item.urgency] ?? preferences.email) && 'email', preferences.slack && 'slack']
        .filter(Boolean) as string[];
      for (const channel of channels) this.db.prepare(`INSERT OR IGNORE INTO delivery_outbox
        (id, inboxId, channel, state, attempts, nextAt, createdAt) VALUES (?, ?, ?, 'pending', 0, ?, ?)`)
        .run(newId('delivery'), item.id, channel, createdAt, createdAt);
    }
  }

  removeAuthorizationInbox(requestId: string): void {
    this.deleteInbox("kind='approval-requested' AND json_extract(subject, '$.requestId')=?", [requestId]);
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
    return this.taskMetadata(id);
  }

  /** Human whose Git identity should own development performed for this task.
   * Agent-created children inherit through their parent chain; automations with
   * no human ancestor intentionally return undefined. */
  taskCreatorUserId(taskId: string): string | undefined {
    let task = this.getTaskShallow(taskId);
    const visited = new Set<string>();
    while (task && !visited.has(task.id)) {
      visited.add(task.id);
      if (task.createdBy?.kind === 'user') return task.createdBy.userId;
      if (task.createdBy?.kind === 'avatar') return this.getAvatar(task.createdBy.avatarId)?.ownerUserId;
      if (task.createdBy?.kind !== 'task-agent') return undefined;
      task = this.getTaskShallow(task.createdBy.taskId);
    }
    return undefined;
  }

  private expandPrincipal(principal: ProjectPrincipalRef, projectId: string): string[] {
    if (principal.kind === 'user') return [principal.userId];
    if (principal.kind === 'team') return (this.listTeamMemberships(principal.teamId)).map((m) => m.userId);
    if (principal.kind === 'organization') return this.listOrganizationMemberships(principal.organizationId).map((member) => member.userId);
    if (principal.kind === 'avatar') return [];
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
      else if (candidate.createdBy?.kind === 'avatar') {
        const ownerUserId = this.getAvatar(candidate.createdBy.avatarId)?.ownerUserId;
        if (ownerUserId) users.add(ownerUserId);
      }
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

  /**
   * Every inbox delete goes through here. `claimDelivery` inner-joins `inbox`,
   * so a row dropped without its pending deliveries strands them in the outbox
   * forever (the same defect `deleteTask` documents).
   */
  private deleteInbox(where: string, params: unknown[]): number {
    const ids = (this.db.prepare(`SELECT id FROM inbox WHERE ${where}`).all(...(params as any[])) as any[])
      .map((row) => String(row.id));
    if (!ids.length) return 0;
    deleteRows(this.db, 'delivery_outbox', 'inboxId', ids);
    deleteRows(this.db, 'inbox', 'id', ids);
    return ids.length;
  }

  /** Approval asks on a task that no `*.approval-resolved` event has answered. */
  private hasPendingApprovals(taskId: string, includeDismissed = false): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM events e
      WHERE e.taskId=? AND e.type IN ('credential.approval-requested', 'permission.approval-requested', 'authorization.approval-requested', 'connection.requested')
        AND NOT EXISTS (SELECT 1 FROM events r WHERE r.taskId=e.taskId
          AND r.type IN ('credential.approval-resolved', 'connection.resolved', 'permission.approval-resolved', 'authorization.approval-resolved', 'permission.approval-dismissed', 'authorization.approval-dismissed')
          AND (?=0 OR r.type NOT IN ('permission.approval-dismissed', 'authorization.approval-dismissed'))
          AND json_extract(r.payload, '$.requestId') = json_extract(e.payload, '$.requestId'))
      LIMIT 1`).get(taskId, includeDismissed ? 1 : 0));
  }

  /**
   * An inbox row is a LIVE ask (or the task's latest outcome), never a copy of
   * the event log. Three invariants keep the panel readable, and every one of
   * them is a bug this replaced:
   *
   *  - one row per (user, task, kind) — a repeat of the same ask updates the row
   *    in place and keeps its original age, instead of stacking a new one;
   *  - at most one ACTIONABLE row per (user, task) — a new ask supersedes the
   *    previous one, because it is what the task needs from you *now*;
   *  - a row is DELETED the moment its ask is discharged (the task stopped
   *    waiting on a human, every approval was resolved, the task finished).
   *
   * Machine waits — an account lease, a host agent slot, the merge queue — are
   * not asks. Reporting `status === 'waiting'` as a review request is what
   * turned one task in review into 66 unread "review requested" rows.
   */
  private materializeInbox(eventSeq: number, ev: KarmaxEvent): void {
    const task = this.getTaskShallow(ev.taskId);
    const project = task && this.getProject(task.projectId);
    if (!task || !project?.organizationId) return;
    const status = ev.type === 'view.updated' ? String(ev.payload.status ?? '') : '';
    const finished = ['done', 'failed', 'cancelled'].includes(status);

    // ── Discharge: drop what the task no longer needs from anybody ───────────
    if (ev.type === 'credential.approval-resolved' || ev.type === 'connection.resolved' || ev.type === 'permission.approval-resolved'
      || ev.type === 'authorization.approval-resolved' || ev.type === 'permission.approval-dismissed'
      || ev.type === 'authorization.approval-dismissed') {
      if (!this.hasPendingApprovals(task.id)) this.deleteInbox("taskId=? AND kind='approval-requested'", [task.id]);
      return;
    }
    if (finished) this.deleteInbox('taskId=? AND actionable=1', [task.id]);
    else if (ev.type === 'view.updated') {
      // The task is live again, so its last outcome has stopped being news — and
      // any ask it had parked on is answered unless it is STILL on a human.
      const stale = ev.payload.waitingFor === 'human'
        ? ["'update'"] : ["'update'", "'review-requested'", "'escalated'"];
      this.deleteInbox(`taskId=? AND kind IN (${stale.join(', ')})`, [task.id]);
    }

    // ── Classify: what is this event asking of whom ─────────────────────────
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
    } else if (ev.type === 'credential.approval-requested' || ev.type === 'connection.requested') {
      kind = 'approval-requested'; actionable = true;
      users = this.humanAudience(task.id, ['@creator']);
      // The creator is the natural first audience, while organization owners
      // remain a deterministic resolver for automated/delegated tasks.
      for (const member of this.listOrganizationMemberships(project.organizationId))
        if (member.role === 'owner') users.push(member.userId);
    } else if (ev.type === 'permission.approval-requested' || ev.type === 'authorization.approval-requested') {
      kind = 'approval-requested'; actionable = true;
      users = Array.isArray(ev.payload.recipients) ? ev.payload.recipients.map(String) : [];
    } else if (isReviewRequestEvent(ev.type)) {
      kind = 'review-requested'; actionable = true; users = this.reviewAudience(task);
    } else if (ev.type.includes('escalat')) {
      kind = 'escalated'; actionable = true;
      users = this.reviewAudience(task);
      if (!users.length && task.assignee) users = this.expandPrincipal(task.assignee, task.projectId);
    } else if (ev.type === 'view.updated' && ev.payload.waitingFor === 'human') {
      // The one lifecycle state that is an ask: the task is parked ON a human.
      // While an approval is outstanding that approval IS the ask, and it was
      // already routed to exactly the people who can answer it.
      // A dismissed approval is still the reason for this hold; a lifecycle tick
      // must not turn it into a fresh escalation notification.
      if (this.hasPendingApprovals(task.id, true)) return;
      kind = ev.payload.stage === 'review' ? 'review-requested' : 'escalated';
      actionable = true;
      users = this.reviewAudience(task);
      if (!users.length && task.assignee) users = this.expandPrincipal(task.assignee, task.projectId);
    } else if (finished) {
      kind = 'update';
      for (const subscriber of this.subscribersFor(task.id)) users.push(...this.expandPrincipal(subscriber, task.projectId));
    }
    if (!kind) return;
    // The requester states urgency ONCE, on the event that raises the ask; the
    // lifecycle ticks that restate it carry none. So an explicit level always
    // wins, and silence leaves whatever the ask was already raised at — never
    // demoting an agent's "critical" back to the kind's default on the next tick.
    const requested = ev.payload.urgency === undefined ? undefined : normalizeUrgency(ev.payload.urgency);
    for (const userId of new Set(users)) {
      const preferences = this.getDeliveryPreferences(userId, project.organizationId);
      if (!actionable && !preferences.routine) continue;
      const existing = this.db.prepare('SELECT id FROM inbox WHERE userId=? AND taskId=? AND kind=?')
        .get(userId, task.id, kind) as any;
      if (existing) {
        // The same ask, restated. Point it at the newest event but leave its age
        // and read state alone: a repeat is not a new notification.
        this.db.prepare(`UPDATE inbox SET eventSeq=?, actionable=?${requested ? ', urgency=?' : ''} WHERE id=?`)
          .run(eventSeq, actionable ? 1 : 0, ...(requested ? [urgencyRank(requested)] : []), existing.id);
        continue;
      }
      if (actionable) this.deleteInbox('userId=? AND taskId=? AND actionable=1', [userId, task.id]);
      const item: InboxItem = { id: newId('inbox'), organizationId: project.organizationId, userId, eventSeq,
        taskId: task.id, kind, urgency: requested ?? DEFAULT_URGENCY[kind], unread: true, actionable, createdAt: ev.ts };
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO inbox
        (id, organizationId, userId, eventSeq, taskId, kind, urgency, unread, actionable, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(item.id, item.organizationId, item.userId, item.eventSeq,
          item.taskId, item.kind, urgencyRank(item.urgency), item.actionable ? 1 : 0, item.createdAt);
      if (Number(inserted.changes)) {
        const channels = [preferences.browser && 'browser', (preferences.emailUrgencies?.[item.urgency] ?? preferences.email) && 'email', preferences.slack && 'slack'].filter(Boolean) as string[];
        for (const channel of channels) this.db.prepare(`INSERT OR IGNORE INTO delivery_outbox
          (id, inboxId, channel, state, attempts, nextAt, createdAt) VALUES (?, ?, ?, 'pending', 0, ?, ?)`)
          .run(newId('delivery'), item.id, channel, item.createdAt, item.createdAt);
      }
    }
  }

  /**
   * The same discharge rules, applied to the whole table from the tasks' current
   * state rather than from one event. Runs on every boot: it clears the backlog
   * older builds accumulated, and nets any ask whose closing event was missed.
   */
  pruneStaleInbox(): number {
    let dropped = 0;
    dropped += this.deleteInbox('subject IS NULL AND taskId NOT IN (SELECT id FROM tasks)', []);
    dropped += this.deleteInbox(`actionable=1 AND taskId IN (SELECT id FROM tasks
      WHERE json_extract(lastView, '$.status') IN ('done', 'failed', 'cancelled'))`, []);
    dropped += this.deleteInbox(`kind='update' AND taskId IN (SELECT id FROM tasks
      WHERE COALESCE(json_extract(lastView, '$.status'), 'setup') NOT IN ('done', 'failed', 'cancelled'))`, []);
    dropped += this.deleteInbox(`kind IN ('review-requested', 'escalated') AND taskId IN (SELECT id FROM tasks
      WHERE COALESCE(json_extract(lastView, '$.waitingFor.kind'), '') <> 'human')`, []);
    if (this.db.prepare("SELECT 1 FROM inbox WHERE kind='approval-requested' LIMIT 1").get()) {
      dropped += this.deleteInbox(`subject IS NULL AND kind='approval-requested' AND taskId NOT IN (
        SELECT e.taskId FROM events e
        WHERE e.type IN ('credential.approval-requested', 'permission.approval-requested', 'authorization.approval-requested', 'connection.requested')
          AND NOT EXISTS (SELECT 1 FROM events r WHERE r.taskId=e.taskId
            AND r.type IN ('credential.approval-resolved', 'connection.resolved', 'permission.approval-resolved', 'authorization.approval-resolved', 'permission.approval-dismissed', 'authorization.approval-dismissed')
            AND json_extract(r.payload, '$.requestId') = json_extract(e.payload, '$.requestId')))`, []);
    }
    return dropped;
  }

  claimDelivery(now = Date.now()): { id: string; inbox: InboxItem; channel: 'browser' | 'email' | 'slack'; attempts: number } | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A crashed dispatcher releases its claim after one minute.
      this.db.prepare("UPDATE delivery_outbox SET state='pending', claimedAt=NULL WHERE state='sending' AND claimedAt<?")
        .run(now - 60_000);
      const row = this.db.prepare(`SELECT d.*, i.organizationId, i.userId, i.eventSeq, i.taskId, i.kind, i.urgency,
        i.unread, i.actionable, i.subject, i.createdAt inboxCreatedAt, i.readAt FROM delivery_outbox d
        JOIN inbox i ON i.id=d.inboxId WHERE d.state='pending' AND d.nextAt<=? ORDER BY d.createdAt LIMIT 1`).get(now) as any;
      if (!row) { this.db.exec('COMMIT'); return undefined; }
      this.db.prepare("UPDATE delivery_outbox SET state='sending', claimedAt=? WHERE id=? AND state='pending'").run(now, row.id);
      this.db.exec('COMMIT');
      return { id: row.id, channel: row.channel, attempts: Number(row.attempts), inbox: rowToInbox({
        id: row.inboxId, organizationId: row.organizationId, userId: row.userId, eventSeq: row.eventSeq,
        taskId: row.taskId, kind: row.kind, urgency: row.urgency, unread: row.unread, actionable: row.actionable,
        subject: row.subject,
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
    // Count statuses inside the database. Selecting `lastView` and JSON.parsing it in
    // Node allocated every task's FULL transcript just to read one string — the
    // exact pattern `listTaskSummaries` documents as having pushed a few hundred
    // tasks past 1 GiB RSS — and this runs on every Prometheus scrape (15 s by
    // default), i.e. continuously.
    const tasks: Record<string, number> = Object.fromEntries(
      (this.db.prepare(`SELECT COALESCE(json_extract(lastView, '$.status'), 'setup') s, COUNT(*) c
        FROM tasks GROUP BY s`).all() as any[]).map((row) => [String(row.s), Number(row.c)]),
    );
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

  createTag(input: { projectId: string; name: string; parentId?: string; color?: string; kind?: 'type' | 'topic' | 'flag'; description?: string }): Tag {
    const raw = input.name.trim();
    if (!raw) throw new Error('tag name required');
    assertTagColor(input.color);
    // A slash-separated name is a hierarchy path (`frontend/web`): find-or-create each
    // level under the previous, so the UI never needs a parent picker — the user just
    // types the path. `color`/`description` apply to the leaf; `kind` applies to the
    // whole path, because a hierarchy is within-kind — kind-scoped sectioning
    // (`group:tag-type`) drops a child whose parent carries a different kind.
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
          kind: input.kind,
          ...(isLeaf ? { color: input.color, description: input.description } : {}),
        });
        parentId = leaf.id;
      }
      return leaf!;
    }
    return this.createOneTag({ ...input, name: raw });
  }

  /** Create-or-reuse a single tag under an explicit parent (no path parsing). */
  private createOneTag(input: { projectId: string; name: string; parentId?: string; color?: string; kind?: 'type' | 'topic' | 'flag'; description?: string }): Tag {
    const name = input.name.trim();
    if (!name) throw new Error('tag name required');
    if (input.parentId) {
      const parent = this.getTag(input.parentId);
      if (!parent || parent.projectId !== input.projectId) throw new Error('tag parent must belong to the same project');
    }
    // Reuse an existing sibling with the same (case-insensitive) name rather than
    // minting a duplicate — tag catalogues should stay small and canonical.
    const existing = this.db
      .prepare("SELECT * FROM tags WHERE projectId = ? AND lower(name) = lower(?) AND IFNULL(parentId, '') = IFNULL(?, '')")
      .get(input.projectId, name, input.parentId ?? null) as any;
    if (existing) {
      const patch = {
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.description?.trim() ? { description: input.description } : {}),
      };
      return Object.keys(patch).length ? this.updateTag(existing.id, patch)! : rowToTag(existing);
    }
    const t: Tag = {
      id: newId('tag'),
      projectId: input.projectId,
      name,
      parentId: input.parentId,
      color: input.color,
      // Every tag carries a kind. `topic` is the default because it is the neutral
      // "what area" axis, and because the callers that omit one are the implicit
      // ones (an agent naming a new tag through `tag_task`, a path ancestor). A
      // kind-less tag is not representable in the UI and falls out of kind-scoped
      // sections. Reuse of an existing tag above deliberately never overwrites.
      kind: input.kind ?? 'topic',
      description: input.description?.trim() || undefined,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO tags (id, projectId, name, parentId, color, kind, description, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.projectId, t.name, t.parentId ?? null, t.color ?? null, t.kind ?? null, t.description ?? null, t.createdAt);
    return t;
  }

  updateTag(id: string, patch: { name?: string; parentId?: string | null; color?: string | null; kind?: 'type' | 'topic' | 'flag' | null; description?: string | null }): Tag | undefined {
    assertTagColor(patch.color);
    const cur = this.getTag(id);
    if (!cur) return undefined;
    const nextParentId = patch.parentId === null ? undefined : patch.parentId ?? cur.parentId;
    if (nextParentId) {
      const parent = this.getTag(nextParentId);
      if (!parent || parent.projectId !== cur.projectId) throw new Error('tag parent must belong to the same project');
    }
    // Guard against a cycle: a tag can't be reparented under itself or a descendant.
    if (nextParentId) {
      const all = this.listTags(cur.projectId);
      const byId = new Map(all.map((t) => [t.id, t]));
      let p: string | undefined = nextParentId;
      const seen = new Set<string>();
      while (p) {
        if (p === id || seen.has(p)) throw new Error('tag cannot be its own ancestor');
        seen.add(p);
        p = byId.get(p)?.parentId;
      }
    }
    const nextName = patch.name?.trim() || cur.name;
    const duplicate = this.db
      .prepare("SELECT id FROM tags WHERE projectId = ? AND id <> ? AND lower(name) = lower(?) AND IFNULL(parentId, '') = IFNULL(?, '')")
      .get(cur.projectId, id, nextName, nextParentId ?? null) as { id: string } | undefined;
    if (duplicate) throw new Error('a sibling tag with that name already exists');
    const next: Tag = {
      ...cur,
      name: nextName,
      parentId: nextParentId,
      color: patch.color === null ? undefined : patch.color ?? cur.color,
      kind: patch.kind === null ? undefined : patch.kind ?? cur.kind,
      description: patch.description === null ? undefined : patch.description !== undefined ? patch.description.trim() || undefined : cur.description,
    };
    this.db
      .prepare('UPDATE tags SET name = ?, parentId = ?, color = ?, kind = ?, description = ? WHERE id = ?')
      .run(next.name, next.parentId ?? null, next.color ?? null, next.kind ?? null, next.description ?? null, id);
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

  // ─── Avatars ───

  upsertAvatar(avatar: Avatar): Avatar {
    this.db.prepare(`INSERT INTO avatars
      (id, organizationId, projectId, ownerUserId, json, createdAt, updatedAt, deletedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET organizationId=excluded.organizationId,
      projectId=excluded.projectId, ownerUserId=excluded.ownerUserId,
      json=excluded.json, updatedAt=excluded.updatedAt, deletedAt=excluded.deletedAt`)
      .run(avatar.id, avatar.organizationId, avatar.projectId, avatar.ownerUserId,
        JSON.stringify(avatar), avatar.createdAt, avatar.updatedAt, avatar.deletedAt ?? null);
    return avatar;
  }

  getAvatar(id: string, includeDeleted = false): Avatar | undefined {
    const row = this.db.prepare(`SELECT json FROM avatars WHERE id=?${includeDeleted ? '' : ' AND deletedAt IS NULL'}`).get(id) as any;
    return row ? JSON.parse(row.json) as Avatar : undefined;
  }

  listAvatars(projectId?: string, includeDeleted = false): Avatar[] {
    const where = [projectId ? 'projectId=?' : '', includeDeleted ? '' : 'deletedAt IS NULL'].filter(Boolean).join(' AND ');
    const rows = this.db.prepare(`SELECT json FROM avatars${where ? ` WHERE ${where}` : ''} ORDER BY createdAt`)
      .all(...(projectId ? [projectId] : [])) as any[];
    return rows.map((row) => JSON.parse(row.json) as Avatar)
      .sort((left, right) => left.name.localeCompare(right.name) || left.createdAt - right.createdAt);
  }

  deleteAvatar(id: string, at = Date.now()): Avatar | undefined {
    const avatar = this.getAvatar(id);
    if (!avatar) return undefined;
    const removed = { ...avatar, enabled: false, deletedAt: at, updatedAt: at };
    this.upsertAvatar(removed);
    this.deleteAuthorizationRequestKv(avatar.organizationId, { kind: 'avatar', ids: [id] });
    this.deleteInbox("json_extract(subject, '$.avatarId')=?", [id]);
    return removed;
  }

  avatarAvailability(projectId: string): AvatarAvailability {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    const organizationId = project.organizationId ?? 'org_personal';
    const organization = this.kvGet(`avatars:organization:${organizationId}`) === 'enabled';
    const raw = this.kvGet(`avatars:project:${projectId}`);
    const projectSetting: AvatarAvailability['project'] = raw === 'enabled' || raw === 'disabled' ? raw : 'inherit';
    return { organization, project: projectSetting,
      effective: projectSetting === 'inherit' ? organization : projectSetting === 'enabled' };
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

  /** One-time frecency backfill, restricted to the caller's existing vault IDs.
   * Page by sequence so long-lived audit logs never load into memory at once. */
  vaultUsageHistory(itemIds: string[], now: number): Record<string, VaultUsage> {
    const usage: Record<string, VaultUsage> = {};
    for (let offset = 0; offset < itemIds.length; offset += 500) {
      const ids = itemIds.slice(offset, offset + 500);
      const query = this.db.prepare(`SELECT seq, ts, json_extract(detail, '$.itemId') itemId
        FROM audit_log WHERE seq > ? AND action IN ('vault.used', 'vault.revealed')
        AND json_extract(detail, '$.itemId') IN (${ids.map(() => '?').join(',')})
        ORDER BY seq LIMIT 1000`);
      let seq = 0;
      for (;;) {
        const rows = query.all(seq, ...ids) as { seq: number; ts: number; itemId: string }[];
        for (const row of rows) {
          const value = usage[row.itemId] ??= { useCount: 0, frecencyScore: 0, frecencyUpdatedAt: now };
          value.useCount++;
          value.frecencyScore += decayVaultUsage(1, row.ts, now);
          value.lastUsedAt = Math.max(value.lastUsedAt ?? 0, row.ts);
          seq = row.seq;
        }
        if (rows.length < 1000) break;
      }
    }
    return usage;
  }

  auditSince(seq = 0, limit = 500): any[] {
    return (this.db.prepare('SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, Math.max(1, Math.min(limit, 2000))) as any[])
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  /** Newest audit rows, returned chronologically. Operational diagnostics should
   * not scan from seq 0: a long-lived hosted deployment can have millions of rows. */
  auditRecent(limit = 100): any[] {
    return (this.db.prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?').all(Math.max(1, Math.min(limit, 2000))) as any[])
      .reverse()
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  auditRecentByActionPrefix(prefix: string, limit = 100): any[] {
    return (this.db.prepare(
      'SELECT * FROM audit_log WHERE substr(action, 1, length(?)) = ? ORDER BY seq DESC LIMIT ?',
    ).all(prefix, prefix, Math.max(1, Math.min(limit, 2000))) as any[])
      .reverse()
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
      exact.run(`avatars:project:${projectId}`);
      exact.run(`conversation-sharing:project:${projectId}`);
      const workflowPrefix = `wfpin:${projectId}:`;
      prefix.run(workflowPrefix, workflowPrefix);
    }
    for (const taskId of taskIds) {
      const sharePrefix = `conversation-share-index:${taskId}:`;
      const shares = this.db.prepare('SELECT v FROM kv WHERE substr(k, 1, length(?))=?').all(sharePrefix, sharePrefix) as Array<{ v: string }>;
      for (const share of shares) exact.run(`conversation-share:${share.v}`);
      prefix.run(sharePrefix, sharePrefix);
      for (const key of [`task-agents:${taskId}`, `confirm-transcript:${taskId}`, `spent:${taskId}`, `credpolicy:task:${taskId}`,
        `permission:grant:${taskId}`, `pending-review:${taskId}`, `review-artifacts:${taskId}`]) exact.run(key);
      for (const value of [`session:${taskId}:`, `sessionmeta:${taskId}:`, `turnsession:${taskId}#`,
        `view-conversation:${taskId}:`]) prefix.run(value, value);
    }
  }

  private deletePermissionRequestKv(organizationId: string | undefined, taskIds: string[]): void {
    if (!taskIds.length) return;
    this.deleteAuthorizationRequestKv(organizationId, { kind: 'task', ids: taskIds });
    const exact = this.db.prepare('DELETE FROM kv WHERE k=?');
    for (const taskId of taskIds) exact.run(`permission:grant:${taskId}`);
    if (!organizationId) return;
    const key = `permission:requests:${organizationId}`;
    const raw = this.kvGet(key);
    if (!raw) return;
    try {
      const removed = new Set(taskIds);
      const requests = JSON.parse(raw);
      if (!Array.isArray(requests)) return;
      const remaining = requests.filter((request) => !removed.has(String(request?.taskId ?? '')));
      if (remaining.length) this.kvSet(key, JSON.stringify(remaining));
      else exact.run(key);
    } catch {
      // Leave malformed metadata available for diagnostics instead of masking it
      // with an unrelated task/project deletion.
    }
  }

  private deleteAuthorizationRequestKv(
    organizationId: string | undefined,
    target: { kind: 'task' | 'avatar'; ids: string[] },
  ): void {
    if (!organizationId || !target.ids.length) return;
    const key = `authorization:requests:${organizationId}`;
    const raw = this.kvGet(key);
    if (!raw) return;
    try {
      const removed = new Set(target.ids);
      const requests = JSON.parse(raw);
      if (!Array.isArray(requests)) return;
      const remaining = requests.filter((request) => {
        if (request?.target?.kind !== target.kind) return true;
        const id = target.kind === 'task' ? request.target.taskId : request.target.avatarId;
        return !removed.has(String(id ?? ''));
      });
      if (remaining.length) this.kvSet(key, JSON.stringify(remaining));
      else this.db.prepare('DELETE FROM kv WHERE k=?').run(key);
    } catch {
      // Preserve malformed metadata for diagnostics.
    }
  }

  // ─── Event log (live stream) ─────────────────────────────────────────────────

  createCollaborationRequest(input: {
    requesterTaskId: string;
    targetTaskId: string;
    targetRole?: string;
    action: CollaborationRequest['action'];
  }): CollaborationRequest {
    const now = Date.now();
    const afterSeq = Number((this.db.prepare('SELECT COALESCE(MAX(seq), 0) seq FROM events').get() as any)?.seq ?? 0);
    const request: CollaborationRequest = {
      id: newId('collab'),
      requesterTaskId: input.requesterTaskId,
      targetTaskId: input.targetTaskId,
      targetRole: input.targetRole ?? 'do',
      action: input.action,
      status: 'pending',
      afterSeq,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`INSERT INTO collaboration_requests
      (id, requesterTaskId, targetTaskId, targetRole, action, status, afterSeq, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      request.id, request.requesterTaskId, request.targetTaskId, request.targetRole,
      request.action, request.status, request.afterSeq, request.createdAt, request.updatedAt,
    );
    return request;
  }

  getCollaborationRequest(id: string): CollaborationRequest | undefined {
    const row = this.db.prepare('SELECT * FROM collaboration_requests WHERE id=?').get(id) as any;
    return row ? this.collaborationRequestFromRow(row) : undefined;
  }

  listCollaborationRequests(input: {
    requesterTaskId?: string;
    targetTaskId?: string;
    status?: CollaborationRequestStatus;
    unnotified?: boolean;
  } = {}): CollaborationRequest[] {
    const clauses: string[] = [];
    const args: any[] = [];
    if (input.requesterTaskId) { clauses.push('requesterTaskId=?'); args.push(input.requesterTaskId); }
    if (input.targetTaskId) { clauses.push('targetTaskId=?'); args.push(input.targetTaskId); }
    if (input.status) { clauses.push('status=?'); args.push(input.status); }
    if (input.unnotified) clauses.push("status!='pending' AND notifiedAt IS NULL");
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM collaboration_requests${where} ORDER BY createdAt, id`).all(...args) as any[])
      .map((row) => this.collaborationRequestFromRow(row));
  }

  settleCollaborationRequests(
    targetTaskId: string,
    status: Exclude<CollaborationRequestStatus, 'pending'>,
    result: Record<string, unknown>,
    eventSeq?: number,
  ): CollaborationRequest[] {
    const pending = this.listCollaborationRequests({ targetTaskId, status: 'pending' })
      .filter((request) => eventSeq === undefined || eventSeq > request.afterSeq);
    if (!pending.length) return [];
    const now = Date.now();
    const update = this.db.prepare(`UPDATE collaboration_requests
      SET status=?, result=?, updatedAt=?, settledAt=?
      WHERE id=? AND status='pending'`);
    const settled: CollaborationRequest[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const request of pending) {
        const changed = update.run(status, JSON.stringify(result), now, now, request.id).changes;
        if (changed) settled.push({ ...request, status, result, updatedAt: now, settledAt: now });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return settled;
  }

  settleCollaborationRequest(
    id: string,
    status: Exclude<CollaborationRequestStatus, 'pending'>,
    result: Record<string, unknown>,
  ): CollaborationRequest | undefined {
    const request = this.getCollaborationRequest(id);
    if (!request || request.status !== 'pending') return undefined;
    const now = Date.now();
    const changed = this.db.prepare(`UPDATE collaboration_requests
      SET status=?, result=?, updatedAt=?, settledAt=?
      WHERE id=? AND status='pending'`).run(status, JSON.stringify(result), now, now, id).changes;
    return changed ? { ...request, status, result, updatedAt: now, settledAt: now } : undefined;
  }

  markCollaborationRequestNotified(id: string): void {
    this.db.prepare("UPDATE collaboration_requests SET notifiedAt=?, updatedAt=? WHERE id=? AND status!='pending'")
      .run(Date.now(), Date.now(), id);
  }

  deleteCollaborationRequest(id: string): void {
    this.db.prepare('DELETE FROM collaboration_requests WHERE id=?').run(id);
  }

  private collaborationRequestFromRow(row: any): CollaborationRequest {
    return {
      id: String(row.id),
      requesterTaskId: String(row.requesterTaskId),
      targetTaskId: String(row.targetTaskId),
      targetRole: String(row.targetRole),
      action: row.action as CollaborationRequest['action'],
      status: row.status as CollaborationRequestStatus,
      afterSeq: Number(row.afterSeq),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      ...(row.settledAt == null ? {} : { settledAt: Number(row.settledAt) }),
      ...(row.result == null ? {} : { result: JSON.parse(String(row.result)) as Record<string, unknown> }),
      ...(row.notifiedAt == null ? {} : { notifiedAt: Number(row.notifiedAt) }),
    };
  }

  appendEvent(ev: KarmaxEvent): number {
    // The event row and its inbox/delivery materialization are one write: a
    // failure inside `materializeInbox` after the insert would leave an event
    // whose caller sees an exception, retries, and appends it twice.
    const nested = this.db.inTransaction();
    if (!nested) this.db.exec('BEGIN IMMEDIATE');
    try {
      const info = this.db
        .prepare('INSERT INTO events (taskId, type, ts, payload) VALUES (?, ?, ?, ?)')
        .run(ev.taskId, ev.type, ev.ts, JSON.stringify(ev.payload));
      const seq = Number(info.lastInsertRowid);
      this.materializeInbox(seq, ev);
      if (!nested) this.db.exec('COMMIT');
      return seq;
    } catch (error) {
      if (!nested) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  eventsSince(taskId: string, seq: number, limit?: number, excludeTiming = false): (KarmaxEvent & { seq: number })[] {
    // Initial task-page loads ask for the newest bounded window. Do the bound in
    // SQLite: materializing every historical event and slicing in JS is precisely
    // the allocation spike this API is meant to avoid. Incremental consumers omit
    // `limit` and retain the original "everything after cursor" contract.
    if (limit && limit > 0) {
      const rows = this.db
        .prepare(`SELECT * FROM events WHERE taskId = ? AND seq > ? ${excludeTiming ? "AND type != 'timing'" : ''} ORDER BY seq DESC LIMIT ?`)
        .all(taskId, seq, limit) as any[];
      rows.reverse();
      return rows.map((r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }));
    }
    return (this.db.prepare(`SELECT * FROM events WHERE taskId = ? AND seq > ? ${excludeTiming ? "AND type != 'timing'" : ''} ORDER BY seq`).all(taskId, seq) as any[])
      .map((r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }));
  }

  /** Sparse durable annotations should not disappear merely because a task has
   *  more live activity rows than the UI's bounded event window. */
  eventsOfType(taskId: string, type: string): (KarmaxEvent & { seq: number })[] {
    return (this.db.prepare('SELECT * FROM events WHERE taskId = ? AND type = ? ORDER BY seq').all(taskId, type) as any[])
      .map((r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }));
  }

  eventBySeq(taskId: string, seq: number): (KarmaxEvent & { seq: number }) | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE taskId = ? AND seq = ?').get(taskId, seq) as any;
    return row ? { seq: row.seq, type: row.type, taskId: row.taskId, ts: row.ts, payload: JSON.parse(row.payload) } : undefined;
  }

  /** Current durable event cursor without materializing or parsing the event log. */
  latestEventSeq(): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as any)?.seq ?? 0);
  }

  allEventsSince(seq: number, limit?: number, excludeTiming = false): (KarmaxEvent & { seq: number })[] {
    // Bound the read in SQL. Callers that want "the last N" would otherwise
    // materialize the ENTIRE append-only table before slicing — the events table
    // is the largest in the DB, so that is the dominant read-path allocation.
    // Grab the newest N (DESC + LIMIT), then return ascending as before.
    if (limit && limit > 0) {
      const rows = this.db
        .prepare(`SELECT * FROM events WHERE seq > ? ${excludeTiming ? "AND type != 'timing'" : ''} ORDER BY seq DESC LIMIT ?`)
        .all(seq, limit) as any[];
      rows.reverse();
      return rows.map((r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }));
    }
    return (this.db.prepare(`SELECT * FROM events WHERE seq > ? ${excludeTiming ? "AND type != 'timing'" : ''} ORDER BY seq`).all(seq) as any[]).map(
      (r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }),
    );
  }

  /** Oldest bounded page after a cursor, for lossless forward consumers. */
  async nextEventsSince(seq: number, limit: number): Promise<(KarmaxEvent & { seq: number })[]> {
    const rows = await this.readRows<any>('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?', [seq, limit]);
    return rows.map((r) => ({ seq: r.seq, type: r.type, taskId: r.taskId, ts: r.ts, payload: JSON.parse(r.payload) }));
  }

  /** Event routing needs ownership, never a conversation or reviewer expansion. */
  async taskProjectIds(taskIds: readonly string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const ids = [...new Set(taskIds)];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const rows = await this.readRows<{ id: string; projectId: string }>(
        `SELECT id, projectId FROM tasks WHERE id IN (${batch.map(() => '?').join(',')})`, batch);
      for (const row of rows) result.set(row.id, row.projectId);
    }
    return result;
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
    // A fresh epoch prevents an in-flight span crossing a rapid off/on cycle.
    if (scopeKey === 'global' && workflow === 'timing') values = { ...values, revision: crypto.randomUUID() };
    if (workflow === 'payments') {
      if (values.budget !== undefined && values.budget !== null && (!Number.isSafeInteger(values.budget) || Number(values.budget) < 0))
        throw new Error('Budget must be a non-negative amount in cents');
      if (values.cardIds !== undefined) {
        const project = this.getProject(scopeKey);
        const org = project?.organizationId ?? (scopeKey.startsWith('organization:') ? scopeKey.slice(13) : 'org_personal');
        const cards = this.listCards(project?.id, org);
        if (!Array.isArray(values.cardIds) || values.cardIds.some(id => !cards.some(card => card.id === id && card.status !== 'canceled')))
          throw new Error('Choose available cards from this organization');
      }
    }

    if (values.otherAttempts !== undefined && !['ask', 'keep', 'cancel'].includes(values.otherAttempts as string))
      throw new Error('otherAttempts must be ask, keep, or cancel');
    if (process.env.KARMAX_DEPLOYMENT === 'hosted' && values.remote === 'none')
      throw new Error('hosted GitHub projects require remote policy "pr" or the advanced direct-push policy');
    this.db
      .prepare('INSERT INTO settings (scopeKey, workflow, json) VALUES (?, ?, ?) ON CONFLICT(scopeKey, workflow) DO UPDATE SET json = excluded.json')
      .run(scopeKey, workflow, JSON.stringify(values));
  }

  // ─── Project resources ──────────────────────────────────────────────────

  createResourceAttachment(input: Omit<ResourceAttachment, 'id' | 'createdAt' | 'updatedAt' | 'enabled'>
    & Partial<Pick<ResourceAttachment, 'id' | 'createdAt' | 'updatedAt' | 'enabled'>>): ResourceAttachment {
    if (!this.getProject(input.projectId)) throw new Error('resource project not found');
    const now = input.createdAt ?? Date.now();
    const value: ResourceAttachment = { ...input, id: input.id ?? newId('resource'), enabled: input.enabled ?? true,
      createdAt: now, updatedAt: input.updatedAt ?? now };
    validateResourceAttachment(value);
    this.db.prepare(`INSERT INTO resource_attachments (id, organizationId, projectId, name, driver, target,
      access, isolation, source, credentialHandles, currentRevisionId, publish, storageLocationId, enabled, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(value.id, value.organizationId, value.projectId,
        value.name, value.driver, JSON.stringify(value.target), value.access, value.isolation, JSON.stringify(value.source),
        JSON.stringify(value.credentialHandles), value.currentRevisionId ?? null, value.publish, value.storageLocationId ?? null, value.enabled ? 1 : 0,
        value.createdAt, value.updatedAt);
    return value;
  }

  getResourceAttachment(id: string): ResourceAttachment | undefined {
    const row = this.db.prepare('SELECT * FROM resource_attachments WHERE id=?').get(id) as any;
    return row ? resourceAttachmentRow(row) : undefined;
  }

  listResourceAttachments(projectId: string, includeDisabled = false): ResourceAttachment[] {
    const rows = includeDisabled
      ? this.db.prepare('SELECT * FROM resource_attachments WHERE projectId=? ORDER BY createdAt').all(projectId)
      : this.db.prepare('SELECT * FROM resource_attachments WHERE projectId=? AND enabled=1 ORDER BY createdAt').all(projectId);
    return (rows as any[]).map(resourceAttachmentRow);
  }

  updateResourceAttachment(id: string, patch: Partial<Pick<ResourceAttachment,
    'name' | 'target' | 'access' | 'isolation' | 'source' | 'credentialHandles' | 'storageLocationId' | 'publish' | 'enabled'>>): ResourceAttachment {
    const current = this.getResourceAttachment(id);
    if (!current) throw new Error('resource attachment not found');
    const next = { ...current, ...patch, updatedAt: Date.now() };
    validateResourceAttachment(next);
    this.db.prepare(`UPDATE resource_attachments SET name=?, target=?, access=?, isolation=?, source=?,
      credentialHandles=?, storageLocationId=?, publish=?, enabled=?, updatedAt=? WHERE id=?`).run(next.name, JSON.stringify(next.target),
        next.access, next.isolation, JSON.stringify(next.source), JSON.stringify(next.credentialHandles),
        next.storageLocationId ?? null, next.publish, next.enabled ? 1 : 0, next.updatedAt, id);
    return next;
  }

  deleteResourceAttachment(id: string): ResourceAttachment | undefined {
    const value = this.getResourceAttachment(id);
    if (!value) return undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM resource_leases WHERE attachmentId=?').run(id);
      this.db.prepare('DELETE FROM resource_revisions WHERE attachmentId=?').run(id);
      this.db.prepare('DELETE FROM resource_attachments WHERE id=?').run(id);
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveResourceRevision(input: Omit<ResourceRevision, 'id' | 'createdAt'>
    & Partial<Pick<ResourceRevision, 'id' | 'createdAt'>>): ResourceRevision {
    const value: ResourceRevision = { ...input, id: input.id ?? newId('revision'), createdAt: input.createdAt ?? Date.now() };
    if (!this.getResourceAttachment(value.attachmentId)) throw new Error('resource attachment not found');
    this.db.prepare(`INSERT INTO resource_revisions (id, attachmentId, parentRevisionId, engine, sealedRef,
      rootDigest, bytes, files, metadata, createdByTaskId, storageLocationId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        value.id, value.attachmentId, value.parentRevisionId ?? null, value.engine, value.sealedRef, value.rootDigest,
        value.bytes, value.files ?? null, jsonOrNull(value.metadata), value.createdByTaskId ?? null,
        value.storageLocationId ?? null, value.createdAt);
    return value;
  }

  getResourceRevision(id: string): ResourceRevision | undefined {
    const row = this.db.prepare('SELECT * FROM resource_revisions WHERE id=?').get(id) as any;
    return row ? resourceRevisionRow(row) : undefined;
  }

  listResourceRevisions(attachmentId: string): ResourceRevision[] {
    return (this.db.prepare('SELECT * FROM resource_revisions WHERE attachmentId=? ORDER BY createdAt DESC').all(attachmentId) as any[])
      .map(resourceRevisionRow);
  }

  createResourceCandidate(input: Omit<ResourceCandidate, 'id' | 'createdAt' | 'state'>
    & Partial<Pick<ResourceCandidate, 'id' | 'createdAt' | 'state'>>): ResourceCandidate {
    const task = this.getTask(input.taskId);
    const attachment = this.getResourceAttachment(input.attachmentId);
    if (!task || task.projectId !== input.projectId) throw new Error('resource candidate task does not belong to project');
    if (!attachment || attachment.projectId !== input.projectId || attachment.enabled)
      throw new Error('resource candidate requires a disabled attachment in the same project');
    const value: ResourceCandidate = { ...input, id: input.id ?? newId('resource-candidate'),
      state: input.state ?? 'pending', createdAt: input.createdAt ?? Date.now() };
    if (!['path', 'vault-item'].includes(value.sourceKind)) throw new Error('invalid resource candidate source');
    this.db.prepare(`INSERT INTO resource_candidates (id, organizationId, projectId, taskId, worldId,
      worldGeneration, attachmentId, sourceKind, sourcePath, vaultItemId, vaultField, state, createdAt,
      resolvedAt, resolvedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        value.id, value.organizationId, value.projectId, value.taskId, value.worldId, value.worldGeneration,
        value.attachmentId, value.sourceKind, value.sourcePath ?? null, value.vaultItemId ?? null,
        value.vaultField ?? null, value.state, value.createdAt, value.resolvedAt ?? null, value.resolvedBy ?? null);
    return value;
  }

  getResourceCandidate(id: string): ResourceCandidate | undefined {
    const row = this.db.prepare('SELECT * FROM resource_candidates WHERE id=?').get(id) as any;
    return row ? resourceCandidateRow(row) : undefined;
  }

  listResourceCandidates(taskId: string, includeResolved = true): ResourceCandidate[] {
    const rows = includeResolved
      ? this.db.prepare('SELECT * FROM resource_candidates WHERE taskId=? ORDER BY createdAt').all(taskId)
      : this.db.prepare("SELECT * FROM resource_candidates WHERE taskId=? AND state='pending' ORDER BY createdAt").all(taskId);
    return (rows as any[]).map(resourceCandidateRow);
  }

  resolveResourceCandidate(id: string, state: 'adopted' | 'discarded', resolvedBy: string): ResourceCandidate {
    const current = this.getResourceCandidate(id);
    if (!current) throw new Error('resource candidate not found');
    const expected = state === 'discarded' ? 'discarding' : 'pending';
    if (current.state !== expected) throw new Error(`resource candidate is already ${current.state}`);
    const now = Date.now();
    this.db.prepare('UPDATE resource_candidates SET state=?, resolvedAt=?, resolvedBy=? WHERE id=? AND state=?')
      .run(state, now, resolvedBy, id, expected);
    return this.getResourceCandidate(id)!;
  }

  beginDiscardResourceCandidate(id: string, taskId: string): ResourceCandidate {
    const current = this.getResourceCandidate(id);
    if (!current || current.taskId !== taskId) throw new Error('resource candidate does not belong to task');
    if (current.state === 'discarding') return current;
    if (current.state !== 'pending') throw new Error(`resource candidate is already ${current.state}`);
    const claimed = this.db.prepare("UPDATE resource_candidates SET state='discarding' WHERE id=? AND state='pending'").run(id);
    if (!Number(claimed.changes)) throw new Error('resource candidate changed during discard');
    return this.getResourceCandidate(id)!;
  }

  adoptResourceCandidate(id: string, taskId: string, resolvedBy: string): { candidate: ResourceCandidate; attachment: ResourceAttachment } {
    const current = this.getResourceCandidate(id);
    if (!current || current.taskId !== taskId) throw new Error('resource candidate does not belong to task');
    if (current.state !== 'pending') throw new Error(`resource candidate is already ${current.state}`);
    const attachment = this.getResourceAttachment(current.attachmentId);
    if (!attachment || attachment.enabled) throw new Error('resource candidate attachment is unavailable');
    if (current.sourceKind === 'path' && !attachment.currentRevisionId)
      throw new Error('resource candidate snapshot is incomplete and must be discarded');
    const now = Date.now();
    const source: Record<string, unknown> = { ...attachment.source, adoptedFromCandidate: current.id };
    delete source.candidate;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const enabled = this.db.prepare('UPDATE resource_attachments SET enabled=1, source=?, updatedAt=? WHERE id=? AND enabled=0')
        .run(JSON.stringify(source), now, attachment.id);
      const resolved = this.db.prepare("UPDATE resource_candidates SET state='adopted', resolvedAt=?, resolvedBy=? WHERE id=? AND state='pending'")
        .run(now, resolvedBy, id);
      if (!Number(enabled.changes) || !Number(resolved.changes)) throw new Error('resource candidate changed during adoption');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { candidate: this.getResourceCandidate(id)!, attachment: this.getResourceAttachment(attachment.id)! };
  }

  promoteResourceRevision(attachmentId: string, revisionId: string, expectedRevisionId?: string): ResourceAttachment {
    const revision = this.getResourceRevision(revisionId);
    if (!revision || revision.attachmentId !== attachmentId) throw new Error('resource revision does not belong to attachment');
    const now = Date.now();
    const result = expectedRevisionId === undefined
      ? this.db.prepare('UPDATE resource_attachments SET currentRevisionId=?, updatedAt=? WHERE id=? AND currentRevisionId IS NULL')
        .run(revisionId, now, attachmentId)
      : this.db.prepare('UPDATE resource_attachments SET currentRevisionId=?, updatedAt=? WHERE id=? AND currentRevisionId=?')
        .run(revisionId, now, attachmentId, expectedRevisionId);
    if (!Number(result.changes)) throw new Error('resource baseline changed before publish; review the newer revision and retry');
    return this.getResourceAttachment(attachmentId)!;
  }

  createResourceLease(input: Omit<ResourceLease, 'id' | 'createdAt' | 'state'>
    & Partial<Pick<ResourceLease, 'id' | 'createdAt' | 'state'>>): ResourceLease {
    const value: ResourceLease = { ...input, id: input.id ?? newId('resource-lease'), state: input.state ?? 'preparing',
      createdAt: input.createdAt ?? Date.now() };
    this.db.prepare(`INSERT INTO resource_leases (id, attachmentId, revisionId, taskId, worldId, worldGeneration,
      access, state, sealedDriverRef, createdAt, expiresAt, releasedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attachmentId, taskId, worldGeneration) DO UPDATE SET revisionId=excluded.revisionId,
      access=excluded.access, state=excluded.state, sealedDriverRef=excluded.sealedDriverRef,
      expiresAt=excluded.expiresAt, releasedAt=NULL`).run(value.id, value.attachmentId, value.revisionId ?? null,
        value.taskId, value.worldId, value.worldGeneration, value.access, value.state, value.sealedDriverRef ?? null,
        value.createdAt, value.expiresAt ?? null, value.releasedAt ?? null);
    return this.listResourceLeases(value.worldId, value.worldGeneration).find((lease) => lease.attachmentId === value.attachmentId)!;
  }

  listResourceLeases(worldId: string, generation?: number): ResourceLease[] {
    const rows = generation == null
      ? this.db.prepare('SELECT * FROM resource_leases WHERE worldId=? ORDER BY createdAt').all(worldId)
      : this.db.prepare('SELECT * FROM resource_leases WHERE worldId=? AND worldGeneration=? ORDER BY createdAt').all(worldId, generation);
    return (rows as any[]).map(resourceLeaseRow);
  }

  updateResourceLease(id: string, state: ResourceLease['state'], sealedDriverRef?: string): void {
    this.db.prepare('UPDATE resource_leases SET state=?, sealedDriverRef=COALESCE(?, sealedDriverRef), releasedAt=? WHERE id=?')
      .run(state, sealedDriverRef ?? null, state === 'released' ? Date.now() : null, id);
  }

  // ─── Organization storage locations and physical snapshot accounting ─────

  saveStorageLocation(input: Omit<StorageLocation, 'createdAt' | 'updatedAt'>
    & Partial<Pick<StorageLocation, 'createdAt' | 'updatedAt'>>): StorageLocation {
    if (!this.getOrganization(input.organizationId)) throw new Error('storage organization not found');
    if (!['managed', 's3'].includes(input.kind)) throw new Error('unsupported storage location kind');
    const now = Date.now();
    const value: StorageLocation = { ...input, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (value.isDefault) this.db.prepare('UPDATE storage_locations SET isDefault=0, updatedAt=? WHERE organizationId=?')
        .run(now, value.organizationId);
      this.db.prepare(`INSERT INTO storage_locations (id, organizationId, name, kind, config, credentialHandle,
        isDefault, status, lastCheckedAt, lastError, quotaBytes, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, config=excluded.config,
          credentialHandle=excluded.credentialHandle, isDefault=excluded.isDefault, status=excluded.status,
          lastCheckedAt=excluded.lastCheckedAt, lastError=excluded.lastError, quotaBytes=excluded.quotaBytes,
          updatedAt=excluded.updatedAt`).run(value.id, value.organizationId, value.name, value.kind,
          JSON.stringify(value.config), value.credentialHandle ?? null, value.isDefault ? 1 : 0, value.status,
          value.lastCheckedAt ?? null, value.lastError ?? null, value.quotaBytes ?? null, value.createdAt, value.updatedAt);
      this.db.exec('COMMIT');
      return this.getStorageLocation(value.id)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getStorageLocation(id: string): StorageLocation | undefined {
    const row = this.db.prepare('SELECT * FROM storage_locations WHERE id=?').get(id) as any;
    return row ? storageLocationRow(row) : undefined;
  }

  listStorageLocations(organizationId: string): StorageLocation[] {
    return (this.db.prepare('SELECT * FROM storage_locations WHERE organizationId=? ORDER BY isDefault DESC, createdAt')
      .all(organizationId) as any[]).map(storageLocationRow);
  }

  deleteStorageLocation(id: string): StorageLocation | undefined {
    const value = this.getStorageLocation(id);
    if (!value) return undefined;
    const refs = Number((this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM resource_attachments WHERE storageLocationId=?) +
      (SELECT COUNT(*) FROM resource_revisions WHERE storageLocationId=?) AS n`).get(id, id) as any)?.n ?? 0);
    if (refs) throw new Error('storage location is still used by project resources or revisions');
    this.db.prepare('DELETE FROM storage_locations WHERE id=?').run(id);
    return value;
  }

  storageLocationUsage(locationId: string): StorageLocationUsage {
    const location = this.getStorageLocation(locationId);
    if (!location) throw new Error('storage location not found');
    let retainedBytes = Number((this.db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes
      FROM resource_snapshot_chunks WHERE organizationId=? AND storageLocationId=?`)
      .get(location.organizationId, locationId) as any)?.bytes ?? 0);
    if (location.kind === 'managed') {
      retainedBytes += Number((this.db.prepare('SELECT COALESCE(SUM(bytes), 0) bytes FROM promoted_artifacts WHERE organizationId=?')
        .get(location.organizationId) as any)?.bytes ?? 0);
      retainedBytes += Number((this.db.prepare(`SELECT COALESCE(SUM(CAST(json_extract(manifest, '$.filesystemDelta.bytes') AS INTEGER)), 0) bytes
        FROM world_checkpoints WHERE projectId IN (SELECT id FROM projects WHERE organizationId=?)`)
        .get(location.organizationId) as any)?.bytes ?? 0);
    }
    return { locationId, retainedBytes, quotaBytes: location.quotaBytes,
      ...(location.quotaBytes == null ? {} : { availableBytes: Math.max(0, location.quotaBytes - retainedBytes) }) };
  }

  backfillManagedStorageLocation(organizationId: string, locationId: string): void {
    this.db.prepare(`UPDATE resource_snapshot_chunks SET storageLocationId=?
      WHERE organizationId=? AND storageLocationId IS NULL`).run(locationId, organizationId);
  }

  reserveStorageUpload(uploadId: string, organizationId: string, storageLocationId: string,
    bytes: number, expiresAt: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid storage upload reservation');
    const location = this.getStorageLocation(storageLocationId);
    if (!location || location.organizationId !== organizationId) throw new Error('storage location does not belong to organization');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const retained = this.storageLocationUsage(storageLocationId).retainedBytes;
      const total = retained + Number((this.db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes
        FROM storage_upload_reservations WHERE storageLocationId=? AND uploadId<>?`)
        .get(storageLocationId, uploadId) as any)?.bytes ?? 0) + bytes;
      if (location.quotaBytes != null && total > location.quotaBytes)
        throw new Error(`managed upload quota exceeded (${total} retained or pending bytes, ${location.quotaBytes} byte limit)`);
      this.db.prepare(`INSERT INTO storage_upload_reservations (uploadId, organizationId, storageLocationId, bytes, expiresAt)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(uploadId) DO UPDATE SET bytes=excluded.bytes, expiresAt=excluded.expiresAt`)
        .run(uploadId, organizationId, storageLocationId, bytes, expiresAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  releaseStorageUpload(uploadId: string): void {
    this.db.prepare('DELETE FROM storage_upload_reservations WHERE uploadId=?').run(uploadId);
  }

  retainResourceChunks(organizationId: string, chunks: Array<{ id: string; bytes: number }>, storageLocationId?: string): void {
    const insert = this.db.prepare(`INSERT INTO resource_snapshot_chunks (organizationId, chunkId, storageLocationId, refs, bytes)
      VALUES (?, ?, ?, 1, ?) ON CONFLICT(organizationId, chunkId) DO UPDATE SET refs=resource_snapshot_chunks.refs+1`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (storageLocationId) {
        const location = this.getStorageLocation(storageLocationId);
        if (!location || location.organizationId !== organizationId) throw new Error('storage location does not belong to organization');
        const newBytes = chunks.reduce((sum, chunk) => sum + (this.db.prepare(
          'SELECT 1 FROM resource_snapshot_chunks WHERE organizationId=? AND chunkId=?').get(organizationId, chunk.id) ? 0 : chunk.bytes), 0);
        const used = Number((this.db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS bytes FROM resource_snapshot_chunks
          WHERE organizationId=? AND storageLocationId=?`).get(organizationId, storageLocationId) as any)?.bytes ?? 0);
        if (location.quotaBytes != null && used + newBytes > location.quotaBytes)
          throw new Error(`managed storage quota exceeded (${used + newBytes} bytes requested, ${location.quotaBytes} byte limit)`);
      }
      for (const chunk of chunks) insert.run(organizationId, chunk.id, storageLocationId ?? null, chunk.bytes);
      this.db.exec('COMMIT');
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  releaseResourceChunks(organizationId: string, chunkIds: string[]): string[] {
    const zero: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of chunkIds) {
        const row = this.db.prepare('SELECT refs FROM resource_snapshot_chunks WHERE organizationId=? AND chunkId=?')
          .get(organizationId, id) as { refs: number } | undefined;
        if (!row) continue;
        if (Number(row.refs) <= 1) {
          this.db.prepare('DELETE FROM resource_snapshot_chunks WHERE organizationId=? AND chunkId=?').run(organizationId, id);
          zero.push(id);
        } else this.db.prepare('UPDATE resource_snapshot_chunks SET refs=refs-1 WHERE organizationId=? AND chunkId=?')
          .run(organizationId, id);
      }
      this.db.exec('COMMIT');
      return zero;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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

  /** Record a branch the Do agent added to this world (SPEC §11.1, multi-PR).
   *  The durable handle is what every later activity re-opens the world from —
   *  merge, PR, the terminal — so a checkout that exists on disk but not here
   *  would simply not be merged or reviewed. */
  updateWorldCheckouts(handle: WorldHandleRef, repos: NonNullable<WorldHandleRef['repos']>): WorldHandleRef {
    const current = this.currentWorld(handle.id);
    if (!current || (current.generation ?? 1) !== (handle.generation ?? 1)) throw new Error('cannot update a stale world generation');
    const next = { ...current, repos };
    this.db.prepare('UPDATE world_instances SET handle=?, updatedAt=? WHERE worldId=? AND generation=?')
      .run(JSON.stringify(next), Date.now(), handle.id, handle.generation ?? 1);
    return next;
  }

  /** Persist an accepted in-flight retarget on the durable world handle. The
   * immutable base/baseSha remain untouched; only non-pinned repository targets
   * follow the task-level destination. */
  updateCurrentWorldTarget(worldId: string, target: string): WorldHandleRef {
    const current = this.currentWorld(worldId);
    if (!current) throw new Error('cannot retarget a missing world');
    const repos = current.repos?.map((repo) => repo.targetPinned === false ? { ...repo, target } : repo);
    const next = { ...current, target, ...(repos ? { repos } : {}) };
    this.db.prepare('UPDATE world_instances SET handle=?, updatedAt=? WHERE worldId=? AND generation=?')
      .run(JSON.stringify(next), Date.now(), current.id, current.generation ?? 1);
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
    const remote = !['worktree', 'container', 'memory'].includes(pool.provider);
    const hostedCustomerWorld = remote && this.hosted && pool.mode === 'customer';
    const project = this.getProject(input.projectId);
    const task = this.getTask(input.taskId);
    if (!project || project.organizationId !== input.organizationId || !task || task.projectId !== project.id)
      throw new Error('runner admission attribution does not match the organization project and task');
    const resources = { cpu: Math.max(1, input.cpu ?? 2), memoryMb: Math.max(128, input.memoryMb ?? 2048), gpu: Math.max(0, input.gpu ?? 0) };
    if (!hostedCustomerWorld && (resources.cpu > pool.capacity.cpu || resources.memoryMb > pool.capacity.memoryMb || resources.gpu > pool.capacity.gpu
      || pool.capacity.activeWorlds < 1)) throw new Error('world resource request exceeds runner pool capacity');
    const id = newId('lease');
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const policy = this.getOrganizationUsagePolicy(input.organizationId);
      const month = monthWindow(now);
      const organizationBudget = this.getOrganizationExecutionPolicy(input.organizationId).monthlyBudgetMicros;
      if (organizationBudget != null && this.usageSummary(input.organizationId, month.from, month.to).costMicros >= organizationBudget)
        throw new Error('organization monthly cloud budget is exhausted');
      if (project.config.monthlyBudgetMicros != null
        && this.usageSummary(input.organizationId, month.from, month.to, project.id).costMicros >= project.config.monthlyBudgetMicros)
        throw new Error('project monthly cloud budget is exhausted');
      if (remote && this.hosted && pool.mode === 'managed')
        throw new Error('centrally funded remote sandbox pools are not enabled; connect the organization provider account');
      let organizationActive = 0;
      if (remote) {
        organizationActive = Number((this.db.prepare(`SELECT COUNT(*) n FROM world_leases l
          JOIN runner_pools p ON p.id=l.runnerPoolId WHERE l.organizationId=? AND l.state='active'
            AND p.provider NOT IN ('worktree','container','memory')`).get(input.organizationId) as any).n);
      }
      const active = this.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(cpu),0) cpu, COALESCE(SUM(memoryMb),0) memoryMb,
        COALESCE(SUM(gpu),0) gpu FROM world_leases WHERE runnerPoolId=? AND state='active'`).get(pool.id) as any;
      const acquired = hostedCustomerWorld
        ? organizationActive < policy.maxActiveWorlds
        : Number(active.n) < pool.capacity.activeWorlds && Number(active.cpu) + resources.cpu <= pool.capacity.cpu
          && Number(active.memoryMb) + resources.memoryMb <= pool.capacity.memoryMb && Number(active.gpu) + resources.gpu <= pool.capacity.gpu;
      if (remote && acquired) {
        const recent = Number((this.db.prepare(`SELECT COUNT(*) n FROM world_leases l
          JOIN runner_pools p ON p.id=l.runnerPoolId WHERE l.organizationId=? AND l.acquiredAt>=?
            AND p.provider NOT IN ('worktree','container','memory')`).get(input.organizationId, now - 60_000) as any).n);
        if (recent >= policy.maxRemoteStartsPerMinute) throw new Error('organization remote sandbox start rate limit exceeded');
      }
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

  private promoteQueuedWorldLeases(filter: { runnerPoolId?: string; organizationId?: string; remoteOnly?: boolean }): string[] {
    const queued = filter.runnerPoolId
      ? this.db.prepare(`SELECT * FROM world_leases WHERE runnerPoolId=? AND state='queued'
          ORDER BY priority DESC, createdAt`).all(filter.runnerPoolId) as any[]
      : this.db.prepare(`SELECT * FROM world_leases WHERE organizationId=? AND state='queued'
          ORDER BY priority DESC, createdAt`).all(filter.organizationId) as any[];
    const activated: string[] = [];
    for (const candidate of queued) {
      const pool = this.getRunnerPool(candidate.runnerPoolId);
      if (!pool?.enabled || pool.organizationId !== candidate.organizationId) continue;
      const remote = !['worktree', 'container', 'memory'].includes(pool.provider);
      if (filter.remoteOnly && !remote) continue;
      if (remote && this.hosted && pool.mode === 'managed') continue;
      const hostedCustomerWorld = remote && this.hosted && pool.mode === 'customer';
      const policy = this.getOrganizationUsagePolicy(candidate.organizationId);
      if (remote) {
        const organizationActive = Number((this.db.prepare(`SELECT COUNT(*) n FROM world_leases l
          JOIN runner_pools p ON p.id=l.runnerPoolId WHERE l.organizationId=? AND l.state='active'
            AND p.provider NOT IN ('worktree','container','memory')`).get(candidate.organizationId) as any).n);
        if (organizationActive >= policy.maxActiveWorlds) continue;
        const recent = Number((this.db.prepare(`SELECT COUNT(*) n FROM world_leases l
          JOIN runner_pools p ON p.id=l.runnerPoolId WHERE l.organizationId=? AND l.acquiredAt>=?
            AND p.provider NOT IN ('worktree','container','memory')`).get(candidate.organizationId, Date.now() - 60_000) as any).n);
        if (recent >= policy.maxRemoteStartsPerMinute) continue;
      }
      const project = this.getProject(candidate.projectId);
      const month = monthWindow(Date.now());
      const organizationBudget = this.getOrganizationExecutionPolicy(candidate.organizationId).monthlyBudgetMicros;
      if (organizationBudget != null && this.usageSummary(candidate.organizationId, month.from, month.to).costMicros >= organizationBudget) continue;
      if (project?.config.monthlyBudgetMicros != null
        && this.usageSummary(candidate.organizationId, month.from, month.to, candidate.projectId).costMicros >= project.config.monthlyBudgetMicros) continue;
      if (!hostedCustomerWorld) {
        const active = this.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(cpu),0) cpu, COALESCE(SUM(memoryMb),0) memoryMb,
          COALESCE(SUM(gpu),0) gpu FROM world_leases WHERE runnerPoolId=? AND state='active'`).get(pool.id) as any;
        if (Number(active.n) >= pool.capacity.activeWorlds || Number(active.cpu) + candidate.cpu > pool.capacity.cpu
          || Number(active.memoryMb) + candidate.memoryMb > pool.capacity.memoryMb || Number(active.gpu) + candidate.gpu > pool.capacity.gpu) continue;
      }
      this.db.prepare("UPDATE world_leases SET state='active', acquiredAt=? WHERE id=? AND state='queued'").run(Date.now(), candidate.id);
      activated.push(candidate.id);
    }
    return activated;
  }

  /** Re-evaluate customer-funded hosted worlds after a plan change. Downgrades
   * are non-destructive; upgrades immediately admit queued setup work. */
  reconcileWorldLeaseCapacity(organizationId: string): string[] {
    if (!this.hosted) return [];
    // Billing and organization-policy mutations may already own the surrounding
    // transaction. Join it instead of attempting a nested BEGIN (unsupported by
    // both SQLite and PostgreSQL); standalone callers still get an atomic pass.
    const ownsTransaction = !this.db.inTransaction();
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const activated = this.promoteQueuedWorldLeases({ organizationId, remoteOnly: true });
      if (ownsTransaction) this.db.exec('COMMIT');
      return activated;
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  releaseWorldLease(id: string): string[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.db.prepare('SELECT runnerPoolId, organizationId FROM world_leases WHERE id=?').get(id) as any;
      if (!lease) { this.db.exec('COMMIT'); return []; }
      this.db.prepare("UPDATE world_leases SET state='released', releasedAt=? WHERE id=? AND state!='released'").run(Date.now(), id);
      const pool = this.getRunnerPool(lease.runnerPoolId);
      const hostedCustomerRemote = !!pool && this.hosted && pool.mode === 'customer'
        && !['worktree', 'container', 'memory'].includes(pool.provider);
      const activated = hostedCustomerRemote
        ? this.promoteQueuedWorldLeases({ organizationId: lease.organizationId, remoteOnly: true })
        : this.promoteQueuedWorldLeases({ runnerPoolId: lease.runnerPoolId });
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

  activeWorldLeaseCount(worldId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM world_leases WHERE worldId=? AND state='active'")
      .get(worldId) as any)?.n ?? 0);
  }

  listWorldLeases(runnerPoolId: string): any[] {
    return this.db.prepare(`SELECT * FROM world_leases WHERE runnerPoolId=? AND state!='released'
      ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, priority DESC, createdAt`).all(runnerPoolId) as any[];
  }

  worldLeasesForTask(taskId: string): any[] {
    return this.db.prepare(`SELECT * FROM world_leases WHERE taskId=? AND state!='released'
      ORDER BY createdAt`).all(taskId) as any[];
  }

  /** Dedicated terminal/preview access can legitimately outlive its task's
   * workflow. Runner reconciliation must preserve capacity explicitly owned by
   * one of those live records rather than guessing from world state alone. */
  worldLeaseHasLiveAccessor(leaseId: string, now = Date.now()): boolean {
    const preview = this.db.prepare(`SELECT 1 FROM preview_leases
      WHERE runnerLeaseId=? AND revokedAt IS NULL AND expiresAt>? LIMIT 1`).get(leaseId, now);
    if (preview) return true;
    return Boolean(this.db.prepare(`SELECT 1 FROM executions
      WHERE runnerLeaseId=? AND state IN ('starting','running','stop-requested') LIMIT 1`).get(leaseId));
  }

  unreleasedWorldLeases(): any[] {
    return this.db.prepare(`SELECT * FROM world_leases WHERE state!='released'
      ORDER BY createdAt`).all() as any[];
  }

  recordedUsageEventIds(ids: string[]): Set<string> {
    const recorded = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const rows = this.db.prepare(`SELECT id FROM usage_events WHERE id IN (${batch.map(() => '?').join(',')})`)
        .all(...batch) as Array<{ id: string }>;
      for (const row of rows) recorded.add(row.id);
    }
    return recorded;
  }

  /** Ownership lookups do not need a task's potentially huge transcript. */
  taskAttribution(taskId: string): { projectId: string; organizationId: string } | undefined {
    return this.db.prepare(`SELECT tasks.projectId, projects.organizationId FROM tasks
      JOIN projects ON projects.id=tasks.projectId WHERE tasks.id=?`).get(taskId) as
      { projectId: string; organizationId: string } | undefined;
  }

  recordUsage(event: Omit<UsageEvent, 'id'> & { id?: string }): UsageEvent {
    const value: UsageEvent = { ...event, id: event.id ?? newId('usage') };
    this.db.prepare(`INSERT OR IGNORE INTO usage_events (id, organizationId, projectId, taskId, worldId, provider,
      kind, quantity, unit, costMicros, startedAt, endedAt, metadata, fundingSource, costClassification)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(value.id, value.organizationId, value.projectId ?? null, value.taskId ?? null, value.worldId ?? null,
        value.provider, value.kind, value.quantity, value.unit, value.costMicros, value.startedAt, value.endedAt,
        value.metadata ? JSON.stringify(value.metadata) : null, value.fundingSource ?? 'customer',
        value.costClassification ?? (value.costMicros > 0 ? 'incurred' : 'none'));
    const stored = this.db.prepare('SELECT fundingSource, costClassification FROM usage_events WHERE id=?').get(value.id) as any;
    return { ...value, fundingSource: stored?.fundingSource ?? value.fundingSource ?? 'customer',
      costClassification: stored?.costClassification ?? value.costClassification ?? (value.costMicros > 0 ? 'incurred' : 'none') };
  }

  /** Idempotent model admission. The stable turn id is the retry key: a retry
   * reuses an active reservation, while a completed turn is rejected rather
   * than billed twice after an acknowledgement loss. */
  activeAgentUsageAdmissions(organizationId: string): Array<{ id: string; taskId: string }> {
    return this.db.prepare(`SELECT id, taskId FROM usage_admissions
      WHERE organizationId=? AND kind='agent' AND state='active' ORDER BY createdAt`)
      .all(organizationId) as Array<{ id: string; taskId: string }>;
  }

  admitAgentUsage(input: { id: string; organizationId: string; projectId: string; taskId: string;
    provider: string; model?: string; fundingSource: 'managed' | 'byok' | 'customer';
    reservedCostMicros?: number; now?: number }): { reused: boolean } {
    const now = input.now ?? Date.now();
    const project = this.getProject(input.projectId);
    const task = this.getTask(input.taskId);
    if (!project || project.organizationId !== input.organizationId || !task || task.projectId !== project.id)
      throw new Error('usage attribution does not match the organization project and task');
    const entitlements = this.organizationEntitlements(input.organizationId);
    if (!entitlements.agentRunAdmissionAllowed) {
      const limit = entitlements.maxMembers ?? 0;
      const extra = Math.max(1, entitlements.currentMemberCount - limit);
      throw new EntitlementError(
        `${entitlements.planName} allows ${limit} organization user${limit === 1 ? '' : 's'}, but this organization has ${entitlements.currentMemberCount}. Remove ${extra} member${extra === 1 ? '' : 's'} or restore Team to start another agent run.`,
      );
    }
    const policy = this.getOrganizationUsagePolicy(input.organizationId);
    if (policy.allowedModelProviders.length && !policy.allowedModelProviders.includes(input.provider))
      throw new Error(`model provider ${input.provider} is not allowed by the organization`);
    if (input.model && policy.allowedModels.length && !policy.allowedModels.includes(input.model))
      throw new Error(`model ${input.model} is not allowed by the organization`);
    if (input.fundingSource === 'managed') {
      if (!policy.managedSpendCapMicros) throw new Error('managed model usage is disabled until an organization owner sets a spend cap');
      if (!policy.managedModelProviders.includes(input.provider))
        throw new Error(`managed ${input.provider} usage is not enabled for this organization`);
      if (!Number.isSafeInteger(input.reservedCostMicros) || input.reservedCostMicros! < 1)
        throw new Error('managed model usage has no installation-configured per-request cost ceiling');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const assertManagedCapacity = () => {
        if (input.fundingSource !== 'managed') return;
        const month = monthWindow(now);
        const spent = this.usageSummary(input.organizationId, month.from, month.to).byFundingSource.managed ?? 0;
        const reserved = Number((this.db.prepare(`SELECT COALESCE(SUM(reservedCostMicros), 0) n FROM usage_admissions
          WHERE organizationId=? AND fundingSource='managed' AND state='active'`).get(input.organizationId) as any).n);
        if (spent + reserved + input.reservedCostMicros! > policy.managedSpendCapMicros!)
          throw new Error('organization managed spend cap is exhausted');
      };
      const existing = this.db.prepare('SELECT * FROM usage_admissions WHERE id=?').get(input.id) as any;
      if (existing) {
        if (existing.organizationId !== input.organizationId || existing.projectId !== input.projectId
          || existing.taskId !== input.taskId || existing.provider !== input.provider
          || existing.fundingSource !== input.fundingSource || (existing.model ?? undefined) !== input.model
          || Number(existing.reservedCostMicros) !== Number(input.reservedCostMicros ?? 0))
          throw new Error('usage admission retry key belongs to different attributed work');
        if (existing.state === 'active') {
          this.db.exec('COMMIT');
          return { reused: true };
        }
        if (existing.state === 'released') {
          assertManagedCapacity();
          const active = Number((this.db.prepare(`SELECT COUNT(*) n FROM usage_admissions
            WHERE organizationId=? AND kind='agent' AND state='active'`).get(input.organizationId) as any).n);
          if (active >= policy.effectiveMaxActiveAgentTurns) throw new Error('organization active model turn limit reached');
          this.db.prepare("UPDATE usage_admissions SET state='active', releasedAt=NULL WHERE id=?").run(input.id);
          this.db.exec('COMMIT');
          return { reused: true };
        }
        this.db.exec('COMMIT');
        throw new Error('this model turn was already completed; refusing duplicate provider admission');
      }
      assertManagedCapacity();
      const minute = now - 60_000;
      const recent = Number((this.db.prepare(`SELECT COUNT(*) n FROM usage_admissions
        WHERE organizationId=? AND kind='agent' AND createdAt>=?`).get(input.organizationId, minute) as any).n);
      if (recent >= policy.maxAgentStartsPerMinute) throw new Error('organization model request rate limit exceeded');
      const active = Number((this.db.prepare(`SELECT COUNT(*) n FROM usage_admissions
        WHERE organizationId=? AND kind='agent' AND state='active'`).get(input.organizationId) as any).n);
      if (active >= policy.effectiveMaxActiveAgentTurns) throw new Error('organization active model turn limit reached');
      this.db.prepare(`INSERT INTO usage_admissions (id, organizationId, projectId, taskId, kind, provider, model,
        fundingSource, state, reservedCostMicros, createdAt) VALUES (?, ?, ?, ?, 'agent', ?, ?, ?, 'active', ?, ?)`)
        .run(input.id, input.organizationId, input.projectId, input.taskId, input.provider, input.model ?? null,
          input.fundingSource, input.reservedCostMicros ?? 0, now);
      this.db.exec('COMMIT');
      return { reused: false };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already committed */ }
      throw error;
    }
  }

  finishUsageAdmission(id: string, completed: boolean, now = Date.now(),
    events: Array<Omit<UsageEvent, 'id'> & { id?: string }> = []): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) this.recordUsage(event);
      this.db.prepare(`UPDATE usage_admissions SET state=?, releasedAt=? WHERE id=? AND state='active'`)
        .run(completed ? 'completed' : 'released', now, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  usageSummary(organizationId: string, from = 0, to = Date.now() + 1, projectId?: string): {
    costMicros: number; events: number; byKind: Record<string, number>; byFundingSource: Record<string, number>;
    incurredCostMicros: number; estimatedCostMicros: number; activeReservationsMicros: number;
    byCostClassification: Record<string, number>; byProvider: Record<string, number>; quantities: Record<string, number>;
    requests: { total: number; managed: number; byok: number; customer: number };
    active: { agentTurns: number; worlds: number; executions: number };
  } {
    const rows = (projectId
      ? this.db.prepare(`SELECT kind, provider, fundingSource, costClassification, unit, quantity, costMicros, startedAt, endedAt FROM usage_events
          WHERE organizationId=? AND projectId=? AND startedAt<?
            AND ((endedAt>startedAt AND endedAt>?) OR (endedAt<=startedAt AND startedAt>=?))`)
        .all(organizationId, projectId, to, from, from)
      : this.db.prepare(`SELECT kind, provider, fundingSource, costClassification, unit, quantity, costMicros, startedAt, endedAt FROM usage_events
          WHERE organizationId=? AND startedAt<?
            AND ((endedAt>startedAt AND endedAt>?) OR (endedAt<=startedAt AND startedAt>=?))`)
        .all(organizationId, to, from, from)) as any[];
    const byKind: Record<string, number> = {};
    const byFundingSource: Record<string, number> = {};
    const byCostClassification: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    const quantities: Record<string, number> = {};
    let costMicros = 0;
    for (const row of rows) {
      const startedAt = Number(row.startedAt);
      const endedAt = Number(row.endedAt);
      const duration = endedAt - startedAt;
      const overlap = duration > 0 ? Math.max(0, Math.min(endedAt, to) - Math.max(startedAt, from)) : 0;
      const cost = duration > 0 ? Math.round(Number(row.costMicros) * overlap / duration) : Number(row.costMicros);
      byKind[row.kind] = (byKind[row.kind] ?? 0) + cost;
      byFundingSource[row.fundingSource] = (byFundingSource[row.fundingSource] ?? 0) + cost;
      byCostClassification[row.costClassification] = (byCostClassification[row.costClassification] ?? 0) + cost;
      byProvider[row.provider] = (byProvider[row.provider] ?? 0) + cost;
      quantities[row.unit] = (quantities[row.unit] ?? 0) + Number(row.quantity);
      costMicros += cost;
    }
    const scope = projectId ? ' AND projectId=?' : '';
    const args = projectId ? [organizationId, projectId] : [organizationId];
    const requestRows = this.db.prepare(`SELECT fundingSource, COUNT(*) n FROM usage_admissions
      WHERE organizationId=?${scope} AND createdAt>=? AND createdAt<? GROUP BY fundingSource`).all(...args, from, to) as any[];
    const requests = { total: 0, managed: 0, byok: 0, customer: 0 };
    for (const row of requestRows) {
      const count = Number(row.n);
      requests.total += count;
      const source = String(row.fundingSource) as 'managed' | 'byok' | 'customer';
      if (source === 'managed' || source === 'byok' || source === 'customer') requests[source] += count;
    }
    const active = {
      agentTurns: Number((this.db.prepare(`SELECT COUNT(*) n FROM usage_admissions WHERE organizationId=?${scope} AND kind='agent' AND state='active'`).get(...args) as any).n),
      worlds: Number((this.db.prepare(`SELECT COUNT(*) n FROM world_leases WHERE organizationId=?${scope} AND state='active'`).get(...args) as any).n),
      executions: Number((this.db.prepare(`SELECT COUNT(*) n FROM executions WHERE organizationId=?${scope} AND state IN ('starting','running','stop-requested')`).get(...args) as any).n),
    };
    const activeReservationsMicros = Number((this.db.prepare(`SELECT COALESCE(SUM(reservedCostMicros), 0) n
      FROM usage_admissions WHERE organizationId=?${scope} AND fundingSource='managed' AND state='active'`)
      .get(...args) as any).n);
    return { costMicros, incurredCostMicros: byCostClassification.incurred ?? 0,
      estimatedCostMicros: byCostClassification.estimated ?? 0, activeReservationsMicros,
      events: rows.length, byKind, byFundingSource, byCostClassification, byProvider, quantities, requests, active };
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

  /** Keep policy accounting and reservation insertion atomic across workers. */
  paymentTransaction<T>(fn: () => T): T {
    const nested = this.db.inTransaction();
    if (!nested) this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.dialect === 'postgres') this.db.exec('LOCK TABLE cards, payment_spend_requests IN SHARE ROW EXCLUSIVE MODE');
      const result = fn();
      if (!nested) this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (!nested) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createCard(c: { id: string; provider: string; scope: 'project' | 'organization' | 'global'; scopeId?: string;
    label: string; cap: number; available: number; merchantLock?: string[]; createdAt: number;
    externalId?: string; currency?: string; status?: string; cardholderId?: string; last4?: string }) {
    this.paymentTransaction(() => {
      const organizationId = c.scope === 'project' ? this.getProject(c.scopeId!)?.organizationId
        : c.scope === 'organization' ? c.scopeId : 'org_personal';
      c.label = c.label.trim();
      if (!c.label || this.listOrganizationCards(organizationId ?? 'org_personal')
        .some(card => card.label.trim().toLowerCase() === c.label.toLowerCase()))
        throw new Error('Card name must be unique in the organization');
      this.db
        .prepare(`INSERT INTO cards (id, provider, scope, scopeId, label, cap, available, merchantLock, createdAt,
          externalId, currency, status, cardholderId, last4) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(c.id, c.provider, c.scope, c.scopeId ?? null, c.label, c.cap, c.available,
          c.merchantLock ? JSON.stringify(c.merchantLock) : null, c.createdAt, c.externalId ?? null,
          c.currency ?? 'usd', c.status ?? 'active', c.cardholderId ?? null, c.last4 ?? null);
    });
  }

  getCard(id: string): any {
    const r = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as any;
    return r ? cardRow(r) : undefined;
  }
  /**
   * Cards visible in a scope: a project sees its own project cards plus its
   * organization's cards; an organization view sees its own cards. Legacy
   * `scope='global'` cards (created before cards were org-scoped) remain visible
   * to the personal organization only, so a hosted tenant never spends from
   * another tenant's — or the installation's — card.
   */
  listCards(projectId?: string, organizationId?: string): any[] {
    const org = organizationId ?? (projectId ? this.getProject(projectId)?.organizationId : undefined) ?? 'org_personal';
    const legacyGlobal = org === 'org_personal' ? " OR scope='global'" : '';
    const rows = projectId
      ? (this.db.prepare(`SELECT * FROM cards WHERE (scope='organization' AND scopeId=?) OR (scope='project' AND scopeId=?)${legacyGlobal} ORDER BY createdAt`).all(org, projectId) as any[])
      : (this.db.prepare(`SELECT * FROM cards WHERE (scope='organization' AND scopeId=?)${legacyGlobal} ORDER BY createdAt`).all(org) as any[]);
    return rows.map(cardRow);
  }
  /** Every card funded by an organization, including cards narrowed to one of
   * its projects. Used for balance accounting and safe provider disconnect. */
  listOrganizationCards(organizationId: string): any[] {
    const legacyGlobal = organizationId === 'org_personal' ? " OR c.scope='global'" : '';
    return (this.db.prepare(`SELECT c.* FROM cards c LEFT JOIN projects p
      ON c.scope='project' AND c.scopeId=p.id
      WHERE (c.scope='organization' AND c.scopeId=?)
        OR (c.scope='project' AND p.organizationId=?)${legacyGlobal}
      ORDER BY c.createdAt`).all(organizationId, organizationId) as any[]).map(cardRow);
  }
  getCardByExternalId(provider: string, externalId: string): any {
    const row = this.db.prepare('SELECT * FROM cards WHERE provider=? AND externalId=?').get(provider, externalId) as any;
    return row ? cardRow(row) : undefined;
  }
  updateCard(id: string, patch: { available?: number; cap?: number; status?: string; last4?: string }) {
    const c = this.getCard(id);
    if (!c) return;
    this.db.prepare('UPDATE cards SET available=?, cap=?, status=?, last4=? WHERE id=?')
      .run(patch.available ?? c.available, patch.cap ?? c.cap, patch.status ?? c.status,
        patch.last4 ?? c.last4 ?? null, id);
  }

  // ─── Organization payment connections + durable spend ledger ───────────────

  upsertPaymentConnection(value: { organizationId: string; provider: string; accountId: string;
    status?: string; livemode?: boolean; details?: Record<string, unknown> }): any {
    const now = Date.now();
    const existing = this.getPaymentConnection(value.organizationId, value.provider);
    this.db.prepare(`INSERT INTO payment_connections
      (organizationId, provider, accountId, status, livemode, details, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organizationId, provider) DO UPDATE SET accountId=excluded.accountId,
      status=excluded.status, livemode=excluded.livemode, details=excluded.details, updatedAt=excluded.updatedAt`)
      .run(value.organizationId, value.provider, value.accountId, value.status ?? 'ready',
        value.livemode ? 1 : 0, JSON.stringify(value.details ?? {}), existing?.createdAt ?? now, now);
    return this.getPaymentConnection(value.organizationId, value.provider);
  }
  getPaymentConnection(organizationId: string, provider: string): any {
    const row = this.db.prepare('SELECT * FROM payment_connections WHERE organizationId=? AND provider=?')
      .get(organizationId, provider) as any;
    return row ? { ...row, livemode: Boolean(row.livemode), details: JSON.parse(row.details || '{}') } : undefined;
  }
  getPaymentConnectionByAccount(provider: string, accountId: string): any {
    const row = this.db.prepare('SELECT * FROM payment_connections WHERE provider=? AND accountId=?')
      .get(provider, accountId) as any;
    return row ? { ...row, livemode: Boolean(row.livemode), details: JSON.parse(row.details || '{}') } : undefined;
  }
  listPaymentConnections(organizationId: string): any[] {
    return (this.db.prepare('SELECT * FROM payment_connections WHERE organizationId=? ORDER BY createdAt')
      .all(organizationId) as any[]).map((row) => ({
        ...row, livemode: Boolean(row.livemode), details: JSON.parse(row.details || '{}'),
      }));
  }
  deletePaymentConnection(organizationId: string, provider: string): any {
    const value = this.getPaymentConnection(organizationId, provider);
    if (value) this.db.prepare('DELETE FROM payment_connections WHERE organizationId=? AND provider=?')
      .run(organizationId, provider);
    return value;
  }

  createPaymentOAuthState(input: { organizationId: string; userId?: string; redirectUri: string;
    ttlMs?: number }): string {
    const state = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare(`INSERT INTO payment_oauth_states
      (stateHash, organizationId, userId, redirectUri, createdAt, expiresAt, usedAt)
      VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .run(sha256(state), input.organizationId, input.userId ?? null, input.redirectUri,
        now, now + (input.ttlMs ?? 10 * 60_000));
    return state;
  }
  consumePaymentOAuthState(state: string): any {
    const hash = sha256(state);
    const row = this.db.prepare('SELECT * FROM payment_oauth_states WHERE stateHash=?').get(hash) as any;
    if (!row || row.usedAt || row.expiresAt <= Date.now()) return undefined;
    const result = this.db.prepare('UPDATE payment_oauth_states SET usedAt=? WHERE stateHash=? AND usedAt IS NULL')
      .run(Date.now(), hash);
    return Number(result.changes) === 1 ? row : undefined;
  }

  createPaymentSpendRequest(input: { organizationId: string; projectId: string; taskId: string;
    cardId?: string; amount: number; currency?: string; merchant?: string; why?: string;
    status: string; reason?: string; shortfall?: number; expiresAt?: number }): any {
    const now = Date.now();
    const id = newId('spend');
    this.db.prepare(`INSERT INTO payment_spend_requests
      (id, organizationId, projectId, taskId, cardId, amount, currency, merchant, why,
       status, reason, shortfall, providerAuthorizationId, createdAt, updatedAt, expiresAt, resolvedBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`)
      .run(id, input.organizationId, input.projectId, input.taskId, input.cardId ?? null, input.amount,
        input.currency ?? 'usd', input.merchant ?? null, input.why ?? null, input.status,
        input.reason ?? null, input.shortfall ?? null, now, now, input.expiresAt ?? now + 30 * 60_000);
    // The `spent:<taskId>` kv mirror below is DEAD in production: nothing reads
    // it — `paymentSpent` recomputes the sum from `payment_spend_requests` on
    // every call, as it must (authorizations expire on a clock). It is retained
    // only because tests/payments.test.ts asserts on it; removing the write and
    // that assertion together is a one-line follow-up owned by whoever owns that
    // test file. `deleteProjectKv` already sweeps the key on task deletion, so it
    // does not leak beyond a task's lifetime.
    if (input.status === 'authorized') this.kvSet(`spent:${input.taskId}`, String(this.paymentSpent(input.taskId)));
    return this.getPaymentSpendRequest(id);
  }
  getPaymentSpendRequest(id: string): any {
    return this.db.prepare('SELECT * FROM payment_spend_requests WHERE id=?').get(id) as any;
  }
  setPaymentSpendRequestCard(id: string, cardId: string): void {
    this.db.prepare('UPDATE payment_spend_requests SET cardId=?, updatedAt=? WHERE id=?')
      .run(cardId, Date.now(), id);
  }
  listPaymentSpendRequests(input: { organizationId?: string; taskId?: string; status?: string } = {}): any[] {
    this.expirePaymentSpendRequests();
    const clauses: string[] = [];
    const values: any[] = [];
    if (input.organizationId) { clauses.push('organizationId=?'); values.push(input.organizationId); }
    if (input.taskId) { clauses.push('taskId=?'); values.push(input.taskId); }
    if (input.status) { clauses.push('status=?'); values.push(input.status); }
    return this.db.prepare(`SELECT * FROM payment_spend_requests${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY createdAt DESC, rowid DESC`).all(...values) as any[];
  }
  /** `amount` is patchable because a request starts life as a *reservation* — an
   * upper bound the agent asked for — and the rail later reports what it really
   * moved. Everything that counts against a cap or an allowance sums this column,
   * so reconciling it is how the ceiling comes to reflect real money. */
  updatePaymentSpendRequest(id: string, patch: { status?: string; reason?: string; shortfall?: number;
    providerAuthorizationId?: string; resolvedBy?: string; expiresAt?: number; amount?: number }): any {
    const current = this.getPaymentSpendRequest(id);
    if (!current) return undefined;
    this.db.prepare(`UPDATE payment_spend_requests SET status=?, reason=?, shortfall=?,
      providerAuthorizationId=?, resolvedBy=?, expiresAt=?, amount=?, updatedAt=? WHERE id=?`)
      .run(patch.status ?? current.status, patch.reason ?? current.reason ?? null,
        patch.shortfall ?? current.shortfall ?? null,
        patch.providerAuthorizationId ?? current.providerAuthorizationId ?? null,
        patch.resolvedBy ?? current.resolvedBy ?? null, patch.expiresAt ?? current.expiresAt,
        patch.amount ?? current.amount, Date.now(), id);
    const updated = this.getPaymentSpendRequest(id);
    this.kvSet(`spent:${current.taskId}`, String(this.paymentSpent(current.taskId))); // see the note above
    return updated;
  }
  paymentSpent(taskId: string): number {
    this.expirePaymentSpendRequests();
    const row = this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS amount FROM payment_spend_requests
      WHERE taskId=? AND (status IN ('authorizing','consumed','settled')
        OR (status='authorized' AND expiresAt>?))`).get(taskId, Date.now()) as any;
    return Number(row?.amount ?? 0);
  }
  cardPaymentSpent(cardId: string, railOnly = false): number {
    this.expirePaymentSpendRequests();
    const row = this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS amount FROM payment_spend_requests
      WHERE cardId=? AND (status IN (${railOnly ? "'consumed','settled'" : "'authorizing','consumed','settled'"})
        OR (status='authorized' AND expiresAt>?))`).get(cardId, Date.now()) as any;
    return Number(row?.amount ?? 0);
  }
  findPaymentAuthorization(cardId: string, amount: number, merchant?: string): any {
    this.expirePaymentSpendRequests();
    const rows = this.db.prepare(`SELECT * FROM payment_spend_requests
      WHERE cardId=? AND status='authorized' AND amount>=? AND expiresAt>?
      ORDER BY CASE WHEN amount=? THEN 0 ELSE 1 END, createdAt`).all(cardId, amount, Date.now(), amount) as any[];
    const normalized = normalizePaymentMerchant(merchant);
    return rows.find((row) => {
      const expected = normalizePaymentMerchant(row.merchant);
      return !expected || !normalized || normalized.includes(expected) || expected.includes(normalized);
    });
  }
  expirePaymentSpendRequests(now = Date.now()): number {
    return Number(this.db.prepare(`UPDATE payment_spend_requests
      SET status='expired', reason='request expired', updatedAt=?
      WHERE expiresAt<=? AND status='authorized'`)
      .run(now, now).changes);
  }
  /** `amount` is what the rail actually authorized, which `findPaymentAuthorization`
   * allows to be *less* than the reservation. Recording it here is what stops an
   * over-estimated reservation from burning the card's cap for money nobody spent. */
  consumePaymentAuthorization(id: string, providerAuthorizationId: string, amount?: number): any {
    const result = this.db.prepare(`UPDATE payment_spend_requests SET status='consumed',
      providerAuthorizationId=?, amount=?, updatedAt=? WHERE id=? AND status='authorized' AND expiresAt>?`)
      .run(providerAuthorizationId,
        Number.isSafeInteger(amount) && amount! > 0 ? amount : this.getPaymentSpendRequest(id)?.amount,
        Date.now(), id, Date.now());
    return Number(result.changes) === 1 ? this.getPaymentSpendRequest(id) : undefined;
  }

  upsertPaymentTransaction(value: { organizationId: string; projectId?: string; taskId?: string;
    cardId?: string; spendRequestId?: string; provider: string; providerId: string; kind: string;
    status: string; amount: number; currency?: string; merchant?: string; raw?: unknown;
    createdAt?: number }): any {
    const now = Date.now();
    const id = newId('paytxn');
    this.db.prepare(`INSERT INTO payment_transactions
      (id, organizationId, projectId, taskId, cardId, spendRequestId, provider, providerId,
       kind, status, amount, currency, merchant, raw, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, providerId, kind) DO UPDATE SET status=excluded.status,
      amount=excluded.amount, merchant=excluded.merchant, raw=excluded.raw, updatedAt=excluded.updatedAt`)
      .run(id, value.organizationId, value.projectId ?? null, value.taskId ?? null, value.cardId ?? null,
        value.spendRequestId ?? null, value.provider, value.providerId, value.kind, value.status,
        value.amount, value.currency ?? 'usd', value.merchant ?? null, JSON.stringify(value.raw ?? {}),
        value.createdAt ?? now, now);
    const row = this.db.prepare('SELECT * FROM payment_transactions WHERE provider=? AND providerId=? AND kind=?')
      .get(value.provider, value.providerId, value.kind) as any;
    return row ? { ...row, raw: JSON.parse(row.raw || '{}') } : undefined;
  }
  listPaymentTransactions(organizationId: string, limit = 100): any[] {
    return (this.db.prepare('SELECT * FROM payment_transactions WHERE organizationId=? ORDER BY createdAt DESC LIMIT ?')
      .all(organizationId, Math.max(1, Math.min(500, limit))) as any[])
      .map((row) => ({ ...row, raw: JSON.parse(row.raw || '{}') }));
  }
  getPaymentTransactionByProviderId(provider: string, providerId: string): any {
    const row = this.db.prepare(`SELECT * FROM payment_transactions
      WHERE provider=? AND providerId=? ORDER BY updatedAt DESC LIMIT 1`).get(provider, providerId) as any;
    return row ? { ...row, raw: JSON.parse(row.raw || '{}') } : undefined;
  }
  getPaymentEvent(provider: string, eventId: string): any {
    const row = this.db.prepare('SELECT * FROM payment_events WHERE provider=? AND eventId=?')
      .get(provider, eventId) as any;
    return row ? { ...row, decision: row.decision ? JSON.parse(row.decision) : undefined } : undefined;
  }
  recordPaymentEvent(value: { provider: string; eventId: string; organizationId?: string;
    type: string; decision?: unknown }): any {
    this.db.prepare(`INSERT OR IGNORE INTO payment_events
      (provider, eventId, organizationId, type, decision, createdAt) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(value.provider, value.eventId, value.organizationId ?? null, value.type,
        value.decision === undefined ? null : JSON.stringify(value.decision), Date.now());
    return this.getPaymentEvent(value.provider, value.eventId);
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

  getScopedTokenById(tokenId: string): Record<string, unknown> | undefined {
    const r = this.db.prepare('SELECT json FROM scoped_tokens WHERE tokenId=? AND revokedAt IS NULL AND expiresAt>?')
      .get(tokenId, Date.now()) as any;
    return r ? JSON.parse(r.json) : undefined;
  }

  putHumanDelegation(id: string, record: Record<string, unknown>, expiresAt: number): void {
    this.db.prepare(`INSERT INTO human_delegations (id, json, expiresAt, revokedAt)
      VALUES (?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET
      json=excluded.json, expiresAt=excluded.expiresAt, revokedAt=NULL`)
      .run(id, JSON.stringify(record), expiresAt);
  }

  getHumanDelegation(id: string): Record<string, unknown> | undefined {
    const r = this.db.prepare('SELECT json FROM human_delegations WHERE id=? AND revokedAt IS NULL AND expiresAt>?')
      .get(id, Date.now()) as any;
    return r ? JSON.parse(r.json) : undefined;
  }

  revokeHumanDelegation(id: string): void {
    this.db.prepare('UPDATE human_delegations SET revokedAt=? WHERE id=?').run(Date.now(), id);
  }

  revokeHumanDelegationsForTask(taskId: string): number {
    return this.revokeHumanDelegations({ taskId });
  }

  revokeHumanDelegations(scope: { taskId?: string; projectId?: string; organizationId?: string; humanUserId?: string }): number {
    const update = this.db.prepare('UPDATE human_delegations SET revokedAt=? WHERE id=? AND revokedAt IS NULL');
    let revoked = 0;
    for (const row of this.db.prepare('SELECT id, json FROM human_delegations WHERE revokedAt IS NULL').all() as any[]) {
      try {
        const record = JSON.parse(row.json) as Record<string, unknown>;
        if ((scope.taskId && record.taskId === scope.taskId)
          || (scope.projectId && (record.projectId === scope.projectId
            || Array.isArray(record.projectIds) && record.projectIds.includes(scope.projectId)))
          || (scope.organizationId && record.organizationId === scope.organizationId)
          || (scope.humanUserId && record.humanUserId === scope.humanUserId))
          revoked += Number(update.run(Date.now(), row.id).changes);
      } catch { /* malformed historical state is unusable, but must not block cleanup */ }
    }
    return revoked;
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

  purgeHumanDelegations(now = Date.now()): number {
    return Number(this.db.prepare('DELETE FROM human_delegations WHERE expiresAt<=? OR revokedAt IS NOT NULL').run(now).changes);
  }

  /** How long a GitHub delivery id stays in the dedupe table. GitHub retries a
   *  failed delivery for at most ~24 h and the manual "Redeliver" button is a
   *  deliberate act, so a week is generous while still bounding the table. */
  static readonly GITHUB_DELIVERY_RETENTION_MS = 7 * 24 * 3600_000;

  /** Age out consumed GitHub webhook delivery ids (unbounded growth otherwise:
   *  one row per delivery, forever, and nothing ever deleted them). */
  purgeGithubDeliveries(olderThanMs = Store.GITHUB_DELIVERY_RETENTION_MS, now = Date.now()): number {
    return Number(this.db.prepare('DELETE FROM github_webhook_deliveries WHERE receivedAt <= ?')
      .run(now - olderThanMs).changes);
  }

  /**
   * The periodic retention sweep. Every sweep here is idempotent and bounded, so
   * a caller can run it on any interval (hourly is plenty).
   *
   * This exists because `purgeScopedTokens` had ZERO call sites repo-wide —
   * `scoped_tokens` accumulated every expired and revoked row forever, and the
   * `idx_scoped_tokens_expiry` index existed purely for a sweep that never ran.
   * `github_webhook_deliveries` had the same problem. Per-task `agent.output`
   * pruning is NOT here: it is event-driven off `saveView` (a task settling), so
   * it needs no timer.
   *
   * SEAM: the app boot (`src/main.ts`) is what must schedule this — e.g.
   * Scheduled hourly (and once at boot) by `src/main.ts`, next to the orphan sweep.
   */
  retentionSweep(now = Date.now()): { scopedTokens: number; humanDelegations: number; githubDeliveries: number;
    subscriptionRequests: number } {
    return {
      scopedTokens: this.purgeScopedTokens(now),
      humanDelegations: this.purgeHumanDelegations(now),
      githubDeliveries: this.purgeGithubDeliveries(Store.GITHUB_DELIVERY_RETENTION_MS, now),
      subscriptionRequests: Number(this.db.prepare(`DELETE FROM subscription_billing_requests
        WHERE createdAt<? AND responseJson IS NOT NULL`).run(now - 30 * 24 * 60 * 60 * 1000).changes),
    };
  }

  /** Undo a delivery claim so a GitHub redelivery is processed instead of being
   *  short-circuited as a duplicate (see `recordGithubDelivery`). */
  releaseGithubDelivery(deliveryId: string): void {
    this.db.prepare('DELETE FROM github_webhook_deliveries WHERE deliveryId=?').run(deliveryId);
  }

  kvHas(k: string): boolean { return !!this.db.prepare('SELECT 1 FROM kv WHERE k=?').get(k); }

  kvGet(k: string): string | undefined {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as any;
    return r?.v;
  }

  kvSet(k: string, v: string) {
    this.db
      .prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, v);
  }

  kvClaim(k: string, v: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)').run(k, v).changes) === 1;
  }

  kvEntries(prefix: string): Array<{ key: string; value: string }> {
    return (this.db.prepare('SELECT k, v FROM kv WHERE k LIKE ? ORDER BY k').all(`${prefix}%`) as any[])
      .map((row) => ({ key: String(row.k), value: String(row.v) }));
  }

  kvDelete(k: string): void { this.db.prepare('DELETE FROM kv WHERE k=?').run(k); }

  /** Immutable evidence of the exact launch-policy set affirmatively accepted.
   * Keep this normalized and append-only; a new policy release creates another
   * row rather than rewriting the evidence for an older action. */
  recordPolicyAcceptance(input: { userId: string; email?: string; organizationId?: string; context: 'signup' | 'checkout';
    versions: Record<string, string>; acceptedAt?: number; checkoutRequestReference?: string;
    checkoutSessionReference?: string;
    commercialTerms?: Record<string, unknown> }) {
    const row = { id: newId('pa'), userId: input.userId, email: input.email,
      organizationId: input.organizationId, context: input.context, versions: { ...input.versions },
      acceptedAt: input.acceptedAt ?? Date.now(), checkoutRequestReference: input.checkoutRequestReference,
      checkoutSessionReference: input.checkoutSessionReference,
      commercialTerms: input.commercialTerms ? { ...input.commercialTerms } : undefined };
    this.db.prepare(`INSERT OR IGNORE INTO policy_acceptances
      (id,userId,email,organizationId,context,versionsJson,acceptedAt,checkoutRequestReference,checkoutSessionReference,commercialTermsJson)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.userId, row.email ?? null, row.organizationId ?? null, row.context,
        JSON.stringify(row.versions), row.acceptedAt, row.checkoutRequestReference ?? null,
        row.checkoutSessionReference ?? null, row.commercialTerms ? JSON.stringify(row.commercialTerms) : null);
    return row;
  }

  policyAcceptances(userId: string): Array<{ id: string; userId: string; email?: string; organizationId?: string;
    context: 'signup' | 'checkout'; versions: Record<string, string>; acceptedAt: number;
    checkoutRequestReference?: string; checkoutSessionReference?: string;
    commercialTerms?: Record<string, unknown> }> {
    return (this.db.prepare('SELECT * FROM policy_acceptances WHERE userId=? ORDER BY acceptedAt,id').all(userId) as any[])
      .map((row) => ({ id: String(row.id), userId: String(row.userId), email: row.email ? String(row.email) : undefined,
        organizationId: row.organizationId ? String(row.organizationId) : undefined,
        context: row.context, versions: JSON.parse(String(row.versionsJson)), acceptedAt: Number(row.acceptedAt),
        checkoutRequestReference: row.checkoutRequestReference ? String(row.checkoutRequestReference) : undefined,
        checkoutSessionReference: row.checkoutSessionReference ? String(row.checkoutSessionReference) : undefined,
        commercialTerms: row.commercialTermsJson ? JSON.parse(String(row.commercialTermsJson)) : undefined }));
  }

  close() {
    void this.asyncDatabase?.close().catch(error => console.error('[store] closing read pool:', error));
    this.organizationEntitlementListeners.clear();
    this.db.close();
  }

  /** Apply idempotent row migrations after a legacy database has been imported. */
  finishLegacyImport(): void {
    this.migrate();
    this.migrateData();
    this.migrateConversations();
  }
}

/** Open the configured backend and import the legacy SQLite store once. */
export function openStore(sqliteFile: string, databaseUrl?: string,
  options: { hosted?: boolean } = {}): { store: Store; migration?: SqliteImportResult } {
  if (!databaseUrl) return { store: new Store(sqliteFile, options) };
  const store = new Store(databaseUrl, options);
  try {
    const migration = importSqliteDatabase(sqliteFile, store.db, 'store', {
      sentinelTable: 'tasks',
      transformRows: (table, rows) => table === 'organizations'
        ? disambiguateLegacyOrganizationNames(rows as LegacyOrganizationNameRow[])
        : rows,
    });
    if (migration.imported) store.finishLegacyImport();
    return { store, migration };
  } catch (error) {
    store.close();
    throw error;
  }
}

interface LegacyOrganizationNameRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
}

/** Normalize legacy duplicate labels before a unique index or import can reject
 * them. Returning copies keeps the read-only SQLite cutover source untouched. */
function disambiguateLegacyOrganizationNames<T extends LegacyOrganizationNameRow>(organizations: T[]): T[] {
  const ordered = [...organizations].sort((left, right) => Number(left.createdAt) - Number(right.createdAt)
    || left.id.localeCompare(right.id));
  const occupied = new Set(ordered.map((organization) => canonicalAccountName(organization.name)));
  const preserved = new Set<string>();
  const renamed = new Map<string, string>();
  for (const organization of ordered) {
    const key = canonicalAccountName(organization.name);
    if (!preserved.has(key)) {
      preserved.add(key);
      continue;
    }
    const base = organization.slug.trim() || 'organization';
    let candidate = base;
    for (let suffix = 2; occupied.has(canonicalAccountName(candidate)); suffix++)
      candidate = `${base}-${suffix}`;
    renamed.set(organization.id, candidate);
    occupied.add(canonicalAccountName(candidate));
    preserved.add(canonicalAccountName(candidate));
  }
  return organizations.map((organization) => renamed.has(organization.id)
    ? { ...organization, name: renamed.get(organization.id)! }
    : organization);
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
    externalId: r.externalId ?? undefined,
    currency: r.currency ?? 'usd',
    status: r.status ?? 'active',
    cardholderId: r.cardholderId ?? undefined,
    last4: r.last4 ?? undefined,
    createdAt: r.createdAt,
  };
}

function normalizePaymentMerchant(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resourceAttachmentRow(row: any): ResourceAttachment {
  return { id: row.id, organizationId: row.organizationId, projectId: row.projectId, name: row.name,
    driver: row.driver, target: JSON.parse(row.target), access: row.access, isolation: row.isolation,
    source: JSON.parse(row.source), credentialHandles: JSON.parse(row.credentialHandles),
    storageLocationId: row.storageLocationId ?? undefined,
    currentRevisionId: row.currentRevisionId ?? undefined, publish: row.publish, enabled: Boolean(row.enabled),
    createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
}

function resourceRevisionRow(row: any): ResourceRevision {
  return { id: row.id, attachmentId: row.attachmentId, parentRevisionId: row.parentRevisionId ?? undefined,
    engine: row.engine, storageLocationId: row.storageLocationId ?? undefined,
    sealedRef: row.sealedRef, rootDigest: row.rootDigest, bytes: Number(row.bytes),
    files: row.files == null ? undefined : Number(row.files), metadata: parseJsonOptional(row.metadata),
    createdByTaskId: row.createdByTaskId ?? undefined, createdAt: Number(row.createdAt) };
}

function storageLocationRow(row: any): StorageLocation {
  return { id: row.id, organizationId: row.organizationId, name: row.name, kind: row.kind,
    config: JSON.parse(row.config), credentialHandle: row.credentialHandle ?? undefined,
    isDefault: Boolean(row.isDefault), status: row.status,
    lastCheckedAt: row.lastCheckedAt == null ? undefined : Number(row.lastCheckedAt),
    lastError: row.lastError ?? undefined, quotaBytes: row.quotaBytes == null ? undefined : Number(row.quotaBytes),
    createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
}

function resourceLeaseRow(row: any): ResourceLease {
  return { id: row.id, attachmentId: row.attachmentId, revisionId: row.revisionId ?? undefined,
    taskId: row.taskId, worldId: row.worldId, worldGeneration: Number(row.worldGeneration), access: row.access,
    state: row.state, sealedDriverRef: row.sealedDriverRef ?? undefined, createdAt: Number(row.createdAt),
    expiresAt: row.expiresAt == null ? undefined : Number(row.expiresAt),
    releasedAt: row.releasedAt == null ? undefined : Number(row.releasedAt) };
}

function resourceCandidateRow(row: any): ResourceCandidate {
  return { id: row.id, organizationId: row.organizationId, projectId: row.projectId,
    taskId: row.taskId, worldId: row.worldId, worldGeneration: Number(row.worldGeneration),
    attachmentId: row.attachmentId, sourceKind: row.sourceKind,
    sourcePath: row.sourcePath ?? undefined, vaultItemId: row.vaultItemId ?? undefined,
    vaultField: row.vaultField ?? undefined, state: row.state, createdAt: Number(row.createdAt),
    resolvedAt: row.resolvedAt == null ? undefined : Number(row.resolvedAt), resolvedBy: row.resolvedBy ?? undefined };
}

function selectRows(db: SqlDatabase, table: string, where: string, args: any[]): any[] {
  return db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...args) as any[];
}

/**
 * SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 32,766 — one placeholder per
 * id means a project with more tasks than that makes `IN (...)` a hard error, so
 * a big project could not be deleted at all. Chunk well under the limit.
 */
const SQL_VARIABLE_CHUNK = 900;

function chunked<T>(values: T[], run: (chunk: T[]) => void): void {
  for (let i = 0; i < values.length; i += SQL_VARIABLE_CHUNK) run(values.slice(i, i + SQL_VARIABLE_CHUNK));
}

function rowsFor(db: SqlDatabase, table: string, column: string, values: string[]): any[] {
  if (!values.length) return [];
  const out: any[] = [];
  chunked(values, (chunk) => {
    out.push(...selectRows(db, table, `${column} IN (${chunk.map(() => '?').join(',')})`, chunk));
  });
  return out;
}

export function deleteRows(db: SqlDatabase, table: string, column: string, values: string[]): void {
  chunked(values, (chunk) => {
    db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${chunk.map(() => '?').join(',')})`).run(...chunk);
  });
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

/** Path segments the web router and gateway own. An organization owns the top URL
 *  segment by its slug, and a project is addressed at `/<org>/<project>` by the
 *  slug of its name — so a name that slugifies to one of these words would be
 *  shadowed by a built-in route and unreachable in the console (e.g. a project
 *  named "wiki" collides with the organization wiki view). Reject those names at
 *  creation. Keep this in sync with `web/app.js` (`parseRoute` / `ORG_VIEWS`) and
 *  the gateway's `/api` + `/ws` prefixes. */
const RESERVED_ROUTE_SLUGS = new Set([
  'mcp-callback',
  // gateway-owned top-level prefixes
  'api', 'ws',
  // top-level routes / legacy org paths (an org slug is the first URL segment)
  'invite', 'projects', 'organization', 'organizations',
  // organization-level views — ORG_VIEWS (a project slug is the segment after the org)
  'dashboard', 'settings', 'inbox', 'wiki', 'profile',
  // project-level tabs
  'tasks', 'queue', 'activity',
]);

/** Throw a user-facing error if `name` (or an explicit `slug`) resolves to a
 *  reserved routing word. Applied at the single creation choke points for
 *  projects and organizations. */
function assertRoutableName(kind: 'project' | 'organization', name: string, slug?: string): void {
  const s = slugify(slug ?? name);
  if (RESERVED_ROUTE_SLUGS.has(s))
    throw new Error(`"${s}" is a reserved name and can't be used for a ${kind}. Please choose a different name.`);
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
  if (raw.environment?.flavor != null && !['headless', 'desktop'].includes(raw.environment.flavor))
    throw new Error('environment flavor must be headless or desktop');
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

function monthWindow(now: number): { from: number; to: number } {
  const date = new Date(now);
  return { from: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    to: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}

function validateResourceAttachment(value: ResourceAttachment): void {
  if (!value.name.trim() || value.name.length > 120) throw new Error('resource name is required and must be at most 120 characters');
  if (!/^[a-z][a-z0-9._-]*@\d+$/i.test(value.driver)) throw new Error('resource driver must be a versioned registry id');
  if (!['read', 'write'].includes(value.access)) throw new Error('resource access must be read or write');
  if (!['fork', 'shared'].includes(value.isolation)) throw new Error('resource isolation must be fork or shared');
  if (!['discard', 'review'].includes(value.publish)) throw new Error('resource publish policy must be discard or review');
  const driver = resourceDriver(value.driver);
  if (!driver) throw new Error(`resource driver ${value.driver} is not installed`);
  const snapshot = driver.dataPlane === 'snapshot';
  if (value.isolation === 'shared' && value.access === 'write' && value.publish !== 'discard')
    throw new Error('shared writable resources record side effects directly and cannot be promoted');
  if (!driver.isolations.includes(value.isolation)) throw new Error(`${value.driver} does not support ${value.isolation} isolation`);
  if (!driver.targets.includes(value.target.kind)) throw new Error(`${value.driver} does not support ${value.target.kind} targets`);
  if (driver.credentialRequired && !value.credentialHandles.length) throw new Error('credential-backed resources require a credential handle');
  if (value.publish === 'review' && (!snapshot || value.access !== 'write' || value.isolation !== 'fork'))
    throw new Error('reviewed promotion requires a writable, forked snapshot resource');
  if (value.target.kind === 'path') {
    const normalized = value.target.path.replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..'))
      throw new Error('resource path target must be world-relative');
  } else if (value.target.kind === 'environment' || value.target.kind === 'service') {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(value.target.name)) throw new Error('resource environment target must be an uppercase variable name');
  } else throw new Error('unknown resource target');
  if (!Array.isArray(value.credentialHandles) || value.credentialHandles.some((handle) => typeof handle !== 'string' || !handle))
    throw new Error('resource credential handles must be non-empty strings');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function principalKey(principal: ProjectPrincipalRef): string {
  if (principal.kind === 'user') return `user:${principal.userId}`;
  if (principal.kind === 'team') return `team:${principal.teamId}`;
  if (principal.kind === 'organization') return `organization:${principal.organizationId}`;
  if (principal.kind === 'avatar') return `avatar:${principal.avatarId}`;
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
  return { id: r.id, name: r.name, slug: r.slug, kind: r.kind, nameVisibility: r.nameVisibility === 'public' ? 'public' : 'members',
    plan: isHostedPlanId(r.plan) ? r.plan : 'free', createdAt: r.createdAt };
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
    taskId: r.taskId, kind: r.kind, urgency: URGENCY_LEVELS[Number(r.urgency ?? urgencyRank('normal'))] ?? 'normal',
    unread: Boolean(r.unread), actionable: Boolean(r.actionable),
    createdAt: r.createdAt, readAt: r.readAt ?? undefined,
    ...(r.subject ? { subject: JSON.parse(r.subject) } : {}) };
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

/** New hosted configuration can never select the local-only `none` policy.
 * Keep this at the Store boundary as well as the HTTP boundary: agents and
 * future service callers write through the Store without necessarily using the
 * browser route. Legacy rows are tolerated by `effectiveProjectConfig` above
 * and resolve to `pr`; only a new write is rejected. */
function writableProjectConfig(config: ProjectConfig): ProjectConfig {
  if (process.env.KARMAX_DEPLOYMENT !== 'hosted') return config;
  if (config.remote === 'none')
    throw new Error('hosted GitHub projects require remote policy "pr" or the advanced direct-push policy');
  return config.remote === undefined ? { ...config, remote: 'pr' } : config;
}

function rowToProject(r: any): Project {
  return { id: r.id, organizationId: r.organizationId ?? 'org_personal', name: r.name, createdAt: r.createdAt, config: JSON.parse(r.config), order: r.ord ?? 0, ...(r.folder ? { folder: r.folder } : {}) };
}

/** Canonical form of a sidebar folder path: segments trimmed, empties dropped,
 * so "  Work / Clients /" and "Work/Clients" are the same folder. Undefined
 * means top level — the column stores NULL, never ''. */
function normalizeFolder(folder: unknown): string | undefined {
  return String(folder ?? '').split('/').map((s) => s.trim()).filter(Boolean).join('/') || undefined;
}

/** Split the one user-facing project path into its routable leaf name and its
 * implicit sidebar folder. Empty path segments are harmless, matching folder
 * normalization used by drag-and-drop. */
function parseProjectPath(value: unknown): { name: string; folder?: string } {
  const parts = String(value ?? '').split('/').map((part) => part.trim()).filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error('project name is required');
  const folder = normalizeFolder(parts.join('/'));
  return { name, ...(folder ? { folder } : {}) };
}
function rowToTag(r: any): Tag {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    parentId: r.parentId ?? undefined,
    color: r.color ?? undefined,
    kind: r.kind ?? undefined,
    description: r.description ?? undefined,
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
    executionWorkflow: r.executionWorkflow ?? r.workflow,
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
    lastView: r.lastView ? { ...(r.conversation ? JSON.parse(r.conversation) : {}), ...JSON.parse(r.lastView) } : undefined,
  };
}

/** A tag colour is rendered into an inline `style` custom property; only a
 *  hex literal is accepted so it can never carry a CSS declaration. */
function assertTagColor(color: string | null | undefined): void {
  if (color == null || color === '') return;
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) throw new Error('tag color must be a hex colour like #4a90d9');
}
