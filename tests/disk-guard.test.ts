import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DISK_GUARD_SCRIPT, diskCheckCommand, diskNotice, isDiskFullMessage, parseDiskCheck, parseLargest, worldUsage } from '../src/world/disk.js';

let roots: string[] = [];
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots = []; });
const tmp = (prefix: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(dir); return dir; };

/** A fake /proc with just the memory the guard reads. */
function fakeProc(totalMb: number, availableMb: number) {
  const proc = tmp('karmax-disk-proc-');
  fs.writeFileSync(path.join(proc, 'meminfo'), `MemTotal: ${totalMb * 1024} kB\nMemFree: 1 kB\nMemAvailable: ${availableMb * 1024} kB\n`);
  return proc;
}
const noCgroup = path.join(os.tmpdir(), 'karmax-disk-no-cgroup');

/** Run the guard exactly as a world runs it: the script inline, nothing uploaded. */
function guard(command: 'check' | 'largest', root: string, env: Record<string, string> = {}) {
  const [cmd, ...args] = diskCheckCommand(command, root);
  const result = spawnSync(cmd!, args, { encoding: 'utf8', env: { ...process.env, KARMAX_GUARD_PROC: fakeProc(2048, 1536),
    KARMAX_GUARD_CGROUP: noCgroup, HOME: root, ...env } });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('disk guard', () => {
  it('measures the world\'s disk and memory in one line', () => {
    const root = tmp('karmax-disk-root-');
    const check = parseDiskCheck(guard('check', root, { KARMAX_DISK_RESTORE_KB: String(10 ** 12) }))!;
    expect(check.disk.totalKb).toBeGreaterThan(0);
    expect(check.disk.availKb).toBeGreaterThan(0);
    expect(check.memory).toEqual({ totalKb: 2048 * 1024, availKb: 1536 * 1024 });
    expect(check.ballast).toBe('missing');
    expect(worldUsage(check, 1000)).toEqual({ at: 1000,
      disk: { usedMb: Math.round(check.disk.usedKb / 1024), totalMb: Math.round(check.disk.totalKb / 1024) },
      memory: { usedMb: 512, totalMb: 2048 } });
  });

  it('keeps a ballast file, gives it up when the disk is critically full, and makes it again once there is room', () => {
    const root = tmp('karmax-disk-ballast-');
    const ballast = path.join(root, '.karmax-injection', 'ballast');
    // Room to spare: the ballast is made (1 MB here; 512 MB in a world).
    expect(parseDiskCheck(guard('check', root, { KARMAX_BALLAST_KB: '1024', KARMAX_DISK_RESTORE_KB: '0' }))!.ballast).toBe('created');
    expect(fs.statSync(ballast).size).toBe(1024 * 1024);
    expect(parseDiskCheck(guard('check', root, { KARMAX_BALLAST_KB: '1024', KARMAX_DISK_RESTORE_KB: '0' }))!.ballast).toBe('present');
    // Critically full: it goes, so the agent can start; the reading is from before.
    const released = parseDiskCheck(guard('check', root, { KARMAX_BALLAST_KB: '1024', KARMAX_DISK_CRITICAL_KB: String(10 ** 12) }))!;
    expect(released.ballast).toBe('released');
    expect(released.availBeforeKb).toBeLessThanOrEqual(released.disk.availKb);
    expect(fs.existsSync(ballast)).toBe(false);
    // Not enough room to spare yet: it stays gone.
    expect(parseDiskCheck(guard('check', root, { KARMAX_BALLAST_KB: '1024', KARMAX_DISK_RESTORE_KB: String(10 ** 12) }))!.ballast).toBe('missing');
    expect(fs.existsSync(ballast)).toBe(false);
  });

  // pramana#3: a failed build's 8.4 GB `pramana.db.tmp` and a server holding a
  // deleted database open filled the disk; the agent found out from its own `df`.
  it('names the largest paths, most specific first, and deleted files still held open', () => {
    const root = tmp('karmax-disk-largest-');
    fs.mkdirSync(path.join(root, 'karmax', 'data', 'stage'), { recursive: true });
    fs.writeFileSync(path.join(root, 'karmax', 'data', 'pramana.db.tmp'), Buffer.alloc(3 * 1024 * 1024, 1));
    fs.writeFileSync(path.join(root, 'karmax', 'data', 'stage', 'part'), Buffer.alloc(2 * 1024 * 1024, 1));
    const fd = fs.openSync(path.join(root, 'held.db'), 'w');
    fs.writeSync(fd, Buffer.alloc(2 * 1024 * 1024, 1));
    fs.unlinkSync(path.join(root, 'held.db'));
    try {
      const largest = parseLargest(guard('largest', path.join(root, 'karmax'), { KARMAX_LARGEST_MIN_KB: '1024', KARMAX_GUARD_TMP: path.join(root, 'no-tmp'), KARMAX_GUARD_PROC: '/proc' }));
      expect(largest.paths.map((entry) => entry.path)).toEqual([
        path.join(root, 'karmax', 'data', 'pramana.db.tmp'), path.join(root, 'karmax', 'data', 'stage', 'part')]);
      expect(largest.paths[0]!.kb).toBeGreaterThanOrEqual(3 * 1024);
      expect(largest.held).toContainEqual(expect.objectContaining({ pid: process.pid, path: `${path.join(root, 'held.db')} (deleted)` }));
    } finally { fs.closeSync(fd); }
  });

  it('is plain POSIX sh with no dependency on files in the world', () => {
    expect(DISK_GUARD_SCRIPT).toMatch(/^#!\/bin\/sh/);
    expect(spawnSync('sh', ['-n', '-c', DISK_GUARD_SCRIPT]).status).toBe(0);
  });
});

describe('out of disk', () => {
  it('recognizes a full disk in what failed', () => {
    for (const message of [
      'ENOSPC: no space left on device, write',
      'Error: No space left on device (os error 28)',
      'SqliteError: database or disk is full',
      'OSError: [Errno 28] No space left on device',
      'write /tmp/x: disk quota exceeded',
    ]) expect(isDiskFullMessage(message)).toBe(true);
    for (const message of ['exited with code 127', 'Error: spawn ENOENT', 'disk usage is fine', 'rate limited'])
      expect(isDiskFullMessage(message)).toBe(false);
  });

  it('tells the agent what happened and where the space went, tersely', () => {
    const disk = { totalKb: 22 * 2 ** 20, usedKb: 20 * 2 ** 20, availKb: 2 * 2 ** 20 };
    const largest = { paths: [{ kb: 8.4 * 2 ** 20, path: '/home/user/karmax/data/pramana.db.tmp' }],
      held: [{ kb: 2.7 * 2 ** 20, pid: 812, command: 'node server.js', path: '/home/user/karmax/data/old.db (deleted)' }] };
    const nearly = diskNotice({ kind: 'nearly-full', disk, largest, maxDiskGb: 29, taskId: 'task_x' });
    expect(nearly).toContain('Disk 20 of 22 GB used (91%)');
    expect(nearly).toContain('8.4 GB /home/user/karmax/data/pramana.db.tmp');
    expect(nearly).toContain('2.7 GB held open by PID 812 (node server.js): /home/user/karmax/data/old.db (deleted)');
    expect(nearly).toContain('platform_request(POST, "/api/tasks/task_x/bigger-disk", {"diskGb": 29})');
    const atCeiling = diskNotice({ kind: 'nearly-full', disk, largest, maxDiskGb: 22, taskId: 'task_x' });
    expect(atCeiling).toMatch(/largest disk this account allows/);
    expect(atCeiling).not.toContain('diskGb');
    expect(diskNotice({ kind: 'ballast-released', disk })).toMatch(/512 MB reserve.*was deleted/);
  });
});
