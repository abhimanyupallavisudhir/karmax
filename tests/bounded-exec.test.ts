import { describe, expect, it } from 'vitest';
import { boundedExec } from '../src/world/bounded-exec.js';
import { openLocalPty } from '../src/world/local-execution.js';
import { platformToolHandlers } from '../src/agent/tools.js';

/** A terminal that runs the wrapper like bash would: the command's chunks, then
 * the end-of-output marker with its status, then the PTY exit. `lostTail`
 * reproduces node-pty emitting exit before the final chunks were read. */
function fixture(chunks: string[], code = 0, options: { lostTail?: number; splitMarker?: boolean } = {}) {
  let output = (_: string) => {};
  let exit = (_: number) => {};
  let closed = false;
  let marker = '';
  const world = {
    async openPty() {
      return {
        onData(cb: typeof output) { output = cb; return () => {}; },
        onExit(cb: typeof exit) { exit = cb; return () => {}; },
        async write(command: string) {
          if (command.startsWith('stty')) {
            marker = command.match(/KARMAX_EXEC_[a-f0-9]+/)![0];
            output(command + '\r\n'); // terminal echo must not become output
            output('\n' + marker.slice(0, 8));
            output(marker.slice(8) + '\r\n');
            return;
          }
          const end = `${marker}_EXIT:${code}\n`;
          const stream = [...chunks, ...(options.splitMarker ? [end.slice(0, 20), end.slice(20)] : [end])];
          for (const chunk of stream.slice(0, stream.length - (options.lostTail ?? 0))) output(chunk);
          exit(code);
        },
        async close() { closed = true; },
      };
    },
  };
  return { world: world as any, closed: () => closed };
}

describe('bounded world command capture', () => {
  it('executes real local shell output with exit status and UTF-8 intact', async () => {
    const world = { openPty: (spec: any) => openLocalPty('/tmp', spec) } as any;
    const result = await boundedExec(world, "printf 'hello 🌍\\n'; printf 'oops\\n' >&2; exit 7", { maxBytes: 1024 });
    expect(result).toEqual({ code: 7, stdout: 'hello 🌍\n' + 'oops\n', stderr: '' });
  });

  it('completes a command that reads the terminal as its stdin', async () => {
    const world = { openPty: (spec: any) => openLocalPty('/tmp', spec) } as any;
    const result = await boundedExec(world, "read -t 1 line; printf 'read:%s' \"$line\"", { maxBytes: 1024, timeoutMs: 5000 });
    expect(result).toEqual({ code: 0, stdout: 'read:', stderr: '' });
  });

  it('delivers commands larger than the terminal canonical line limit intact', async () => {
    const world = { openPty: (spec: any) => openLocalPty('/tmp', spec) } as any;
    const command = `printf '%s' '${'x'.repeat(200_000)}'; printf done`;
    const result = await boundedExec(world, command, { maxBytes: 32, overflow: 'tail', timeoutMs: 5000 });
    expect(result.code).toBe(0);
    expect(result.stdout.endsWith('done')).toBe(true);
  });

  // AD-30: node-pty emits exit once its socket closes, destroying the socket
  // 200 ms after the child exits whatever is still unread. Only the marker
  // proves the output is complete.
  it('treats an exit that arrives before the final output as a transport failure', async () => {
    const f = fixture(['first part ', 'the tail that matters'], 0, { lostTail: 2 });
    await expect(boundedExec(f.world, 'command', { maxBytes: 1024 })).rejects.toThrow(/without its end-of-output marker/);
    expect(f.closed()).toBe(true);
  });

  it('takes the exit status from the end-of-output marker, even split across chunks', async () => {
    const f = fixture(['partial line without newline'], 3, { splitMarker: true });
    await expect(boundedExec(f.world, 'command', { maxBytes: 1024 }))
      .resolves.toEqual({ code: 3, stdout: 'partial line without newline', stderr: '' });
    const tail = fixture(['x'.repeat(100), 'end'], 0, { splitMarker: true });
    await expect(boundedExec(tail.world, 'command', { maxBytes: 8, overflow: 'tail' }))
      .resolves.toMatchObject({ code: 0, stdout: 'x'.repeat(5) + 'end' });
  });

  it('preserves the result if terminal cleanup throws synchronously', async () => {
    const f = fixture(['done']);
    const open = f.world.openPty;
    f.world.openPty = async () => ({ ...await open(), close() { throw new Error('already closed'); } });
    await expect(boundedExec(f.world, 'command', { maxBytes: 32 })).resolves.toMatchObject({ stdout: 'done', code: 0 });
  });

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
