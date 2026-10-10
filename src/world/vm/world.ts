import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import type { ExecOptions, ExecResult, World, WorldCheckoutSpec, WorldDiagnosis, WorldHandle, WorldHttpRequest,
  WorldHttpResponse, WorldProcess, WorldProcessSpec, WorldPty, WorldPtySpec, WorldPtyTermination } from '../types.js';
import { worldRelativePath, worldWorkingDirectory } from '../types.js';
import { addCheckoutViaExec } from '../checkout.js';
import { quote, type SshChannel, type SshTransport, VmTransportError } from './ssh.js';

const SESSION_SCRIPT = fs.readFileSync(fileURLToPath(new URL('./session.sh', import.meta.url)), 'utf8');
const SESSION_HASH = crypto.createHash('sha256').update(SESSION_SCRIPT).digest('hex').slice(0, 12);
/** Session state lives on the machine's own disk: no process outlives a park. */
const SESSIONS = '/tmp/karmax-sessions';
// Same bounds as E2B and Daytona: a stream that keeps dropping is not a blip.
const REATTACH_LIMIT = 3;
const REATTACH_WINDOW_MS = 10 * 60_000;
const REATTACH_WAIT_MS = 60_000;
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

export interface VmWorldHooks {
  /** Delete the machine and its volume through the control plane. */
  destroy(): Promise<void>;
  /** Control-plane evidence (an OOM-killed machine, a stopped one). */
  diagnose?(window: { since: number; now: number }): Promise<WorldDiagnosis | undefined>;
}

/**
 * A karmax World on any Linux machine reached over SSH (SPEC §11.1). The
 * provider driver (Fly, Hetzner) owns the machine's lifecycle; this owns
 * everything that happens on it: commands, files (SFTP), PTYs and background
 * processes (through `session.sh`, so they survive a dropped connection and
 * are followed again from the byte they reached), and previews (SSH port
 * forwarding to the VM's loopback, so nothing in it listens publicly).
 */
export class VmWorld implements World {
  private sessionScript?: Promise<string>;

  constructor(public handle: WorldHandle, readonly transport: SshTransport, private home: string, private hooks: VmWorldHooks) {}

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const line = [cmd, ...args].map(quote).join(' ');
    // A login shell, as on E2B: tools the agent installs on its profile's PATH are found.
    const script = `cd ${quote(this.cwd(opts.cwd))} || exit 1\n${exports(opts.env)}${line}`;
    const result = await this.transport.exec(`exec bash -lc ${quote(script)}`,
      { timeoutMs: opts.timeoutMs ?? 120_000, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    return { stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8'), code: result.code };
  }

  async readFile(relPath: string): Promise<string> { return (await this.readFileBuffer(relPath)).toString('utf8'); }
  async readFileBuffer(relPath: string): Promise<Buffer> { return this.transport.readFile(this.file(relPath)); }
  async readFilePrefix(relPath: string, maxBytes: number): Promise<Buffer> {
    if (maxBytes <= 0) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    for await (const chunk of this.transport.readStream(this.file(relPath), { start: 0, end: maxBytes - 1 })) chunks.push(chunk);
    return Buffer.concat(chunks).subarray(0, maxBytes);
  }
  readFileStream(relPath: string): AsyncIterable<Buffer> { return this.transport.readStream(this.file(relPath)); }
  async writeFile(relPath: string, content: string): Promise<void> { await this.writeFileBuffer(relPath, Buffer.from(content)); }
  async writeFileBuffer(relPath: string, content: Buffer): Promise<void> {
    const target = this.file(relPath);
    try {
      await this.transport.writeFile(target, content);
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ENOENT') throw error;
      const made = await this.transport.exec(`mkdir -p ${quote(path.posix.dirname(target))}`, { timeoutMs: 30_000 });
      if (made.code !== 0) throw new Error(made.stderr.toString() || 'could not create the directory in the VM');
      await this.transport.writeFile(target, content);
    }
  }
  async listFiles(): Promise<string[]> {
    const result = await this.exec('bash', ['-c', "find . -type f -not -path '*/.git/*' -print -o -type l -not -path '*/.git/*' -print | sed 's#^./##'"],
      { cwd: this.handle.root });
    if (result.code !== 0) throw new Error(result.stderr || 'failed to list VM files');
    return result.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
  }

  async startProcess(spec: WorldProcessSpec): Promise<WorldProcess> {
    const session = await this.startSession('pipe', 80, 24, this.launchScript(spec.command, spec.cwd, spec.env));
    return {
      onOutput: (listener) => session.onData(listener),
      onExit: (listener) => session.onExit((code) => listener(code)),
      kill: async (signal = 'SIGTERM') => { await session.kill(signal === 'SIGKILL' ? 'KILL' : 'TERM'); },
    };
  }

  async openPty(spec: WorldPtySpec = {}): Promise<WorldPty> {
    // The command runs directly on the terminal: no interactive shell types it,
    // so no line discipline can truncate it (Daytona's 4095-byte canonical line).
    const session = await this.startSession('pty', spec.cols ?? 80, spec.rows ?? 24,
      this.launchScript(spec.command ?? 'exec bash -l', spec.cwd, spec.env));
    return {
      onData: (listener) => session.onData(listener),
      onExit: (listener) => session.onExit(listener),
      write: (data) => session.write(data),
      resize: async (cols, rows) => { await this.session(['resize', session.dir, String(cols), String(rows)]); },
      close: () => session.close(),
    };
  }

  async fetchPort(port: number, requestPath: string, request: WorldHttpRequest = { method: 'GET' }): Promise<WorldHttpResponse> {
    checkPort(port);
    // An SSH channel is a plain duplex: give it the few socket methods node:http calls.
    const socket = Object.assign(await this.transport.forward(port), {
      setTimeout() { return this; }, setNoDelay() { return this; }, setKeepAlive() { return this; },
      ref() { return this; }, unref() { return this; },
    });
    const safePath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    const method = request.method.toUpperCase();
    return new Promise<WorldHttpResponse>((resolve, reject) => {
      const outgoing = http.request({ method, path: safePath, headers: request.headers ?? {},
        createConnection: () => socket as unknown as net.Socket }, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_PREVIEW_BYTES) { response.destroy(new Error(`preview response exceeds ${MAX_PREVIEW_BYTES / 2 ** 20} MiB`)); return; }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
          resolve({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
        });
      });
      outgoing.on('error', reject);
      const timer = setTimeout(() => outgoing.destroy(new Error('preview request timed out')), 120_000);
      outgoing.on('close', () => clearTimeout(timer));
      if (!['GET', 'HEAD'].includes(method) && request.body?.length) outgoing.end(request.body);
      else outgoing.end();
    });
  }

  /** A single-use loopback listener in front of an SSH forward: the gateway's
   * WebSocket client dials it like any upstream, and it closes after the first
   * connection (or 30 s unused). */
  async previewSocketTarget(port: number, requestPath: string) {
    checkPort(port);
    const safePath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    const server = net.createServer({ pauseOnConnect: true });
    server.maxConnections = 1;
    const listening = new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    const local = await listening;
    const expire = setTimeout(() => server.close(), 30_000);
    expire.unref();
    server.once('connection', (client) => {
      clearTimeout(expire);
      server.close();
      void this.transport.forward(port).then((upstream: Duplex) => {
        client.pipe(upstream).pipe(client);
        const end = () => { client.destroy(); upstream.destroy(); };
        client.on('error', end); upstream.on('error', end);
        client.on('close', end); upstream.on('close', end);
        client.resume();
      }, () => client.destroy());
    });
    return { url: `ws://127.0.0.1:${local}${safePath}` };
  }

  async addCheckout(spec: WorldCheckoutSpec): Promise<WorldHandle> { return addCheckoutViaExec(this, spec); }

  /** Control-plane evidence first (it survives a machine that stopped
   * answering), then the machine's own: the kernel's OOM kills and the memory
   * guard's log since the turn began, and how much memory is left now. */
  async diagnose({ since, now = Date.now() }: { since: number; now?: number }): Promise<WorldDiagnosis | undefined> {
    const external = await this.hooks.diagnose?.({ since, now }).catch(() => undefined);
    if (external) return external;
    try {
      const sinceSeconds = Math.floor(since / 1000);
      const result = await this.transport.exec(`awk '/MemTotal|MemAvailable/ {print $2}' /proc/meminfo | tr '\\n' ' '; echo; `
        + `(sudo -n journalctl -k --since=@${sinceSeconds} -o cat 2>/dev/null || sudo -n dmesg 2>/dev/null) | grep -iE 'out of memory: killed process' | tail -n 3; `
        + `tail -n 3 ${quote(path.posix.join(this.handle.root, '.karmax-injection/agent/memory-guard.log'))} 2>/dev/null`, { timeoutMs: 15_000 });
      const [memory = '', ...evidence] = result.stdout.toString().split('\n');
      const [total = 0, available = 0] = memory.trim().split(/\s+/).map(Number);
      const killed = evidence.filter((line) => /out of memory|killed/i.test(line));
      const low = total > 0 && available / total < 0.05;
      if (!killed.length && !low) return undefined;
      return { memoryExhausted: true, summary: [
        low ? `the VM has ${Math.round(available / 1024)} of ${Math.round(total / 1024)} MB of memory free` : '',
        ...killed.map((line) => line.trim().slice(0, 300)),
      ].filter(Boolean).join('; ') };
    } catch {
      return undefined; // diagnosis must never replace the failure it explains
    }
  }

  async destroy(): Promise<void> {
    this.transport.close();
    await this.hooks.destroy();
  }

  /** The command, its directory and environment as a script the holder runs.
   * It deletes itself before anything else: it may carry secrets. */
  private launchScript(command: string, cwd: string | undefined, env: Record<string, string> | undefined): string {
    return `rm -f -- "$0"\ncd ${quote(this.cwd(cwd))} || exit 1\n${exports(env)}exec bash -lc ${quote(command)}\n`;
  }

  private async script(): Promise<string> {
    if (!this.sessionScript) {
      const target = path.posix.join(this.home, '.karmax-vm', `session-${SESSION_HASH}.sh`);
      const pending = (async () => {
        const present = await this.transport.exec(`test -f ${quote(target)}`, { timeoutMs: 30_000 });
        if (present.code !== 0) {
          await this.transport.exec(`mkdir -p ${quote(path.posix.dirname(target))}`, { timeoutMs: 30_000 });
          await this.transport.writeFile(`${target}.tmp`, Buffer.from(SESSION_SCRIPT));
          await this.transport.exec(`mv -f ${quote(`${target}.tmp`)} ${quote(target)}`, { timeoutMs: 30_000 });
        }
        return target;
      })();
      this.sessionScript = pending;
      pending.catch(() => { if (this.sessionScript === pending) this.sessionScript = undefined; });
    }
    return this.sessionScript;
  }

  /** Run one `session.sh` operation to completion. */
  async session(args: string[], input?: string): Promise<{ stdout: string; code: number }> {
    const script = await this.script();
    const result = await this.transport.exec(`sh ${[script, ...args].map(quote).join(' ')}`,
      { timeoutMs: 60_000, ...(input !== undefined ? { input } : {}) });
    return { stdout: result.stdout.toString('utf8'), code: result.code };
  }

  private async startSession(mode: 'pty' | 'pipe', cols: number, rows: number, launch: string): Promise<VmSession> {
    const dir = path.posix.join(SESSIONS, crypto.randomBytes(9).toString('base64url'));
    const started = await this.session(['start', dir, mode, String(cols), String(rows)], launch);
    if (started.code !== 0) throw new Error(`could not start the process in the VM (status ${started.code})`);
    const session = new VmSession(this, dir, await this.script());
    session.follow();
    return session;
  }

  private file(relative: string): string {
    const safe = worldRelativePath(relative);
    if (safe === '.') throw new Error('path is a directory');
    return path.posix.join(this.handle.root, safe);
  }

  private cwd(value?: string): string {
    if (!value) return worldWorkingDirectory(this.handle);
    if (value === this.handle.root || value.startsWith(`${this.handle.root}/`)) return value;
    const safe = worldRelativePath(value);
    return safe === '.' ? this.handle.root : path.posix.join(this.handle.root, safe);
  }
}

type ExitListener = (code: number | null, termination?: WorldPtyTermination) => void;

/**
 * Client side of one `session.sh` session. Output is followed from the byte
 * offset already delivered, so a reattach after a dropped connection neither
 * loses nor repeats a byte — which a line-oriented agent protocol depends on.
 */
class VmSession {
  private outputs = new Set<(chunk: string) => void>();
  private exits = new Set<ExitListener>();
  private pending: string[] = [];
  private attached = false;
  private decoder = new TextDecoder();
  private offset = 0;
  private channel?: SshChannel;
  private input?: SshChannel;
  private sending: Promise<void> = Promise.resolve();
  private reattached: number[] = [];
  private exited = false;
  private closed = false;
  private exitCode: number | null = null;
  private termination?: WorldPtyTermination;

  constructor(private world: VmWorld, readonly dir: string, private script: string) {}

  onData(listener: (chunk: string) => void): () => void {
    this.outputs.add(listener);
    if (!this.attached) { this.attached = true; for (const chunk of this.pending.splice(0)) listener(chunk); }
    return () => this.outputs.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    if (this.exited) queueMicrotask(() => listener(this.exitCode, this.termination));
    else this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  follow(): void {
    void this.world.transport.open(`sh ${[this.script, 'follow', this.dir, String(this.offset)].map(quote).join(' ')}`, {
      stdout: (chunk) => {
        this.offset += chunk.length;
        const text = this.decoder.decode(chunk, { stream: true });
        if (!text) return;
        if (!this.attached) this.pending.push(text);
        for (const listener of this.outputs) listener(text);
      },
    }).then(async (channel) => {
      this.channel = channel;
      channel.end();
      await channel.done.catch(() => undefined);
      await this.settle();
    }, () => this.settle());
  }

  /** The follower ended: the process exited, or the connection did. */
  private async settle(): Promise<void> {
    if (this.exited) return;
    const status = await this.world.session(['status', this.dir]).catch((error) => ({ error }));
    if ('stdout' in status) {
      const exit = /^exit (\d+)/.exec(status.stdout.trim());
      if (exit) return this.end(Number(exit[1]));
      if (this.closed) return this.end(null, { signal: 'SIGKILL' });
      if (status.stdout.trim() === 'lost')
        return this.end(null, { lost: new Error('the process in the VM ended without an exit status (it was killed)') });
    }
    if (this.closed) return this.end(null, { signal: 'SIGKILL' });
    // Still running (or unknown because the VM is unreachable): follow it again.
    this.reattached = this.reattached.filter((at) => Date.now() - at < REATTACH_WINDOW_MS);
    if (this.reattached.length >= REATTACH_LIMIT)
      return this.end(null, { lost: new VmTransportError('the connection to the VM kept dropping; the process may still be running there') });
    this.reattached.push(Date.now());
    this.input?.close();
    this.input = undefined;
    const deadline = Date.now() + REATTACH_WAIT_MS;
    while (!this.closed) {
      try { await this.world.transport.connection(); break; }
      catch (error) {
        if (Date.now() >= deadline) return this.end(null, { lost: error instanceof Error ? error : new Error(String(error)) });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    this.follow();
  }

  private end(code: number | null, termination?: WorldPtyTermination): void {
    if (this.exited) return;
    const tail = this.decoder.decode();
    if (tail) for (const listener of this.outputs) listener(tail);
    this.exited = true;
    this.exitCode = code;
    this.termination = termination;
    this.input?.close();
    for (const listener of this.exits) listener(code, termination);
    void this.world.session(['remove', this.dir]).catch(() => undefined);
  }

  /** Input is queued so concurrent writers never interleave. A write in
   * flight when the connection drops fails, as on E2B. */
  write(data: string): Promise<void> {
    const sent = this.sending.then(async () => {
      if (this.exited) throw new Error('the process in the VM has exited');
      if (!this.input) {
        const channel = await this.world.transport.open(`sh ${[this.script, 'input', this.dir].map(quote).join(' ')}`);
        this.input = channel;
        void channel.done.catch(() => undefined).finally(() => { if (this.input === channel) this.input = undefined; });
      }
      await this.input.write(data);
    });
    this.sending = sent.catch(() => undefined);
    return sent;
  }

  async kill(signal: 'TERM' | 'KILL'): Promise<void> {
    await this.world.session(['kill', this.dir, signal]);
    if (signal === 'TERM') setTimeout(() => { if (!this.exited) void this.world.session(['kill', this.dir, 'KILL']).catch(() => undefined); }, 5_000).unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    try { if (!this.exited) await this.kill('KILL'); }
    finally { this.channel?.close(); this.input?.close(); }
  }
}

function exports(env: Record<string, string> | undefined): string {
  const value = { ...env };
  // Host credential paths mean nothing in the VM, and credentials must not cross into it.
  delete value.GIT_SSH_COMMAND; delete value.GIT_ASKPASS; delete value.GH_TOKEN;
  return Object.entries(value).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, entry]) => `export ${key}=${quote(entry)}\n`).join('');
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid preview port');
}
