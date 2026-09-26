import { expect, it, vi } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';

it('revokes platform tokens when their browser session is revoked (GW-8)', async () => {
  let active = true;
  const identity = {
    connectOrganizationNames() {}, connectAccountClosure() {}, listUsers: async () => [],
    session: async () => active ? { user: { id: 'alice', name: 'Alice', email: 'alice@example.com' },
      session: { id: 'browser-session', expiresAt: new Date(Date.now() + 60_000) } } : undefined,
    sessionActive: async () => active,
  };
  const h = await stubGateway({ identity: identity as any,
    authorization: { capabilitiesAsync: async () => ['task:read'] } as any });
  try {
    const session = await (h.gateway as any).auth({ headers: {} });
    expect(await h.tokens.verify(session.apiToken)).toBeDefined();
    active = false;
    expect(await h.tokens.verify(session.apiToken)).toBeUndefined();
    expect(await h.store.getScopedToken((h.tokens as any).digest(session.apiToken))).toBeUndefined();
  } finally { await h.close(); }
});

it('evicts expired identity cache entries by time and revokes their tokens (PS-9)', async () => {
  const identity = { connectOrganizationNames() {}, connectAccountClosure() {}, listUsers: async () => [],
    session: async () => ({ user: { id: 'alice', name: 'Alice' }, session: { id: 'fresh' } }),
    sessionActive: async () => true };
  const h = await stubGateway({ identity: identity as any, authorization: { capabilitiesAsync: async () => [] } as any });
  try {
    const expired = (await h.tokens.mintPrincipal('user:alice', [])).token;
    (h.gateway as any).identityTokens.set('old', { apiToken: expired, fingerprint: '[]', expiresAt: 0 });
    await (h.gateway as any).auth({ headers: {} });
    expect((h.gateway as any).identityTokens.has('old')).toBe(false);
    expect(await h.tokens.verify(expired)).toBeUndefined();
  } finally { await h.close(); }
});
