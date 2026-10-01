import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { StorageLocationService } from '../src/store/storage-locations.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { HOSTED_PLANS, STORAGE_PACK, hostedStorageQuotaBytes, organizationEntitlements } from '../src/domain/entitlements.js';

const GIB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function fixture(hosted: boolean, operatorQuota?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-storage-plans-')); dirs.push(dir);
  const store = (await Store.create(':memory:', { hosted }));
  const project = (await store.createProject('Storage plans'));
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const locations = new StorageLocationService(store, new LocalObjectStore(path.join(dir, 'objects')), broker, operatorQuota);
  const managed = (await locations.ensureManaged(project.organizationId!));
  return { store, organizationId: project.organizationId!, locations, managed };
}

describe('plan storage entitlements', () => {
  it('prices storage per plan, per additional Team user and per pack', () => {
    expect(HOSTED_PLANS.free.storageBytes).toBe(5 * GIB);
    expect(HOSTED_PLANS.individual.storageBytes).toBe(50 * GIB);
    expect(HOSTED_PLANS.team.storageBytes).toBe(100 * GIB);
    expect(STORAGE_PACK).toEqual({ bytes: 100 * GIB, monthlyPriceCents: 400 });
    expect(hostedStorageQuotaBytes('team', 3, 2)).toBe((100 + 2 * 10 + 2 * 100) * GIB);
    expect(hostedStorageQuotaBytes('individual', 1, 1)).toBe(150 * GIB);
  });

  it('ignores packs on Free, so a lapsed subscription falls back to the Free quota', () => {
    expect(hostedStorageQuotaBytes('free', 1, 5)).toBe(5 * GIB);
    expect(organizationEntitlements('free', true, 1, 5)).toMatchObject({ storageQuotaBytes: 5 * GIB, storagePacks: 0 });
  });

  it('leaves private installations unmetered', () => {
    expect(organizationEntitlements('team', false, 4, 3)).toMatchObject({ storageQuotaBytes: null });
  });
});

describe('hosted managed storage quota', () => {
  it('follows the plan, active users and verified packs', async () => {
    const f = (await fixture(true));
    expect((await f.store.storageLocationUsage(f.managed.id)).quotaBytes).toBe(5 * GIB);

    (await f.store.setOrganizationPlan(f.organizationId, 'team'));
    (await f.store.setOrganizationStoragePacks(f.organizationId, 2));
    expect((await f.store.organizationEntitlements(f.organizationId))).toMatchObject({ storagePacks: 2, storageQuotaBytes: 300 * GIB });
    const [listed] = (await f.locations.list(f.organizationId));
    expect(listed!.quotaBytes).toBe(300 * GIB);
    expect(listed!.usage).toMatchObject({ quotaBytes: 300 * GIB, availableBytes: 300 * GIB });

    (await f.store.setOrganizationPlan(f.organizationId, 'free'));
    expect((await f.store.storageLocationUsage(f.managed.id)).quotaBytes).toBe(5 * GIB);
  });

  it('enforces the plan quota rather than a quota saved on the location', async () => {
    const f = (await fixture(true));
    (await f.store.saveStorageLocation({ ...f.managed, quotaBytes: 1 }));
    (await f.locations.reserveUpload('upload-a', f.organizationId, f.managed.id, 4 * GIB, Date.now() + 60_000));
    await expect(f.locations.reserveUpload('upload-b', f.organizationId, f.managed.id, 2 * GIB, Date.now() + 60_000))
      .rejects.toThrow(/upload quota exceeded/i);
  });

  it('rejects an invalid pack count', async () => {
    const f = (await fixture(true));
    await expect(f.store.setOrganizationStoragePacks(f.organizationId, -1)).rejects.toThrow(/non-negative/);
    await expect(f.store.setOrganizationStoragePacks(f.organizationId, 1.5)).rejects.toThrow(/non-negative/);
  });
});

describe('private managed storage quota', () => {
  it('keeps the operator cap and ignores plans', async () => {
    const f = (await fixture(false, 1024));
    (await f.store.setOrganizationPlan(f.organizationId, 'team'));
    expect((await f.store.storageLocationUsage(f.managed.id)).quotaBytes).toBe(1024);
  });
});
