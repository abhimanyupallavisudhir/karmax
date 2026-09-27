import crypto from 'node:crypto';
import type { ExecResult, World } from './types.js';

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
  const endMarker = `${marker}_EXIT:`;
  const endLine = new RegExp(`${endMarker}(\\d+)\\r?\\n`);
  let held = '';
  let prefix = '';
  let started = false;
  let truncated = false;
  let tail = Buffer.alloc(0);
  const pieces: Buffer[] = [];
  let capturedBytes = 0;
  let detachOutput = () => {};
  let detachExit = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
      let pendingScript: string | undefined;
      const sendScript = () => {
        if (!pendingScript || settled) return;
        const script = pendingScript; pendingScript = undefined;
        void Promise.resolve().then(() => terminal.write(script)).catch(fail);
      };
      timer = setTimeout(() => fail(new Error('world command timed out')), options.timeoutMs ?? 120_000);
      // Keep only what fits the limit. Returns false once the capture failed.
      const capture = (chunk: string): boolean => {
        const bytes = Buffer.byteLength(chunk);
        if ((options.overflow === 'tail' ? tail.length : capturedBytes) + bytes > options.maxBytes) {
          if (options.overflow !== 'tail') { fail(new Error('world command output exceeds capture limit')); return false; }
          truncated = true;
        }
        // Slice before encoding so a single hostile chunk cannot create another
        // unbounded allocation in the control plane.
        if (options.overflow !== 'tail') {
          if (pieces.length >= 65_536) { fail(new Error('world command output exceeds fragment limit')); return false; }
          if (chunk) { pieces.push(Buffer.from(chunk)); capturedBytes += bytes; }
          return true;
        }
        const incoming = Buffer.from(chunk.slice(-options.maxBytes));
        tail = Buffer.concat([tail.subarray(Math.max(0, tail.length + incoming.length - options.maxBytes)),
          incoming.subarray(Math.max(0, incoming.length - options.maxBytes))]);
        return true;
      };
      detachOutput = terminal.onData((chunk) => {
        if (settled) return;
        if (!started) {
          const text = prefix + chunk;
          const match = new RegExp(`(?:^|\\r?\\n)${marker}\\r?\\n`).exec(text);
          if (!match) { prefix = text.slice(-marker.length - 4); return; }
          started = true;
          prefix = '';
          chunk = text.slice(match.index + match[0].length);
          queueMicrotask(sendScript);
        }
        const text = held + chunk;
        const end = endLine.exec(text);
        if (end) {
          if (!capture(text.slice(0, end.index))) return;
          settled = true;
          resolve({ code: Number(end[1]), stdout: (options.overflow === 'tail' ? tail : Buffer.concat(pieces, capturedBytes)).toString('utf8'), stderr: truncated ? '\n[output truncated; showing tail]' : '' });
          return;
        }
        // Hold back what may be the start of the end marker until it resolves.
        held = text.slice(Math.max(0, text.length - endMarker.length - 16));
        capture(text.slice(0, text.length - held.length));
      });
      // The PTY's exit proves nothing about the output: node-pty emits it once
      // its socket closes, and destroys the socket 200 ms after the child exits
      // whatever is still unread. Only the end-of-output marker (written after
      // the command, carrying its status) proves the capture is complete; an
      // exit before it means the shell died, never a finished command.
      detachExit = terminal.onExit(() => fail(new Error('world command transport ended without its end-of-output marker')));
      // Base64 lines avoid terminal canonical-line and exec argv limits. Supply
      // the script on a descriptor so command stdin remains the terminal.
      const encoded = Buffer.from(command).toString('base64').match(/.{1,1024}/g)?.join('\n') ?? '';
      // The trailer shares the command's last line so the shell parses it with
      // the command; a separate line would sit in the terminal's input, where a
      // command reading stdin could consume it. After the marker the shell waits
      // on the terminal instead of exiting: an exiting shell starts node-pty's
      // 200 ms socket teardown, which a slow reader loses the marker to. We
      // close the terminal once the marker arrives; the bounded wait still ends
      // a shell whose close cannot reach it (a detached `docker exec`).
      const script = `bash -l /dev/fd/3 3< <(base64 -d <<'${marker}_END'\n${encoded}\n${marker}_END\n`
        + `); karmax_status=$?; printf '%s%s\\n' '${endMarker}' "$karmax_status"; read -r -t 60 _; exit "$karmax_status"\n`;
      void Promise.resolve(terminal.write(`stty -echo -onlcr; PS1= PS2=; bind 'set enable-bracketed-paste off'; printf '\\n${marker}\\n'\n`))
        .then(() => { pendingScript = script; if (started) sendScript(); }).catch(fail);
    });
  } finally {
    if (timer) clearTimeout(timer);
    detachOutput();
    detachExit();
    try { await terminal.close(); } catch { /* cleanup must not replace the command outcome */ }
  }
}
