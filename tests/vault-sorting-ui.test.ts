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
    { id: 'z', label: 'Zulu', selectionFrecencyScore: 8 },
    { id: 'b', label: 'Beta', selectionFrecencyScore: 2 },
    { id: 'a', label: 'Alpha', selectionFrecencyScore: 2 },
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
      { id: 'old', label: 'Alpha', useCount: 8, selectionFrecencyScore: 8, selectionUpdatedAt: now - 4 * month },
      { id: 'recent', label: 'Zulu', useCount: 2, selectionFrecencyScore: 2, selectionUpdatedAt: now },
      { id: 'regular', label: 'Regular', useCount: 12, selectionFrecencyScore: 12, selectionUpdatedAt: now - month },
      { id: 'unused', label: 'Beta', selectionFrecencyScore: 0, selectionUpdatedAt: now },
    ];
    expect(sortVaultItems(credentials, new Set(), now).map((item: any) => item.id))
      .toEqual(['regular', 'recent', 'old', 'unused']);
    expect(sortVaultItems(credentials, new Set(['old', 'recent']), now).map((item: any) => item.id))
      .toEqual(['recent', 'old', 'regular', 'unused']);
  });
  it('breaks equal scores by most recent selection before label', () => {
    const now = 1_800_000_000_000;
    expect(sortVaultItems([
      { id: 'older', label: 'Alpha', selectionFrecencyScore: 1, selectionUpdatedAt: now, lastSelectedAt: now - 1 },
      { id: 'newer', label: 'Zulu', selectionFrecencyScore: 1, selectionUpdatedAt: now, lastSelectedAt: now },
    ], new Set(), now).map((item: any) => item.id)).toEqual(['newer', 'older']);
  });

  it('carries historical task grants through metadata JSON into the displayed ordering', async () => {
    const store = await Store.create(':memory:');
    try {
      const now = Date.now();
      const month = 30 * 24 * 60 * 60 * 1000;
      const vault = new VaultItems(store);
      const old = await vault.save({ type: 'login', label: 'Alpha' });
      const recent = await vault.save({ type: 'login', label: 'Zulu' });
      const frequent = await vault.save({ type: 'login', label: 'Most selected' });
      const unused = await vault.save({ type: 'login', label: 'Beta' });
      const project = await store.createProject('Selections');
      for (const [item, count, ts] of [[old, 8, now - 4 * month], [recent, 2, now], [frequent, 12, now - month]] as const) {
        for (let i = 0; i < count; i++) {
          const task = await store.createTask({ projectId: project.id, title: 'Legacy task', workflow: 'software-dev', workflowVersion: '1',
            params: { prompt: '', archived: true, _authorization: { capabilities: [`use-credential:item:${item.id}`] } } });
          await store.db.prepare('UPDATE tasks SET createdAt = ?, credentialSelections = NULL WHERE id = ?').run(ts, task.id);
        }
      }
      // Old access-based metadata must never influence this picker again.
      await store.kvSet('vault:items:org_personal', JSON.stringify((await vault.list()).map(item =>
        item.id === unused.id ? { ...item, useCount: 1000, frecencyScore: 1000, frecencyUpdatedAt: now, lastUsedAt: now } : item)));
      const payload = JSON.parse(JSON.stringify(await vault.listForSelection()));
      expect(sortVaultItems(payload, new Set(), now).map((item: any) => item.id))
        .toEqual([frequent.id, recent.id, old.id, unused.id]);
      expect(sortVaultItems(payload, new Set([old.id]), now).map((item: any) => item.id))
        .toEqual([old.id, frequent.id, recent.id, unused.id]);
    } finally { await store.close(); }
  });
});
