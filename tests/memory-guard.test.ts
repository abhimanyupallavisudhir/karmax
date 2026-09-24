import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../src/agent/memory-guard.sh', import.meta.url));
const uid = String(os.userInfo().uid);
let roots: string[] = [];
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots = []; });

/** A fake /proc: meminfo plus the per-process files the guard reads. */
function fakeProc(availableMb: number, processes: Array<{ pid: number; ppid: number; comm: string; score: number; uid?: string; rssMb?: number }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-guard-proc-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'meminfo'), `MemTotal:        2030592 kB\nMemFree:           10000 kB\nMemAvailable:    ${availableMb * 1024} kB\n`);
  for (const p of processes) {
    const dir = path.join(root, String(p.pid));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'comm'), `${p.comm}\n`);
    fs.writeFileSync(path.join(dir, 'status'), `Name:\t${p.comm}\nPPid:\t${p.ppid}\nUid:\t${p.uid ?? uid}\t${p.uid ?? uid}\t${p.uid ?? uid}\t${p.uid ?? uid}\nVmRSS:\t${(p.rssMb ?? 1) * 1024} kB\n`);
    fs.writeFileSync(path.join(dir, 'oom_score'), `${p.score}\n`);
    fs.writeFileSync(path.join(dir, 'cmdline'), `${p.comm}\0--flag\0`);
  }
  return root;
}

const pick = (proc: string) => spawnSync('sh', [guard, 'pick'], { env: { ...process.env, KARMAX_GUARD_PROC: proc }, encoding: 'utf8' });

// Task 348/349 process tree: envd → relay (node) → npm exec → claude → bash → tsc.
const sandbox = [
  { pid: 1, ppid: 0, comm: 'systemd', score: 0, uid: '0' },
  { pid: 318, ppid: 1, comm: 'envd', score: 0, uid: '0' },
  { pid: 1710, ppid: 318, comm: 'node', score: 700 },
  { pid: 1724, ppid: 1710, comm: 'npm exec @anthr', score: 760 },
  { pid: 1745, ppid: 1724, comm: 'claude', score: 800, rssMb: 250 },
  { pid: 1783, ppid: 1745, comm: 'chrome', score: 310 },
  { pid: 2000, ppid: 1745, comm: 'bash', score: 105 },
  { pid: 2001, ppid: 2000, comm: 'node', score: 690, rssMb: 1200 },
];

describe('sandbox memory guard', () => {
  it('picks the hungriest process that is not the agent or its ancestors', () => {
    const result = pick(fakeProc(80, sandbox));
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('2001');
  });

  it('does nothing while memory is available', () => {
    expect(pick(fakeProc(400, sandbox)).stdout.trim()).toBe('');
  });

  it('never selects processes it cannot signal or the kernel exempts', () => {
    const protectedOnly = [
      { pid: 318, ppid: 1, comm: 'envd', score: 900, uid: uid === '0' ? '1' : '0' },
      { pid: 1745, ppid: 318, comm: 'codex', score: 800 },
      { pid: 2002, ppid: 1745, comm: 'sleep', score: 0 },
    ];
    expect(pick(fakeProc(80, protectedOnly)).stdout.trim()).toBe('');
  });

  it('runs one detached guard per sandbox and kills a runaway process', async () => {
    const proc = fakeProc(400, []);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-guard-run-'));
    roots.push(dir);
    fs.copyFileSync(guard, path.join(dir, 'memory-guard.sh'));
    const hog = spawn('sleep', ['30']);
    const env = { ...process.env, KARMAX_GUARD_PROC: proc, KARMAX_GUARD_INTERVAL: '0.05' };
    try {
      for (let i = 0; i < 2; i++) expect(spawnSync('sh', [path.join(dir, 'memory-guard.sh'), 'start'], { env }).status).toBe(0);
      const pidFile = path.join(dir, 'memory-guard.pid');
      for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
      const guardPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(guardPid).toBeGreaterThan(0);
      // Present the real sleep process as the only candidate, then drain memory.
      const fakeHog = path.join(proc, String(hog.pid));
      fs.mkdirSync(fakeHog);
      fs.writeFileSync(path.join(fakeHog, 'comm'), 'sleep\n');
      fs.writeFileSync(path.join(fakeHog, 'status'), `Name:\tsleep\nPPid:\t1\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nVmRSS:\t1228800 kB\n`);
      fs.writeFileSync(path.join(fakeHog, 'oom_score'), '690\n');
      fs.writeFileSync(path.join(fakeHog, 'cmdline'), 'sleep\x0030\x00');
      const exited = new Promise<NodeJS.Signals | null>((resolve) => hog.once('exit', (_code, signal) => resolve(signal)));
      fs.writeFileSync(path.join(proc, 'meminfo'), 'MemTotal:        2030592 kB\nMemAvailable:      81920 kB\n');
      expect(await exited).toBe('SIGKILL');
      const logFile = path.join(dir, 'memory-guard.log');
      for (let i = 0; i < 100 && !fs.existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 20));
      const log = fs.readFileSync(logFile, 'utf8');
      expect(log).toMatch(new RegExp(`killed PID ${hog.pid} \\(sleep 30\\) using 1200 MB: the sandbox had 80 MB of 1983 MB memory left`));
      const guards = spawnSync('pgrep', ['-f', `${dir}/memory-guard.sh run`], { encoding: 'utf8' }).stdout.trim().split('\n');
      expect(guards).toEqual([String(guardPid)]);
      // Removing the injection directory retires the guard.
      fs.rmSync(dir, { recursive: true, force: true });
      for (let i = 0; i < 100 && spawnSync('kill', ['-0', String(guardPid)]).status === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(spawnSync('kill', ['-0', String(guardPid)]).status).not.toBe(0);
    } finally {
      hog.kill('SIGKILL');
      spawnSync('pkill', ['-f', `${dir}/memory-guard.sh run`]);
    }
  });
});
