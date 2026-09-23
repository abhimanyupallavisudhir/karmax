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

it.each([true, false])('round trips binary chunks with binary-write support=%s', async (binaryWrite) => {
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
  if (!binaryWrite) {
    world.writeFile = async (file, text) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), text);
    };
    world.writeFileBuffer = undefined;
  }
  try {
    const target = "nested/it's a binary file";
    const first = Buffer.alloc(1024 * 1024, 0x82), second = crypto.randomBytes(300 * 1024);
    const compressed = await transferResourceChunk(world, target, first, 0, { compress: true });
    if (binaryWrite) expect(compressed).toBeLessThan(first.length / 10);
    else expect(compressed).toBe(first.length);
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

it('rejects failed and truncated remote reads and observes cancellation', async () => {
  const { readResourceChunks } = await import('../src/world/resource-transfer.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-read-'));
  const world = { async exec(command: string, args: string[]) {
    try { const r = await run(command, args, { cwd: root, maxBuffer: 32 * 1024 * 1024 }); return { ...r, code: 0 }; }
    catch (e: any) { return { code: e.code, stderr: e.stderr, stdout: e.stdout }; }
  } } as World;
  const read = async (file: string, bytes?: number, check?: () => Promise<void>) => {
    const chunks = [];
    for await (const data of readResourceChunks(world, file, bytes, check)) chunks.push(data);
    return Buffer.concat(chunks);
  };
  try {
    await expect(read('missing')).rejects.toThrow();
    const data = crypto.randomBytes(16 * 1024 * 1024 + 17);
    await fs.writeFile(path.join(root, "it's binary"), data);
    expect((await read("it's binary", data.length)).equals(data)).toBe(true);
    await expect(read("it's binary", data.length + 1)).rejects.toThrow('truncated');
    let checks = 0;
    await expect(read("it's binary", data.length, async () => {
      if (++checks === 3) throw new Error('superseded');
    })).rejects.toThrow('superseded');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
