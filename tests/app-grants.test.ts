import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { AppGrants, ACCESS_TOKEN_TTL_MS, GRANT_IDLE_TTL_MS, ceilingScope, digest, grantCapabilities, scopeCeiling } from '../src/auth/app-grants.js';

let store: Store;
let grants: AppGrants;
beforeEach(async () => { store = await Store.create(':memory:'); grants = new AppGrants(store); });
afterEach(async () => { vi.useRealTimers(); await store.close(); });

const cli = () => grants.create({ userId: 'u1', kind: 'cli', clientId: 'tavya-cli', name: 'laptop' });

describe('app grants', () => {
  it('stores tokens only as digests and resolves them to their grant', async () => {
    const grant = await cli();
    const { accessToken, refreshToken, expiresIn } = await grants.issue(grant);
    expect(accessToken).toMatch(/^tva_[A-Za-z0-9_-]{43}$/);
    expect(refreshToken).toMatch(new RegExp(`^tvr_${grant.id}\\.[A-Za-z0-9_-]{43}$`));
    expect(expiresIn).toBe(ACCESS_TOKEN_TTL_MS / 1000);
    const dump = JSON.stringify(await store.kvEntries('app-'));
    expect(dump).not.toContain(accessToken.slice(4));
    expect(dump).not.toContain(refreshToken.split('.')[1]);
    expect(dump).toContain(digest(accessToken));
    expect((await grants.authenticate(accessToken))?.id).toBe(grant.id);
    // A refresh token is not a bearer.
    expect(await grants.authenticate(refreshToken)).toBeUndefined();
    expect(await grants.authenticate(`tva_${'x'.repeat(43)}`)).toBeUndefined();
  });

  it('rotates refresh tokens and revokes the grant when a rotated one is reused', async () => {
    const grant = await cli();
    const first = await grants.issue(grant);
    const second = await grants.refresh(first.refreshToken, 'tavya-cli');
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(await grants.authenticate(second.accessToken)).toBeDefined();
    await expect(grants.refresh(first.refreshToken, 'tavya-cli')).rejects.toThrow(/reuse/);
    // The whole family is gone: the live access and refresh tokens too.
    expect(await grants.authenticate(second.accessToken)).toBeUndefined();
    expect(await grants.authenticate(first.accessToken)).toBeUndefined();
    await expect(grants.refresh(second.refreshToken, 'tavya-cli')).rejects.toThrow(/invalid/i);
    expect(await grants.list('u1')).toEqual([]);
  });

  it('refuses a refresh by another client without revoking anything', async () => {
    const grant = await cli();
    const { refreshToken, accessToken } = await grants.issue(grant);
    await expect(grants.refresh(refreshToken, 'someone-else')).rejects.toThrow(/invalid/i);
    await expect(grants.refresh(`tvr_${grant.id}.forged`, 'tavya-cli')).rejects.toThrow(/invalid/i);
    expect(await grants.authenticate(accessToken)).toBeDefined();
  });

  it('revoking a grant kills its tokens for every reader of the store (replicas)', async () => {
    const grant = await cli();
    const { accessToken } = await grants.issue(grant);
    const otherReplica = new AppGrants(store);
    expect(await otherReplica.authenticate(accessToken)).toBeDefined();
    expect(await grants.revoke(grant.id, 'someone-else')).toBe(false);
    expect(await grants.revoke(grant.id, 'u1')).toBe(true);
    expect(await otherReplica.authenticate(accessToken)).toBeUndefined();
  });

  it('slides cli/mcp grants on use and expires them after 90 idle days', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    const grant = await cli();
    const { accessToken, refreshToken } = await grants.issue(grant);
    vi.setSystemTime(1_000_000 + 30 * 60_000);
    const used = await grants.authenticate(accessToken);
    expect(used?.lastUsedAt).toBe(Date.now());
    expect(used?.expiresAt).toBe(Date.now() + GRANT_IDLE_TTL_MS);
    // At most one write a minute.
    vi.setSystemTime(Date.now() + 10_000);
    expect((await grants.authenticate(accessToken))?.lastUsedAt).toBe(1_000_000 + 30 * 60_000);
    // Access tokens die after an hour; refresh keeps the grant alive.
    vi.setSystemTime(1_000_000 + ACCESS_TOKEN_TTL_MS + 1);
    expect(await grants.authenticate(accessToken)).toBeUndefined();
    const next = await grants.refresh(refreshToken, 'tavya-cli');
    vi.setSystemTime(Date.now() + GRANT_IDLE_TTL_MS + 1);
    await expect(grants.refresh(next.refreshToken, 'tavya-cli')).rejects.toThrow(/invalid/i);
    expect(await grants.list('u1')).toEqual([]);
  });

  it('gives personal tokens a fixed expiry that use does not extend', async () => {
    vi.useFakeTimers({ now: 5_000_000, toFake: ['Date'] });
    const expiresAt = Date.now() + 7 * 24 * 60 * 60_000;
    const grant = await grants.create({ userId: 'u1', kind: 'token', clientId: 'personal', name: 'CI', expiresAt });
    const token = await grants.personalToken(grant);
    expect(token).toMatch(/^tvp_/);
    vi.setSystemTime(Date.now() + 60 * 60_000);
    expect((await grants.authenticate(token))?.expiresAt).toBe(expiresAt);
    vi.setSystemTime(expiresAt);
    expect(await grants.authenticate(token)).toBeUndefined();
    await expect(grants.create({ userId: 'u1', kind: 'token', clientId: 'personal', name: 'x', expiresAt: Date.now() - 1 }))
      .rejects.toThrow(/expiry/);
  });

  it('revokes per RFC 7009: refresh and personal tokens take their grant, access tokens only themselves', async () => {
    const grant = await cli();
    const one = await grants.issue(grant);
    const two = await grants.refresh(one.refreshToken, 'tavya-cli');
    await grants.revokeToken(two.accessToken, 'tavya-cli');
    expect(await grants.authenticate(two.accessToken)).toBeUndefined();
    expect(await grants.authenticate(one.accessToken)).toBeDefined();
    await grants.revokeToken(two.refreshToken, 'another-client');
    expect(await grants.authenticate(one.accessToken)).toBeDefined();
    await grants.revokeToken(two.refreshToken, 'tavya-cli');
    expect(await grants.authenticate(one.accessToken)).toBeUndefined();
    const pat = await grants.create({ userId: 'u1', kind: 'token', clientId: 'personal', name: 'CI', expiresAt: Date.now() + 60_000 });
    const token = await grants.personalToken(pat);
    await grants.revokeToken(token);
    expect(await grants.list('u1')).toEqual([]);
  });

  it('dies with the account: a closed account authenticates nothing and closure removes its grants', async () => {
    const grant = await cli();
    const { accessToken } = await grants.issue(grant);
    await store.kvSet('account-closed:u1', '{}');
    expect(await grants.authenticate(accessToken)).toBeUndefined();
    expect(await grants.revokeUser('u1')).toBe(1);
    await store.kvDelete('account-closed:u1');
    expect(await grants.authenticate(accessToken)).toBeUndefined();
    expect(await store.kvEntries('app-token:')).toEqual([]); // the dead token's row went with it
  });

  it('sweeps token rows nobody presented again', async () => {
    const grant = await cli();
    await grants.issue(grant);
    await grants.revoke(grant.id);
    expect(await grants.sweep()).toBe(1);
    expect(await store.kvEntries('app-token:')).toEqual([]);
  });
});

describe('grant ceilings', () => {
  it('attenuates by level and explicit caps and confines to project and organization scope', () => {
    const user = ['task:read', 'task:create', 'project:read', 'project:settings:write'];
    expect(grantCapabilities(undefined, user, { projectId: 'p1' }, undefined)).toEqual(user);
    expect(grantCapabilities({ level: 'viewer' }, user, { projectId: 'p1' }, ['task:read', 'project:read']).sort())
      .toEqual(['project:read', 'task:read']);
    expect(grantCapabilities({ level: 'missing' }, user, {}, undefined)).toEqual([]);
    expect(grantCapabilities({ caps: ['task:*'] }, user, {}, undefined).sort()).toEqual(['task:create', 'task:read']);
    expect(grantCapabilities({ projectIds: ['p1'] }, user, { projectId: 'p2', organizationId: 'o' }, undefined)).toEqual([]);
    expect(grantCapabilities({ projectIds: ['p1'] }, user, { projectId: 'p1', organizationId: 'o' }, undefined)).toEqual(user);
    expect(grantCapabilities({ projectIds: ['p1'] }, user, { organizationId: 'o' }, undefined)).toEqual([]);
    expect(grantCapabilities({ organizationId: 'o1' }, user, { projectId: 'p', organizationId: 'o2' }, undefined)).toEqual([]);
    expect(grantCapabilities({ organizationId: 'o1' }, user, { organizationId: 'o1' }, undefined)).toEqual(user);
  });

  it('describes ceilings as OAuth scope words and back', () => {
    expect(ceilingScope(undefined)).toBe('all');
    const ceiling = { level: 'developer', projectIds: ['proj_b', 'proj_a'] };
    expect(ceilingScope(scopeCeiling(ceilingScope(ceiling)))).toBe('level:developer project:proj_a project:proj_b');
    expect(scopeCeiling('openid level:viewer bogus:x/y')).toEqual({ level: 'viewer' });
    expect(scopeCeiling('')).toBeUndefined();
  });
});

// The hosted store is PostgreSQL: the compare-and-set that rotation and use
// tracking rely on must hold there too (shared database, so a fresh user id).
const postgres = process.env.KARMAX_TEST_POSTGRES_URL;
(postgres ? describe : describe.skip)('app grants on PostgreSQL', () => {
  it('rotates, detects reuse and revokes', async () => {
    const pg = await Store.create(postgres!);
    try {
      const pgGrants = new AppGrants(pg);
      const userId = `u_pg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const grant = await pgGrants.create({ userId, kind: 'cli', clientId: 'tavya-cli', name: 'pg' });
      const first = await pgGrants.issue(grant);
      // Concurrent uses and a refresh: none may undo the rotation.
      const [, , second] = await Promise.all([pgGrants.authenticate(first.accessToken), pgGrants.authenticate(first.accessToken),
        pgGrants.refresh(first.refreshToken, 'tavya-cli')]);
      expect(await pgGrants.authenticate(second.accessToken)).toBeDefined();
      await expect(pgGrants.refresh(first.refreshToken, 'tavya-cli')).rejects.toThrow(/reuse/);
      expect(await pgGrants.authenticate(second.accessToken)).toBeUndefined();
      expect(await pgGrants.list(userId)).toEqual([]);
    } finally { await pg.close(); }
  });
});
