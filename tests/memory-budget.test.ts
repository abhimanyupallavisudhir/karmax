import { describe, expect, it } from 'vitest';
import { containerMemoryLimit, memoryBudget } from '../src/runtime/memory-budget.js';

const MiB = 1024 * 1024;

describe('memory budget (RT-35)', () => {
  it('splits the container limit between the gateway heap, two worker heaps and native memory', () => {
    const budget = memoryBudget({ limitBytes: 4096 * MiB, separateWorker: true });
    expect(budget).toMatchObject({ limitMb: 4096, workerHeapMb: 1228, gatewayHeapMb: 614 });
    // The worker's flag sizes both its isolates (main and workflow thread); all
    // three heaps at their limits still leave a quarter for native memory.
    expect(2 * budget.workerHeapMb + budget.gatewayHeapMb).toBeLessThanOrEqual(4096 * 0.75);
  });

  it('gives one combined process two equal isolates', () => {
    const budget = memoryBudget({ limitBytes: 4096 * MiB, separateWorker: false });
    expect(budget).toMatchObject({ gatewayHeapMb: 1536, workerHeapMb: 1536 });
    expect(2 * budget.gatewayHeapMb).toBeLessThanOrEqual(4096 * 0.75);
  });

  it('never goes below a floor that Node can start with, and honors an explicit limit', () => {
    expect(memoryBudget({ limitBytes: 256 * MiB, separateWorker: true })).toMatchObject({ workerHeapMb: 192, gatewayHeapMb: 128 });
    expect(memoryBudget({ limitBytes: 64 * 1024 * MiB, separateWorker: true, env: { KARMAX_MEMORY_LIMIT_MB: '2048' } }))
      .toMatchObject({ limitMb: 2048, workerHeapMb: 614, gatewayHeapMb: 307 });
    expect(() => memoryBudget({ limitBytes: 1, separateWorker: true, env: { KARMAX_MEMORY_LIMIT_MB: 'lots' } }))
      .toThrow('KARMAX_MEMORY_LIMIT_MB');
  });

  it('reads the cgroup v2 limit, then v1, then the host memory', () => {
    const files = (entries: Record<string, string>) => (file: string) => {
      if (!(file in entries)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return entries[file]!;
    };
    expect(containerMemoryLimit(files({ '/sys/fs/cgroup/memory.max': '4294967296\n' }), 8 * 1024 * MiB)).toBe(4096 * MiB);
    // "max" means unlimited; v1 reports unlimited as a huge number.
    expect(containerMemoryLimit(files({ '/sys/fs/cgroup/memory.max': 'max\n' }), 8 * 1024 * MiB)).toBe(8 * 1024 * MiB);
    expect(containerMemoryLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '2147483648' }), 8 * 1024 * MiB)).toBe(2048 * MiB);
    expect(containerMemoryLimit(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }), 8 * 1024 * MiB)).toBe(8 * 1024 * MiB);
    expect(containerMemoryLimit(files({}), 3 * 1024 * MiB)).toBe(3 * 1024 * MiB);
  });
});
