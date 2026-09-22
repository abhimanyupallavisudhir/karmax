import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { World } from '../world/types.js';

/**
 * Remote-world credential fill (PLAN-passwords.md §5B, cloud path).
 *
 * For a LOCAL world the gateway types the secret over CDP itself (fill.ts) —
 * agent and gateway share a host, so `127.0.0.1:<port>` is the same browser.
 * For a REMOTE world the browser runs inside the sandbox and the gateway has no
 * private socket to the sandbox's loopback, so it runs the `cdp-fill.mjs`
 * helper INSIDE the world via `world.exec`. The secret is resolved host-side
 * (the vault never leaves the gateway) and handed to the helper over STDIN —
 * never argv/env/a file, so the co-resident agent cannot read it. The helper
 * re-verifies the live page origin against the item's domains before typing,
 * exactly like the local path.
 */
const HELPER_SOURCE = fs.readFileSync(fileURLToPath(new URL('./cdp-fill.mjs', import.meta.url)), 'utf8');
const HELPER_REL = '.karmax/cdp-fill.mjs';

export async function fillInWorld(world: World, args: {
  selector: string;
  expectDomains?: string[];
  cdpUrl: string;
  /** Resolves the secret host-side; called once, its result goes only to stdin. */
  resolveText: () => string | Promise<string>;
  timeoutMs?: number;
}): Promise<{ origin: string }> {
  await world.writeFile(HELPER_REL, HELPER_SOURCE);
  const res = await world.exec('node', [HELPER_REL, args.selector, (args.expectDomains ?? []).join(','), args.cdpUrl], {
    input: (await args.resolveText()),
    timeoutMs: args.timeoutMs ?? 30_000,
  });
  let parsed: { origin?: string; error?: string } = {};
  try { parsed = JSON.parse((res.stdout || '').trim() || '{}'); } catch { /* fall through to error below */ }
  if (res.code !== 0 || parsed.error || !parsed.origin) {
    throw new Error(parsed.error || res.stderr.trim() || `in-world fill failed (exit ${res.code})`);
  }
  return { origin: parsed.origin };
}
