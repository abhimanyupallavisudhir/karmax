import type { World, WorldHandle, WorldRepo } from './types.js';
import { worldRelativePath, worldRepos } from './types.js';
import type { ResolvedObjectMount } from '../store/project-objects.js';

/**
 * Materialize declared data-object mounts into a live world (PLAN-state §3.2).
 * Every mode starts as a plain write of the current version; `readonly` is
 * additionally chmod 444 so accidental writes fail loudly. No git exclusion:
 * mount paths are normally already gitignored by the repo, and where they are
 * not, an agent's ordinary commit/merge judgment applies. Returns the manifest
 * recorded on the handle — path/object/mode, so the checkpoint can capture
 * task-local changes (sha drift) even for gitignored paths.
 */
export async function materializeObjectMounts(world: World, mounts: ResolvedObjectMount[]): Promise<Array<{ path: string; object: string; mode: ResolvedObjectMount['mode'] }>> {
  const manifest: Array<{ path: string; object: string; mode: ResolvedObjectMount['mode'] }> = [];
  for (const mount of mounts) {
    const rel = worldRelativePath(mount.path);
    if (world.writeFileBuffer) await world.writeFileBuffer(rel, mount.data);
    else await world.writeFile(rel, mount.data.toString('utf8'));
    if (mount.mode === 'readonly') await world.exec('chmod', ['444', rel]).catch(() => undefined);
    manifest.push({ path: rel, object: mount.object, mode: mount.mode });
  }
  return manifest;
}

/** The object-mount manifest a handle carries (paths + version shas, no data). */
export function objectMountManifest(meta: Record<string, unknown> | undefined): Array<{ path: string; object: string; mode: ResolvedObjectMount['mode'] }> {
  const raw = meta?.objectMounts;
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is { path: string; object: string; mode: ResolvedObjectMount['mode'] } =>
    Boolean(m && typeof m === 'object' && typeof (m as any).path === 'string' && typeof (m as any).object === 'string'));
}

/** The repo whose checkout contains a world-relative path (single-repo worlds:
 * the only repo; multi-repo: matched by subdirectory prefix), plus the path
 * relative to that repo — the mapping the checkpoint delta format needs. */
export function enclosingRepo(handle: WorldHandle, rel: string): { repo: WorldRepo; inRepo: string } | undefined {
  const repos = worldRepos(handle);
  if (repos.length <= 1) return repos[0] ? { repo: repos[0], inRepo: rel } : undefined;
  const repo = repos.find((r) => rel === r.name || rel.startsWith(`${r.name}/`));
  return repo ? { repo, inRepo: rel.startsWith(`${repo.name}/`) ? rel.slice(repo.name.length + 1) : rel } : undefined;
}
