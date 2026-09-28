import { describe, expect, it } from 'vitest';
import type { ResourceAttachment, ResourceIsolation, ResourceTarget } from '../src/domain/types.js';
import {
  credentialResource, resourceDriver, resourceDriverCatalog, snapshotResource,
} from '../src/domain/resource-drivers.js';
import { Store } from '../src/store/db.js';

describe('resource driver registry (CI-38c)', () => {
  it('classifies every built-in driver onto exactly one data plane', () => {
    const catalog = resourceDriverCatalog();
    expect(catalog.map((driver) => driver.id)).toEqual(['volume@1', 'object-tree@1', 'secret@1', 'database@1', 'service@1']);
    for (const driver of catalog) {
      expect(resourceDriver(driver.id)).toEqual(driver);
      expect(snapshotResource(driver.id)).toBe(driver.dataPlane === 'snapshot');
      expect(credentialResource(driver.id)).toBe(driver.dataPlane === 'credential');
      // Only snapshots have revisions to promote; only credentials need a handle.
      expect(driver.reviewedPromotion).toBe(driver.dataPlane === 'snapshot');
      expect(driver.credentialRequired).toBe(driver.dataPlane === 'credential');
    }
    expect(snapshotResource({ driver: 'object-tree@1' } as ResourceAttachment)).toBe(true);
    expect(credentialResource({ driver: 'service@1' } as ResourceAttachment)).toBe(true);
  });

  it('treats an unknown driver as neither snapshot nor credential', () => {
    for (const id of ['volume@2', 'volume', 'VOLUME@1', '']) {
      expect(resourceDriver(id)).toBeUndefined();
      expect(snapshotResource(id)).toBe(false);
      expect(credentialResource(id)).toBe(false);
    }
  });

  it('hands out catalog copies that cannot rewrite the registry', () => {
    const [volume] = resourceDriverCatalog();
    volume!.label = 'changed';
    volume!.dataPlane = 'credential';
    volume!.targets.push('environment');
    volume!.isolations.push('shared');
    expect(resourceDriver('volume@1')).toMatchObject({ label: 'Versioned files / model / SQLite', dataPlane: 'snapshot',
      targets: ['path'], isolations: ['fork'] });
    expect(() => (resourceDriver('volume@1')!.targets as string[]).push('service')).toThrow(TypeError);
    expect(resourceDriverCatalog()[0]).toMatchObject({ targets: ['path'], isolations: ['fork'] });
  });
});

describe('store validation follows each driver definition', () => {
  const targets: Record<ResourceTarget['kind'], ResourceTarget> = {
    path: { kind: 'path', path: 'data/model' },
    environment: { kind: 'environment', name: 'PROJECT_TOKEN' },
    service: { kind: 'service', name: 'DATABASE_URL' },
  };

  it('accepts exactly the targets and isolations a driver declares', async () => {
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Drivers');
      const attach = (driver: string, target: ResourceTarget, isolation: ResourceIsolation, credentialHandles = ['resource:h']) =>
        store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id, name: `${driver} ${target.kind} ${isolation} ${credentialHandles.length}`,
          driver, target, access: 'read', isolation, source: {}, credentialHandles, publish: 'discard' });
      for (const driver of resourceDriverCatalog()) {
        for (const kind of Object.keys(targets) as ResourceTarget['kind'][]) {
          for (const isolation of ['fork', 'shared'] as const) {
            const created = attach(driver.id, targets[kind], isolation);
            if (!driver.isolations.includes(isolation))
              await expect(created).rejects.toThrow(`${driver.id} does not support ${isolation} isolation`);
            else if (!driver.targets.includes(kind))
              await expect(created).rejects.toThrow(`${driver.id} does not support ${kind} targets`);
            else await expect(created).resolves.toMatchObject({ driver: driver.id, target: targets[kind], isolation });
          }
        }
        const supported = targets[driver.targets[0]!];
        const withoutHandle = attach(driver.id, supported, driver.isolations[0]!, []);
        if (driver.credentialRequired) await expect(withoutHandle).rejects.toThrow(/require a credential handle/);
        else await expect(withoutHandle).resolves.toMatchObject({ credentialHandles: [] });
      }
      await expect(attach('volume@9', targets.path, 'fork')).rejects.toThrow('resource driver volume@9 is not installed');
      await expect(attach('volume', targets.path, 'fork')).rejects.toThrow(/versioned registry id/);
    } finally {
      await store.close();
    }
  });

  it('allows reviewed promotion only for writable forked snapshots', async () => {
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Promotion');
      const attach = (driver: string, target: ResourceTarget, access: 'read' | 'write') =>
        store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id, name: `${driver} ${access}`,
          driver, target, access, isolation: 'fork', source: {}, credentialHandles: ['resource:h'], publish: 'review' });
      await expect(attach('volume@1', targets.path, 'write')).resolves.toMatchObject({ publish: 'review' });
      await expect(attach('object-tree@1', targets.path, 'read')).rejects.toThrow(/reviewed promotion requires/);
      await expect(attach('secret@1', targets.environment, 'write')).rejects.toThrow(/reviewed promotion requires/);
    } finally {
      await store.close();
    }
  });
});
