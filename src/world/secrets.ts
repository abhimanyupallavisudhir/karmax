// The worktree-scoped exclusion lives in secret-exclude.ts (one canonical
// implementation); re-exported here for legacy import paths.
export { ensureWorldExcluded } from './secret-exclude.js';

/** The manifest of secret-materialized paths a LEGACY handle carries (never
 * values). New worlds inject secrets as resource attachments; this reader
 * keeps checkpoints of pre-resource worlds excluding their secret files. */
export function secretFileManifest(meta: Record<string, unknown> | undefined): Set<string> {
  const raw = meta?.secretFiles;
  return new Set(Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []);
}
