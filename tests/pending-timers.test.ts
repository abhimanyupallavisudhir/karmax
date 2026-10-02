import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionOutput } from '../src/gateway/execution-output.js';
import { pendingTimers } from './helpers/pending-timers.js';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

describe('pending timers of the code under test', () => {
  it("ignores another file's leftover timers and counts the code's own until they fire or are cleared", async () => {
    vi.useFakeTimers();
    try {
      const pending = pendingTimers(/src[\\/]gateway[\\/]execution-output/);
      setTimeout(() => {}, 60_000); // what made master CI #1416 count 1
      const persist = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
      const fired = new ExecutionOutput(persist, () => {});
      fired.append('retried');
      await vi.advanceTimersByTimeAsync(1);
      expect(pending()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(persist).toHaveBeenCalledTimes(2);
      expect(pending()).toBe(0);

      const cleared = new ExecutionOutput(vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined), () => {});
      cleared.append('closed');
      await vi.advanceTimersByTimeAsync(1);
      expect(pending()).toBe(1);
      await cleared.close();
      expect(pending()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('leaves the real timers in place after a test', () => {
    expect(globalThis.setTimeout).toBe(realSetTimeout);
    expect(globalThis.clearTimeout).toBe(realClearTimeout);
  });

  // Every file shares one process, so the fake clock's global count includes
  // timers other files' background work creates: it flaked master CI three times.
  it("replaces the fake clock's global timer count in every test", () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') scan(file);
          continue;
        }
        if (!/\.[cm]?[jt]s$/.test(entry.name)) continue;
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (!/^\s*(\/\/|\/?\*)/.test(line) && /\bvi\.getTimerCount\(/.test(line))
            offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}`);
        });
      }
    };
    scan(path.resolve('tests'));
    expect(offenders).toEqual([]);
  });
});
