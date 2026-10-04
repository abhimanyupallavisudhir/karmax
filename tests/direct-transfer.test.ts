import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';
import { DirectTransfer, DirectTransferError } from '../src/world/direct-transfer.js';
import { CHUNK_BYTES, chunkId, openCompressed, openDeterministic, sha256 } from '../src/world/chunk-store.js';

/** A stand-in for presigned object-store URLs: PUT stores, GET serves, by path. */
export async function presignServer() {
  const objects = new Map<string, Buffer>();
  let failNext = 0;
  const server = http.createServer((request, response) => {
    const key = decodeURIComponent(new URL(request.url!, 'http://x').pathname.slice(1));
    if (failNext > 0) { failNext--; response.writeHead(503).end(); request.resume(); return; }
    if (request.method === 'PUT') {
      const parts: Buffer[] = [];
      request.on('data', (part) => parts.push(part));
      request.on('end', () => { objects.set(key, Buffer.concat(parts)); response.writeHead(200).end(); });
    } else if (request.method === 'GET') {
      const data = objects.get(key);
      if (data) response.writeHead(200).end(data); else response.writeHead(404).end();
    } else response.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { objects, url: (key: string) => `http://127.0.0.1:${port}/${encodeURIComponent(key)}?X-Amz-Signature=secret`,
    failNext: (count: number) => { failNext = count; }, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function worldFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-direct-transfer-'));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
  await gitOrThrow(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
  const world = await new WorktreeProvider(path.join(dir, 'worlds')).create({ taskId: 'direct', repo, base: 'main', target: 'main' });
  const stamp = (file: string) => { const s = fs.lstatSync(file, { bigint: true }); return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`; };
  return { world, root: world.handle.root, stamp, cleanup: async () => { await world.destroy(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

describe('direct resource transfer (in-world half)', () => {
  it('packs, chunks and hashes files into objects the worker reads like its own', async () => {
    const { world, root, stamp, cleanup } = await worldFixture();
    const key = crypto.randomBytes(32);
    const transfer = new DirectTransfer(world);
    try {
      fs.mkdirSync(path.join(root, 'data'));
      const small = ['a', 'b', 'c'].map((name, i) => {
        const file = path.join(root, 'data', `${name}.txt`);
        fs.writeFileSync(file, `page ${name}\n`.repeat(i + 1));
        return { source: file, path: `${name}.txt`, stamp: stamp(file), bytes: fs.statSync(file).size };
      });
      const unchanged = small[1]!;
      const packed = await transfer.run<{ packs: Array<{ id: string; file: string; bytes: number; size: number }>;
        files: Array<Record<string, unknown>> }>('pack', { key: key.toString('base64'), ns: 'loc', packBytes: 20,
          files: small.map((file) => ({ ...file, ...(file === unchanged ? { base: sha256(fs.readFileSync(file.source)) } : {}) })) });
      // A file that hashes to its baseline is reported, not packed; the rest fill packs of at most packBytes.
      expect(packed.files.find((file) => file.path === 'b.txt')).toEqual({ path: 'b.txt', same: true });
      expect(packed.packs).toHaveLength(2);
      for (const pack of packed.packs) {
        const plain = await openCompressed(key, pack.id, fs.readFileSync(pack.file), 1 << 20);
        expect(pack.id).toBe(chunkId(key, 'loc', plain, 'pack'));
        expect(pack.bytes).toBe(plain.length);
        expect(pack.size).toBe(fs.statSync(pack.file).size);
        for (const member of packed.files.filter((file) => file.pack === pack.id)) {
          const slice = plain.subarray(member.offset as number, (member.offset as number) + (member.bytes as number));
          expect(slice.equals(fs.readFileSync(path.join(root, 'data', member.path as string)))).toBe(true);
          expect(member.sha256).toBe(sha256(slice));
        }
      }
      // A file changed since it was listed is reported, never packed torn.
      fs.appendFileSync(small[0]!.source, 'more');
      const again = await transfer.run<{ files: Array<Record<string, unknown>> }>('pack', { key: key.toString('base64'), packBytes: 40,
        files: [small[0]] });
      expect(again.files).toEqual([{ path: 'a.txt', changed: true }]);

      const large = path.join(root, 'data', 'large.bin');
      const bytes = crypto.randomBytes(2 * CHUNK_BYTES + 5);
      fs.writeFileSync(large, bytes);
      const read = (offset: number) => transfer.run<{ chunks: Array<{ id: string; file: string; bytes: number }>; next: number; eof: boolean }>(
        'chunks', { key: key.toString('base64'), source: large, path: 'large.bin', stamp: stamp(large), offset, count: 2, chunkBytes: CHUNK_BYTES });
      const first = await read(0);
      expect(first).toMatchObject({ next: 2 * CHUNK_BYTES, eof: false });
      const second = await read(first.next);
      expect(second).toMatchObject({ next: bytes.length, eof: true });
      const chunks = [...first.chunks, ...second.chunks];
      expect(Buffer.concat(chunks.map((chunk) => openDeterministic(key, chunk.id, fs.readFileSync(chunk.file)))).equals(bytes)).toBe(true);
      expect(chunks.map((chunk) => chunk.id)).toEqual(chunks.map((_, i) =>
        chunkId(key, undefined, bytes.subarray(i * CHUNK_BYTES, Math.min(bytes.length, (i + 1) * CHUNK_BYTES)))));
      expect(await transfer.run('hash', { source: large, path: 'large.bin', stamp: stamp(large) }))
        .toEqual({ sha256: sha256(bytes), bytes: bytes.length });
      // An empty file is one empty chunk, as the manifest requires.
      const empty = path.join(root, 'data', 'empty.bin'); fs.writeFileSync(empty, '');
      const none = await transfer.run<{ chunks: Array<{ bytes: number }>; eof: boolean }>('chunks', { key: key.toString('base64'),
        source: empty, path: 'empty.bin', stamp: stamp(empty), offset: 0, count: 4, chunkBytes: CHUNK_BYTES });
      expect(none).toMatchObject({ eof: true, chunks: [{ bytes: 0 }] });
      // A changed file fails the read, naming the file.
      await expect(transfer.run('chunks', { key: key.toString('base64'), source: large, path: 'large.bin', stamp: 'stale',
        offset: 0, count: 1, chunkBytes: CHUNK_BYTES })).rejects.toThrow(new DirectTransferError('chunks', 'large.bin changed while it was being saved'));
    } finally { await transfer.cleanup(); await cleanup(); }
  }, 30_000);

  it('uploads staged objects to their URLs, retrying transient failures, and leaves nothing staged', async () => {
    const { world, cleanup } = await worldFixture();
    const server = await presignServer();
    const transfer = new DirectTransfer(world);
    try {
      fs.mkdirSync(transfer.staging, { recursive: true });
      const items = [0, 1, 2, 3, 4].map((i) => {
        const file = path.join(transfer.staging, `${i}.bin`);
        fs.writeFileSync(file, `object ${i}`);
        return { file, url: server.url(`chunks/${i}.bin`) };
      });
      server.failNext(2);
      expect(await transfer.run('upload', { items, concurrency: 3 })).toEqual({ uploaded: 5 });
      expect([...server.objects.keys()].sort()).toEqual([0, 1, 2, 3, 4].map((i) => `chunks/${i}.bin`));
      expect(server.objects.get('chunks/3.bin')!.toString()).toBe('object 3');
      expect(fs.readdirSync(transfer.staging)).toEqual([]);
      // A refusal is not retried, and its message never carries the signed URL.
      fs.writeFileSync(path.join(transfer.staging, 'x.bin'), 'x');
      const refused = transfer.run('upload', { items: [{ file: path.join(transfer.staging, 'x.bin'), url: server.url('missing/..') }] });
      await server.close();
      const error = await refused.then(() => undefined, (failure) => failure as Error);
      expect(error?.message).toMatch(/upload failed/);
      expect(error?.message).not.toContain('secret');
      expect(fs.existsSync(path.join(transfer.staging, 'x.bin'))).toBe(false);
    } finally { await transfer.cleanup(); await cleanup(); }
  }, 60_000);
});
