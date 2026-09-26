import assert from 'node:assert/strict';
import { IdentityService } from '../../src/auth/identity.js';
import { TokenAuthority } from '../../src/platform/tokens.js';
const identity = await IdentityService.open(':memory:', { baseURL: 'http://localhost:4600' });
try {
  const signup = await identity.signUp({ name: 'Session Owner', email: 'session@example.com', password: 'initial-password-long' });
  const headers = new Headers({ cookie: signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), origin: 'http://localhost:4600' });
  const session = await identity.session(headers);
  assert.ok(session);
  const tokens = new TokenAuthority();
  tokens.connectIdentitySessions((id, user) => identity.sessionActive(id, user));
  const issued = await tokens.mintPrincipal(`user:${session.user.id}`, ['task:read'], undefined, 60_000, undefined, session.session.id);
  assert.ok(await tokens.verify(issued.token));
  let evicted = false;
  identity.connectSessionRevocation(async () => { evicted = true; });
  const response = await identity.changePassword('initial-password-long', 'replacement-password-long', headers);
  assert.equal(response.status, 200, await response.text());
  assert.equal(await tokens.verify(issued.token), undefined);
  assert.equal(evicted, true);
  console.log('session revocation passed');
} finally { await identity.close(); }
