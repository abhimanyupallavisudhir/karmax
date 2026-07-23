import crypto from 'node:crypto';
import { ProjectObjectMount } from '../domain/types.js';
import type { ObjectStore } from './objects.js';
import { worldRelativePath } from '../world/types.js';

/**
 * Project data objects (PLAN-state.md §3.2): the fixtures / dev databases /
 * model weights that are too big or too binary for git. Content-addressed —
 * blobs live in the ObjectStore (a directory locally, S3 hosted) keyed by
 * sha256; the registry of declared placements (mounts) lives in the store's kv
 * table per project. A mount's history is its version chain, so promoting a
 * task's modified copy is auditable and reversible.
 */

const KV_PREFIX = 'project-objects:';
const HISTORY_LIMIT = 20;

export function projectObjectKey(projectId: string, sha: string): string {
  return `objects/${projectId}/${sha}`;
}

export interface ProjectObjectsStore {
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
}

/** A mount with its current blob loaded, ready to materialize into a world. */
export interface ResolvedObjectMount {
  path: string;
  mode: ProjectObjectMount['mode'];
  object: string;
  data: Buffer;
}

export class ProjectObjects {
  constructor(
    private store: ProjectObjectsStore,
    private objects: ObjectStore,
  ) {}

  list(projectId: string): ProjectObjectMount[] {
    const raw = this.store.kvGet(KV_PREFIX + projectId);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as ProjectObjectMount[];
    } catch {
      return [];
    }
  }

  get(projectId: string, path: string): ProjectObjectMount | undefined {
    return this.list(projectId).find((m) => m.path === path);
  }

  /** Create or replace a mount with new content. Replacement pushes the prior
   * version onto the history chain (blobs are content-addressed and kept). */
  async put(projectId: string, args: { path: string; mode?: ProjectObjectMount['mode']; data: Buffer }): Promise<ProjectObjectMount> {
    const path = worldRelativePath(args.path);
    if (path === '.') throw new Error('object path must name a file');
    const sha = sha256(args.data);
    await this.objects.put(projectObjectKey(projectId, sha), args.data);
    const prior = this.get(projectId, path);
    const mount: ProjectObjectMount = {
      path,
      object: sha,
      mode: args.mode ?? prior?.mode ?? 'seed',
      bytes: args.data.length,
      updatedAt: Date.now(),
      ...(prior && prior.object !== sha
        ? { history: [{ object: prior.object, bytes: prior.bytes, replacedAt: Date.now() }, ...(prior.history ?? [])].slice(0, HISTORY_LIMIT) }
        : prior?.history ? { history: prior.history } : {}),
    };
    this.save(projectId, [...this.list(projectId).filter((m) => m.path !== path), mount]);
    return mount;
  }

  /** Promote a task world's modified copy to the mount's new current version
   * (PLAN-state §3.2) — the data analogue of merging a branch. Only declared,
   * non-readonly mounts are promotable. */
  async promote(projectId: string, path: string, data: Buffer): Promise<ProjectObjectMount> {
    const mount = this.get(projectId, worldRelativePath(path));
    if (!mount) throw new Error(`no declared object mount at ${path}`);
    if (mount.mode === 'readonly') throw new Error(`object at ${path} is readonly — not promotable`);
    return this.put(projectId, { path: mount.path, mode: mount.mode, data });
  }

  remove(projectId: string, path: string) {
    this.save(projectId, this.list(projectId).filter((m) => m.path !== path));
    // Blobs stay: they are content-addressed and may back history entries.
  }

  async data(projectId: string, sha: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('object id must be a sha256');
    return this.objects.get(projectObjectKey(projectId, sha));
  }

  /** Every mount with its current blob loaded — the world-creation input. */
  async resolved(projectId: string): Promise<ResolvedObjectMount[]> {
    const out: ResolvedObjectMount[] = [];
    for (const mount of this.list(projectId)) {
      out.push({ path: mount.path, mode: mount.mode, object: mount.object,
        data: await this.objects.get(projectObjectKey(projectId, mount.object)) });
    }
    return out;
  }

  private save(projectId: string, mounts: ProjectObjectMount[]) {
    this.store.kvSet(KV_PREFIX + projectId, JSON.stringify(mounts));
  }
}

export function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
