import { IllegalStateError } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import { installRuntime } from '../src/temporal/worker.js';

/**
 * One Temporal Runtime per process. When a test file's dev server dies mid-shard,
 * the Runtime that suite created stays behind, and every later file in the same
 * vitest worker used to fail with "Runtime singleton has already been
 * instantiated" (wiki ops/ci "Temporal dev server gone mid-shard"): a cascade that
 * hid the one real failure. A Runtime that already exists is used as it is.
 */
describe('installing the Temporal Runtime', () => {
  it('installs the quiet logger once', () => {
    let calls = 0;
    expect(installRuntime(() => { calls++; })).toBe('installed');
    expect(calls).toBe(1);
  });

  it('keeps a Runtime that already exists in the process', () => {
    expect(installRuntime(() => { throw new IllegalStateError('Runtime singleton has already been instantiated'); })).toBe('existing');
  });

  it('still fails on anything else', () => {
    expect(() => installRuntime(() => { throw new Error('bad logger'); })).toThrow('bad logger');
  });
});
