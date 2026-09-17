import { Store } from '../src/store/db.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync('web/app.js', 'utf8');
const start = app.indexOf('function sortVaultItems(');
const end = app.indexOf('\nfunction vaultItemSearchText', start);
const sortVaultItems = new vm.Script(`(${app.slice(start, end).trim()})`).runInNewContext();

describe('vault credential ordering', () => {
  const items = [
    { id: 'z', label: 'Zulu', useCount: 8 },
    { id: 'b', label: 'Beta', useCount: 2 },
    { id: 'a', label: 'Alpha', useCount: 2 },
    { id: 'old', label: 'Legacy' },
    { id: 'new', label: 'New', useCount: 0 },
  ];
  it('orders by frequency, then label, including unused and legacy credentials', () => {
    expect(sortVaultItems(items).map((item: any) => item.id)).toEqual(['z', 'a', 'b', 'old', 'new']);
    expect(items.map((item) => item.id)).toEqual(['z', 'b', 'a', 'old', 'new']);
  });
  it('puts selected items first and orders each group by frequency', () => {
    expect(sortVaultItems(items, new Set(['old', 'b', 'a', 'missing'])).map((item: any) => item.id))
      .toEqual(['a', 'b', 'old', 'z', 'new']);
  });
  it('uses a deterministic tie-breaker for duplicate labels', () => {
    expect(sortVaultItems([{ id: 'b', label: 'Same' }, { id: 'a', label: 'Same' }])
      .map((item: any) => item.id)).toEqual(['a', 'b']);
    expect(sortVaultItems([])).toEqual([]);
  });
  it('ranks the entire list by decayed frequency, not just its most-used item', () => {
    const now = 1_800_000_000_000;
    const month = 30 * 24 * 60 * 60 * 1000;
    const credentials = [
      { id: 'old', label: 'Alpha', useCount: 8, frecencyScore: 8, frecencyUpdatedAt: now - 4 * month },
      { id: 'recent', label: 'Zulu', useCount: 2, frecencyScore: 2, frecencyUpdatedAt: now },
      { id: 'regular', label: 'Regular', useCount: 12, frecencyScore: 12, frecencyUpdatedAt: now - month },
      { id: 'unused', label: 'Beta', frecencyScore: 0, frecencyUpdatedAt: now },
    ];
    expect(sortVaultItems(credentials, new Set(), now).map((item: any) => item.id))
      .toEqual(['regular', 'recent', 'old', 'unused']);
    expect(sortVaultItems(credentials, new Set(['old', 'recent']), now).map((item: any) => item.id))
      .toEqual(['recent', 'old', 'regular', 'unused']);
  });
  it('breaks equal scores by most recent access before label', () => {
    const now = 1_800_000_000_000;
    expect(sortVaultItems([
      { id: 'older', label: 'Alpha', frecencyScore: 1, frecencyUpdatedAt: now, lastUsedAt: now - 1 },
      { id: 'newer', label: 'Zulu', frecencyScore: 1, frecencyUpdatedAt: now, lastUsedAt: now },
    ], new Set(), now).map((item: any) => item.id)).toEqual(['newer', 'older']);
  });

  it('carries historical usage through vault metadata JSON into the displayed ordering', () => {
    const store = new Store(':memory:');
    try {
      const now = Date.now();
      const month = 30 * 24 * 60 * 60 * 1000;
      const vault = new VaultItems(store);
      const old = vault.save({ type: 'login', label: 'Alpha' });
      const recent = vault.save({ type: 'login', label: 'Zulu' });
      const frequent = vault.save({ type: 'login', label: 'Most used' });
      const unused = vault.save({ type: 'login', label: 'Beta' });
      store.kvSet('vault:items:org_personal', JSON.stringify(vault.list().map((item) => {
        const { frecencyScore, frecencyUpdatedAt, ...legacy } = item;
        return legacy;
      })));
      for (const [item, count, ts] of [[old, 8, now - 4 * month], [recent, 2, now], [frequent, 12, now - month]] as const) {
        for (let i = 0; i < count; i++) store.appendAudit({ ts, principalId: 'system',
          action: 'vault.used', detail: { itemId: item.id } });
      }
      // This is the metadata payload returned by GET /api/vault/items.
      const payload = JSON.parse(JSON.stringify(vault.list()));
      expect(sortVaultItems(payload, new Set(), Date.now()).map((item: any) => item.id))
        .toEqual([frequent.id, recent.id, old.id, unused.id]);
      expect(sortVaultItems(payload, new Set([old.id]), Date.now()).map((item: any) => item.id))
        .toEqual([old.id, frequent.id, recent.id, unused.id]);
    } finally { store.close(); }
  });

});
