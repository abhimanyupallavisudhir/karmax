import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';

describe('durable scoped tokens', () => {
  it('survives authority restart, verifies across replicas, and revokes immediately', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-token-'));
    const file = path.join(dir, 'state.db');
    const storeA = new Store(file);
    const authorityA = new TokenAuthority(storeA);
    const issued = authorityA.mint({ taskId: 'task-1', profileId: 'do', principal: 'user:a',
      organizationId: 'org_personal', projectId: 'project-1', ceiling: ['task:read'], grantorCaps: ['task:read'] });

    const stored = storeA.db.prepare('SELECT tokenHash, json FROM scoped_tokens').get() as any;
    expect(stored.tokenHash).not.toContain(issued.token);
    expect(stored.json).not.toContain(issued.token);

    const storeB = new Store(file);
    const authorityB = new TokenAuthority(storeB);
    expect(authorityB.check(issued.token, 'task:read', { organizationId: 'org_personal', projectId: 'project-1' }).ok).toBe(true);
    expect(authorityB.check(issued.token, 'task:read', { organizationId: 'another' }).ok).toBe(false);

    authorityB.revoke(issued.token);
    expect(authorityA.verify(issued.token)).toBeUndefined();
    storeB.close();
    storeA.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
