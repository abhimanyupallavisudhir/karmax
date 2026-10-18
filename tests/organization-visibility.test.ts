import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';

describe('organization name discovery', () => {
  it('migrates privately, persists visibility, and respects membership removal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-discovery-'));
    const file = path.join(dir, 'store.db');
    let store = (await Store.create(file));
    try {
      const org = (await store.createOrganization({ name: 'A private team', ownerUserId: 'owner' }));
      (await store.db.exec('ALTER TABLE organizations DROP COLUMN nameVisibility'));
      (await store.close());
      store = (await Store.create(file));
      expect((await store.getOrganization(org.id))?.nameVisibility).toBe('members');
      expect((await store.organizationDirectory('stranger'))).toEqual([]);
      expect((await store.organizationDirectory('owner'))).toEqual([{ id: org.id, name: org.name, accessible: true }]);
      (await store.setOrganizationMembership(org.id, 'viewer', 'member'));
      expect((await store.organizationDirectory('viewer'))).toEqual([{ id: org.id, name: org.name, accessible: true }]);
      (await store.db.prepare('DELETE FROM organization_memberships WHERE userId=?').run('viewer'));
      expect((await store.organizationDirectory('viewer'))).toEqual([]);
      (await store.setOrganizationNameVisibility(org.id, 'public'));
      (await store.close());
      store = (await Store.create(file));
      expect((await store.organizationDirectory('stranger'))).toEqual([{ id: org.id, name: org.name, accessible: false }]);
      await expect((async () => (await store.setDefaultOrganization('stranger', org.id)))()).rejects.toThrow();
      await expect((async () => (await store.setOrganizationNameVisibility(org.id, 'bad' as any)))()).rejects.toThrow();
      (await store.setOrganizationNameVisibility(org.id, 'members'));
      expect((await store.organizationDirectory('stranger'))).toEqual([]);
      expect((await store.organizationDirectory('operator', true)).map((o) => o.id)).toContain(org.id);
      (await store.setDefaultOrganization('operator', org.id, true));
      expect((await store.exportUserData('operator')).preferences).toEqual({ defaultOrganizationId: org.id, dismissed: [] });
      expect((await store.defaultOrganization('operator', true))?.id).toBe(org.id);
    } finally { (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps what a person dismissed when their default organization goes away', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-preferences-'));
    const file = path.join(dir, 'store.db');
    let store = (await Store.create(file));
    try {
      const home = (await store.createOrganization({ name: 'Home base', ownerUserId: 'pat' }));
      const team = (await store.createOrganization({ name: 'Side team', ownerUserId: 'lee' }));
      (await store.setOrganizationMembership(team.id, 'pat', 'member'));
      (await store.setDefaultOrganization('pat', team.id));
      expect((await store.updateUserPreferences('pat', { dismiss: ['task-store:p1', 'task-store:p2', 'task-store:p1'] })).dismissed)
        .toEqual(['task-store:p1', 'task-store:p2']);
      expect((await store.updateUserPreferences('pat', { undismiss: ['task-store:p2'] })).dismissed).toEqual(['task-store:p1']);
      (await store.removeOrganizationMembership(team.id, 'pat'));
      expect((await store.userPreferences('pat')).dismissed).toEqual(['task-store:p1']);
      expect((await store.defaultOrganization('pat'))?.id).toBe(home.id);
      (await store.setOrganizationMembership(team.id, 'pat', 'member'));
      (await store.setDefaultOrganization('pat', team.id));
      (await store.deleteOrganization(team.id));
      (await store.close());
      store = (await Store.create(file));
      expect((await store.userPreferences('pat')).dismissed).toEqual(['task-store:p1']);
      expect((await store.exportUserData('pat')).preferences).toMatchObject({ dismissed: ['task-store:p1'] });
      expect((await store.userPreferences('nobody')).dismissed).toEqual([]);
    } finally { (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
