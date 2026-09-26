import crypto from 'node:crypto';
import type { ExecResult, World } from './types.js';

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Capture sandbox output through the streaming PTY, avoiding SDK command
 * handles that accumulate stdout internally even when a callback is supplied. */
export async function boundedExec(world: World, command: string, options: {
  maxBytes: number;
  overflow?: 'tail' | 'reject';
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<ExecResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
    throw new Error('invalid command output limit');
  const terminal = await world.openPty({ cwd: options.cwd, env: options.env });
  const marker = `KARMAX_EXEC_${crypto.randomBytes(16).toString('hex')}`;
  let prefix = '';
  let started = false;
  let truncated = false;
  let tail = Buffer.alloc(0);
  let detachOutput = () => {};
  let detachExit = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
      timer = setTimeout(() => fail(new Error('world command timed out')), options.timeoutMs ?? 120_000);
      detachOutput = terminal.onData((chunk) => {
        if (settled) return;
        if (!started) {
          const text = prefix + chunk;
          const match = new RegExp(`(?:^|\\r?\\n)${marker}\\r?\\n`).exec(text);
          if (!match) { prefix = text.slice(-marker.length - 4); return; }
          started = true;
          prefix = '';
          chunk = text.slice(match.index + match[0].length);
        }
        const bytes = Buffer.byteLength(chunk);
        if (tail.length + bytes > options.maxBytes) {
          if (options.overflow !== 'tail') return fail(new Error('world command output exceeds capture limit'));
          truncated = true;
        }
        // Slice before encoding so a single hostile chunk cannot create another
        // unbounded allocation in the control plane.
        const incoming = Buffer.from(chunk.slice(-options.maxBytes));
        tail = Buffer.concat([tail.subarray(Math.max(0, tail.length + incoming.length - options.maxBytes)),
          incoming.subarray(Math.max(0, incoming.length - options.maxBytes))]);
      });
      detachExit = terminal.onExit((code, termination) => {
        if (settled) return;
        if (termination || !started || code === null) return fail(new Error('world command transport ended without a verified exit'));
        settled = true;
        resolve({ code, stdout: tail.toString('utf8'), stderr: truncated ? '\n[output truncated; showing tail]' : '' });
      });
      void Promise.resolve(terminal.write(`stty -echo -onlcr; printf '\\n${marker}\\n'; exec bash -lc ${quote(command)}\n`)).catch(fail);
    });
  } finally {
    if (timer) clearTimeout(timer);
    detachOutput();
    detachExit();
    await Promise.resolve(terminal.close()).catch(() => undefined);
  }
}
