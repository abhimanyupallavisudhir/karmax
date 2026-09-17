import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReviewInfo } from '../domain/types.js';
import { worldWorkingRelativePath, type World } from '../world/types.js';
import type { Store } from './db.js';
import type { ObjectStore } from './objects.js';
import { ARTIFACT_MIME } from './artifact-mime.js';

export const MAX_REVIEW_ARTIFACT_BYTES = 100 * 1024 * 1024;
const indexKey = (taskId: string) => `review-artifacts:${taskId}`;
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');

export function savedReviewArtifact(store: Store, taskId: string, target: string) {
  const index = JSON.parse(store.kvGet(indexKey(taskId)) ?? '{}') as Record<string, string>;
  const artifact = index[hash(target)] ? store.getPromotedArtifact(index[hash(target)]!) : undefined;
  return artifact?.taskId === taskId && (artifact.expiresAt == null || artifact.expiresAt > Date.now())
    ? artifact : undefined;
}

export function unsavedReviewArtifacts(store: Store, taskId: string, info: ReviewInfo | undefined): boolean {
  return (info?.actions ?? []).some((action) => action.kind === 'open' && action.target
    && !/^https?:\/\//i.test(action.target) && !savedReviewArtifact(store, taskId, action.target));
}

/** Snapshot the published file bytes without rewriting agent-authored targets.
 * The index keeps existing task-scoped links valid after the world is released.
 * Retry identities include content, so repeated publication doesn't bill twice. */
export async function preserveReviewArtifacts(store: Store, objects: ObjectStore, world: World,
  taskId: string, info: ReviewInfo | undefined, onlyMissing = false): Promise<void> {
  const targets = [...new Set((info?.actions ?? []).filter((a) => a.kind === 'open')
    .map((a) => String(a.target ?? '')).filter((target) => target && !/^https?:\/\//i.test(target)))];
  if (!targets.length) return;
  const task = store.getTask(taskId);
  const project = task && store.getProject(task.projectId);
  if (!project?.organizationId) throw new Error('review artifact task has no organization');
  const index: Record<string, string> = {};
  for (const target of targets) {
    if (onlyMissing && savedReviewArtifact(store, taskId, target)) continue;
    const root = world.handle.root.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalized = target.replace(/\\/g, '/');
    let relative: string;
    if (normalized.startsWith('/')) {
      if (!normalized.startsWith(`${root}/`)) throw new Error('artifact path escapes world');
      relative = normalized.slice(root.length + 1);
      // Enforce traversal checks on absolute targets too.
      relative = worldWorkingRelativePath({ ...world.handle, workdir: root }, relative);
    } else relative = worldWorkingRelativePath(world.handle, normalized);
    const hostPath = path.resolve(root, relative);
    if (fs.existsSync(hostPath)) {
      const realRoot = await fs.promises.realpath(root);
      const real = await fs.promises.realpath(hostPath);
      if (!real.startsWith(realRoot + path.sep)) throw new Error('artifact path escapes world');
      const stat = await fs.promises.stat(real);
      if (!stat.isFile()) throw new Error('review artifact must be a file');
      if (stat.size > MAX_REVIEW_ARTIFACT_BYTES) throw new Error('artifact exceeds 100 MiB');
    }
    const data = await world.readFileBuffer(relative);
    if (data.length > MAX_REVIEW_ARTIFACT_BYTES) throw new Error('artifact exceeds 100 MiB');
    const sha256 = hash(data);
    const id = `review-${hash(`${taskId}\0${target}\0${sha256}`)}`;
    if (!store.getPromotedArtifact(id)) {
      // Retries share the logical artifact identity, but never the upload key:
      // cleanup of one failed attempt must not erase another attempt's object.
      const uploadId = `artifact:${crypto.randomUUID()}`;
      const objectKey = `artifacts/${project.organizationId}/${project.id}/${taskId}/${id}/${uploadId.slice(9)}`;
      const name = path.posix.basename(normalized);
      const mediaType = ARTIFACT_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
      const managed = store.listStorageLocations(project.organizationId).find((location) => location.kind === 'managed');
      if (managed) store.reserveStorageUpload(uploadId, project.organizationId, managed.id,
        data.length, Date.now() + 60 * 60_000);
      try {
        await objects.put(objectKey, data, mediaType);
        store.db.exec('BEGIN IMMEDIATE');
        try {
          if (!store.getTask(taskId)) throw new Error('review artifact task was deleted during upload');
          if (!store.getPromotedArtifact(id)) {
            store.savePromotedArtifact({ id, organizationId: project.organizationId, projectId: project.id,
              taskId, objectKey, sha256, bytes: data.length, mediaType, name, createdAt: Date.now() });
            store.recordUsage({ id: `usage:artifact:${id}`, organizationId: project.organizationId,
              projectId: project.id, taskId, worldId: world.handle.id, provider: 'managed-object-store',
              kind: 'resource.storage', quantity: data.length, unit: 'byte', costMicros: 0, fundingSource: 'managed',
              startedAt: Date.now(), endedAt: Date.now(), metadata: { artifactId: id, mediaType } });
          }
          store.db.exec('COMMIT');
        } catch (error) { store.db.exec('ROLLBACK'); throw error; }
      } finally {
        if (store.getPromotedArtifact(id)?.objectKey !== objectKey)
          await objects.delete(objectKey).catch(() => {});
        if (managed) store.releaseStorageUpload(uploadId);
      }
    }
    index[hash(target)] = id;
  }
  // Publish pointers only after every attachment is durable.
  store.kvSet(indexKey(taskId), JSON.stringify({
    ...JSON.parse(store.kvGet(indexKey(taskId)) ?? '{}'), ...index,
  }));
}
