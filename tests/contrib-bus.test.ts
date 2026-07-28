import { describe, it, expect, vi } from 'vitest';
import { KarmaxBus } from '../src/contrib/bus.js';
import { resolveRequires } from '../src/contrib/manifests.js';
import type { KarmaxEvent } from '../src/domain/types.js';

describe('KarmaxBus dispatch isolation', () => {
  const event = (taskId = 't1'): KarmaxEvent =>
    ({ type: 'view.updated', taskId, ts: 0, payload: { status: 'done' } } as KarmaxEvent);

  it('keeps one throwing subscriber from skipping the rest or failing the emitter', () => {
    const bus = new KarmaxBus();
    const seen: string[] = [];
    bus.onAny(() => seen.push('first'));
    bus.onAny(() => { throw new Error('subscriber is broken'); });
    bus.onAny(() => seen.push('third'));
    bus.onTask('t1', () => { throw new Error('task subscriber is broken'); });
    bus.onTask('t1', () => seen.push('task'));

    const consoleError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      // EventEmitter.emit runs listeners inline: the throw used to abort the whole
      // dispatch and propagate back into the *activity* that emitted the event.
      expect(() => bus.emit(event())).not.toThrow();
    } finally {
      console.error = consoleError;
    }
    expect(seen).toEqual(['first', 'third', 'task']);
    expect(logged.length).toBe(2); // both failures reported, neither swallowed
  });

  it('still routes to the right channels and honours unsubscribe', () => {
    const bus = new KarmaxBus();
    const any = vi.fn();
    const mine = vi.fn();
    const theirs = vi.fn();
    const off = bus.onAny(any);
    bus.onTask('t1', mine);
    bus.onTask('t2', theirs);
    bus.emit(event('t1'));
    expect(any).toHaveBeenCalledTimes(1);
    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
    off();
    bus.emit(event('t1'));
    expect(any).toHaveBeenCalledTimes(1);
    expect(mine).toHaveBeenCalledTimes(2);
  });
});

describe('resolveRequires', () => {
  it('terminates on a circular requires graph', () => {
    // `visit` marks a name seen BEFORE recursing into its requires, so a cycle
    // among installed manifests cannot spin. Pinned so a refactor cannot quietly
    // move the `seen.add` after the recursion and hang the worker at boot.
    const names = resolveRequires(['software-dev', 'just-do']);
    expect(names).toEqual(expect.arrayContaining(['software-dev', 'just-do']));
    expect(new Set(names).size).toBe(names.length); // no duplicates
    expect(resolveRequires(['does-not-exist'])).toEqual(['does-not-exist']);
  });
});
