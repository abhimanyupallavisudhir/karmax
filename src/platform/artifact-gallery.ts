import path from 'node:path';
import type { Store } from '../store/db.js';
import { ARTIFACT_MIME } from '../store/artifact-mime.js';
import { reviewTargetKey } from '../store/review-artifacts.js';
import { worldFilesPath, type ProjectFiles } from '../world/project-files.js';
import type { WorldHandle } from '../world/types.js';

/**
 * The artifact gallery (wiki features/project-files): every file a task's
 * Review ever attached that nothing has superseded, as a place in the
 * project's Files. A file is its path there, so a later attachment of the
 * same path, by this task or any other, replaces it. Unfinished tasks show
 * what they attach now; finished (done) ones what they left, and cancelled or
 * failed ones nothing. A finished task's file in a repository is shown as
 * the repository has it now (its latest version), and not at all once it
 * was deleted from there; a file that never reached a repository (an
 * ignored screenshot, a report outside every checkout) is shown as saved.
 */

export interface GalleryArtifact {
  projectId: string;
  /** Where it sits in the project's Files (its identity in the gallery). */
  path: string;
  name: string;
  /** The Review action's label. */
  label: string;
  taskId: string;
  num?: number;
  title: string;
  /** Whether the task that attached it is still underway, or done. */
  state: 'active' | 'done';
  /** Where its bytes come from: the task's Review action (`index`; its saved
   * copy, else its world), or the repository's current file at `path`. */
  source: 'review' | 'repository';
  index?: number;
  /** When it was attached. */
  at: number;
  bytes?: number;
  mediaType: string;
}

export interface GalleryDeps {
  store: Store;
  /** Repositories tasks start from; without it every finished file shows as saved. */
  files?: Pick<ProjectFiles, 'repositoryPresence'>;
}

const EXTERNAL = /^https?:\/\//i;

/** One project's gallery, newest first. `repository`: the caller may read the
 * project's repositories (else a finished file shows as its saved copy). */
export async function projectArtifactGallery(deps: GalleryDeps, projectId: string, options: { repository: boolean }): Promise<GalleryArtifact[]> {
  const { store } = deps;
  const tasks = await store.reviewAttachmentTasks(projectId);
  if (!tasks.length) return [];
  const { artifacts, indexes } = await store.reviewArtifactsOf(projectId, tasks.map((task) => task.id));
  const now = Date.now();
  const latest = new Map<string, GalleryArtifact & { saved: boolean }>();
  for (const task of tasks) {
    const status = task.status ?? 'active';
    if (status === 'cancelled' || status === 'failed' || task.stage === 'cancelled' || task.stage === 'failed') continue;
    const state = status === 'done' ? 'done' : 'active';
    const index = indexes.get(task.id) ?? {};
    let handle = task.world as WorldHandle | undefined;
    if (!handle?.root) handle = (await store.currentWorld(task.id)) as WorldHandle | undefined;
    task.actions.forEach((action, i) => {
      const target = typeof action?.target === 'string' ? action.target : '';
      if (action?.kind !== 'open' || !target || EXTERNAL.test(target)) return;
      let where: string;
      try { where = worldFilesPath(handle, target); } catch { return; }
      if (!where) return;
      const saved = artifacts.get(index[reviewTargetKey(target)] ?? '');
      const usable = saved && saved.taskId === task.id && (saved.expiresAt == null || saved.expiresAt > now) ? saved : undefined;
      const name = usable?.name ?? path.posix.basename(where);
      const at = usable?.createdAt ?? task.statusChangedAt ?? task.createdAt;
      const previous = latest.get(where);
      if (previous && previous.at >= at) return;
      latest.set(where, { projectId, path: where, name, label: String(action.label || name), taskId: task.id,
        ...(task.num != null ? { num: task.num } : {}), title: task.title, state, source: 'review', index: i, at,
        ...(usable ? { bytes: usable.bytes } : {}), mediaType: usable?.mediaType ?? mediaTypeOf(name), saved: !!usable });
    });
  }
  // A finished task's file: the repository's latest, unless deleted there; else its saved copy.
  const finished = [...latest.values()].filter((item) => item.state === 'done');
  const presence = finished.length && deps.files
    ? await deps.files.repositoryPresence(projectId, finished.map((item) => item.path)).catch(() => new Map())
    : new Map();
  const out: GalleryArtifact[] = [];
  for (const { saved, ...item } of latest.values()) {
    if (item.state === 'done') {
      const there = presence.get(item.path);
      if (there?.state === 'deleted') continue;
      if (there?.state === 'present' && options.repository) {
        const { index: _index, ...rest } = item;
        out.push({ ...rest, source: 'repository', ...(there.size !== undefined ? { bytes: there.size } : {}) });
        continue;
      }
      // Its world is gone: only a saved copy can still be opened.
      if (!saved) continue;
    }
    out.push(item);
  }
  return out.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
}

function mediaTypeOf(name: string): string {
  return ARTIFACT_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}
