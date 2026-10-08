import { describe, expect, it } from 'vitest';
import { assertAccountNameAllowed, canonicalAccountName } from '../src/domain/account-names.js';
import { Store } from '../src/store/db.js';
import { IdentityService } from '../src/auth/identity.js';

// User and organization names share one namespace (SPEC §2.4), and SQLite's
// NOCASE unique index only folds ASCII — so these are the cases only the
// application-level key catches.
describe('canonicalAccountName (CI-38b)', () => {
  it.each([
    ['  Acme  ', 'acme'],
    ['ＡＣＭＥ', 'acme'], // fullwidth compatibility forms
    ['ﬁnance', 'finance'], // ligature
    ['ÉCOLE', 'école'], // non-ASCII case
    ['Café', 'café'], // decomposed accent composes
    ['ΣΟΦΙΑ', 'σοφια'],
  ])('%j → %j', (input, key) => {
    expect(canonicalAccountName(input)).toBe(key);
  });

  it('keeps names apart that merely look alike', () => {
    expect(canonicalAccountName('acme')).not.toBe(canonicalAccountName('acme-labs'));
    expect(canonicalAccountName('a c m e')).not.toBe(canonicalAccountName('acme'));
  });

  it('refuses organization names that collide with a user or organization beyond ASCII case', async () => {
    const store = await Store.create(':memory:');
    try {
      store.connectUserNames(() => [{ id: 'renee', name: 'Renée' }]);
      const ecole = await store.createOrganization({ name: 'École' });
      await expect(store.createOrganization({ name: 'ÉCOLE' })).rejects.toThrow(/already used by an organization/i);
      await expect(store.createOrganization({ name: 'ÉＣＯＬＥ' })).rejects.toThrow(/already used by an organization/i);
      await expect(store.createOrganization({ name: 'RENÉE' })).rejects.toThrow(/already used by a user/i);
      await expect(store.renameOrganization(ecole.id, 'Renée')).rejects.toThrow(/already used by a user/i);
      // Renaming to its own name in another form is not a collision with itself.
      expect((await store.renameOrganization(ecole.id, 'ÉCOLE')).name).toBe('ÉCOLE');
    } finally {
      await store.close();
    }
  });

  it('refuses an organization named after a public page (docs, pricing, policies), which owns that URL', async () => {
    const store = await Store.create(':memory:');
    try {
      for (const name of ['Docs', 'Pricing', 'Legal']) await expect(store.createOrganization({ name })).rejects.toThrow(/reserved/);
    } finally {
      await store.close();
    }
  });
});

// `for:me` means "the signed-in person" in every search, so no user or
// organization may be called "me"; `/installation` is a top-level route.
describe('reserved account names', () => {
  it.each(['me', 'Me', ' ME ', 'ｍｅ'])('refuses %j as a user name', (name) => {
    expect(() => assertAccountNameAllowed(name)).toThrow(/"me" is reserved/);
  });

  it('allows names that merely contain it', () => {
    for (const name of ['Mel', 'me too', 'Ana Me']) expect(() => assertAccountNameAllowed(name)).not.toThrow();
  });

  it('refuses an organization named or slugged "me" or "installation", on create and rename', async () => {
    const store = await Store.create(':memory:');
    try {
      await expect(store.createOrganization({ name: 'me' })).rejects.toThrow(/reserved/);
      await expect(store.createOrganization({ name: 'ME' })).rejects.toThrow(/reserved/);
      await expect(store.createOrganization({ name: 'Acme', slug: 'me' })).rejects.toThrow(/reserved/);
      await expect(store.createOrganization({ name: 'Installation' })).rejects.toThrow(/reserved/);
      const acme = await store.createOrganization({ name: 'Acme' });
      await expect(store.renameOrganization(acme.id, 'Me')).rejects.toThrow(/reserved/);
      await expect(store.createProject('me', {}, acme.id)).rejects.toThrow(/reserved/);
    } finally {
      await store.close();
    }
  });

  it('refuses an organization named after a public page (docs, pricing, policies), which owns that URL', async () => {
    const store = await Store.create(':memory:');
    try {
      for (const name of ['Docs', 'Pricing', 'Legal']) await expect(store.createOrganization({ name })).rejects.toThrow(/reserved/);
    } finally {
      await store.close();
    }
  });
});

describe('reserved user names through sign-up and rename', () => {
  it('refuses "me" when a user is created or renamed', async () => {
    const identity = await IdentityService.open(':memory:', { baseURL: 'http://127.0.0.1:1' });
    try {
      await expect(identity.createUser({ name: 'Me', email: 'me@example.com', password: 'correct horse battery' }))
        .rejects.toThrow(/reserved/);
      await identity.createUser({ name: 'Ana', email: 'ana@example.com', password: 'correct horse battery' });
      const signIn = await identity.auth.api.signInEmail({ body: { email: 'ana@example.com', password: 'correct horse battery' }, asResponse: true });
      const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
      await expect(identity.auth.api.updateUser({ body: { name: 'ME' }, headers: new Headers({ cookie }) })).rejects.toThrow(/reserved/);
      await identity.auth.api.updateUser({ body: { name: 'Ana Lima' }, headers: new Headers({ cookie }) });
      expect((await identity.listUsers()).map((user) => user.name)).toEqual(['Ana Lima']);
    } finally {
      await identity.close?.();
    }
  });
});
