import { FileAccessError, FileNotFoundError, type PlaceRevision } from './project-files.js';

/**
 * The server's half of the apps' offline files (wiki features/offline-files).
 * A device keeps its pins to itself; it asks, in one call, which of them
 * changed since the revision it holds. Only a changed folder then reads its
 * manifest, and only changed files download.
 */

/** Pins checked in one call. A device with more checks in several. */
export const OFFLINE_CHECK_MAX = 2_000;
/** Places read at once while checking. */
const CHECKS_AT_ONCE = 4;

export interface OfflinePin { projectId: string; path: string; branch?: string; revision: string }

/** `current`: nothing under it changed. `changed`: it did (its new revision,
 * and a file's size). `missing`: nothing is there any more (deleted, renamed,
 * or the project is gone): the device keeps its copy, marked. `forbidden`: the
 * person may no longer read it: the device removes its copy. `error`: it could
 * not be read now: try later (the copy stays, out of date). */
export type OfflineCheck =
  | { status: 'current' }
  | { status: 'changed'; kind: 'file' | 'directory'; revision: string; size?: number }
  | { status: 'missing' }
  | { status: 'forbidden' }
  | { status: 'error'; error: string };

export interface OfflineCheckDeps {
  /** What the caller may read of a project (none: no such project). */
  access(projectId: string): Promise<{ read: boolean; data: boolean } | undefined>;
  revision(pin: OfflinePin, data: boolean): Promise<PlaceRevision>;
}

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\\0]{1,250}$/;

/** A pin as the request names it, or why not. */
function readPin(raw: unknown): OfflinePin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const pin = raw as Record<string, unknown>;
  if (typeof pin.projectId !== 'string' || !pin.projectId || typeof pin.path !== 'string' || typeof pin.revision !== 'string') return undefined;
  if (pin.branch !== undefined && pin.branch !== null && pin.branch !== '' && (typeof pin.branch !== 'string' || !BRANCH.test(pin.branch))) return undefined;
  return { projectId: pin.projectId, path: pin.path, revision: pin.revision, ...(typeof pin.branch === 'string' && pin.branch ? { branch: pin.branch } : {}) };
}

/** Each pin's answer, in the order given. */
export async function checkOfflinePins(pins: unknown[], deps: OfflineCheckDeps): Promise<OfflineCheck[]> {
  const results: OfflineCheck[] = Array.from({ length: pins.length });
  let next = 0;
  const one = async (raw: unknown): Promise<OfflineCheck> => {
    const pin = readPin(raw);
    if (!pin) return { status: 'error', error: 'Not a pin: {projectId, path, revision, branch?}.' };
    const access = await deps.access(pin.projectId);
    if (!access) return { status: 'missing' };
    if (!access.read) return { status: 'forbidden' };
    try {
      const now = await deps.revision(pin, access.data);
      if (now.revision === pin.revision) return { status: 'current' };
      return { status: 'changed', kind: now.kind, revision: now.revision, ...(now.kind === 'file' ? { size: now.size ?? 0 } : {}) };
    } catch (error) {
      if (error instanceof FileNotFoundError) return { status: 'missing' };
      // Data refused for want of the right to read it; any other refusal (a version still being converted) passes.
      if (error instanceof FileAccessError && !access.data) return { status: 'forbidden' };
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECKS_AT_ONCE, pins.length) }, async () => {
    while (next < pins.length) { const at = next++; results[at] = await one(pins[at]); }
  }));
  return results;
}
