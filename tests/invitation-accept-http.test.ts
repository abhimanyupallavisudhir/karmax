import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';

let nextPort = 49_180;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// Stub only the identity provider: each cookie names a signed-in user. The
// invitation, membership, authorization and seat-sync paths are the real ones.
const users = {
  owner: { id: 'owner', name: 'Owner', email: 'owner@example.test' },
  invitee: { id: 'invitee', name: 'Invitee', email: 'Invitee@Example.test' },
  stranger: { id: 'stranger', name: 'Stranger', email: 'stranger@example.test' },
  unverified: { id: 'unverified', name: 'No email', email: '' },
};

async function boot() {
  const store = await Store.create(':memory:');
  const tokens = new TokenAuthority(), worlds = new WorldRegistry();
  const client = { workflow: { getHandle: () => ({ query: async () => [] }) } } as any;
  const api = new KarmaxApi({ store, tokens, worlds, client, taskQueue: 'test' });
  const authorization = await AuthorizationService.create(store);
  const syncSeats = vi.fn(async () => {});
  const user = (headers: Headers) => Object.values(users).find((u) => headers.get('cookie') === `fixture=${u.id}`);
  const gateway = await Gateway.create({ store, tokens, worlds, client, api, authorization,
    identity: { sessionActive: async (id: string, userId: string) => id === `session-${userId}`,
      connectOrganizationNames: () => {},
      session: async (headers: Headers) => {
        const found = user(headers);
        return found ? { user: found, session: { id: `session-${found.id}` } } : null;
      },
      listUsers: async () => Object.values(users),
    } as any,
    subscriptions: { syncSeats } as any,
    taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'invitation acceptance verification' } });
  const server = await gateway.listen(await findFreePortFrom(nextPort += 10));
  cleanups.push(async () => { await server.close(); await store.close(); });
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  await authorization.bootstrapOrganizationOwner('system:test', 'owner', organization.id);
  const as = (userId: string | undefined) => (route: string, body?: unknown) => fetch(`${server.url}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(userId ? { cookie: `fixture=${userId}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const invite = async (email: string, authorizationSelection?: unknown) => {
    const response = await as('owner')(`/api/organizations/${organization.id}/invitations`,
      { email, ...(authorizationSelection ? { authorization: authorizationSelection } : {}) });
    expect(response.status).toBe(200);
    return (await response.json() as { token: string }).token;
  };
  return { store, authorization, server, organization, syncSeats, as, invite };
}

it('joins the invited organization with the invitation\'s authorization and syncs seats', async () => {
  const { store, authorization, organization, syncSeats, as, invite } = await boot();
  const token = await invite('invitee@example.test', { level: 'viewer' });
  // Not yet a member: the organization is closed to the invitee.
  expect((await as('invitee')(`/api/organizations/${organization.id}/members`)).status).toBe(403);

  const accepted = await as('invitee')('/api/invitations/accept', { token });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ organizationId: organization.id, userId: 'invitee', role: 'member' });
  expect(await store.organizationMembership(organization.id, 'invitee')).toMatchObject({ role: 'member' });
  const caps = await authorization.capabilitiesAsync('user:invitee', undefined, organization.id);
  expect(caps).toContain('organization:member:read');
  expect(caps).not.toContain('organization:member:write');
  expect((await as('invitee')(`/api/organizations/${organization.id}/members`)).status).toBe(200);
  await vi.waitFor(() => expect(syncSeats).toHaveBeenCalledWith(organization.id));
  expect((await store.listOrganizationInvitations(organization.id))[0]!.acceptedAt).toEqual(expect.any(Number));
});

it('refuses a used, expired, forged or someone else\'s invitation as a 400 without granting access', async () => {
  const { store, authorization, organization, syncSeats, as, invite } = await boot();
  const accept = (userId: string, token: string) => as(userId)('/api/invitations/accept', { token });
  const token = await invite('invitee@example.test');

  const wrongPerson = await accept('stranger', token);
  expect(wrongPerson.status).toBe(400);
  expect((await wrongPerson.json() as any).error).toMatch(/different email/);
  expect(await store.organizationMembership(organization.id, 'stranger')).toBeUndefined();
  expect(await authorization.capabilitiesAsync('user:stranger', undefined, organization.id)).toEqual([]);

  // The failed attempt did not consume the invitation; the right person can still use it once.
  expect((await accept('invitee', token)).status).toBe(200);
  const reused = await accept('invitee', token);
  expect(reused.status).toBe(400);
  expect((await reused.json() as any).error).toMatch(/already used/);

  const forged = await accept('stranger', 'ki_not-a-real-token');
  expect(forged.status).toBe(400);
  expect((await forged.json() as any).error).toMatch(/invalid/);
  expect((await accept('stranger', '')).status).toBe(400);

  const expired = await store.createOrganizationInvitation({ organizationId: organization.id,
    email: 'stranger@example.test', invitedBy: 'user:owner', ttlMs: -1 });
  const late = await accept('stranger', expired.token);
  expect(late.status).toBe(400);
  expect((await late.json() as any).error).toMatch(/expired/);
  expect(await store.organizationMembership(organization.id, 'stranger')).toBeUndefined();
  expect(syncSeats).toHaveBeenCalledTimes(1);
});

it('requires a signed-in person with a verified email', async () => {
  const { store, server, organization, invite } = await boot();
  const token = await invite('invitee@example.test');
  const anonymous = await fetch(`${server.url}/api/invitations/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  });
  expect(anonymous.status).toBe(401);

  const noEmail = await fetch(`${server.url}/api/invitations/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: 'fixture=unverified' },
    body: JSON.stringify({ token }),
  });
  expect(noEmail.status).toBe(400);
  expect((await noEmail.json() as any).error).toMatch(/verified account/);
  expect(await store.organizationInvitationForToken(token)).toMatchObject({ acceptedAt: undefined });
  expect((await store.listOrganizationMemberships(organization.id)).map((member) => member.userId)).toEqual(['owner']);
});
