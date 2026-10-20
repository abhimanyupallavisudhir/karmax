import { describe, expect, it } from 'vitest';
import { importWithPanagent } from '../src/agent/panagent.js';
import { liveEnabled } from './helpers/live-gate.js';

/**
 * A real claude.ai share through the real network path: Cloudflare in front of
 * claude.ai decides what a server may read, and no fake can tell when that
 * changes. Needs `KARMAX_RUN_LIVE=1` and `KARMAX_LIVE_CLAUDE_SHARE`, a public
 * https://claude.ai/share/<id> link.
 */
const share = process.env.KARMAX_LIVE_CLAUDE_SHARE;
describe.skipIf(!liveEnabled() || !share)('claude.ai share, live', () => {
  it('imports the conversation from tavya’s own network path', async () => {
    const result = await importWithPanagent({ source: { url: share! }, provider: 'claude', forkHome: '/unused',
      worldPath: '/work', mode: 'context', native: false });
    expect(result.kind).toBe('context');
    if (result.kind !== 'context') return;
    expect(result.message.text).toMatch(/^## User$/m);
    expect(result.message.text).toMatch(/^## Assistant$/m);
  }, 60_000);
});
