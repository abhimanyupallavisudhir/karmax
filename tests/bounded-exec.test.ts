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

  // AD-30 on a real PTY: node-pty destroys its socket 200 ms after the shell
  // exits. A reader slower than that (a loaded host) must still get every byte.
  it('delivers the complete output of a real terminal to a slow reader', async () => {
    const world = { openPty: async (spec: any) => {
      const terminal = await openLocalPty('/tmp', spec);
      return { ...terminal, onData: (cb: (chunk: string) => void) => terminal.onData((chunk) => {
        const until = Date.now() + 30;
        while (Date.now() < until) { /* a busy event loop */ }
        cb(chunk);
      }) };
    } } as any;
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const result = await boundedExec(world, `for i in $(seq 0 3999); do echo "line $i"; done; printf last`,
      { maxBytes: 1_000_000, timeoutMs: 60_000 });
    expect(result).toEqual({ code: 0, stdout: `${lines.join('\n')}\nlast`, stderr: '' });
  }, 90_000);

  // The same teardown, modelled exactly: a real shell behind a terminal that
  // delivers each chunk later and, 10 ms after the shell exits, drops
  // whatever it has not delivered yet, then reports exit.
  it('never loses the marker to a terminal torn down as soon as the shell exits', async () => {
    const { spawn } = await import('node:child_process');
    let shell: ReturnType<typeof spawn> | undefined;
    const world = { async openPty() {
      shell = spawn('bash', ['--norc', '-i'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = (_: string) => {}, exit = (_: number | null) => {};
      let queue = Promise.resolve(), torn = false;
      const deliver = (data: Buffer) => { queue = queue.then(() => new Promise(resolve => setTimeout(() => {
        if (!torn) output(data.toString('utf8'));
        resolve();
      }, 20))); };
      shell.stdout!.on('data', deliver);
      shell.stderr!.on('data', () => {}); // prompts and non-terminal warnings
      shell.on('exit', (code) => setTimeout(() => { torn = true; exit(code); }, 10));
      return {
        onData(cb: typeof output) { output = cb; return () => {}; },
        onExit(cb: typeof exit) { exit = cb; return () => {}; },
        write(data: string) { shell!.stdin!.write(data); },
        close() { shell!.kill('SIGKILL'); },
      };
    } } as any;
    const result = await boundedExec(world, "printf 'first\\n'; printf 'the tail that matters'; exit 4", { maxBytes: 1024, timeoutMs: 10_000 });
    expect(result).toEqual({ code: 4, stdout: 'first\nthe tail that matters', stderr: '' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(shell!.exitCode !== null || shell!.signalCode !== null).toBe(true); // the terminal was closed
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
