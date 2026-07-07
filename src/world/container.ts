import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { World, WorldHandle, WorldProvider, WorldSpec, ExecOptions, ExecResult } from './types.js';
import { WorktreeProvider } from './worktree.js';
import { paths } from '../config/paths.js';

const pexec = promisify(execFile);
const IMAGE = process.env.KARMAX_CONTAINER_IMAGE ?? 'node:22-slim';

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

async function docker(args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await pexec('docker', args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 });
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
  private worktrees: WorktreeProvider;

  constructor(home = paths().worlds) {
    this.worktrees = new WorktreeProvider(home);
  }

  async create(spec: WorldSpec): Promise<World> {
    if (!(await dockerAvailable())) throw new Error('container world requested but Docker is not available');
    const base = await this.worktrees.create(spec); // host worktree on karmax/<taskId>
    const name = `karmax-${spec.taskId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    await docker(['rm', '-f', name]); // clear any stale container
    const run = await docker([
      'run', '-d', '--name', name,
      ...containerLimitArgs(),
      '-v', `${base.handle.root}:/work`,
      '-w', '/work',
      IMAGE, 'sleep', 'infinity',
    ]);
    if (run.code !== 0) {
      await base.destroy();
      throw new Error(`failed to start container: ${run.stderr}`);
    }
    const handle: WorldHandle = { ...base.handle, kind: 'container', meta: { container: name, image: IMAGE } };
    return new ContainerWorld(handle);
  }

  async open(handle: WorldHandle): Promise<World> {
    return new ContainerWorld(handle);
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
    for (const [k, v] of Object.entries(opts.env ?? {})) dArgs.push('-e', `${k}=${v}`);
    dArgs.push(this.name, 'bash', '-lc', inner);
    return docker(dArgs, { timeoutMs: opts.timeoutMs });
  }
  // file ops use the host bind-mount (fast, and visible inside the container)
  async readFile(rel: string): Promise<string> {
    return fs.promises.readFile(path.join(this.handle.root, rel), 'utf8');
  }
  async writeFile(rel: string, content: string): Promise<void> {
    const abs = path.join(this.handle.root, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
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
  async destroy(): Promise<void> {
    await docker(['rm', '-f', this.name]);
    const { repo, root } = this.handle;
    const { git } = await import('./git.js');
    if (repo) {
      await git(repo, ['worktree', 'remove', '--force', root]);
      await git(repo, ['worktree', 'prune']);
    }
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  }
}
