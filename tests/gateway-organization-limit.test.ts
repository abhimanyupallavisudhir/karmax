import { expect, it } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';

it('atomically caps organizations per owner before provisioning hosted storage (GW-4)', async () => {
  let provisions = 0;
  const h = await stubGateway({ hosted: true, resources: { storageLocationService: () => ({ ensureManaged: async () => { provisions++; } }) } as any });
  try {
    for (let n = 0; n < 9; n++) await h.store.createOrganization({ name: `Existing ${n}`, ownerUserId: 'limited-user' });
    const token = (await h.tokens.mintPrincipal('user:limited-user', ['organization:create'])).token;
    (h.gateway as any).sessions.set('browser-session', { user: 'limited-user', userId: 'limited-user', apiToken: token });
    const responses = await Promise.all([1, 2].map(n => fetch(`${h.base}/api/organizations`, {
      method: 'POST', headers: { authorization: 'Bearer browser-session', 'content-type': 'application/json' },
      body: JSON.stringify({ name: `Another ${n}` }),
    })));
    expect(responses.map(r => r.status).sort(), JSON.stringify(await Promise.all(responses.map(r => r.text())))).toEqual([200, 429]);
    expect(await h.store.listOrganizations('limited-user')).toHaveLength(10);
    expect(provisions).toBe(1);
  } finally { await h.close(); }
});
