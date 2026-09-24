import assert from 'node:assert/strict';
import { IdentityService } from '../../src/auth/identity.js';

// Native Node: Better Auth's SQLite adapter cannot be loaded through Vite.
const identity = await IdentityService.open(':memory:', { baseURL: 'http://localhost:4599' });
try {
  const first = await identity.bootstrap({ name: 'Erasure subject', email: 'subject@example.test', password: 'a-long-fixture-password' });
  const cookie = first.response.headers.get('set-cookie') ?? '';
  const headers = new Headers({ cookie });
  assert.equal((await identity.session(headers))?.user.id, first.user.id);
  let fenced = false;
  identity.connectAccountClosure(async id => fenced && id === first.user.id);
  fenced = true;
  assert.equal(await identity.session(headers), undefined);
  const login = await identity.signIn('subject@example.test', 'a-long-fixture-password');
  assert.equal(login.ok, false);
  await identity.removeUser(first.user.id);
  await identity.removeUser(first.user.id); // retry is harmless
  assert.deepEqual(await identity.listUsers(), []);
  assert.deepEqual(await identity.providersForUser(first.user.id), []);
  assert.equal(await identity.session(headers), undefined);
  console.log('account-erasure-identity:ok');
} finally { await identity.close(); }
