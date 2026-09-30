import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { readRegularFilePrefix, readWorldFilePrefix } from '../src/world/file-prefix.js';
import { MemoryWorldProvider } from '../src/world/memory.js';
import { E2BWorldProvider, type E2BSandboxLike } from '../src/world/e2b.js';
import { DaytonaWorldProvider, type DaytonaSandboxLike } from '../src/world/daytona.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import type { World } from '../src/world/types.js';

// AD-1: a tool or page that shows part of a sandbox file must never bring the
// whole file into the worker or gateway. One huge (or endless) file there is
// every tenant's outage on a shared host.
const GiB = 1024 ** 3;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-prefix-')); roots.push(root);
  return root;
}

describe('host file prefix', () => {
  it('reads only the requested prefix of a huge file', async () => {
    const file = path.join(scratch(), 'huge');
    fs.writeFileSync(file, 'head');
    fs.truncateSync(file, 4 * GiB); // sparse: no disk, but 4 GiB to a whole read
    const data = await readRegularFilePrefix(file, 10);
    expect(data).toEqual(Buffer.concat([Buffer.from('head'), Buffer.alloc(6)]));
  });

  it('returns a short file whole', async () => {
    const file = path.join(scratch(), 'short');
    fs.writeFileSync(file, 'short');
    expect((await readRegularFilePrefix(file, 1024)).toString()).toBe('short');
  });

  it('refuses a FIFO without waiting for a writer, and a directory', async () => {
    const root = scratch();
    const fifo = path.join(root, 'pipe');
    execFileSync('mkfifo', [fifo]);
    await expect(readRegularFilePrefix(fifo, 10)).rejects.toThrow('not a regular file');
    await expect(readRegularFilePrefix(root, 10)).rejects.toThrow('not a regular file');
  });

  it('bounds a real memory world', async () => {
    const world = await new MemoryWorldProvider().create({ taskId: 'prefix', base: 'main' } as any);
    try {
      await world.writeFile('big.txt', 'x'.repeat(1000));
      expect((await readWorldFilePrefix(world, 'big.txt', 7)).toString()).toBe('xxxxxxx');
    } finally { await world.destroy(); }
  });
});

describe('remote file prefix', () => {
  it('stops an E2B streamed read at the limit and cancels the rest', async () => {
    let pulled = 0, cancelled = false, signal: AbortSignal | undefined;
    const sandbox: E2BSandboxLike = {
      sandboxId: 'sbx_prefix',
      commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      files: {
        async read(_file, options: any = {}) {
          if (options.format !== 'stream') throw new Error('whole-file read of an endless file');
          signal = options.signal;
          return new ReadableStream<Uint8Array>({
            pull(controller) { pulled++; controller.enqueue(new Uint8Array(4096).fill(97)); },
            cancel() { cancelled = true; },
          }) as any;
        },
        write: async () => undefined,
      },
      pty: { create: async () => ({ pid: 1 }), sendInput: async () => undefined, resize: async () => undefined, kill: async () => undefined },
      pause: async () => undefined, kill: async () => undefined, updateNetwork: async () => undefined,
    };
    const world = await new E2BWorldProvider({ create: async () => sandbox, connect: async () => sandbox })
      .create({ taskId: 'task-prefix', base: 'main' });
    const data = await readWorldFilePrefix(world, 'endless', 10_000);
    expect(data.length).toBe(10_000);
    expect(data.every((byte) => byte === 97)).toBe(true);
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it('reads a Daytona prefix inside the sandbox, binary-safe', async () => {
    const commands: string[] = [];
    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    const sandbox: DaytonaSandboxLike = {
      id: 'fake', state: 'started', updateNetworkSettings: async () => {},
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          return { exitCode: 0, result: command.includes('head -c') ? `${bytes.toString('base64')}\n` : '' };
        },
        createPty: async () => ({ waitForConnection: async () => {}, wait: () => new Promise(() => {}) }),
      },
      fs: { downloadFile: async () => { throw new Error('whole-file download'); }, uploadFile: async () => {} },
      getUserHomeDir: async () => '/home/daytona', getSignedPreviewUrl: async () => ({ url: 'https://invalid/' }),
      start: async () => {}, stop: async () => {}, archive: async () => {}, delete: async () => {},
    } as any;
    const world = await new DaytonaWorldProvider({ create: async () => sandbox, get: async () => sandbox })
      .create({ taskId: 'prefix', base: 'main' });
    expect(await readWorldFilePrefix(world, 'data.bin', 5)).toEqual(bytes);
    const read = commands.find((command) => command.includes('head -c'))!;
    expect(read).toContain("'5'");
    expect(read).toContain('data.bin');
  });
});

describe('read_file tool', () => {
  it('reads a bounded prefix and truncates exactly as before', async () => {
    const text = 'y'.repeat(100_000);
    let limit = 0;
    const world = {
      readFile: async () => { throw new Error('whole-file read'); },
      readFileBuffer: async () => { throw new Error('whole-file read'); },
      readFilePrefix: async (_path: string, maxBytes: number) => { limit = maxBytes; return Buffer.from(text).subarray(0, maxBytes); },
    } as unknown as World;
    const result = await platformToolHandlers(world, { emit() {} } as any).read_file!({ path: 'log.txt' });
    expect(result).toBe(`${text.slice(0, 12_000)}\n…(truncated)`);
    expect(limit).toBeLessThanOrEqual(64 * 1024);
  });

  it('shows a short file whole and reports a missing one', async () => {
    const world = await new MemoryWorldProvider().create({ taskId: 'read-file', base: 'main' } as any);
    try {
      await world.writeFile('notes.md', 'é naïve ✓');
      const handlers = platformToolHandlers(world, { emit() {} } as any);
      expect(await handlers.read_file!({ path: 'notes.md' })).toBe('é naïve ✓');
      expect(await handlers.read_file!({ path: 'missing.md' })).toMatch(/^error: /);
    } finally { await world.destroy(); }
  });
});
