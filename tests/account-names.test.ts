import { describe, expect, it } from 'vitest';
import { canonicalAccountName } from '../src/domain/account-names.js';
import { Store } from '../src/store/db.js';

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
});
