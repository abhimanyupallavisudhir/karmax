import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { VaultItems } from '../src/autonomy/vault-items.js';

let dir: string;
let store: Store;
let first: VaultItems;
let second: VaultItems;
let broker: CredentialBroker;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-async-concurrency-'));
  store = await Store.create();
  broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  first = new VaultItems(store, broker, path.join(dir, 'state'));
  second = new VaultItems(store, broker, path.join(dir, 'state'));
});
afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('retains concurrent creates from independent service instances', async () => {
  const created = await Promise.all([
    first.save({ type: 'note', label: 'First concurrent item' }),
    second.save({ type: 'note', label: 'Second concurrent item' }),
  ]);
  expect((await first.list()).map(item => item.id).sort()).toEqual(created.map(item => item.id).sort());
});

it('preserves sparse edits and every concurrent use without moving the edit revision for usage', async () => {
  const item = await first.save({ type: 'note', label: 'Original', secrets: { note: 'test-only' } });
  await Promise.all([
    first.save({ id: item.id, type: 'note', label: 'Renamed' }),
    second.save({ id: item.id, type: 'note', tags: ['kept'] }),
    first.resolveField(item, 'note', { mode: 'use' }),
    second.resolveField(item, 'note', { mode: 'use' }),
  ]);
  const edited = (await first.get(item.id))!;
  expect(edited).toMatchObject({ label: 'Renamed', tags: ['kept'], useCount: 2 });
  await second.resolveField(item, 'note', { mode: 'use' });
  expect(await first.get(item.id)).toMatchObject({ useCount: 3, updatedAt: edited.updatedAt });
});

it('does not resurrect deleted items during concurrent legacy usage migration', async () => {
  const removed = await first.save({ type: 'note', label: 'Remove' });
  const kept = await first.save({ type: 'note', label: 'Keep' });
  const legacy = (await first.list()).map(({ frecencyUpdatedAt, ...item }) => item);
  await store.kvSet('vault:items:org_personal', JSON.stringify(legacy));
  await Promise.all([first.list(), second.delete(removed.id)]);
  expect((await first.list()).map(item => item.id)).toEqual([kept.id]);
});

it('resolves an approval exactly once and consumes its pass exactly once', async () => {
  const item = await first.save({ type: 'note', label: 'Restricted', policy: { use: 'ask' } });
  const request = await first.request({ taskId: 'test-task', itemId: item.id, caps: [] });
  const results = await Promise.allSettled([
    first.resolve(request.requestId!, { action: 'once', by: 'test-human' }),
    second.resolve(request.requestId!, { action: 'once', by: 'test-human' }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const accesses = await Promise.all([
    first.access([], 'test-task', item, 'use', { consume: true }),
    second.access([], 'test-task', item, 'use', { consume: true }),
  ]);
  expect(accesses.filter(result => result.status === 'granted')).toHaveLength(1);
  expect(accesses.filter(result => result.status === 'needs_approval')).toHaveLength(1);
});

it('retains concurrent Git profile registrations', async () => {
  const { GitProfiles } = await import('../src/autonomy/git-profiles.js');
  const a = new GitProfiles(store, undefined, dir);
  const b = new GitProfiles(store, undefined, dir);
  await Promise.all([
    a.save({ name: 'first', userName: 'First', userEmail: 'first@example.test' }),
    b.save({ name: 'second', userName: 'Second', userEmail: 'second@example.test' }),
  ]);
  expect((await a.list()).map(profile => profile.name).sort()).toEqual(['first', 'second']);
});

it('does not lose simulated funds or authorize the same balance twice', async () => {
  const { MockPaymentProvider } = await import('../src/autonomy/payments.js');
  const a = new MockPaymentProvider(store);
  const b = new MockPaymentProvider(store);
  const card = await a.provisionCard({ scope: 'organization', scopeId: 'org_personal', label: 'Concurrent funds', cap: 1000 });
  await Promise.all([a.fund(card.id, 40), b.fund(card.id, 60)]);
  expect((await a.getCard(card.id))?.available).toBe(100);
  const results = await Promise.all([a.authorize(card.id, 80), b.authorize(card.id, 80)]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect((await a.getCard(card.id))?.available).toBe(20);
});


it('preserves independent connector settings and concurrent durable export retries', async () => {
  const { Connectors } = await import('../src/autonomy/connectors.js');
  const a = new Connectors(store, first, broker);
  const b = new Connectors(store, second, broker);
  const connector = {
    name: 'source',
    describe: async () => ({ name: 'source', label: 'source', available: true, detail: '', canPush: true }),
    list: async () => [],
    pull: async () => ({ items: [], failures: [] }),
    push: async () => { throw new Error('test connector offline'); },
  };
  a.register(connector);
  b.register(connector);
  await Promise.all([
    a.setConfig('source', { writeBack: true }),
    b.setConfig('source', { lastSync: { at: 123, count: 2 } }),
  ]);
  expect(await a.config('source')).toMatchObject({ writeBack: true, lastSync: { at: 123, count: 2 } });
  const items = await Promise.all([
    first.save({ type: 'note', label: 'First export', secrets: { note: 'first-test-secret' } }),
    second.save({ type: 'note', label: 'Second export', secrets: { note: 'second-test-secret' } }),
  ]);
  await Promise.all([a.writeBackCreated(items[0]!.id), b.writeBackCreated(items[1]!.id)]);
  const pending = await a.pendingWrites();
  expect(pending.map(write => write.itemId).sort()).toEqual(items.map(item => item.id).sort());
  expect(pending.every(write => write.attempts === 1)).toBe(true);
  expect(JSON.stringify(pending)).not.toContain('test-secret');
  await Promise.all([a.discardWrites('source'), b.setConfig('source', { writeBack: false })]);
  expect(await a.pendingWrites()).toEqual([]);
  expect(await b.config('source')).toMatchObject({ writeBack: false, lastSync: { at: 123, count: 2 } });
});
