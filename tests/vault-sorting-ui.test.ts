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
});
