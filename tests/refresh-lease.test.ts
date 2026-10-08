import { describe, expect, it } from 'vitest';
import { RefreshLeases } from '../src/autonomy/refresh-lease.js';
import { storeBackends } from './helpers/store-backends.js';

/**
 * The cross-process refresh lease (wiki planned/host-local-state, step 2):
 * one refresh of a stored OAuth credential at a time, a crashed holder's lease
 * lapses, a write-back is a compare-and-set, and waiters re-read instead of
 * refreshing again.
 */

/** A token endpoint whose refresh tokens are single-use, as Claude's and Codex's are. */
function tokenEndpoint(first = 'r0') {
  let live = first;
  let issued = 0;
  const calls: string[] = [];
  return {
    calls,
    async refresh(token: string): Promise<string> {
      calls.push(token);
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (token !== live) throw new Error(`invalid_grant: refresh token ${token} was already used`);
      live = `r${++issued}`;
      return live;
    },
  };
}

/** A stored credential with a compare-and-set, as the vault provides. */
function storedCredential(initial: string) {
  let value: string | undefined = initial;
  return {
    get value() { return value; },
    read: async () => value,
    write: async (current: string | undefined, next: string) => { if (value !== current) return false; value = next; return true; },
    set(next: string) { value = next; },
  };
}

describe.each(storeBackends)('the credential refresh lease ($name)', ({ open }) => {
  it('admits one holder until it releases, and a crashed holder only until its lease lapses', async () => {
    const store = await open();
    const leases = new RefreshLeases(store.db, { ttlMs: 200 });
    const first = await leases.acquire('model-login:org_a:claude:work');
    expect(first).toBeDefined();
    expect(await leases.acquire('model-login:org_a:claude:work')).toBeUndefined();
    // Keyed by credential: another login is free.
    expect(await leases.acquire('model-login:org_a:claude:home')).toBeDefined();
    expect(await leases.heartbeat(first!)).toBe(true);
    expect(await leases.holds(first!)).toBe(true);
    await leases.release(first!);
    const second = await leases.acquire('model-login:org_a:claude:work');
    expect(second).toBeDefined();
    // The holder "crashes": no heartbeat, no release. Its lease lapses.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const third = await leases.acquire('model-login:org_a:claude:work');
    expect(third).toBeDefined();
    // The crashed holder can no longer extend, write under, or release it.
    expect(await leases.holds(second!)).toBe(false);
    expect(await leases.heartbeat(second!)).toBe(false);
    await leases.release(second!);
    expect(await leases.holds(third!)).toBe(true);
  });

  it('refreshes once when two holders race, and both end with the new credential', async () => {
    const store = await open();
    const endpoint = tokenEndpoint();
    const credential = storedCredential('r0');
    // Two processes: separate lease clients on one database.
    const a = new RefreshLeases(store.db, { pollMs: 10 });
    const b = new RefreshLeases(store.db, { pollMs: 10 });
    const refresh = (leases: RefreshLeases) => leases.refresh({
      credential: 'model-login:org_a:claude:work',
      since: { value: 'r0' },
      read: credential.read,
      refresh: async (current) => ({ next: await endpoint.refresh(current!) }),
      write: credential.write,
    });
    const [first, second] = await Promise.all([refresh(a), refresh(b)]);
    expect(endpoint.calls).toEqual(['r0']);
    expect([first.outcome, second.outcome].sort()).toEqual(['raced', 'refreshed']);
    expect(first.stored).toBe('r1');
    expect(second.stored).toBe('r1');
    expect(credential.value).toBe('r1');
    // Released on completion.
    expect(Number((await store.db.prepare('SELECT COUNT(*) AS n FROM credential_refresh_leases').get() as { n: number }).n)).toBe(0);
  });

  it('discards a refresh whose credential changed under it, and keeps the stored one', async () => {
    const store = await open();
    const credential = storedCredential('r0');
    const leases = new RefreshLeases(store.db);
    const result = await leases.refresh({
      credential: 'mcp-oauth:conn_1',
      read: credential.read,
      refresh: async () => {
        credential.set('r9'); // another writer, outside the lease (a sign-in)
        return { next: 'r1' };
      },
      write: credential.write,
    });
    expect(result).toEqual({ outcome: 'lost', stored: 'r9' });
    expect(credential.value).toBe('r9');
  });

  it('refuses the write-back of a holder whose lease was taken over', async () => {
    const store = await open();
    const credential = storedCredential('r0');
    const slow = new RefreshLeases(store.db, { ttlMs: 150 });
    const result = await slow.refresh({
      credential: 'model-login:org_a:codex:work',
      read: credential.read,
      refresh: async () => {
        // The heartbeat stops (a frozen process) and another holder takes over.
        await store.db.prepare('UPDATE credential_refresh_leases SET holder = ? WHERE credential = ?').run('someone-else', 'model-login:org_a:codex:work');
        return { next: 'r1' };
      },
      write: credential.write,
    });
    expect(result.outcome).toBe('lost');
    expect(credential.value).toBe('r0');
  });

  it('a waiter whose winner left the credential unchanged refreshes itself, once', async () => {
    const store = await open();
    const credential = storedCredential('r0');
    let calls = 0;
    const leases = new RefreshLeases(store.db, { pollMs: 10 });
    const run = () => leases.refresh({
      credential: 'model-login:org_a:claude:work',
      since: { value: 'r0' },
      read: credential.read,
      // The CLI declines: the access token is not in its refresh window yet.
      refresh: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return {}; },
      write: credential.write,
    });
    const outcomes = await Promise.all([run(), run()]);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(calls).toBe(2);
    expect(credential.value).toBe('r0');
  });

  it('gives up waiting for a holder that never finishes', async () => {
    const store = await open();
    const leases = new RefreshLeases(store.db, { ttlMs: 60_000, pollMs: 10, waitMs: 80 });
    await leases.acquire('model-login:org_a:claude:work');
    await expect(leases.hold('model-login:org_a:claude:work', async () => 'ran')).rejects.toThrow(/waiting for another process/);
  });
});
