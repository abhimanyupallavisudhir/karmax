import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';

describe('organization name discovery', () => {
  it('migrates privately, persists visibility, and respects membership removal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-discovery-'));
    const file = path.join(dir, 'store.db');
    let store = new Store(file);
    try {
      const org = store.createOrganization({ name: 'A private team', ownerUserId: 'owner' });
      store.db.exec('ALTER TABLE organizations DROP COLUMN nameVisibility');
      store.close();
      store = new Store(file);
      expect(store.getOrganization(org.id)?.nameVisibility).toBe('members');
      expect(store.organizationDirectory('stranger')).toEqual([]);
      expect(store.organizationDirectory('owner')).toEqual([{ id: org.id, name: org.name, accessible: true }]);
      store.setOrganizationMembership(org.id, 'viewer', 'member');
      expect(store.organizationDirectory('viewer')).toEqual([{ id: org.id, name: org.name, accessible: true }]);
      store.db.prepare('DELETE FROM organization_memberships WHERE userId=?').run('viewer');
      expect(store.organizationDirectory('viewer')).toEqual([]);
      store.setOrganizationNameVisibility(org.id, 'public');
      store.close();
      store = new Store(file);
      expect(store.organizationDirectory('stranger')).toEqual([{ id: org.id, name: org.name, accessible: false }]);
      expect(() => store.setDefaultOrganization('stranger', org.id)).toThrow();
      expect(() => store.setOrganizationNameVisibility(org.id, 'bad' as any)).toThrow();
      store.setOrganizationNameVisibility(org.id, 'members');
      expect(store.organizationDirectory('stranger')).toEqual([]);
      expect(store.organizationDirectory('operator', true).map((o) => o.id)).toContain(org.id);
      store.setDefaultOrganization('operator', org.id, true);
      expect(store.exportUserData('operator').preferences).toEqual({ defaultOrganizationId: org.id });
      expect(store.defaultOrganization('operator', true)?.id).toBe(org.id);
    } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
