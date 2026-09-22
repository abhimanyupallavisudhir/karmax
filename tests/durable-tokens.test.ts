import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';

describe('durable scoped tokens', () => {
  it('survives authority restart, verifies across replicas, and revokes immediately', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-token-'));
    const file = path.join(dir, 'state.db');
    const storeA = (await Store.create(file));
    const authorityA = new TokenAuthority(storeA);
    const issued = (await authorityA.mint({ taskId: 'task-1', profileId: 'do', principal: 'user:a',
      organizationId: 'org_personal', projectId: 'project-1', ceiling: ['task:read'], grantorCaps: ['task:read'] }));

    const stored = (await storeA.db.prepare('SELECT tokenHash, json FROM scoped_tokens').get()) as any;
    expect(stored.tokenHash).not.toContain(issued.token);
    expect(stored.json).not.toContain(issued.token);

    const storeB = (await Store.create(file));
    const authorityB = new TokenAuthority(storeB);
    expect((await authorityB.check(issued.token, 'task:read', { organizationId: 'org_personal', projectId: 'project-1' })).ok).toBe(true);
    expect((await authorityB.check(issued.token, 'task:read', { organizationId: 'another' })).ok).toBe(false);

    (await authorityB.revoke(issued.token));
    expect((await authorityA.verify(issued.token))).toBeUndefined();
    (await storeB.close());
    (await storeA.close());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('checks transferred task ownership without loading its conversation', async () => {
    const store = await Store.create(':memory:');
    try {
      const project = await store.createProject('Token routing');
      const task = await store.createTask({ projectId: project.id, title: 'History', workflow: 'just-do',
        workflowVersion: '1', params: { prompt: 'history', draft: true } });
      const authority = new TokenAuthority(store);
      const issued = await authority.mint({ taskId: task.id, profileId: 'do', principal: 'user:a',
        organizationId: project.organizationId, projectId: project.id, ceiling: ['task:read'], grantorCaps: ['task:read'] });
      vi.spyOn(store, 'getTask').mockRejectedValue(new Error('must not hydrate task history'));
      vi.spyOn(store, 'getProject').mockRejectedValue(new Error('must not hydrate project'));
      expect((await authority.check(issued.token, 'task:read', { taskId: task.id })).ok).toBe(true);
      const destination = await store.createOrganization({ name: 'Destination', ownerUserId: 'receiver' });
      await store.db.prepare('UPDATE projects SET organizationId=? WHERE id=?').run(destination.id, project.id);
      expect((await authority.check(issued.token, 'task:read', { taskId: task.id })).ok).toBe(false);
    } finally { await store.close(); }
  });

});
