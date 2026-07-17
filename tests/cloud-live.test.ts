import { describe, expect, it } from 'vitest';
import { E2BWorldProvider } from '../src/world/e2b.js';
import { DaytonaWorldProvider } from '../src/world/daytona.js';

/**
 * Live provider smoke tests. The unit suites (`e2b-world`, `daytona-world`)
 * validate the provider contract against in-memory fakes; these validate the
 * same flow against the real control planes, catching SDK drift, credential
 * problems, and lifecycle-semantics changes the fakes cannot see.
 *
 * They self-skip without provider credentials, and `KARMAX_SKIP_LIVE=1`
 * force-skips them (same switch as `live-agent.test.ts`). They spend real
 * provider credit: one tiny sandbox each, destroyed in `finally`.
 */
const skipLive = process.env.KARMAX_SKIP_LIVE === '1';

describe.skipIf(skipLive || !process.env.E2B_API_KEY)('E2B live smoke', () => {
  it('provisions a real sandbox, executes a command, and destroys it', async () => {
    const provider = new E2BWorldProvider();
    const world = await provider.create({ taskId: `live-e2b-${Date.now()}`, base: 'main' });
    try {
      const result = await world.exec('echo', ['karmax-live-check']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('karmax-live-check');
      await world.writeFile('live.txt', 'round-trip');
      expect(await world.readFile('live.txt')).toBe('round-trip');
      expect(await provider.probe(world.handle)).toBe('ready');
    } finally {
      await world.destroy().catch(() => undefined);
    }
  }, 180_000);
});

describe.skipIf(skipLive || !process.env.DAYTONA_API_KEY)('Daytona live smoke', () => {
  it('provisions a real sandbox, executes a command, and destroys it', async () => {
    const provider = new DaytonaWorldProvider();
    const world = await provider.create({ taskId: `live-daytona-${Date.now()}`, base: 'main' });
    try {
      const result = await world.exec('echo', ['karmax-live-check']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('karmax-live-check');
      await world.writeFile('live.txt', 'round-trip');
      expect(await world.readFile('live.txt')).toBe('round-trip');
      expect(await provider.probe(world.handle)).toBe('ready');
    } finally {
      await world.destroy().catch(() => undefined);
    }
  }, 300_000);
});
