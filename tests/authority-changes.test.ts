import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../src/store/db.js';
import { storeBackends } from './helpers/store-backends.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import {
  affects, authorityChanged, authoritySeq, changedSince, onAuthorityChange, type AuthorityChange,
} from '../src/store/authorization-epoch.js';

/**
 * Load test 2026-10 (benchmarks/results/load-report-2026-10.md): every agent
 * turn ends by revoking its token, which moved one installation-wide epoch,
 * and every open socket then re-derived its owner's access. A write now says
 * whose authority it touched: a token, a delegation, a principal, a project,
 * an organization. A write the classifier does not know touches everything,
 * so an unrecognised path still fails closed.
 */
describe.each(storeBackends)('authority changes ($name)', ({ open }) => {
  let store: Store;
  let changes: AuthorityChange[] = [];
  let off = () => {};
  const record = () => { changes = []; off(); off = onAuthorityChange((change) => { changes.push(change); }); };
  afterEach(async () => { off(); await store?.close(); });

  it('scopes a revoked token to that token, and a minted one to nothing', async () => {
    store = await open();
    const tokens = new TokenAuthority(store);
    record();
    const minted = await tokens.mint({ taskId: 't', profileId: 'p', principal: 'user:owner', ceiling: ['task:read'], grantorCaps: ['task:read'] });
    expect(changes).toEqual([]);
    await tokens.revoke(minted.token);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.all).toBeFalsy();
    expect(changes[0]!.principals ?? []).toEqual([]);
    expect(changes[0]!.tokens).toHaveLength(1);
    // A person's socket depends on their principal, not on an agent's token.
    expect(affects(changes[0]!, { principals: new Set(['user:owner']), projects: new Set(['p1']), organizations: new Set(['org_personal']) })).toBe(false);
    expect(affects(changes[0]!, { tokens: new Set(changes[0]!.tokens) })).toBe(true);
  });

  it('scopes grant and membership changes to the principal and project they name', async () => {
    store = await open();
    const authorization = await AuthorizationService.create(store);
    const org = await store.createOrganization({ name: 'Scoped' });
    const project = await store.createProject('App', {}, org.id);
    const team = await store.createTeam({ organizationId: org.id, name: 'Team' });
    await store.setOrganizationMembership(org.id, 'dev', 'member');
    record();
    await authorization.grant('user:owner', { principalId: 'user:dev', scopeKey: `organization:${org.id}`, profileId: 'developer' });
    await store.setTeamMembership(team.id, 'dev');
    await store.setProjectMembership(project.id, { kind: 'team', teamId: team.id }, 'maintainer');
    await store.removeProjectMembership(project.id, { kind: 'team', teamId: team.id });
    await store.removeTeamMembership(team.id, 'dev');
    await authorization.revoke('user:owner', 'user:dev', `organization:${org.id}`);
    await store.removeOrganizationMembership(org.id, 'dev');
    expect(changes.length).toBeGreaterThanOrEqual(7);
    for (const change of changes) expect(change.all, JSON.stringify(change)).toBeFalsy();
    const someoneElse = { principals: new Set(['user:other']), projects: new Set(['elsewhere']), organizations: new Set(['org_other']) };
    for (const change of changes) expect(affects(change, someoneElse)).toBe(false);
    const dev = { principals: new Set(['user:dev', `team:${team.id}`, `organization:${org.id}`]) };
    for (const change of changes) expect(affects(change, dev)).toBe(true);
  });

  it('treats a write it does not recognise, and a profile edit, as touching everyone', async () => {
    store = await open();
    record();
    await store.db.prepare('DELETE FROM principal_grants WHERE scopeKey = ? AND principalId <> ?').run('global', 'x');
    await store.setAuthorizationProfile('global', { id: 'custom', name: 'Custom', capabilities: ['task:read'] });
    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.all)).toBe(true);
  });

  it('ignores writes that withdraw nothing', async () => {
    store = await open();
    const tokens = new TokenAuthority(store);
    const minted = await tokens.mint({ taskId: 't', profileId: 'p', principal: 'user:owner', ceiling: ['task:read'], grantorCaps: ['task:read'], ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    record();
    await store.purgeScopedTokens();
    await store.purgeHumanDelegations();
    // Purging deletes only dead rows: nothing that was valid stops being valid.
    for (const change of changes) expect(change.all).toBeFalsy();
    expect(await tokens.verify(minted.token)).toBeUndefined();
  });
});

describe('changedSince', () => {
  it('answers from the changes after a decision, not the installation-wide count', () => {
    const since = authoritySeq();
    authorityChanged({ tokens: ['agent-token'] });
    authorityChanged({ principals: ['user:someone-else'] });
    expect(changedSince(since, { principals: new Set(['user:me']), projects: new Set(['p']) })).toBe(false);
    authorityChanged({ projects: ['p'] });
    expect(changedSince(since, { principals: new Set(['user:me']), projects: new Set(['p']) })).toBe(true);
    const later = authoritySeq();
    authorityChanged({ all: true });
    expect(changedSince(later, { principals: new Set(['user:me']) })).toBe(true);
  });

  it('assumes a change when its record has been forgotten', () => {
    const since = authoritySeq();
    for (let i = 0; i < 5_000; i++) authorityChanged({ tokens: [`t${i}`] });
    expect(changedSince(since, { principals: new Set(['user:me']) })).toBe(true);
  });
});
