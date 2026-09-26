import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorktreeProvider } from '../src/world/worktree.js';
import { gitOrThrow, git, ensureIdentity } from '../src/world/git.js';
import { brokerPublishBranch, brokerPushBranches, brokerFinalizeMerge, brokerImportTaskBranch, brokerRefreshUpstream, brokerRefreshBranch } from '../src/world/git-broker.js';
import { createGitBundle, downloadGitBundle, uploadGitBundle } from '../src/world/git-transfer.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-transfer-test-'));
  roots.push(root);
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  await gitOrThrow(source, ['init', '-q', '-b', 'main']);
  await ensureIdentity(source);
  fs.writeFileSync(path.join(source, 'base.txt'), 'base\n');
  await commit(source);
  const remote = path.join(root, 'remote.git');
  await gitOrThrow(root, ['clone', '-q', '--bare', source, remote]);
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${root}/.insteadOf`, GIT_CONFIG_VALUE_0: 'git@example:' };
  const provider = new WorktreeProvider(path.join(root, 'worlds'));
  async function world(id: string) {
    const seed = path.join(root, id);
    await gitOrThrow(root, ['clone', '-q', '--single-branch', '--branch', 'main', remote, seed]);
    const world = await provider.create({ taskId: id, repo: seed, base: 'main' });
    world.handle.kind = 'e2b';
    world.handle.repo = world.handle.repos![0]!.repo = 'git@example:remote.git';
    world.handle.repos![0]!.name = 'app';
    world.handle.repos![0]!.baseSha = await gitOrThrow(seed, ['rev-parse', 'HEAD']);
    return world;
  }
  return { root, source, remote, env, world };
}
async function commit(dir: string) {
  await gitOrThrow(dir, ['add', '-A']);
  await gitOrThrow(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'test']);
}
function randomFile(file: string, mib: number) {
  const fd = fs.openSync(file, 'w');
  try { for (let i = 0; i < mib; i++) fs.writeSync(fd, crypto.randomBytes(1024 * 1024)); }
  finally { fs.closeSync(fd); }
}

describe('bounded incremental Git handoffs', () => {
  it('publishes, checkpoints, imports, refreshes and lands a small edit over large deleted history under a small explicit quota', async () => {
    const f = await fixture();
    randomFile(path.join(f.source, 'old.bin'), 8);
    await commit(f.source);
    fs.unlinkSync(path.join(f.source, 'old.bin'));
    await commit(f.source);
    await gitOrThrow(f.source, ['push', f.remote, 'main']);
    const author = await f.world('author');
    const reader = await f.world('reader');
    const read = vi.spyOn(author, 'readFileBuffer');
    vi.stubEnv('KARMAX_MAX_GIT_BUNDLE_MB', '1');
    fs.writeFileSync(path.join(author.handle.root, 'report.md'), 'a tiny report\n');
    await commit(author.handle.root);
    const tip = await gitOrThrow(author.handle.root, ['rev-parse', 'HEAD']);
    expect(await brokerPushBranches(author, f.env)).toEqual({ pushed: ['app'], skipped: [] });
    expect(read).toHaveBeenCalled();
    read.mockClear();
    expect(await brokerPublishBranch(author, f.env)).toEqual({ pushed: ['app'], skipped: [] });
    expect(read).not.toHaveBeenCalled(); // already published: no full-history fallback
    const imported = await brokerImportTaskBranch(reader, author.handle, 'author', f.env);
    expect(imported[0]!.sha).toBe(tip);
    expect(await gitOrThrow(reader.handle.root, ['show', `${imported[0]!.ref}:report.md`])).toBe('a tiny report');
    const importWrite = vi.spyOn(reader, 'writeFileBuffer');
    expect((await brokerImportTaskBranch(reader, author.handle, 'author', f.env))[0]!.sha).toBe(tip);
    expect(importWrite).not.toHaveBeenCalled();
    importWrite.mockRestore();
    const landed = await brokerFinalizeMerge(author, 'main', undefined, f.env);
    expect(landed.merged).toBe(true);
    expect((await brokerRefreshUpstream(reader, f.env, 'main')).refs[0]!.sha).toBe(landed.sha);
    const write = vi.spyOn(reader, 'writeFileBuffer');
    expect((await brokerRefreshUpstream(reader, f.env, 'main')).refs[0]!.sha).toBe(landed.sha);
    expect(write).not.toHaveBeenCalled();
    // Remote-ahead refresh and checkpoint racing a child merge must also avoid
    // retransmitting old history, while preserving fast-forward-only behavior.
    await gitOrThrow(f.source, ['fetch', f.remote, author.handle.branch]);
    await gitOrThrow(f.source, ['checkout', '-q', '-B', 'human', 'FETCH_HEAD']);
    fs.writeFileSync(path.join(f.source, 'human.txt'), 'remote work');
    await commit(f.source);
    await gitOrThrow(f.source, ['push', f.remote, `HEAD:refs/heads/${author.handle.branch}`]);
    expect((await brokerRefreshBranch(author, f.env)).updated[0]!.sha).toBe(await gitOrThrow(f.source, ['rev-parse', 'HEAD']));
    expect(await brokerPublishBranch(author, f.env)).toEqual({ pushed: ['app'], skipped: [] });
  });

  it('transfers genuinely new content over 256 MiB in both directions, then lands and verifies it from a fresh clone', async () => {
    const f = await fixture();
    const author = await f.world('large-author');
    const reader = await f.world('large-reader');
    randomFile(path.join(author.handle.root, 'large.bin'), 257);
    await commit(author.handle.root);
    const blob = await gitOrThrow(author.handle.root, ['rev-parse', 'HEAD:large.bin']);
    const read = author.readFileBuffer.bind(author);
    let downloaded = 0;
    vi.spyOn(author, 'readFileBuffer').mockImplementation(async file => {
      const data = await read(file);
      expect(data.length).toBeLessThanOrEqual(4 * 1024 * 1024);
      downloaded += data.length;
      return data;
    });
    expect(await brokerPushBranches(author, f.env)).toEqual({ pushed: ['app'], skipped: [] });
    expect(downloaded).toBeGreaterThan(256 * 1024 * 1024);
    const write = reader.writeFileBuffer!.bind(reader);
    let uploaded = 0;
    vi.spyOn(reader, 'writeFileBuffer').mockImplementation(async (file, data) => {
      expect(data.length).toBeLessThanOrEqual(4 * 1024 * 1024);
      uploaded += data.length;
      return write(file, data);
    });
    const refs = await brokerImportTaskBranch(reader, author.handle, 'large-author', f.env);
    expect(uploaded).toBeGreaterThan(256 * 1024 * 1024);
    expect(await gitOrThrow(reader.handle.root, ['rev-parse', `${refs[0]!.ref}:large.bin`])).toBe(blob);
    expect((await brokerFinalizeMerge(author, 'main', undefined, f.env)).merged).toBe(true);
    const verify = path.join(f.root, 'verify');
    await gitOrThrow(f.root, ['clone', '-q', f.remote, verify]);
    expect(await gitOrThrow(verify, ['hash-object', 'large.bin'])).toBe(blob);
    expect((await git(verify, ['fsck', '--full'])).code).toBe(0);
    expect((await git(author.handle.root, ['status', '--porcelain'])).stdout).toBe('');
    expect((await git(reader.handle.root, ['status', '--porcelain'])).stdout).toBe('');
  }, 300_000);

  it('checks explicit quotas before file APIs allocate payloads, validates configuration, and cleans up failed transfers', async () => {
    const f = await fixture();
    const world = await f.world('quota');
    const file = path.join(f.root, 'incoming.bundle');
    randomFile(file, 5);
    fs.copyFileSync(file, path.join(world.handle.root, 'outgoing.bundle'));
    const read = vi.spyOn(world, 'readFileBuffer');
    const write = vi.spyOn(world, 'writeFileBuffer');
    vi.stubEnv('KARMAX_MAX_GIT_BUNDLE_MB', '1');
    await expect(downloadGitBundle(world, 'outgoing.bundle', path.join(f.root, 'download'))).rejects.toThrow('configured 1 MiB');
    await expect(uploadGitBundle(world, file, 'incoming.bundle')).rejects.toThrow('configured 1 MiB');
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    vi.stubEnv('KARMAX_MAX_GIT_BUNDLE_MB', 'NaN');
    await expect(uploadGitBundle(world, file, 'incoming.bundle')).rejects.toThrow('positive number');
    vi.unstubAllEnvs();
    read.mockResolvedValueOnce(Buffer.alloc(0));
    await expect(downloadGitBundle(world, 'outgoing.bundle', path.join(f.root, 'download'))).rejects.toThrow('Truncated');
    expect(fs.readdirSync(world.handle.root).some(f => f.endsWith('.chunk'))).toBe(false);
    write.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(uploadGitBundle(world, file, 'incoming.bundle')).rejects.toThrow('provider unavailable');
    expect(fs.readdirSync(world.handle.root).some(f => f.endsWith('.chunk'))).toBe(false);
  });

  it('pins the branch snapshot during negotiation and handles a destination ahead without an empty-bundle fallback', async () => {
    const f = await fixture();
    const base = await gitOrThrow(f.source, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(f.source, 'new.txt'), 'next');
    await commit(f.source);
    const tip = await gitOrThrow(f.source, ['rev-parse', 'HEAD']);
    const file = path.join(f.root, 'pinned.bundle');
    let changed = false;
    const bundle = await createGitBundle(async args => {
      if (args.includes('--no-walk') && !changed) {
        changed = true;
        await gitOrThrow(f.source, ['update-ref', 'refs/heads/main', base]);
      }
      return git(f.source, args);
    }, 'refs/heads/main', file, [base]);
    expect(bundle.sha).toBe(tip);
    expect(await gitOrThrow(f.source, ['bundle', 'list-heads', file])).toContain(tip);
    const noop = await createGitBundle(args => git(f.source, args), 'refs/heads/main', path.join(f.root, 'empty.bundle'), [tip]);
    expect(noop).toEqual({ sha: base, ref: base });
    expect(fs.existsSync(path.join(f.root, 'empty.bundle'))).toBe(false);
    expect(await gitOrThrow(f.source, ['for-each-ref', '--format=%(refname)'])).not.toContain('karmax-transfer-');
  });

  it('does not publish corrupt transfers, cleans up, and permits a clean retry', async () => {
    const f = await fixture();
    const author = await f.world('corruption');
    fs.writeFileSync(path.join(author.handle.root, 'report.md'), 'report');
    await commit(author.handle.root);
    const original = author.readFileBuffer.bind(author);
    const read = vi.spyOn(author, 'readFileBuffer').mockImplementation(async file => {
      const data = await original(file);
      data[data.length - 1] = data[data.length - 1]! ^ 0xff;
      return data;
    });
    const receipt = vi.fn();
    const failed = await brokerPushBranches(author, f.env, undefined, {}, receipt);
    expect(failed.skipped).toEqual(['app']);
    expect(failed.errors?.app).toMatch(/bundle import failed/);
    expect(receipt).not.toHaveBeenCalled();
    expect((await git(f.remote, ['rev-parse', '--verify', `refs/heads/${author.handle.branch}`])).code).not.toBe(0);
    expect((await git(author.handle.root, ['status', '--porcelain'])).stdout).toBe('');
    read.mockRestore();
    expect(await brokerPushBranches(author, f.env, undefined, {}, receipt)).toEqual({ pushed: ['app'], skipped: [] });
    expect(receipt).toHaveBeenCalledOnce();
  });
});

it('bounds hosted bundle downloads before reading bytes (WD-9)', async () => {
  vi.stubEnv('KARMAX_DEPLOYMENT', 'hosted');
  const readFileBuffer = vi.fn(async () => Buffer.alloc(0));
  const world = { handle: { root: '/w' }, readFileBuffer,
    exec: vi.fn(async () => ({ code: 0, stdout: String(2 * 1024 ** 3), stderr: '' })) } as any;
  await expect(downloadGitBundle(world, 'bundle', '/tmp/must-not-create-git-bundle')).rejects.toThrow('policy');
  expect(readFileBuffer).not.toHaveBeenCalled();
});

it('cancels bundle downloads before creating an output file (WD-9)', async () => {
  const controller = new AbortController(); controller.abort(new Error('transfer cancelled'));
  const world = { handle: { root: '/w' }, exec: vi.fn(async () => ({ code: 0, stdout: '0', stderr: '' })) } as any;
  await expect(downloadGitBundle(world, 'bundle', '/tmp/must-not-create-git-bundle', controller.signal)).rejects.toThrow('transfer cancelled');
  expect(world.exec).not.toHaveBeenCalled();
});
