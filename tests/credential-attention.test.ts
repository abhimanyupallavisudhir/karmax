import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { credentialNotices, notifyCredentialAttention } from '../src/agent/credential-health.js';

// A Claude sign-in lapses about four weeks after it was made, whatever the
// refreshes, and only a person can sign in again (2026-09-26: claude:personal
// lapsed silently and a day of tasks stalled). Owners get a critical inbox item
// three days ahead, and again if it is signed out, cleared once it is renewed.
describe('credential attention notifications', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 8, 27, 12);

  const setup = async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-attention-'));
    roots.push(root);
    const homes = new ConfigHomeManager(root);
    const store = await Store.create(':memory:');
    await store.claimPersonalOrganization('owner');
    const login = (account: string, oauth: Record<string, unknown>) => fs.writeFileSync(
      path.join(homes.ensure('claude', account), '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
    return { homes, store, login };
  };
  const signedIn = (refreshTokenExpiresAt: number) => ({
    accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3_600_000, refreshTokenExpiresAt,
  });

  it('flags a sign-in in its last three days and a signed-out login, and nothing else', async () => {
    const { homes, login } = await setup();
    login('lapsing', signedIn(NOW + 2 * DAY));
    login('healthy', signedIn(NOW + 20 * DAY));
    login('gone', { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: NOW - DAY });
    homes.ensure('claude', 'never-signed-in');
    expect(credentialNotices(homes, 'org_personal', NOW)).toEqual(expect.arrayContaining([
      { kind: 'credential', credentialKey: 'login:claude:lapsing', provider: 'claude', account: 'lapsing',
        reason: 'expiring', expiresAt: NOW + 2 * DAY },
      { kind: 'credential', credentialKey: 'login:claude:gone', provider: 'claude', account: 'gone',
        reason: 'signed-out', expiresAt: NOW - DAY },
    ]));
    expect(credentialNotices(homes, 'org_personal', NOW)).toHaveLength(2);
  });

  it('notifies owners once, critically, and clears the notice when the login is renewed', async () => {
    const { homes, store, login } = await setup();
    login('lapsing', signedIn(NOW + 2 * DAY));
    const inbox = () => store.listInbox('owner', 'org_personal', { limit: 50 });

    await notifyCredentialAttention({ store, configHomes: homes }, NOW);
    await notifyCredentialAttention({ store, configHomes: homes }, NOW + 3_600_000); // hourly sweep: no duplicate
    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ urgency: 'critical', unread: true, actionable: true,
      subject: { kind: 'credential', credentialKey: 'login:claude:lapsing', reason: 'expiring' } });

    // Signing in again moves the deadline four weeks out: the notice is resolved.
    login('lapsing', signedIn(NOW + 28 * DAY));
    await notifyCredentialAttention({ store, configHomes: homes }, NOW + 7_200_000);
    expect(await inbox()).toEqual([]);
  });

  it('replaces the expiring notice when the login then signs out', async () => {
    const { homes, store, login } = await setup();
    login('lapsing', signedIn(NOW + 2 * DAY));
    await notifyCredentialAttention({ store, configHomes: homes }, NOW);
    login('lapsing', { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: NOW + 2 * DAY });
    await notifyCredentialAttention({ store, configHomes: homes }, NOW + 3 * DAY);
    expect(await store.listInbox('owner', 'org_personal', { limit: 50 })).toEqual([
      expect.objectContaining({ subject: expect.objectContaining({ credentialKey: 'login:claude:lapsing', reason: 'signed-out' }) }),
    ]);
  });
});
