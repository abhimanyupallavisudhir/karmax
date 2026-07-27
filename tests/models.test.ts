import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeApiModels, mergeModels } from '../src/agent/models.js';

describe('provider model discovery', () => {
  it('unions account-specific catalogs without duplicating model ids', () => {
    expect(mergeModels([
      [{ id: 'shared', displayName: 'Shared' }, { id: 'account-a' }],
      [{ id: 'shared', displayName: 'Duplicate' }, { id: 'account-b' }],
    ])).toEqual([
      { id: 'shared', displayName: 'Shared' },
      { id: 'account-a' },
      { id: 'account-b' },
    ]);
  });

  it('discovers exact Claude models with a connected OAuth account', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-claude-models-'));
    try {
      fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
        claudeAiOauth: { accessToken: 'oauth-token' },
      }));
      let request: { url: string; init?: RequestInit } | undefined;
      const models = await claudeApiModels(home, 1_000, async (url, init) => {
        request = { url: String(url), init };
        return new Response(JSON.stringify({ data: [
          { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
          { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
        ] }), { status: 200 });
      });
      expect(models).toEqual([
        { id: 'claude-opus-5', displayName: 'Claude Opus 5' },
        { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
      ]);
      expect(request?.url).toContain('/v1/models?limit=1000');
      expect(new Headers(request?.init?.headers).get('authorization')).toBe('Bearer oauth-token');
      expect(new Headers(request?.init?.headers).get('x-api-key')).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
