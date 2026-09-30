import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { E2BWorldProvider } from '../src/world/e2b.js';
import { liveEnabled } from './helpers/live-gate.js';

/**
 * Live provider smoke tests. The unit suites (`e2b-world`, `daytona-world`)
 * validate the provider contract against in-memory fakes; these validate the
 * same flow against the real control planes, catching SDK drift, credential
 * problems, and lifecycle-semantics changes the fakes cannot see.
 *
 * They require `KARMAX_RUN_LIVE=1` and provider credentials. They spend real
 * provider credit: one tiny sandbox each, destroyed in `finally`.
 */
const skipLive = !liveEnabled();

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

  // The cloud credential-fill path (wiki plans/PLAN-passwords §5B): the gateway hands the
  // secret to an in-sandbox helper over STDIN — never argv/env/a file the
  // co-resident agent could read. These are the pieces the offline fakes cannot
  // exercise: E2B's sendStdin/closeStdin/wait, and cdp-fill.mjs running under the
  // sandbox's own node.
  it('feeds a secret to an in-sandbox process over stdin (never argv), and runs the fill helper there', async () => {
    const provider = new E2BWorldProvider();
    const world = await provider.create({ taskId: `live-e2b-fill-${Date.now()}`, base: 'main' });
    try {
      // 1) the stdin channel itself (E2B background handle + sendStdin + EOF)
      const echoed = await world.exec('cat', [], { input: 'sup3r-secret-42\n' });
      expect(echoed.code).toBe(0);
      expect(echoed.stdout).toContain('sup3r-secret-42');

      // 2) the dep-free helper runs under the sandbox node and consumes the
      //    secret from stdin. With no browser on the port it fails CLOSED (no
      //    page / connection refused) — proving it executed in-sandbox and never
      //    echoed the secret it read from stdin.
      const helper = fs.readFileSync(new URL('../src/autonomy/cdp-fill.mjs', import.meta.url), 'utf8');
      await world.writeFile('.karmax/cdp-fill.mjs', helper);
      const fill = await world.exec('node', ['.karmax/cdp-fill.mjs', '#pw', 'example.com', 'http://127.0.0.1:9222'],
        { input: 'sup3r-secret-42' });
      expect(`${fill.stdout}${fill.stderr}`).toMatch(/no open page|refus|ECONNREFUSED|fetch failed|connect/i);
      expect(fill.stdout).not.toContain('sup3r-secret-42');
    } finally {
      await world.destroy().catch(() => undefined);
    }
  }, 180_000);
});
