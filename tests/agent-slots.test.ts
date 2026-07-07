import { describe, it, expect, beforeAll } from 'vitest';

// Configure the host-admission gate BEFORE the module captures env at import:
// small capacity, both pressure gates disabled → a deterministic pure semaphore.
process.env.KARMAX_MAX_AGENT_SLOTS = '2';
process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';

let slots: typeof import('../src/activities/agent-slots.js');

beforeAll(async () => {
  slots = await import('../src/activities/agent-slots.js');
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
    expect(s.loadPerCore).toBeCloseTo(s.loadavg[0] / s.cores, 2); // reported rounded to 2dp
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

describe('agent-slot admission semaphore', () => {
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
});
