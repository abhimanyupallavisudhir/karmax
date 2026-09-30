import path from 'node:path';
import { Context } from '@temporalio/activity';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { World, ExecResult } from './types.js';

// Provider file APIs are buffer based. Stage one bounded piece at a time so
// even an initial/full-history handoff never buffers a repository on the host.
const CHUNK_BYTES = 4 * 1024 * 1024;
export type GitRunner = (args: string[]) => Promise<ExecResult>;
export interface GitBundle { path?: string; ref: string; sha: string }
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export async function gitTransferCheck(result: Promise<ExecResult>): Promise<string> {
  const value = await result;
  if (value.code !== 0) throw new Error(value.stderr || value.stdout || 'Git transfer command failed');
  return value.stdout.trim();
}

/** Only destination-owned object IDs are offered as prerequisites. Bounds
 * negotiation even for repositories with thousands of branches. Missing a
 * common tip affects efficiency, never correctness. */
export async function knownGitCommits(run: GitRunner, extra: string[] = [], preferredRefs: string[] = []): Promise<string[]> {
  const refs = await gitTransferCheck(run(['for-each-ref', '--sort=-committerdate', '--count=64', '--format=%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tavya/tasks', 'refs/karmax/tasks']));
  for (const ref of preferredRefs) {
    const result = await run(['rev-parse', '--verify', `${ref}^{commit}`]);
    if (result.code === 0) extra = [...extra, result.stdout.trim()];
  }
  const head = await run(['rev-parse', '--verify', 'HEAD']);
  const candidates = [...new Set([...extra, head.code === 0 ? head.stdout.trim() : '', ...refs.split('\n')])].filter(s => oid.test(s));
  return presentCommits(run, candidates);
}

async function presentCommits(run: GitRunner, candidates: string[]): Promise<string[]> {
  const valid = candidates.filter(sha => oid.test(sha));
  if (!valid.length) return [];
  // One sandbox RPC, not one per branch. Only literal OIDs reach rev-list.
  const result = await gitTransferCheck(run(['rev-list', '--no-walk', '--ignore-missing', ...valid]));
  return result.split('\n').filter(sha => oid.test(sha));
}

/** Pin the exported tip before negotiating; concurrent branch edits must not
 * change either the bytes transferred or the publication receipt. */
export async function createGitBundle(run: GitRunner, branch: string, file: string, known: string[]): Promise<GitBundle> {
  const sha = await gitTransferCheck(run(['rev-parse', '--verify', `${branch}^{commit}`]));
  if (!oid.test(sha)) throw new Error('Invalid Git transfer tip');
  if (known.includes(sha)) return { sha, ref: sha };
  const ref = `refs/heads/karmax-transfer-${crypto.randomUUID()}`;
  await gitTransferCheck(run(['update-ref', ref, sha]));
  try {
    const exclusions = (await presentCommits(run, known)).map(sha => `^${sha}`);
    // The destination can have the tip through a newer commit, without having
    // a ref pointing exactly at it. Do not fall back to a huge full bundle.
    const missing = await gitTransferCheck(run(['rev-list', '--count', sha, ...exclusions]));
    if (missing === '0') return { sha, ref: sha };
    await gitTransferCheck(run(['bundle', 'create', file, ref, ...exclusions]));
    return { path: file, ref, sha };
  } finally {
    await run(['update-ref', '-d', ref]);
  }
}

function checkSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid Git bundle size');
  const configured = process.env.KARMAX_MAX_GIT_BUNDLE_MB
    ?? (process.env.KARMAX_DEPLOYMENT === 'hosted' ? '1024' : undefined);
  if (configured === undefined) return;
  const limit = Number(configured);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('KARMAX_MAX_GIT_BUNDLE_MB must be a positive number');
  if (bytes > limit * 1024 * 1024)
    throw new Error(`Git bundle (${bytes} bytes) exceeds configured ${limit} MiB policy`);
}

export async function downloadGitBundle(world: World, relative: string, destination: string, signal = activitySignal()): Promise<void> {
  signal?.throwIfAborted();
  const cwd = world.handle.root;
  const bytes = Number(await gitTransferCheck(world.exec('stat', ['-c', '%s', '--', relative], { cwd })));
  checkSize(bytes);
  const piece = `${relative}.${crypto.randomUUID()}.chunk`;
  const disk = await fs.promises.statfs(path.dirname(destination));
  if (disk.bavail * disk.bsize < bytes + 64 * 1024 * 1024) throw new Error('Insufficient disk space for Git bundle');
  signal?.throwIfAborted();
  const output = await fs.promises.open(destination, 'wx', 0o600);
  try {
    for (let offset = 0; offset < bytes; offset += CHUNK_BYTES) {
      signal?.throwIfAborted();
      await gitTransferCheck(world.exec('dd', [`if=${relative}`, `of=${piece}`, `bs=${CHUNK_BYTES}`, `skip=${offset / CHUNK_BYTES}`, 'count=1', 'status=none'], { cwd }));
      const data = await world.readFileBuffer(piece);
      if (data.length !== Math.min(CHUNK_BYTES, bytes - offset)) throw new Error('Truncated Git bundle transfer');
      signal?.throwIfAborted();
      await output.writeFile(data);
    }
  } catch (error) {
    await fs.promises.rm(destination, { force: true });
    throw error;
  } finally {
    await output.close();
    await world.exec('rm', ['-f', '--', piece], { cwd }).catch(() => undefined);
  }
}

export async function uploadGitBundle(world: World, source: string, relative: string, signal = activitySignal()): Promise<void> {
  signal?.throwIfAborted();
  const bytes = (await fs.promises.stat(source)).size;
  checkSize(bytes);
  if (!world.writeFileBuffer) throw new Error('world provider cannot receive binary Git handoffs');
  const cwd = world.handle.root;
  const piece = `${relative}.${crypto.randomUUID()}.chunk`;
  try {
    await gitTransferCheck(world.exec('truncate', ['-s', '0', '--', relative], { cwd }));
    let offset = 0;
    for await (const data of fs.createReadStream(source, { highWaterMark: CHUNK_BYTES, signal })) {
      signal?.throwIfAborted();
      await world.writeFileBuffer(piece, data as Buffer);
      await gitTransferCheck(world.exec('dd', [`if=${piece}`, `of=${relative}`, 'bs=1M', `seek=${offset}`, 'oflag=seek_bytes', 'conv=notrunc', 'status=none'], { cwd }));
      offset += (data as Buffer).length;
    }
    if (offset !== bytes) throw new Error('Git bundle changed during transfer');
  } finally {
    await world.exec('rm', ['-f', '--', piece], { cwd }).catch(() => undefined);
  }
}

function activitySignal(): AbortSignal | undefined {
  try { return Context.current().cancellationSignal; } catch { return undefined; }
}
