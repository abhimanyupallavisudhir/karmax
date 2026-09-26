import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { World, WorldHandle, WorldHttpRequest, WorldHttpResponse, WorldProvider, WorldSpec, ExecOptions, ExecResult, WorldLifecycleState, WorldProcess, WorldProcessSpec, WorldPty, WorldPtySpec, worldRelativePath, worldWorkingDirectory, WorldCheckoutSpec } from './types.js';
import { addCheckoutViaExec } from './checkout.js';
import { gitOrThrow } from './git.js';
import { worldRepos } from './types.js';
import { WorktreeProvider } from './worktree.js';
import { paths } from '../config/paths.js';
import { boundedResponseBody } from './http.js';
import { openSpawnedPty, runLocalCommand, startSpawnedProcess } from './local-execution.js';

const pexec = promisify(execFile);
const IMAGE = process.env.KARMAX_CONTAINER_IMAGE ?? 'node:22';

/**
 * Per-container resource caps (SPEC §11.2 isolation). Without them a single
 * runaway process inside a container world can consume the whole host's RAM/CPU
 * (the exact failure class behind the July 5 OOM). All env-tunable; set an empty
 * string to opt a limit out.
 */
function containerLimitArgs(): string[] {
  const memory = process.env.KARMAX_CONTAINER_MEMORY ?? '4g';
  const cpus = process.env.KARMAX_CONTAINER_CPUS ?? '2';
  const pids = process.env.KARMAX_CONTAINER_PIDS ?? '512';
  const args: string[] = [];
  if (memory) args.push('--memory', memory, '--memory-swap', memory); // no swap headroom beyond --memory
  if (cpus) args.push('--cpus', cpus);
  if (pids) args.push('--pids-limit', pids);
  return args;
}

async function docker(args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await pexec('docker', args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...opts.env } });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e), code: e.code ?? 1 };
  }
}

export async function dockerAvailable(): Promise<boolean> {
  return (await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 })).code === 0;
}

/**
 * Container world (SPEC §11.2). The git worktree lives on the host (so the
 * deterministic merge stays on host git), bind-mounted into a long-lived
 * container where the agent's commands run isolated. The world interface is
 * unchanged, so worktree → container is a config switch (SPEC §11.1).
 */
export class ContainerWorldProvider implements WorldProvider {
  readonly kind = 'container' as const;
  readonly parkable = true;
  /** Declared (rather than left undefined) so `/api/meta`'s worldProviders has
   * one shape for every provider. `remote: false` is load-bearing: it is what
   * tells runner accounting, world access, and the Git broker that this world's
   * checkout lives on the host. Ports are served through the container's own
   * IP (see `fetchPort`), not a published host port. */
  readonly capabilities = { remote: false, pty: true, snapshots: false, ports: true, networkPolicy: false } as const;
  private worktrees: WorktreeProvider;

  constructor(home = paths().worlds) {
    this.worktrees = new WorktreeProvider(home);
  }

  async create(spec: WorldSpec): Promise<World> {
    if (!(await dockerAvailable())) throw new Error('container world requested but Docker is not available');
    const base = await this.worktrees.create(spec); // host worktree on karmax/<taskId>
    const name = `karmax-${spec.taskId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    try {
    const gitDirs = new Set<string>();
    for (const repo of worldRepos(base.handle))
      gitDirs.add(await gitOrThrow(repo.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    await docker(['rm', '-f', name]); // clear any stale container
    const image = spec.environment?.image ?? IMAGE;
    const run = await docker([
      'run', '-d', '--name', name,
      ...containerLimitArgs(),
      '-v', `${base.handle.root}:/work`,
      '-v', `${base.handle.root}:${base.handle.root}`,
      ...[...gitDirs].flatMap(directory => ['-v', `${directory}:${directory}`]),
      '-w', '/work',
      image, 'sleep', 'infinity',
    ]);
    if (run.code !== 0) {
      throw new Error(`failed to start container: ${run.stderr}`);
    }
    const git = await docker(['exec', name, 'git', '--version']);
    if (git.code !== 0) throw new Error('container image must include Git; use node:22 or a prepared image with Git installed');
    // Keep the worktree's meta: it carries `ephemeralPaths` (copyGlobs and
    // materialized resources), which checkpointing reads to tell inputs apart
    // from project data. Spreading `base.handle` and then overwriting `meta`
    // wholesale silently dropped them.
    const handle: WorldHandle = { ...base.handle, kind: 'container',
      meta: { ...base.handle.meta, container: name, image } };
    return new ContainerWorld(handle);
    } catch (error) {
      await docker(['rm', '-f', name]);
      await base.destroy();
      throw error;
    }
  }

  async open(handle: WorldHandle): Promise<World> {
    const name = String(handle.meta?.container ?? '');
    if (!name) throw new Error('container world handle has no container id');
    const state = await this.status(handle);
    if (state === 'missing') throw new Error(`container world "${handle.id}" no longer exists`);
    if (state === 'parked') {
      const started = await docker(['start', name]);
      if (started.code !== 0) throw new Error(`failed to resume container world: ${started.stderr}`);
    }
    return new ContainerWorld(handle);
  }

  async park(handle: WorldHandle): Promise<WorldHandle> {
    const name = String(handle.meta?.container ?? '');
    if (!name) return handle;
    const stopped = await docker(['stop', '-t', '10', name]);
    if (stopped.code !== 0 && !(await this.status(handle) === 'missing')) {
      throw new Error(`failed to park container world: ${stopped.stderr}`);
    }
    return handle;
  }

  async status(handle: WorldHandle): Promise<WorldLifecycleState> {
    const name = String(handle.meta?.container ?? '');
    if (!name) return 'missing';
    const inspected = await docker(['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 10_000 });
    if (inspected.code !== 0) return 'missing';
    return inspected.stdout.trim() === 'true' ? 'ready' : 'parked';
  }
}

class ContainerWorld implements World {
  constructor(public handle: WorldHandle) {}
  private get name() {
    return String(this.handle.meta?.container);
  }

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const inner = [cmd, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const dArgs = ['exec'];
    // `-i` keeps the container process's stdin attached to ours so a secret can
    // be piped in instead of passed through argv/env, where every co-resident
    // process could read it out of /proc (the vault's fillInWorld relies on
    // this channel). Without it the helper just gets EOF.
    if (opts.input !== undefined) dArgs.push('-i');
    dArgs.push('-w', this.containerCwdFromAny(opts.cwd ?? worldWorkingDirectory(this.handle)));
    for (const key of Object.keys(opts.env ?? {})) dArgs.push('-e', key);
    dArgs.push(this.name, 'bash', '-lc', inner);
    if (opts.input !== undefined)
      return runLocalCommand('docker', dArgs, { timeoutMs: opts.timeoutMs, input: opts.input, env: { ...process.env, ...opts.env } });
    return docker(dArgs, { timeoutMs: opts.timeoutMs, env: opts.env });
  }

  /**
   * A container world's `localhost:<port>` is inside the container's network
   * namespace — the host's port of the same number belongs to something else
   * entirely. `docker run` publishes no ports (the port an agent picks is not
   * known at create time), so previews are proxied through the container's own
   * bridge IP, which the host can route to directly on Linux. On Docker Desktop
   * (macOS/Windows) the container network is not routable from the host and the
   * connection fails with a clear error rather than a wrong page.
   */
  async fetchPort(port: number, requestPath: string, request: WorldHttpRequest = { method: 'GET' }): Promise<WorldHttpResponse> {
    const host = await this.containerAddress(port);
    const safePath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    const method = request.method.toUpperCase();
    const response = await fetch(`http://${host}:${port}${safePath}`, {
      method,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(!['GET', 'HEAD'].includes(method) && request.body?.length ? { body: request.body } : {}),
      redirect: 'manual',
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return { status: response.status, headers, body: await boundedResponseBody(response) };
  }

  async previewSocketTarget(port: number, requestPath: string) {
    const host = await this.containerAddress(port);
    const safePath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
    return { url: `ws://${host}:${port}${safePath}` };
  }

  private async containerAddress(port: number): Promise<string> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid preview port');
    const inspected = await docker(['inspect', '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', this.name], { timeoutMs: 10_000 });
    const address = inspected.stdout.trim().split(/\s+/).find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
    if (!address) throw new Error('container world has no routable address for previews');
    return address;
  }
  // file ops use the host bind-mount (fast, and visible inside the container)
  async readFile(rel: string): Promise<string> {
    return fs.promises.readFile(this.filePath(rel), 'utf8');
  }
  async readFileBuffer(rel: string): Promise<Buffer> {
    return fs.promises.readFile(this.filePath(rel));
  }
  async writeFile(rel: string, content: string): Promise<void> {
    const abs = this.filePath(rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  async writeFileBuffer(rel: string, content: Buffer): Promise<void> {
    const abs = this.filePath(rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  async startProcess(spec: WorldProcessSpec): Promise<WorldProcess> {
    const args = ['exec'];
    args.push('-w', this.containerCwdFromAny(spec.cwd ?? worldWorkingDirectory(this.handle)));
    for (const key of Object.keys(spec.env ?? {})) args.push('-e', key);
    args.push(this.name, 'bash', '-lc', spec.command);
    return startSpawnedProcess('docker', args, { env: { ...process.env, ...spec.env }, detached: true });
  }
  async openPty(spec: WorldPtySpec = {}): Promise<WorldPty> {
    const args = ['exec', '-it', '-w', this.containerCwdFromAny(spec.cwd ?? worldWorkingDirectory(this.handle))];
    for (const key of Object.keys(spec.env ?? {})) args.push('-e', key);
    args.push(this.name, 'bash', ...(spec.command ? ['-lc', spec.command] : ['--norc', '-i']));
    return openSpawnedPty('docker', args, spec);
  }
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else out.push(rel);
      }
    };
    if (fs.existsSync(this.handle.root)) walk(this.handle.root, '');
    return out;
  }
  /** Another branch of a repo in this sandbox (SPEC §11.1, multi-PR). The repos
   *  here are real clones, so this is one `git worktree add` run in place. */
  async addCheckout(spec: WorldCheckoutSpec): Promise<WorldHandle> {
    return addCheckoutViaExec(this, spec);
  }

  async destroy(): Promise<void> {
    await docker(['rm', '-f', this.name]);
    const { git } = await import('./git.js');
    const { worldRepos } = await import('./types.js');
    const { withWorktreeLock } = await import('./worktree-lock.js');
    for (const r of worldRepos(this.handle)) {
      await withWorktreeLock(r.repo, async () => {
        await git(r.repo, ['worktree', 'remove', '--force', r.root]);
        await git(r.repo, ['worktree', 'prune']);
      });
    }
    if (fs.existsSync(this.handle.root)) fs.rmSync(this.handle.root, { recursive: true, force: true });
  }
  private filePath(relPath: string): string {
    const safe = worldRelativePath(relPath);
    if (safe === '.') throw new Error('path is a directory');
    return path.join(this.handle.root, ...safe.split('/'));
  }
  private containerCwd(relPath = '.'): string {
    const safe = worldRelativePath(relPath);
    return safe === '.' ? '/work' : `/work/${safe}`;
  }
  private containerCwdFromAny(value: string): string {
    if (value === this.handle.root) return '/work';
    if (value.startsWith(`${this.handle.root}${path.sep}`)) {
      return `/work/${value.slice(this.handle.root.length + 1).split(path.sep).join('/')}`;
    }
    return this.containerCwd(value);
  }
}
