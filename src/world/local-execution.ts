import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { WorldProcess, WorldProcessSpec, WorldPty, WorldPtySpec, ExecResult } from './types.js';
import { worldRelativePath } from './types.js';

/**
 * A one-shot local command with optional STDIN — the async equivalent of
 * `execFile` that also honors `input`. Used when a caller must feed a secret to
 * a child (e.g. in-world credential fill) without it appearing in argv/env,
 * which `promisify(execFile)` cannot do. Never rejects; returns the exit code.
 */
export function runLocalCommand(command: string, args: string[], opts: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; maxBuffer?: number;
} = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    const cap = opts.maxBuffer ?? 64 * 1024 * 1024;
    let out = '', err = '', outLen = 0, errLen = 0, done = false;
    const finish = (code: number, extraErr?: string) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err + (extraErr ?? ''), code });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(124, '\n[timed out]'); },
      opts.timeoutMs ?? 120_000);
    child.stdout?.on('data', (d) => { if (outLen < cap) { out += d; outLen += d.length; } });
    child.stderr?.on('data', (d) => { if (errLen < cap) { err += d; errLen += d.length; } });
    child.on('error', (e) => finish(1, String(e?.message ?? e)));
    child.on('close', (code) => finish(code ?? 0));
    if (opts.input !== undefined) { child.stdin?.on('error', () => { /* EPIPE if child exits early */ }); child.stdin?.end(opts.input); }
    else child.stdin?.end();
  });
}

/** Local implementation of the provider execution contract. Worktree and
 * memory worlds use it directly; container worlds use the same wrappers around
 * `docker exec`. */
export function startSpawnedProcess(command: string, args: string[], opts: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
} = {}): WorldProcess {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached: opts.detached ?? true,
  });
  return wrapChild(child, opts.detached ?? true);
}

export function startLocalProcess(root: string, spec: WorldProcessSpec): WorldProcess {
  return startSpawnedProcess('bash', ['-lc', spec.command], {
    cwd: localCwd(root, spec.cwd),
    env: { ...process.env, ...(spec.env ?? {}) },
    detached: true,
  });
}

export async function openLocalPty(root: string, spec: WorldPtySpec = {}): Promise<WorldPty> {
  const pty = await import('node-pty');
  const term = pty.spawn('bash', ['--norc', '-i'], {
    name: 'xterm-color',
    cols: spec.cols ?? 80,
    rows: spec.rows ?? 24,
    cwd: localCwd(root, spec.cwd),
    env: { ...process.env, PS1: 'karmax:\\W$ ', ...(spec.env ?? {}) },
  });
  return wrapPty(term);
}

export async function openSpawnedPty(command: string, args: string[], spec: WorldPtySpec = {}): Promise<WorldPty> {
  const pty = await import('node-pty');
  const term = pty.spawn(command, args, {
    name: 'xterm-color',
    cols: spec.cols ?? 80,
    rows: spec.rows ?? 24,
    cwd: process.cwd(),
    env: { ...process.env, ...(spec.env ?? {}) },
  });
  return wrapPty(term);
}

function localCwd(root: string, rel?: string): string {
  if (rel && path.isAbsolute(rel)) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(rel);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`))
      throw new Error('working directory escapes world');
    return resolved;
  }
  const safe = worldRelativePath(rel ?? '.');
  return safe === '.' ? root : path.join(root, ...safe.split('/'));
}

function wrapChild(child: ChildProcess, detached: boolean): WorldProcess {
  const outputs = new Set<(chunk: string) => void>();
  const exits = new Set<(code: number | null) => void>();
  let exited = false;
  let exitCode: number | null = null;
  const emit = (chunk: unknown) => {
    const value = String(chunk);
    for (const listener of outputs) listener(value);
  };
  child.stdout?.on('data', emit);
  child.stderr?.on('data', emit);
  child.on('error', (error) => emit(`\n[spawn error] ${error.message}\n`));
  child.on('exit', (code, signal) => {
    exited = true;
    exitCode = code ?? (signal ? -1 : 0);
    for (const listener of exits) listener(exitCode);
  });
  return {
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    onOutput(listener) {
      outputs.add(listener);
      return () => outputs.delete(listener);
    },
    onExit(listener) {
      if (exited) queueMicrotask(() => listener(exitCode));
      else exits.add(listener);
      return () => exits.delete(listener);
    },
    kill(signal = 'SIGTERM') {
      if (child.pid === undefined) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone */ }
      }
    },
  };
}

function wrapPty(term: {
  pid?: number;
  onData(listener: (chunk: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}): WorldPty {
  return {
    ...(term.pid !== undefined ? { pid: term.pid } : {}),
    onData(listener) {
      const disposable = term.onData(listener);
      return () => disposable.dispose();
    },
    onExit(listener) {
      const disposable = term.onExit((event) => listener(event.exitCode));
      return () => disposable.dispose();
    },
    write(data) { term.write(data); },
    resize(cols, rows) { term.resize(cols, rows); },
    close() { killPtySession(term); },
  };
}

/** Kill the PTY session, including foreground and background jobs. */
function killPtySession(term: { pid?: number; kill(): void }): void {
  if (typeof term.pid === 'number') {
    try { spawn('pkill', ['-KILL', '-s', String(term.pid)], { stdio: 'ignore' }).on('error', () => {}); } catch { /* no pkill */ }
    try { process.kill(-term.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
  try { term.kill(); } catch { /* already gone */ }
}
