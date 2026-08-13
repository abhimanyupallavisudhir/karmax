import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeApiModels, claudeModelCatalog, claudeModels, mergeModels, modelDiscoveryFailureReason } from '../src/agent/models.js';

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

  it('keeps Fable in a successful but partial Claude SDK catalog', () => {
    const catalog = claudeModelCatalog([
      { id: 'default', displayName: 'Default (recommended)' },
      { id: 'sonnet', displayName: 'Sonnet' },
      { id: 'opus', displayName: 'Opus' },
      { id: 'haiku', displayName: 'Haiku' },
    ]);

    expect(catalog.find((model) => model.id === 'default')?.displayName).toBe('Default (recommended)');
    expect(catalog).toContainEqual({ id: 'claude-fable-5[1m]', displayName: 'Fable 5' });
  });

  it('classifies model-discovery failures without logging provider secrets', () => {
    expect(modelDiscoveryFailureReason(new Error('Anthropic models API 401; bearer secret-value')))
      .toBe('provider returned 401');
    expect(modelDiscoveryFailureReason(new Error('request with secret-value exploded'))).toBe('Error');
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

  it('never lets model discovery mutate the connected Claude credential home', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-claude-model-home-'));
    const credential = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'live-access-token',
        refreshToken: 'irreplaceable-refresh-token',
        expiresAt: Date.now() + 60_000,
      },
    });
    fs.writeFileSync(path.join(home, '.credentials.json'), credential, { mode: 0o600 });
    let probeHome: string | undefined;
    try {
      const models = await claudeModels(home, 1_000, {
        query: ({ options }: any) => {
          probeHome = options.env.CLAUDE_CONFIG_DIR;
          expect(probeHome).not.toBe(home);
          expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('live-access-token');
          // Reproduce Claude Code's invalid-refresh/logout behavior. The provider
          // may clear its probe credential, but must never touch karmax's source.
          fs.writeFileSync(path.join(probeHome!, '.credentials.json'), JSON.stringify({
            claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 },
          }));
          return {
            supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }],
            close() {},
          };
        },
        apiModels: async () => [],
      });

      expect(models).toEqual([{ id: 'sonnet', displayName: 'Sonnet' }]);
      expect(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8')).toBe(credential);
      expect(probeHome && fs.existsSync(probeHome)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
