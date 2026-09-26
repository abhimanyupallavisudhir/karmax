import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { scrubbedEnv } from '../src/autonomy/config-homes.js';
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
const waitForPidFile = async (file: string, ms = 4000): Promise<number> => {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (!fs.existsSync(file)) throw new Error(`timed out waiting for ${file}`);
  return Number(fs.readFileSync(file, 'utf8'));
};

/** Simulate a real agent which launches a tool into a NEW process group/session.
 * The detached grandchild is precisely what group-only custody used to miss. */
function spawnMarkedTree(exitRoot = false): {
  root: ReturnType<typeof spawn>;
  custodyId: string;
  descendantFile: string;
} {
  const marked = custody.createCustodyEnv({ ...process.env });
  const descendantFile = path.join(HOME, `descendant-${Date.now()}-${Math.random()}.pid`);
  const script = [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })",
    'child.unref()',
    `fs.writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid))`,
    exitRoot ? 'setTimeout(() => process.exit(0), 100)' : 'setInterval(() => {}, 1000)',
  ].join(';');
  const root = spawn(process.execPath, ['-e', script], {
    detached: true,
    env: marked.env,
    stdio: 'ignore',
  });
  spawned.push(root.pid!);
  return { root, custodyId: marked.custodyId, descendantFile };
}
/** A pid that is certainly dead (spawn a no-op and wait for it to exit) — a
 *  record with a dead owner is a true orphan. Fixed literals like 999999 can
 *  collide with a real pid on hosts with a large pid_max. */
const deadOwnerPid = async (): Promise<number> => {
  const child = spawn('true', [], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise((r) => child.once('exit', r));
  return pid;
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
  it('preserves the outer custody chain through the real environment scrubber', () => {
    const prior = process.env.KARMAX_CUSTODY_CHAIN;
    process.env.KARMAX_CUSTODY_CHAIN = 'outer-turn';
    try {
      const nested = custody.createCustodyEnv(scrubbedEnv({ provider: 'codex' }));
      expect(nested.env[custody.CUSTODY_ENV]).toBe(`outer-turn,${nested.custodyId}`);
    } finally {
      if (prior === undefined) delete process.env.KARMAX_CUSTODY_CHAIN;
      else process.env.KARMAX_CUSTODY_CHAIN = prior;
    }
  });

  it('does not signal a recycled root pid during normal teardown', async () => {
    const pid = spawnDetachedSleep();
    custody.registerAgent({ pid, pidStart: '0', cmd: 'sleep', owner: process.pid, startedAt: Date.now() });
    await custody.killAgent(pid, 0);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(isAlive(pid)).toBe(true);
  });

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

  it('killAgent reaps marked descendants that created a new process group', async () => {
    const { root, custodyId, descendantFile } = spawnMarkedTree();
    const descendant = await waitForPidFile(descendantFile);
    spawned.push(descendant);
    custody.registerAgent({
      pid: root.pid!,
      cmd: path.basename(process.execPath),
      owner: process.pid,
      custodyId,
      startedAt: Date.now(),
    });

    if (process.platform === 'linux') {
      expect(custody.custodyProcesses(custodyId)).toEqual(expect.arrayContaining([root.pid!, descendant]));
    }
    await custody.killAgent(root.pid, 500, custodyId);
    expect(await waitDead(root.pid!)).toBe(true);
    expect(await waitDead(descendant)).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), `${root.pid}.json`))).toBe(false);
  });

  it('releaseAgent reaps detached background tools after a successful root exit', async () => {
    const { root, custodyId, descendantFile } = spawnMarkedTree(true);
    custody.registerAgent({
      pid: root.pid!,
      cmd: path.basename(process.execPath),
      owner: process.pid,
      custodyId,
      startedAt: Date.now(),
    });
    const descendant = await waitForPidFile(descendantFile);
    spawned.push(descendant);
    await new Promise((resolve) => root.once('exit', resolve));
    expect(isAlive(descendant)).toBe(true);

    await custody.releaseAgent(root.pid, custodyId, 500);
    expect(await waitDead(descendant)).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), `${root.pid}.json`))).toBe(false);
  });

  it('preserves an outer custody marker when nesting agent turns', () => {
    const nested = custody.createCustodyEnv({ [custody.CUSTODY_ENV]: 'outer-turn' });
    expect(nested.env[custody.CUSTODY_ENV]).toBe(`outer-turn,${nested.custodyId}`);
  });

  it('reapOrphans hard-kills a surviving group from a prior run and clears the file', async () => {
    const pid = spawnDetachedSleep();
    // Simulate a prior incarnation that was SIGKILLed: its pidfile persists but
    // its child kept running (owner dead ⇒ true orphan).
    custody.registerAgent({ pid, cmd: 'sleep', owner: await deadOwnerPid(), startedAt: Date.now() });

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

  it('reapOrphans finds marked descendants after their recorded root has exited', async () => {
    const { root, custodyId, descendantFile } = spawnMarkedTree(true);
    custody.registerAgent({
      pid: root.pid!,
      cmd: path.basename(process.execPath),
      owner: await deadOwnerPid(),
      custodyId,
      startedAt: Date.now(),
    });
    const descendant = await waitForPidFile(descendantFile);
    spawned.push(descendant);
    await new Promise((resolve) => root.once('exit', resolve));

    const result = custody.reapOrphans();
    expect(result.reaped).toBe(process.platform === 'linux' ? 1 : 0);
    if (process.platform === 'linux') expect(await waitDead(descendant)).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), `${root.pid}.json`))).toBe(false);
  });

  it('reapOrphans spares an agent whose owner process is still alive (dual-instance boot)', async () => {
    const pid = spawnDetachedSleep();
    // Owner = this test process (a live node process): a concurrent karmax
    // instance is mid-turn on this agent, so it is NOT an orphan (the 2026-07-12
    // incident: a dogfooding boot from a task world SIGKILLed prod's live agents).
    custody.registerAgent({ pid, cmd: 'sleep', owner: process.pid, startedAt: Date.now() });

    const result = custody.reapOrphans();
    expect(result.reaped).toBe(0);
    expect(result.skipped).toBe(1);
    expect(isAlive(pid)).toBe(true);
    // The pidfile survives too — custody must persist for when the owner dies.
    expect(fs.existsSync(path.join(agentsDir(), `${pid}.json`))).toBe(true);
    custody.unregisterAgent(pid);
  });

  it('reapOrphans does NOT kill when the recorded command no longer matches (PID reuse guard)', async () => {
    const pid = spawnDetachedSleep();
    // Record a DIFFERENT command than what the pid is actually running.
    custody.registerAgent({ pid, cmd: 'definitely-not-sleep-xyz', owner: await deadOwnerPid(), startedAt: Date.now() });

    const result = custody.reapOrphans();
    expect(fs.existsSync(path.join(agentsDir(), `${pid}.json`))).toBe(false); // stale file cleared
    expect(result.reaped).toBe(0); // but the live, mismatched process is spared
    expect(isAlive(pid)).toBe(true);
  });

  // The Claude Agent-SDK rail spawns `node`, so `rec.cmd` is literally "node" and
  // the cmdline check passes for ANY node process that happens to inherit the pid.
  // Only the /proc start tick (field 22) actually identifies a process (this is the
  // same primitive src/activities/agent-slots.ts already uses for lease owners).
  const linuxOnly = process.platform === 'linux' ? it : it.skip;

  linuxOnly('reapOrphans does NOT kill a recycled pid whose start tick differs (cmdline alone is not enough)', async () => {
    const pid = spawnDetachedSleep();
    // `cmd` deliberately MATCHES the live process (as "node" always would for the
    // Agent-SDK rail) while the recorded start tick does not: this is exactly a
    // recycled pid now owned by an unrelated process.
    custody.registerAgent({ pid, cmd: 'sleep', owner: await deadOwnerPid(), startedAt: Date.now() });
    const file = path.join(agentsDir(), `${pid}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(rec.pidStart).toBeTruthy(); // registerAgent stamps it
    fs.writeFileSync(file, JSON.stringify({ ...rec, pidStart: String(Number(rec.pidStart) + 12345) }));

    const result = custody.reapOrphans();
    expect(result.reaped).toBe(0);
    expect(isAlive(pid)).toBe(true); // the innocent bystander survives
    expect(fs.existsSync(file)).toBe(false); // stale record still cleared
  });

  linuxOnly('reapOrphans still kills a genuine orphan whose start tick matches', async () => {
    const pid = spawnDetachedSleep();
    custody.registerAgent({ pid, cmd: 'sleep', owner: await deadOwnerPid(), startedAt: Date.now() });
    const result = custody.reapOrphans();
    expect(result.reaped).toBe(1);
    expect(await waitDead(pid)).toBe(true);
  });

  linuxOnly('reapOrphans treats a RECYCLED owner pid as dead, so a real orphan stays reapable', async () => {
    const pid = spawnDetachedSleep();
    // owner = this live node process, but with a start tick from a different
    // incarnation: the pid was recycled, so this is NOT a live karmax instance and
    // the record must not be spared forever.
    custody.registerAgent({ pid, cmd: 'sleep', owner: process.pid, startedAt: Date.now() });
    const file = path.join(agentsDir(), `${pid}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(rec.ownerStart).toBeTruthy();
    fs.writeFileSync(file, JSON.stringify({ ...rec, ownerStart: String(Number(rec.ownerStart) + 12345) }));

    const result = custody.reapOrphans();
    expect(result.skipped).toBe(0);
    expect(result.reaped).toBe(1);
    expect(await waitDead(pid)).toBe(true);
  });

  linuxOnly('reapOrphans refuses to group-kill a legacy record that carries no start tick', async () => {
    const pid = spawnDetachedSleep();
    custody.registerAgent({ pid, cmd: 'sleep', owner: await deadOwnerPid(), startedAt: Date.now() });
    const file = path.join(agentsDir(), `${pid}.json`);
    const { pidStart: _drop, ...legacy } = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(legacy)); // a record written before this fix

    const result = custody.reapOrphans();
    expect(result.reaped).toBe(0); // unverifiable ⇒ leak the record rather than kill a bystander
    expect(isAlive(pid)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reapOrphans on an empty/absent dir is a harmless no-op', () => {
    const result = custody.reapOrphans();
    expect(result).toEqual({ reaped: 0, cleared: 0, skipped: 0 });
  });

  it('killProcessGroup tolerates a bogus pid without throwing', () => {
    expect(() => custody.killProcessGroup(0, 'SIGTERM')).not.toThrow();
    expect(() => custody.killProcessGroup(2_000_000_000, 'SIGKILL')).not.toThrow();
  });
});
