/** Isolated data-plane check on real E2B; does not exercise gateway/Temporal. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Sandbox } from 'e2b';
import { readResourceChunks, transferResourceChunk } from '../src/world/resource-transfer.js';
import type { World } from '../src/world/types.js';
const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
const box = await Sandbox.create(process.env.KARMAX_E2B_PROBE_TEMPLATE || 'uj125w982t7wflqad4ig', {
  timeoutMs: 180_000, metadata: { latencyProbe: 'task326-resource-integrity' },
});
const report: Record<string, unknown> = { sandboxId: box.sandboxId, startedAt: new Date().toISOString(),
  scope: 'production host to real E2B data plane; isolated from gateway/Temporal', checks: [] };
const checks = report.checks as string[];
const world = { handle: { root: '/tmp' },
  async writeFile(file: string, data: string) { await box.files.write(`/tmp/${file}`, data); },
  async writeFileBuffer(file: string, data: Buffer) { await box.files.write(`/tmp/${file}`, Uint8Array.from(data).buffer); },
  async exec(cmd: string, args: string[]) {
    try {
      const r = await box.commands.run([cmd, ...args].map(quote).join(' '), { cwd: '/tmp', timeoutMs: 60_000 });
      return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode };
    } catch (error: any) {
      if (typeof error.exitCode === 'number') return { stdout: error.stdout || '', stderr: error.stderr || '', code: error.exitCode };
      throw error;
    }
  },
} as unknown as World;
const read = async (file: string, bytes?: number) => {
  const chunks: Buffer[] = [];
  for await (const data of readResourceChunks(world, file, bytes)) chunks.push(data);
  return Buffer.concat(chunks);
};
try {
  const data = Buffer.concat([Buffer.alloc(1024 * 1024, 0x82), crypto.randomBytes(300 * 1024)]);
  for (const binary of [true, false]) {
    const target = `test-${binary}-it's binary`;
    const adapter = binary ? world : { ...world, writeFileBuffer: undefined } as World;
    await transferResourceChunk(adapter, target, data, 0, { compress: true });
    await transferResourceChunk(adapter, target, data, data.length, { compress: true });
    assert((await read(target, data.length * 2)).equals(Buffer.concat([data, data])));
    checks.push(`binary round trip and append: binary writes=${binary}`);
    await assert.rejects(() => read(target, data.length * 2 + 1), /truncated/);
    checks.push(`truncated read rejected: binary writes=${binary}`);
  }
  await assert.rejects(() => read('missing-file'));
  checks.push('missing file pipeline failure rejected');
  report.passed = true;
} finally {
  await box.kill(); report.destroyed = true;
  console.log(JSON.stringify(report));
}
