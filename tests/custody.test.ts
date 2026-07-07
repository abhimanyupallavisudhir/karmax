import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate custody state in a temp KARMAX_HOME (never touch the real ~/.karmax).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-custody-'));
process.env.KARMAX_HOME = HOME;

let custody: typeof import('../src/agent/custody.js');
const agentsDir = () => path.join(HOME, 'state', 'agents');

const spawned: number[] = [];
/** A long-lived, detached child (its own process group), like a real agent. */
function spawnDetachedSleep(): number {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  spawned.push(child.pid!);
  return child.pid!;
}
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid: number, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(pid);
};

beforeAll(async () => {
  custody = await import('../src/agent/custody.js');
});

afterEach(() => {
  // Clean up any survivors so a failing assertion can't leak processes.
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

describe('process-tree custody', () => {
  it('registers a pidfile and unregisters it', () => {
    const pid = spawnDetachedSleep();
    custody.registerAgent({ pid, cmd: 'sleep', owner: process.pid, startedAt: Date.now() });
    expect(fs.existsSync(path.join(agentsDir(), `${pid}.json`))).toBe(true);
    custody.unregisterAgent(pid);
    expect(fs.existsSync(path.join(agentsDir(), `${pid}.json`))).toBe(false);
  });

  it('killAgent terminates the process group and clears the record', async () => {
    const pid = spawnDetachedSleep();
    custody.registerAgent({ pid, cmd: 'sleep', owner: process.pid, startedAt: Date.now() });
    await custody.killAgent(pid, 500);
    expect(await waitDead(pid)).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), `${pid}.json`))).toBe(false);
  });

  it('reapOrphans hard-kills a surviving group from a prior run and clears the file', async () => {
    const pid = spawnDetachedSleep();
    // Simulate a prior incarnation that was SIGKILLed: its pidfile persists but
    // its child kept running.
    custody.registerAgent({ pid, cmd: 'sleep', owner: 999999, startedAt: Date.now() });

    const result = custody.reapOrphans();
    expect(fs.existsSync(path.join(agentsDir(), `${pid}.json`))).toBe(false); // always cleared
    expect(result.cleared).toBeGreaterThanOrEqual(1);

    if (process.platform === 'linux') {
      // On Linux the /proc cmdline check confirms the pid is still `sleep`, so it
      // is reaped for real.
      expect(result.reaped).toBe(1);
      expect(await waitDead(pid)).toBe(true);
    }
  });

  it('reapOrphans does NOT kill when the recorded command no longer matches (PID reuse guard)', async () => {
    const pid = spawnDetachedSleep();
    // Record a DIFFERENT command than what the pid is actually running.
    custody.registerAgent({ pid, cmd: 'definitely-not-sleep-xyz', owner: 999999, startedAt: Date.now() });

    const result = custody.reapOrphans();
    expect(fs.existsSync(path.join(agentsDir(), `${pid}.json`))).toBe(false); // stale file cleared
    expect(result.reaped).toBe(0); // but the live, mismatched process is spared
    expect(isAlive(pid)).toBe(true);
  });

  it('reapOrphans on an empty/absent dir is a harmless no-op', () => {
    const result = custody.reapOrphans();
    expect(result).toEqual({ reaped: 0, cleared: 0 });
  });

  it('killProcessGroup tolerates a bogus pid without throwing', () => {
    expect(() => custody.killProcessGroup(0, 'SIGTERM')).not.toThrow();
    expect(() => custody.killProcessGroup(2_000_000_000, 'SIGKILL')).not.toThrow();
  });
});
