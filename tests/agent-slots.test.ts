import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Configure the host-admission gate BEFORE the module captures env at import:
// small capacity, both pressure gates disabled → a deterministic pure semaphore.
const previousEnv = {
  slots: process.env.KARMAX_MAX_AGENT_SLOTS,
  memory: process.env.KARMAX_AGENT_MIN_FREE_MB,
  load: process.env.KARMAX_AGENT_MAX_LOAD_FACTOR,
  home: process.env.KARMAX_HOME,
};
process.env.KARMAX_MAX_AGENT_SLOTS = '2';
process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-agent-slots-'));
process.env.KARMAX_HOME = home;

let slots: typeof import('../src/activities/agent-slots.js');

beforeAll(async () => {
  slots = await import('../src/activities/agent-slots.js');
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore('KARMAX_MAX_AGENT_SLOTS', previousEnv.slots);
  restore('KARMAX_AGENT_MIN_FREE_MB', previousEnv.memory);
  restore('KARMAX_AGENT_MAX_LOAD_FACTOR', previousEnv.load);
  restore('KARMAX_HOME', previousEnv.home);
});

describe('host diagnostics', () => {
  it('hostStats reports loadavg, memory, and cores in a sane shape', () => {
    const s = slots.hostStats();
    expect(s.loadavg).toHaveLength(3);
    expect(s.cores).toBeGreaterThan(0);
    expect(s.totalMemMb).toBeGreaterThan(0);
    expect(s.freeMemMb).toBeGreaterThanOrEqual(0);
    expect(s.freeMemMb).toBeLessThanOrEqual(s.totalMemMb + 1);
    expect(s.usedMemPct).toBeGreaterThanOrEqual(0);
    expect(s.usedMemPct).toBeLessThanOrEqual(100);
    // Assert the documented two-decimal projection exactly. toBeCloseTo's
    // half-step boundary is floating-point-sensitive (for example .425→.43).
    expect(s.loadPerCore).toBe(Math.round((s.loadavg[0] / s.cores) * 100) / 100);
  });

  it('agentSlotStats surfaces capacity, gates, and the live host signal', () => {
    const s = slots.agentSlotStats();
    expect(s.capacity).toBe(2);
    expect(s.maxLoadFactor).toBe(0); // disabled in this suite
    expect(s.loadHigh).toBe(false); // factor 0 ⇒ gate inert
    expect(s.memoryTight).toBe(false); // floor 0 ⇒ gate inert
    expect(s.host.cores).toBeGreaterThan(0);
  });
});

describe('admissionDecision (memory-gate decision — karmax#4)', () => {
  it('backpressures when free memory is below the floor', () => {
    const d = slots.admissionDecision({ freeMemMb: 200, loadavg1: 0, cores: 8 }, { minFreeMb: 512, maxLoadFactor: 1.0 });
    expect(d.memoryTight).toBe(true);
    expect(d.loadHigh).toBe(false);
    expect(d.backpressure).toBe(true);
  });

  it('admits when free memory is above the floor and load is easy', () => {
    const d = slots.admissionDecision({ freeMemMb: 4096, loadavg1: 1, cores: 8 }, { minFreeMb: 512, maxLoadFactor: 1.0 });
    expect(d.memoryTight).toBe(false);
    expect(d.loadHigh).toBe(false);
    expect(d.backpressure).toBe(false);
  });

  it('backpressures when the 1-minute load exceeds cores × factor', () => {
    const d = slots.admissionDecision({ freeMemMb: 4096, loadavg1: 12, cores: 8 }, { minFreeMb: 512, maxLoadFactor: 1.0 });
    expect(d.memoryTight).toBe(false);
    expect(d.loadHigh).toBe(true);
    expect(d.backpressure).toBe(true);
  });

  it('treats a 0 threshold as "check disabled" (each gate independently)', () => {
    const noMem = slots.admissionDecision({ freeMemMb: 1, loadavg1: 0, cores: 8 }, { minFreeMb: 0, maxLoadFactor: 1.0 });
    expect(noMem.memoryTight).toBe(false);
    const noLoad = slots.admissionDecision({ freeMemMb: 4096, loadavg1: 999, cores: 8 }, { minFreeMb: 512, maxLoadFactor: 0 });
    expect(noLoad.loadHigh).toBe(false);
    expect(noLoad.backpressure).toBe(false);
  });
});

describe('agent-slot admission semaphore', () => {
  it('shares the capacity across worker processes using the same KARMAX_HOME', async () => {
    const first = await slots.acquireAgentSlot();
    const moduleUrl = pathToFileURL(path.resolve('src/activities/agent-slots.ts')).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `const { acquireAgentSlot } = await import(${JSON.stringify(moduleUrl)}); const release = await acquireAgentSlot(); console.log('READY'); process.stdin.once('data', () => { release(); process.exit(0); }); setInterval(() => {}, 1000);`,
      ],
      { cwd: process.cwd(), env: { ...process.env, KARMAX_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] },
    );
    try {
      let output = '';
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout!.on('data', (chunk) => {
          output += chunk.toString();
          if (output.includes('READY')) resolve();
        });
        child.once('exit', (code) => reject(new Error(`slot-holder child exited before ready (${code})`)));
      });
      expect(slots.agentSlotStats().inUse).toBe(2);

      let overflowGranted = false;
      const overflow = slots.acquireAgentSlot().then((release) => {
        overflowGranted = true;
        return release;
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(overflowGranted).toBe(false);
      expect(slots.agentSlotStats()).toMatchObject({ inUse: 2, waiting: 1 });

      first();
      const releaseOverflow = await overflow;
      releaseOverflow();
    } finally {
      first();
      child.stdin?.write('release\n');
      if (child.exitCode === null) await once(child, 'exit');
    }
    expect(slots.agentSlotStats()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('admits up to capacity, parks the overflow, and hands the slot off on release', async () => {
    const r1 = await slots.acquireAgentSlot();
    const r2 = await slots.acquireAgentSlot();
    expect(slots.agentSlotStats().inUse).toBe(2);

    // Third acquire must PARK (capacity is 2) — it stays pending.
    let thirdGranted = false;
    const third = slots.acquireAgentSlot().then((rel) => {
      thirdGranted = true;
      return rel;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(thirdGranted).toBe(false);
    expect(slots.agentSlotStats().waiting).toBe(1);

    // Releasing one transfers its slot straight to the parked waiter (never a
    // momentary over-admit): inUse stays at capacity, waiting drops to 0.
    r1();
    const r3 = await third;
    expect(thirdGranted).toBe(true);
    expect(slots.agentSlotStats().inUse).toBe(2);
    expect(slots.agentSlotStats().waiting).toBe(0);

    r2();
    r3();
    expect(slots.agentSlotStats().inUse).toBe(0);
  });

  it('a double release is a no-op (does not drive inUse negative)', async () => {
    const rel = await slots.acquireAgentSlot();
    expect(slots.agentSlotStats().inUse).toBe(1);
    rel();
    rel();
    expect(slots.agentSlotStats().inUse).toBe(0);
  });

  it('removes a cancelled waiter without consuming the next released slot', async () => {
    const r1 = await slots.acquireAgentSlot();
    const r2 = await slots.acquireAgentSlot();
    const abort = new AbortController();
    const parked = slots.acquireAgentSlot(undefined, abort.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(slots.agentSlotStats().waiting).toBe(1);

    abort.abort(new Error('turn cancelled'));
    await expect(parked).rejects.toThrow('turn cancelled');
    expect(slots.agentSlotStats()).toMatchObject({ inUse: 2, waiting: 0 });

    r1();
    r2();
    expect(slots.agentSlotStats()).toMatchObject({ inUse: 0, waiting: 0 });
  });
});
