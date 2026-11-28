import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { NO_COMPUTER } from '../domain/computer.js';
import { taskBranch } from '../domain/brand.js';
import { PLATFORM_DIR } from '../domain/changed-files.js';
import { readRegularFilePrefix, regularFileSize } from './file-prefix.js';
import { World, WorldHandle, WorldProvider, WorldSpec, ExecResult, WorldProcess, WorldPty, worldRelativePath } from './types.js';

/** What a task without a computer is told when something asks it to run one. */
export const NO_COMPUTER_MESSAGE = 'this task has no computer: it can only use tavya itself. '
  + 'Create a task with a computer (create_task) for work that runs commands, edits files or opens a browser.';

/** Refusal of anything that would execute in a computerless world. */
export class NoComputerError extends Error {
  constructor(what: string) {
    super(`${what}: ${NO_COMPUTER_MESSAGE}`);
    this.name = 'NoComputerError';
  }
}

/** Where a computerless world keeps the platform's own bookkeeping (attachments
 * materialized for a turn, say). Deterministic, so any worker process reopening
 * the handle finds it; scratch, so nothing of value lives there. */
export function computerlessRoot(taskId: string): string {
  return path.join(os.tmpdir(), 'tavya-computerless', taskId.replace(/[^A-Za-z0-9_.-]/g, '_'));
}

/**
 * The world of a task without a computer (wiki features/computerless-tasks):
 * nothing runs in it. Its agent runs host-side with only tavya's platform
 * tools (src/agent/computerless.ts), so `exec`, processes, PTYs, ports and
 * previews are refused rather than run on the host — which is what makes it
 * safe on hosted, where every other world is a remote sandbox. It has no
 * checkouts (no repositories, so no pull request), no snapshots, nothing to
 * park and nothing billed as compute.
 */
export class NoneWorldProvider implements WorldProvider {
  readonly kind = NO_COMPUTER;
  readonly parkable = false;
  readonly capabilities = { remote: false, pty: false, snapshots: false, ports: false, networkPolicy: false } as const;

  async create(spec: WorldSpec): Promise<World> {
    const root = computerlessRoot(spec.taskId);
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const handle: WorldHandle = {
      kind: NO_COMPUTER,
      id: spec.taskId,
      root,
      branch: taskBranch(spec.taskId),
      base: spec.base,
      ...(spec.target ? { target: spec.target } : {}),
      repos: [],
      ...(spec.generation ? { generation: spec.generation } : {}),
    };
    return new NoneWorld(handle);
  }

  async open(handle: WorldHandle): Promise<World> {
    return new NoneWorld(handle);
  }

  async status(): Promise<'ready'> { return 'ready'; }

  async destroy(handle: WorldHandle): Promise<void> {
    await new NoneWorld(handle).destroy();
  }
}

class NoneWorld implements World {
  constructor(public handle: WorldHandle) {}

  async exec(cmd: string): Promise<ExecResult> {
    throw new NoComputerError(`cannot run ${JSON.stringify(cmd)}`);
  }
  async startProcess(): Promise<WorldProcess> {
    throw new NoComputerError('cannot start a process');
  }
  async openPty(): Promise<WorldPty> {
    throw new NoComputerError('cannot open a terminal');
  }
  async fetchPort(port: number): Promise<never> {
    throw new NoComputerError(`nothing listens on port ${port}`);
  }
  async previewSocketTarget(port: number): Promise<never> {
    throw new NoComputerError(`nothing listens on port ${port}`);
  }
  async desktopSession(): Promise<never> {
    throw new NoComputerError('there is no desktop');
  }
  async addCheckout(): Promise<never> {
    throw new NoComputerError('cannot check out a branch');
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
  async *readFileStream(relPath: string, range?: { start: number; end: number }): AsyncGenerator<Buffer> {
    for await (const chunk of fs.createReadStream(this.filePath(relPath), range ?? {})) yield chunk as Buffer;
  }
  fileSize(relPath: string): Promise<number> { return regularFileSize(this.filePath(relPath)); }
  async writeFile(relPath: string, content: string): Promise<void> {
    await this.writeFileBuffer(relPath, Buffer.from(content));
  }
  async writeFileBuffer(relPath: string, content: Buffer): Promise<void> {
    const abs = this.filePath(relPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(abs, content, { mode: 0o600 });
  }
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (entry.name !== PLATFORM_DIR) walk(path.join(dir, entry.name), rel); }
        else if (entry.isFile()) out.push(rel);
      }
    };
    if (fs.existsSync(this.handle.root)) walk(this.handle.root, '');
    return out;
  }
  async destroy(): Promise<void> {
    // Only ever the directory this provider made: a handle is data.
    if (this.handle.root !== computerlessRoot(this.handle.id)) return;
    await fs.promises.rm(this.handle.root, { recursive: true, force: true });
  }
  private filePath(relPath: string): string {
    const safe = worldRelativePath(relPath);
    if (safe === '.') throw new Error('path is a directory');
    return path.join(this.handle.root, ...safe.split('/'));
  }
}
