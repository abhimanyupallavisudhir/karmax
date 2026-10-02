import { onTestFinished } from 'vitest';

/** Counts the timers that code matching `source` (a stack frame pattern such as
 *  /src[\\/]agent[\\/]/) has set and not yet cleared or fired. Call it after
 *  vi.useFakeTimers(). Not vi.getTimerCount(): every file runs in one process, so
 *  that also counts timers other files' leftover background work creates while
 *  fakes are installed, and it flaked master CI #1300, #1385 and #1416 (ops/ci
 *  "Counting fake timers"). The wrappers are removed when the test finishes,
 *  whether or not it already called vi.useRealTimers(). */
export function pendingTimers(source: RegExp): () => number {
  const pending = new Set<unknown>();
  const ours = () => source.test(new Error().stack ?? '');
  const track = <K extends 'setTimeout' | 'setInterval'>(name: K, once: boolean) => {
    const original = globalThis[name] as (...args: any[]) => unknown;
    const wrapped = (fn: (...args: any[]) => unknown, ...rest: unknown[]) => {
      if (!ours()) return original(fn, ...rest);
      const handle = original(once ? (...args: unknown[]) => { pending.delete(handle); return fn(...args); } : fn, ...rest);
      pending.add(handle);
      return handle;
    };
    return replace(name, wrapped);
  };
  const untrack = (name: 'clearTimeout' | 'clearInterval') => {
    const original = globalThis[name] as (handle: unknown) => void;
    return replace(name, (handle: unknown) => { pending.delete(handle); original(handle); });
  };
  const restores = [track('setTimeout', true), track('setInterval', false), untrack('clearTimeout'), untrack('clearInterval')];
  onTestFinished(() => { for (const restore of restores) restore(); });
  return () => pending.size;
}

function replace(name: 'setTimeout' | 'setInterval' | 'clearTimeout' | 'clearInterval', wrapped: unknown) {
  const original = globalThis[name];
  // Carry the original's properties, as @sinonjs/fake-timers does when it wraps a
  // global: its uninstall puts the real timer back only if the installed function
  // has its `hadOwnProperty` marker, and deletes the global otherwise.
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
  Reflect.set(globalThis, name, wrapped);
  // vi.useRealTimers() may already have put the real function back.
  return () => { if (globalThis[name] === wrapped) Reflect.set(globalThis, name, original); };
}
