import { scrubbedEnv } from '../autonomy/config-homes.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { World, WorldHandle, WorldProvider, WorldSpec, ExecOptions, ExecResult, WorldProcess, WorldProcessSpec, WorldPty, WorldPtySpec, worldRelativePath, worldWorkingDirectory } from './types.js';
import { openLocalPty, startLocalProcess } from './local-execution.js';
import { readRegularFilePrefix } from './file-prefix.js';
import { taskBranch } from '../domain/brand.js';

const pexec = promisify(execFile);

/**
 * A lightweight world backed by a real temp directory but with no git wiring.
 * Used for fast, hermetic tests of the agent loop where merge machinery is not
 * exercised. Real worlds use {@link WorktreeProvider}.
 */
export class MemoryWorldProvider implements WorldProvider {
  readonly kind = 'memory' as const;
  readonly parkable = false;
  /** Declared for a uniform `/api/meta` provider catalog; see WorktreeProvider. */
  readonly capabilities = { remote: false, pty: true, snapshots: false, ports: false, networkPolicy: false } as const;
  private roots = new Map<string, string>();

  async create(spec: WorldSpec): Promise<World> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `karmax-mem-${spec.taskId}-`));
    this.roots.set(spec.taskId, root);
    const handle: WorldHandle = {
      kind: 'memory',
      id: spec.taskId,
      root,
      branch: taskBranch(spec.taskId),
      base: spec.base,
      target: spec.target,
    };
    return new MemoryWorld(handle);
  }

  async open(handle: WorldHandle): Promise<World> {
    return new MemoryWorld(handle);
  }
}

class MemoryWorld implements World {
  constructor(public handle: WorldHandle) {}

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await pexec(cmd, args, {
        cwd: opts.cwd ?? worldWorkingDirectory(this.handle),
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: scrubbedEnv({ provider: 'mock', extra: opts.env }),
      });
      return { stdout, stderr, code: 0 };
    } catch (e: any) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e?.message ?? e), code: e.code ?? 1 };
    }
  }

  async readFile(relPath: string): Promise<string> {
    return fs.promises.readFile(this.filePath(relPath), 'utf8');
  }
  async readFileBuffer(relPath: string): Promise<Buffer> {
    return fs.promises.readFile(this.filePath(relPath));
  }
  async readFilePrefix(relPath: string, maxBytes: number): Promise<Buffer> {
    return readRegularFilePrefix(this.filePath(relPath), maxBytes);
  }
  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = this.filePath(relPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  async writeFileBuffer(relPath: string, content: Buffer): Promise<void> {
    const abs = this.filePath(relPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  async startProcess(spec: WorldProcessSpec): Promise<WorldProcess> {
    return startLocalProcess(this.handle.root, {
      ...spec,
      cwd: spec.cwd ?? worldWorkingDirectory(this.handle),
    });
  }
  async openPty(spec: WorldPtySpec = {}): Promise<WorldPty> {
    return openLocalPty(this.handle.root, {
      ...spec,
      cwd: spec.cwd ?? worldWorkingDirectory(this.handle),
    });
  }
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else out.push(rel);
      }
    };
    if (fs.existsSync(this.handle.root)) walk(this.handle.root, '');
    return out;
  }
  async destroy(): Promise<void> {
    if (fs.existsSync(this.handle.root)) fs.rmSync(this.handle.root, { recursive: true, force: true });
  }
  private filePath(relPath: string): string {
    const safe = worldRelativePath(relPath);
    if (safe === '.') throw new Error('path is a directory');
    return path.join(this.handle.root, ...safe.split('/'));
  }
}
