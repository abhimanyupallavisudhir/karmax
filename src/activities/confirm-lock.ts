// A confirmer belongs to a logical task, so sibling attempts must not review in
// parallel against divergent copies of its conversation. The worker is the
// single activity host in v1; this keyed FIFO serializes those turns while each
// Temporal activity remains independently retryable.
const confirmLocks = new Map<string, { held: boolean; waiters: Array<() => void> }>();
export async function acquireConfirmLock(key: string, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  let lock = confirmLocks.get(key);
  if (!lock) {
    lock = { held: false, waiters: [] };
    confirmLocks.set(key, lock);
  }
  if (lock.held) await new Promise<void>((resolve, reject) => {
    const ready = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => {
      const index = lock!.waiters.indexOf(ready);
      if (index >= 0) lock!.waiters.splice(index, 1);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('confirm turn cancelled'));
    };
    lock!.waiters.push(ready);
    signal?.addEventListener('abort', abort, { once: true });
  });
  else lock.held = true;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = lock!.waiters.shift();
    if (next) next();
    else {
      lock!.held = false;
      confirmLocks.delete(key);
    }
  };
  // Cancellation may arrive after the previous holder hands us the lock but
  // before this continuation runs. Do not strand the next waiter in that race.
  if (signal?.aborted) { release(); signal.throwIfAborted(); }
  return release;
}

