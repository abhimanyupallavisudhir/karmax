import { describe, expect, it } from 'vitest';
import { boundedExec } from '../src/world/bounded-exec.js';
import { platformToolHandlers } from '../src/agent/tools.js';

function fixture(chunks: string[], code = 0) {
  let output = (_: string) => {};
  let exit = (_: number) => {};
  let closed = false;
  const world = {
    async openPty() {
      return {
        onData(cb: typeof output) { output = cb; return () => {}; },
        onExit(cb: typeof exit) { exit = cb; return () => {}; },
        async write(command: string) {
          const marker = command.match(/KARMAX_EXEC_[a-f0-9]+/)![0];
          output(command + '\r\n'); // terminal echo must not become output
          output('\n' + marker.slice(0, 8));
          output(marker.slice(8) + '\r\n');
          for (const chunk of chunks) output(chunk);
          exit(code);
        },
        async close() { closed = true; },
      };
    },
  };
  return { world: world as any, closed: () => closed };
}

describe('bounded world command capture', () => {
  it('keeps only a bounded tail while preserving exit status', async () => {
    const f = fixture(['x'.repeat(1024), 'final'], 7);
    const result = await boundedExec(f.world, 'command', { maxBytes: 32, overflow: 'tail' });
    expect(result.code).toBe(7);
    expect(result.stdout).toHaveLength(32);
    expect(result.stdout.endsWith('final')).toBe(true);
    expect(result.stderr).toMatch(/truncated/);
    expect(f.closed()).toBe(true);
  });

  it('rejects and closes the transport before retaining an oversized capture', async () => {
    const f = fixture(['x'.repeat(1024)]);
    await expect(boundedExec(f.world, 'command', { maxBytes: 32 })).rejects.toThrow(/output exceeds/);
    expect(f.closed()).toBe(true);
  });

  it('bounds API Bash output before it reaches the tool response', async () => {
    const f = fixture(['x'.repeat(1024 * 1024), 'last-line']);
    const handlers = platformToolHandlers(f.world, { emit() {} } as any);
    const result = await handlers.bash!({ command: 'verbose-command' });
    expect(result.length).toBeLessThan(100_000);
    expect(result).toContain('last-line');
  });
});
