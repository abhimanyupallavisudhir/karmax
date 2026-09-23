import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transferResourceChunk } from '../src/world/resource-transfer.js';
import type { World } from '../src/world/types.js';
const run = promisify(execFile);

it('round trips compressed, incompressible, empty and appended binary chunks through real gzip', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-transfer-'));
  const uploads: number[] = [];
  const world = {
    handle: { root },
    async writeFileBuffer(file: string, bytes: Buffer) {
      uploads.push(bytes.length);
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), bytes);
    },
    async exec(command: string, args: string[]) {
      try { const r = await run(command, args, { cwd: root }); return { ...r, code: 0 }; }
      catch (e: any) { return { code: e.code, stderr: e.stderr, stdout: e.stdout }; }
    },
  } as unknown as World;
  try {
    const target = "nested/it's a binary file";
    const first = Buffer.alloc(1024 * 1024, 0x82), second = crypto.randomBytes(300 * 1024);
    const compressed = await transferResourceChunk(world, target, first, 0, { compress: true });
    expect(compressed).toBeLessThan(first.length / 10);
    expect(await transferResourceChunk(world, target, second, first.length, { compress: true })).toBe(second.length);
    await transferResourceChunk(world, target, first, first.length + second.length, { compress: true });
    expect((await fs.readFile(path.join(root, target))).equals(Buffer.concat([first, second, first]))).toBe(true);
    await transferResourceChunk(world, target, Buffer.alloc(0), 0, { compress: true });
    expect((await fs.stat(path.join(root, target))).size).toBe(0);
    expect(await fs.readdir(path.join(root, '.karmax-injection'))).toEqual([]);
    const controller = new AbortController(); controller.abort();
    const count = uploads.length;
    await expect(transferResourceChunk(world, target, first, 0, { compress: true, signal: controller.signal })).rejects.toThrow();
    expect(uploads).toHaveLength(count);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
