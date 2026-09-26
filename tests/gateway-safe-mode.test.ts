import { expect, it } from 'vitest';
import fs from 'node:fs';
import { CAPABILITIES } from '../src/platform/capabilities.js';
import { stubGateway } from './helpers/stub-gateway.js';

it('does not advertise or accept the inert safe-mode control (GW-11)', async () => {
  const h = await stubGateway();
  try {
    const token = (await h.tokens.mintPrincipal('user:test', ['*'])).token;
    for (const method of ['GET', 'POST']) expect((await fetch(`${h.base}/api/safe-mode`, {
      method, headers: { authorization: `Bearer ${token}` },
    })).status).toBe(404);
    expect(CAPABILITIES).not.toContain('safe-mode:write');
    expect(fs.readFileSync('web/app.js', 'utf8')).not.toContain('/api/safe-mode');
  } finally { await h.close(); }
});
