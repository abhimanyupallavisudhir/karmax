import { expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { stubGateway } from './helpers/stub-gateway.js';

it('rejects malformed settings JSON without overwriting stored settings (GW-5)', async () => {
  const h = await stubGateway();
  try {
    await h.store.setSettings('global', 'test-settings', { siteName: 'Keep me' });
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    const response = await fetch(`${h.base}/api/settings/global/test-settings`, { method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{broken' });
    expect(response.status).toBe(400);
    expect(await h.store.getSettings('global', 'test-settings')).toEqual({ siteName: 'Keep me' });
  } finally { await h.close(); }
});
