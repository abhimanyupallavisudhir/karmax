import type { Store } from '../store/db.js';
import type { WorldHandleRef } from '../domain/types.js';

/**
 * A world whose newest state no checkpoint holds: its last park checkpoint
 * failed (a size cap, a sandbox error) and the world parked anyway. Hibernation
 * must not destroy it against an older checkpoint, which would silently drop
 * everything since (audit R-6). Kept per generation: a restored world starts
 * clean, and any later successful checkpoint clears it.
 */
const key = (worldId: string) => `world-checkpoint-stale:${worldId}`;

export async function markCheckpointStale(store: Store, handle: WorldHandleRef, reason: string): Promise<void> {
  await store.kvSet(key(handle.id), JSON.stringify({ generation: handle.generation ?? 1, reason, at: Date.now() }));
}

export async function clearCheckpointStale(store: Store, worldId: string): Promise<void> {
  await store.kvDelete(key(worldId));
}

export async function checkpointStale(store: Store, handle: WorldHandleRef): Promise<boolean> {
  const raw = await store.kvGet(key(handle.id));
  if (!raw) return false;
  try { return JSON.parse(raw).generation === (handle.generation ?? 1); } catch { return true; }
}
