import type { World } from '../world/types.js';

export const STARTUP_PHASES = ['shell-started', 'previous-process-check', 'previous-process-stopped',
  'protocol-ready', 'cli-version-check', 'cli-resolve', 'cli-exec', 'relay-started', 'child-spawned',
  'stdin-received', 'stdin-ended', 'child-error', 'child-exited'] as const;
const FRAME_TYPES = new Set(['control_request', 'control_response', 'control_cancel_request', 'system', 'user',
  'assistant', 'result', 'stream_event', 'keep_alive']);
const SUBTYPES = new Set(['initialize', 'mcp_message', 'can_use_tool', 'interrupt', 'set_permission_mode',
  'set_model', 'set_max_thinking_tokens', 'mcp_status', 'success', 'error', 'init']);
const CODES = ['ENOENT', 'EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ENOMEM', 'EPIPE'];
const FLAGS = ['auth', 'network', 'package', 'memory'];
const WAITS = ['0', 'do_wait', 'wait_woken', 'futex_wait_queue', 'futex_wait_queue_me', 'ep_poll',
  'do_epoll_wait', 'pipe_read', 'pipe_write', 'hrtimer_nanosleep', 'wait_on_page_bit_common'];

/** Allowlisted local stderr evidence, without paths, credentials or arbitrary text. */
export function startupStderrSummary(text: string, bytes: number) {
  return { bytes, codes: CODES.filter(code => text.includes(code)), flags: [
    /unauthorized|authentication|oauth|401|403/i.test(text) && 'auth',
    /network|connect|socket|timed? out|dns/i.test(text) && 'network',
    /npm (?:err|error)|cannot find module/i.test(text) && 'package',
    /heap out of memory|allocation failed|enomem/i.test(text) && 'memory',
  ].filter(Boolean) };
}

/** Only envelope labels survive. Neither arbitrary subtype strings, IDs, nor
 * payloads are diagnostic data. Bound buffering even before a newline arrives. */
export class StartupProtocolTrace {
  private buffer = '';
  private discarding = false;
  private frames: Array<{ type: string; subtype?: string }> = [];
  read(chunk: string): void {
    for (let offset = 0; offset < chunk.length;) {
      const newline = chunk.indexOf('\n', offset);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.discarding) {
        if (this.buffer.length + end - offset > 256 * 1024) { this.buffer = ''; this.discarding = true; }
        else this.buffer += chunk.slice(offset, end);
      }
      if (newline < 0) break;
      if (!this.discarding) {
        try {
          const frame = JSON.parse(this.buffer);
          const type = FRAME_TYPES.has(frame?.type) ? frame.type : 'other';
          const rawSubtype = type === 'control_request' ? frame.request?.subtype
            : type === 'control_response' ? frame.response?.subtype : frame?.subtype;
          this.frames.push({ type, ...(SUBTYPES.has(rawSubtype) ? { subtype: rawSubtype } : {}) });
          this.frames = this.frames.slice(-8);
        } catch { /* Partial shell output is not protocol data. */ }
      }
      this.buffer = ''; this.discarding = false; offset = end + 1;
    }
  }
  snapshot() { return this.frames.map(frame => ({ ...frame })); }
  clear() { this.buffer = ''; this.frames = []; this.discarding = false; }
}

/** Bounded even when a provider ignores its own request timeout. */
export async function boundedStartupProbe<T>(probe: () => Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(probe),
      new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

// Executes in the sandbox; never reads process command lines, environments, or
// protocol payloads. Raw stderr stays there: only known error signatures return.
const PROBE = String.raw`
const fs = require('node:fs');
const tail = (file, cap) => {
  let fd;
  try { fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
    const data = Buffer.alloc(Math.min(size, cap)); fs.readSync(fd, data, 0, data.length, Math.max(0, size - cap));
    return { text: data.toString(), bytes: size };
  } catch { return { text: '', bytes: 0 }; } finally { if (fd !== undefined) fs.closeSync(fd); }
};
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const steps = tail(process.argv[1], 8192).text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const roots = new Set(steps.map(step => step.pid).filter(Number.isSafeInteger));
const all = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).slice(0, 4096).flatMap(p => {
  const stat = read('/proc/' + p + '/stat'); if (!stat) return [];
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return [{ pid: Number(p), ppid: Number(fields[1]), state: fields[0], cpuTicks: Number(fields[11]) + Number(fields[12]),
    rssKb: Number(read('/proc/' + p + '/status').match(/^VmRSS:\s+(\d+)/m)?.[1] || 0),
    wait: read('/proc/' + p + '/wchan').trim() }];
});
for (let depth = 0; depth < 8; depth++) for (const p of all) if (roots.has(p.ppid)) roots.add(p.pid);
const stderr = tail(process.argv[2], 16384);
const mem = read('/proc/meminfo');
console.log(JSON.stringify({ steps, processes: all.filter(p => roots.has(p.pid)).slice(0, 12),
  memory: { totalKb: Number(mem.match(/^MemTotal:\s+(\d+)/m)?.[1]), availableKb: Number(mem.match(/^MemAvailable:\s+(\d+)/m)?.[1]) },
  stderr: { bytes: stderr.bytes, codes: ${JSON.stringify(CODES)}.filter(code => stderr.text.includes(code)),
    flags: [/unauthorized|authentication|oauth|401|403/i.test(stderr.text) && 'auth',
      /network|connect|socket|timed? out|dns/i.test(stderr.text) && 'network',
      /npm (?:err|error)|cannot find module/i.test(stderr.text) && 'package',
      /heap out of memory|allocation failed|enomem/i.test(stderr.text) && 'memory'].filter(Boolean) } }));
`;

/** Revalidate the sandbox response. A task controls its files and executable,
 * so even this purpose-built probe cannot be trusted to supply safe free text. */
export async function collectStartupProbe(world: World, traceFile: string, stderrFile: string): Promise<Record<string, unknown>> {
  return boundedStartupProbe(async () => {
    try {
      const result = await world.exec('node', ['-e', PROBE, traceFile, stderrFile], { timeoutMs: 3000 });
      if (result.code !== 0 || result.stdout.length > 32_768) return { status: 'failed' };
      const data = JSON.parse(result.stdout);
      const num = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
      const list = (v: unknown): any[] => Array.isArray(v) ? v : [];
      return { status: 'ok',
        steps: list(data.steps).filter(s => s && STARTUP_PHASES.includes(s.phase) && num(s.pid) !== undefined && num(s.at) !== undefined)
          .slice(-16).map(s => ({ phase: s.phase, pid: s.pid, at: s.at,
            ...(CODES.includes(s.code) ? { code: s.code } : {}), ...(num(s.exitCode) !== undefined ? { exitCode: s.exitCode } : {}) })),
        processes: list(data.processes).filter(p => p && num(p.pid) !== undefined).slice(0, 12).map(p => ({
          pid: p.pid, ppid: num(p.ppid), state: ['R', 'S', 'D', 'Z', 'T', 't', 'X', 'I'].includes(p.state) ? p.state : 'other',
          rssKb: num(p.rssKb), cpuTicks: num(p.cpuTicks), wait: WAITS.includes(p.wait) ? p.wait : 'other',
        })),
        memory: { totalKb: num(data.memory?.totalKb), availableKb: num(data.memory?.availableKb) },
        stderr: { bytes: num(data.stderr?.bytes), codes: list(data.stderr?.codes).filter(c => CODES.includes(c)).slice(0, CODES.length),
          flags: list(data.stderr?.flags).filter(f => FLAGS.includes(f)).slice(0, FLAGS.length) },
      };
    } catch { return { status: 'failed' }; }
  }, 3500, { status: 'timeout' });
}
