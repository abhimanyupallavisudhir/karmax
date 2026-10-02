import type { Store } from '../store/db.js';
import type { ObjectStore } from '../store/objects.js';
import type { ProjectResourceService } from './resources.js';

const DAY = 24 * 60 * 60 * 1000;

/** Managed-storage lifecycle policy (hosted tavya; the leak repairs also run
 * on private installations). Shown to customers on the storage page. */
export const STORAGE_POLICY = Object.freeze({
  /** Saved workspaces of done or cancelled tasks: their committed work is on
   * the task branch, so the uncommitted leftovers expire after this. */
  finishedTaskCheckpointMs: 30 * DAY,
  /** A park's capture of a task's private data copy that nothing references
   * any more is deleted once it is this old (in-flight parks are younger). */
  unreferencedCheckpointRevisionMs: DAY,
  /** An organization over its quota is read-only for new data; after this its
   * managed data is deleted, older versions first, until it fits. */
  overQuotaDeletionMs: 365 * DAY,
  /** Notices before deletion, besides the one when it first goes over. */
  noticeLeadMs: Object.freeze({ '30d': 30 * DAY, '7d': 7 * DAY }),
});

/** `resolved`: back within the quota; withdraw the notice (no email). */
export type StorageNoticeStage = 'over' | '30d' | '7d' | 'deleted' | 'resolved';

export interface StorageNotice {
  organizationId: string;
  stage: StorageNoticeStage;
  retainedBytes: number;
  quotaBytes: number;
  overSince: number;
  deleteAt: number;
}

export interface StorageOverQuotaView { since: number; deleteAt: number }

export interface StorageContentsView {
  retainedBytes: number;
  quotaBytes?: number;
  overQuota?: StorageOverQuotaView;
  policy: { finishedTaskCheckpointDays: number; overQuotaDeletionDays: number };
  projects: Array<{
    projectId: string;
    name: string;
    /** Logical bytes: versions share unchanged data. */
    bytes: number;
    resources: Array<{ id: string; name: string; currentBytes: number; olderVersions: number; olderBytes: number;
      taskCopies: number; taskCopyBytes: number }>;
    artifacts: { count: number; bytes: number; nextExpiry?: number };
    checkpoints: { count: number; bytes: number; finishedCount: number; finishedBytes: number };
  }>;
}

/** Retention, the over-quota policy and the customer's view of what managed
 * storage holds. Runs hourly; every step is bounded and idempotent. */
export class ManagedStorageService {
  constructor(private deps: {
    store: Store;
    resources: ProjectResourceService;
    /** Deletes queued checkpoint objects and rows (the world lifecycle also runs it). */
    checkpoints?: { collectGarbage(): Promise<void> };
    /** The managed object store, for artifact objects. */
    objects?: ObjectStore;
    notify?: (notice: StorageNotice) => Promise<void>;
  }) {}

  async run(now = Date.now()): Promise<{ expiredCheckpoints: number; deletedRevisions: number; notices: number }> {
    const { store } = this.deps;
    const expiredCheckpoints = (await store.expireFinishedWorldCheckpoints(now - STORAGE_POLICY.finishedTaskCheckpointMs));
    if (expiredCheckpoints) await this.deps.checkpoints?.collectGarbage();
    let deletedRevisions = 0;
    for (const revision of (await store.unreferencedCheckpointRevisions(now - STORAGE_POLICY.unreferencedCheckpointRevisionMs)))
      if ((await this.deps.resources.deleteRevision(revision.id))) deletedRevisions++;
    let notices = 0;
    if (store.hosted) for (const organization of (await store.listOrganizations()))
      notices += (await this.enforceQuota(organization.id, now));
    return { expiredCheckpoints, deletedRevisions, notices };
  }

  /** The over-quota policy for one organization: record when it went over,
   * send each notice once, and at the deadline delete until it fits. */
  async enforceQuota(organizationId: string, now = Date.now()): Promise<number> {
    const { store } = this.deps;
    const usage = (await this.managedUsage(organizationId));
    let state = (await store.storageOverQuota(organizationId));
    if (!usage || usage.quotaBytes == null || usage.retainedBytes <= usage.quotaBytes) {
      if (!state) return 0;
      (await store.setStorageOverQuota(organizationId, undefined));
      await this.deps.notify?.({ organizationId, stage: 'resolved', retainedBytes: usage?.retainedBytes ?? 0,
        quotaBytes: usage?.quotaBytes ?? 0, overSince: state.since, deleteAt: state.since + STORAGE_POLICY.overQuotaDeletionMs });
      return 0;
    }
    state ??= { since: now, notices: [] };
    const deleteAt = state.since + STORAGE_POLICY.overQuotaDeletionMs;
    let stage: StorageNoticeStage | undefined;
    let { retainedBytes } = usage;
    if (now >= deleteAt) {
      retainedBytes = (await this.reduceToQuota(organizationId, usage.quotaBytes, now));
      stage = 'deleted';
    } else if (now >= deleteAt - STORAGE_POLICY.noticeLeadMs['7d']) stage = '7d';
    else if (now >= deleteAt - STORAGE_POLICY.noticeLeadMs['30d']) stage = '30d';
    else stage = 'over';
    const fresh = !state.notices.includes(stage);
    if (retainedBytes <= usage.quotaBytes) (await store.setStorageOverQuota(organizationId, undefined));
    else (await store.setStorageOverQuota(organizationId, { since: state.since, notices: fresh ? [...state.notices, stage] : state.notices }));
    if (!fresh) return 0;
    await this.deps.notify?.({ organizationId, stage, retainedBytes, quotaBytes: usage.quotaBytes, overSince: state.since, deleteAt });
    return 1;
  }

  /** Delete managed data, least valuable first, until the organization fits:
   * finished tasks' saved workspaces, older data versions, review artifacts,
   * then current data versions oldest first. Data an active task is using is
   * never deleted. Returns the retained bytes afterwards. */
  async reduceToQuota(organizationId: string, quotaBytes: number, now = Date.now(), limit = 200): Promise<number> {
    const { store, resources } = this.deps;
    const retained = async () => (await this.managedUsage(organizationId))?.retainedBytes ?? 0;
    if ((await store.expireFinishedWorldCheckpoints(now, { limit: 10_000, organizationId }))) await this.deps.checkpoints?.collectGarbage();
    let left = (await retained());
    if (left <= quotaBytes) return left;
    const managed = (await this.managedLocationId(organizationId));
    const contents = (await store.organizationStorageContents(organizationId));
    const inManaged = (locationId?: string) => !locationId || locationId === managed;
    const current = new Set(contents.attachments.map((attachment) => attachment.currentRevisionId).filter(Boolean));
    const older = contents.revisions.filter((revision) => inManaged(revision.storageLocationId) && !current.has(revision.id));
    const latest = contents.revisions.filter((revision) => inManaged(revision.storageLocationId) && current.has(revision.id));
    const steps: Array<() => Promise<unknown>> = [
      ...older.map((revision) => () => resources.deleteRevision(revision.id)),
      ...contents.artifacts.map((artifact) => () => this.deleteArtifact(artifact.id, artifact.objectKey)),
      ...latest.map((revision) => () => resources.deleteRevision(revision.id, { allowCurrent: true })),
    ];
    for (const step of steps.slice(0, limit)) {
      await step();
      left = (await retained());
      if (left <= quotaBytes) break;
    }
    return left;
  }

  /** What the organization stores, grouped by project, plus its quota state. */
  async contents(organizationId: string, now = Date.now()): Promise<StorageContentsView> {
    const { store } = this.deps;
    const usage = (await this.managedUsage(organizationId));
    const state = usage?.quotaBytes != null && usage.retainedBytes > usage.quotaBytes
      ? (await store.storageOverQuota(organizationId)) ?? { since: now, notices: [] } : undefined;
    const contents = (await store.organizationStorageContents(organizationId));
    const names = new Map<string, string>();
    for (const project of (await store.listProjects()).filter((project) => project.organizationId === organizationId))
      names.set(project.id, project.name);
    const projects = new Map<string, StorageContentsView['projects'][number]>();
    const project = (projectId: string) => {
      let entry = projects.get(projectId);
      if (!entry) projects.set(projectId, entry = { projectId, name: names.get(projectId) ?? projectId, bytes: 0, resources: [],
        artifacts: { count: 0, bytes: 0 }, checkpoints: { count: 0, bytes: 0, finishedCount: 0, finishedBytes: 0 } });
      return entry;
    };
    const byAttachment = new Map<string, typeof contents.revisions>();
    for (const revision of contents.revisions) byAttachment.set(revision.attachmentId, [...(byAttachment.get(revision.attachmentId) ?? []), revision]);
    for (const attachment of contents.attachments) {
      const revisions = byAttachment.get(attachment.id) ?? [];
      if (!revisions.length) continue;
      const currentBytes = revisions.find((revision) => revision.id === attachment.currentRevisionId)?.bytes ?? 0;
      const older = revisions.filter((revision) => revision.id !== attachment.currentRevisionId && !revision.checkpoint);
      const copies = revisions.filter((revision) => revision.id !== attachment.currentRevisionId && revision.checkpoint);
      const sum = (list: typeof revisions) => list.reduce((total, revision) => total + revision.bytes, 0);
      const entry = project(attachment.projectId);
      entry.resources.push({ id: attachment.id, name: attachment.name, currentBytes, olderVersions: older.length,
        olderBytes: sum(older), taskCopies: copies.length, taskCopyBytes: sum(copies) });
      entry.bytes += currentBytes + sum(older) + sum(copies);
    }
    for (const artifact of contents.artifacts) {
      const entry = project(artifact.projectId);
      entry.artifacts.count++; entry.artifacts.bytes += artifact.bytes; entry.bytes += artifact.bytes;
      if (artifact.expiresAt && (!entry.artifacts.nextExpiry || artifact.expiresAt < entry.artifacts.nextExpiry))
        entry.artifacts.nextExpiry = artifact.expiresAt;
    }
    for (const checkpoint of contents.checkpoints) {
      const entry = project(checkpoint.projectId);
      entry.checkpoints.count++; entry.checkpoints.bytes += checkpoint.bytes; entry.bytes += checkpoint.bytes;
      if (checkpoint.taskStatus === 'done' || checkpoint.taskStatus === 'cancelled') {
        entry.checkpoints.finishedCount++; entry.checkpoints.finishedBytes += checkpoint.bytes;
      }
    }
    return {
      retainedBytes: usage?.retainedBytes ?? 0,
      ...(usage?.quotaBytes != null ? { quotaBytes: usage.quotaBytes } : {}),
      ...(state ? { overQuota: { since: state.since, deleteAt: state.since + STORAGE_POLICY.overQuotaDeletionMs } } : {}),
      policy: { finishedTaskCheckpointDays: STORAGE_POLICY.finishedTaskCheckpointMs / DAY,
        overQuotaDeletionDays: STORAGE_POLICY.overQuotaDeletionMs / DAY },
      projects: [...projects.values()].sort((a, b) => b.bytes - a.bytes),
    };
  }

  /** Delete a data resource's older versions, keeping the current one and any
   * a task is still using. */
  async deleteOlderVersions(attachmentId: string): Promise<{ deleted: number; bytes: number }> {
    const attachment = (await this.deps.store.getResourceAttachment(attachmentId));
    if (!attachment) throw new Error('resource attachment not found');
    let deleted = 0; let bytes = 0;
    for (const revision of (await this.deps.store.listResourceRevisions(attachmentId))) {
      if (revision.id === attachment.currentRevisionId) continue;
      if ((await this.deps.resources.deleteRevision(revision.id))) { deleted++; bytes += revision.bytes; }
    }
    return { deleted, bytes };
  }

  /** Delete the saved workspaces of a project's done and cancelled tasks now,
   * instead of after the retention period. */
  async deleteFinishedWorkspaces(organizationId: string, projectId: string, now = Date.now()): Promise<{ queued: number }> {
    const project = (await this.deps.store.getProject(projectId));
    if (!project || project.organizationId !== organizationId) throw new Error('project not found');
    const queued = (await this.deps.store.expireFinishedWorldCheckpoints(now + 1, { limit: 10_000, organizationId, projectId }));
    if (queued) await this.deps.checkpoints?.collectGarbage();
    return { queued };
  }

  private async deleteArtifact(id: string, objectKey: string): Promise<void> {
    if (!(await this.deps.store.deletePromotedArtifact(id))) return;
    await this.deps.objects?.delete(objectKey).catch(() => undefined);
  }

  private async managedLocationId(organizationId: string): Promise<string | undefined> {
    return (await this.deps.store.listStorageLocations(organizationId)).find((location) => location.kind === 'managed')?.id;
  }

  private async managedUsage(organizationId: string) {
    const id = (await this.managedLocationId(organizationId));
    return id ? (await this.deps.store.storageLocationUsage(id)) : undefined;
  }
}
