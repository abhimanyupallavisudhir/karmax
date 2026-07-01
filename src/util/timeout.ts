/**
 * Reject if `p` doesn't settle within `ms`. Used to bound live Temporal queries
 * so a single wedged workflow (e.g. stuck in a workflow-task-failure loop after a
 * code change) can't hang a whole HTTP endpoint. Callers catch and fall back.
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operation timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
