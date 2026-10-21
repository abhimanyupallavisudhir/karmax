import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importConversationShare } from '../src/agent/conversation-sources.js';
import { importWithPanagent } from '../src/agent/panagent.js';
import { conversationImportObjectKey } from '../src/store/conversation-imports.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Store } from '../src/store/db.js';
import { liveEnabled } from './helpers/live-gate.js';

/**
 * Real share links through tavya's real network path: each provider decides
 * what a server may read (Cloudflare in front of claude.ai, Gemini's RPC), and
 * no fake can tell when that changes. Needs `KARMAX_RUN_LIVE=1` and a public
 * link per provider: `KARMAX_LIVE_<PROVIDER>_SHARE` for each of `providers` below
 * (e.g. `KARMAX_LIVE_GEMINI_SHARE`, any form: a share.gemini.google short link too).
 * Perplexity asks for a browser check about half the time; that case is reported
 * and the test is retried by hand, never answered.
 */
const providers = ['claude', 'chatgpt', 'gemini', 'deepseek', 'grok', 'perplexity', 'poe', 'mistral', 'kimi', 'qwen'];
const links = Object.fromEntries(providers.map((name) => [name, process.env[`KARMAX_LIVE_${name.toUpperCase()}_SHARE`]]));
describe.skipIf(!liveEnabled())('conversation share links, live', () => {
  for (const [provider, link] of Object.entries(links)) {
    it.skipIf(!link)(`reads a ${provider} share as the task form does, and the agent starts from that copy`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-live-'));
      const store = await Store.create(':memory:');
      try {
        const objects = new LocalObjectStore(dir);
        const ref = await importConversationShare({ store, objects }, 'proj_live', link!);
        expect(ref.format).toBe(`${provider}-share`);
        expect(ref.messages).toBeGreaterThan(1);
        const data = await objects.get(conversationImportObjectKey('proj_live', ref.id));
        const result = await importWithPanagent({ source: { data, name: ref.name, format: ref.format as any }, provider: 'claude',
          forkHome: '/unused', worldPath: '/work', mode: 'context', native: false });
        expect(result.kind).toBe('context');
        if (result.kind !== 'context') return;
        expect(result.message.text).toMatch(/^## User$/m);
        expect(result.message.text).toMatch(/^## Assistant$/m);
      } finally {
        await store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
