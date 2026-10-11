import * as __asyncCollections from '../util/async-collections.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReviewInfo } from '../domain/types.js';
import { worldWorkingRelativePath, type World } from '../world/types.js';
import { readWorldFilePrefix } from '../world/file-prefix.js';
import type { Store } from './db.js';
import type { ObjectStore } from './objects.js';
import { ARTIFACT_MIME } from './artifact-mime.js';

export const MAX_REVIEW_ARTIFACT_BYTES = 100 * 1024 * 1024;
const indexKey = (taskId: string) => `review-artifacts:${taskId}`;
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');

export async function savedReviewArtifact(store: Store, taskId: string, target: string) {
  const index = JSON.parse((await store.kvGet(indexKey(taskId))) ?? '{}') as Record<string, string>;
  const artifact = index[hash(target)] ? (await store.getPromotedArtifact(index[hash(target)]!)) : undefined;
  return artifact?.taskId === taskId && (artifact.expiresAt == null || artifact.expiresAt > Date.now())
    ? artifact : undefined;
}

export async function unsavedReviewArtifacts(store: Store, taskId: string, info: ReviewInfo | undefined): Promise<boolean> {
  return (await __asyncCollections.some((info?.actions ?? []), async (action) => action.kind === 'open' && action.target
    && !/^https?:\/\//i.test(action.target) && !(await savedReviewArtifact(store, taskId, action.target))));
}

/** Snapshot the published file bytes without rewriting agent-authored targets.
 * The index keeps existing task-scoped links valid after the world is released.
 * Retry identities include content, so repeated publication doesn't bill twice. */
export async function preserveReviewArtifacts(store: Store, objects: ObjectStore, world: World,
  taskId: string, info: ReviewInfo | undefined, onlyMissing = false): Promise<void> {
  const targets = [...new Set((info?.actions ?? []).filter((a) => a.kind === 'open')
    .map((a) => String(a.target ?? '')).filter((target) => target && !/^https?:\/\//i.test(target)))];
  if (!targets.length) return;
  const task = (await store.getTask(taskId));
  const project = task && (await store.getProject(task.projectId));
  if (!project?.organizationId) throw new Error('review artifact task has no organization');
  const organizationId = project.organizationId;
  const index: Record<string, string> = {};
  for (const target of targets) {
    if (onlyMissing && (await savedReviewArtifact(store, taskId, target))) continue;
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
    // A remote world has no host path to stat: one byte past the cap tells a
    // larger artifact apart without loading it whole.
    const data = await readWorldFilePrefix(world, relative, MAX_REVIEW_ARTIFACT_BYTES + 1);
    if (data.length > MAX_REVIEW_ARTIFACT_BYTES) throw new Error('artifact exceeds 100 MiB');
    const sha256 = hash(data);
    const id = `review-${hash(`${taskId}\0${target}\0${sha256}`)}`;
    if (!(await store.getPromotedArtifact(id))) {
      // Retries share the logical artifact identity, but never the upload key:
      // cleanup of one failed attempt must not erase another attempt's object.
      const uploadId = `artifact:${crypto.randomUUID()}`;
      const objectKey = `artifacts/${project.organizationId}/${project.id}/${taskId}/${id}/${uploadId.slice(9)}`;
      const name = path.posix.basename(normalized);
      const mediaType = ARTIFACT_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
      const managed = (await store.listStorageLocations(project.organizationId)).find((location) => location.kind === 'managed');
      if (managed) (await store.reserveStorageUpload(uploadId, project.organizationId, managed.id,
        data.length, Date.now() + 60 * 60_000));
      try {
        await objects.put(objectKey, data, mediaType);
        await store.transaction(async () => {
          // The task's row: its deletion, and another publish of this artifact, wait.
          await store.lockTask(taskId);
          if (!(await store.getTask(taskId))) throw new Error('review artifact task was deleted during upload');
          if (!(await store.getPromotedArtifact(id))) {
            (await store.savePromotedArtifact({ id, organizationId, projectId: project.id,
              taskId, objectKey, sha256, bytes: data.length, mediaType, name, createdAt: Date.now() }));
            (await store.recordUsage({ id: `usage:artifact:${id}`, organizationId,
              projectId: project.id, taskId, worldId: world.handle.id, provider: 'managed-object-store',
              kind: 'resource.storage', quantity: data.length, unit: 'byte', costMicros: 0, fundingSource: 'managed',
              startedAt: Date.now(), endedAt: Date.now(), metadata: { artifactId: id, mediaType } }));
          }
        });
      } finally {
        if ((await store.getPromotedArtifact(id))?.objectKey !== objectKey)
          await objects.delete(objectKey).catch(() => {});
        if (managed) (await store.releaseStorageUpload(uploadId));
      }
    }
    index[hash(target)] = id;
  }
  // Publish pointers only after every attachment is durable.
  await store.transaction(async () => {
    await store.lock(`kv:${indexKey(taskId)}`);
    await store.kvSet(indexKey(taskId), JSON.stringify({
      ...JSON.parse((await store.kvGet(indexKey(taskId))) ?? '{}'), ...index,
    }));
  });
}
