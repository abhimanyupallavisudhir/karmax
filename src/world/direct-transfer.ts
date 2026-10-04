import crypto from 'node:crypto';
import path from 'node:path';
import type { World } from './types.js';
import { DIRECT_TRANSFER_SCRIPT } from './direct-transfer-script.js';

const SCRIPT_VERSION = crypto.createHash('sha256').update(DIRECT_TRANSFER_SCRIPT).digest('hex').slice(0, 12);
const SCRIPT = `.karmax-injection/resource-transfer-${SCRIPT_VERSION}.mjs`;

/** A direct transfer could not run in the world (no Node, no route to the
 * object store, a failure the script reported). */
export class DirectTransferError extends Error {
  constructor(readonly operation: string, detail: string) { super(`direct resource ${operation} failed: ${detail}`); }
}

/** Runs the in-world half of direct resource transfers (direct-transfer-script.ts)
 * one operation at a time, each its own command with its input on stdin. */
export class DirectTransfer {
  private installed?: Promise<void>;
  readonly staging: string;

  constructor(private world: World, run = crypto.randomBytes(8).toString('hex')) {
    this.staging = path.posix.join(world.handle.root, '.karmax-injection', 'resource-staging', run);
  }

  async run<T>(operation: string, input: Record<string, unknown>, timeoutMs = 10 * 60_000): Promise<T> {
    this.installed ??= this.world.writeFile(SCRIPT, DIRECT_TRANSFER_SCRIPT).catch((error) => { this.installed = undefined; throw error; });
    await this.installed;
    const result = await this.world.exec('node', [path.posix.join(this.world.handle.root, SCRIPT), operation],
      { cwd: this.world.handle.root, input: JSON.stringify({ dir: this.staging, ...input }), timeoutMs });
    if (result.code !== 0)
      throw new DirectTransferError(operation, (result.stderr || result.stdout).trim().split('\n').pop() || `exit ${result.code}`);
    try { return JSON.parse(result.stdout) as T; }
    catch { throw new DirectTransferError(operation, 'unreadable result'); }
  }

  /** Remove anything staged and not uploaded; never fails the caller. */
  async cleanup(): Promise<void> {
    if (this.installed) await this.run('cleanup', {}, 60_000).catch(() => undefined);
  }
}
