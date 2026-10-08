import crypto from 'node:crypto';
import type { SqlDatabase } from '../store/sql.js';

/**
 * One refresh at a time for a stored OAuth credential, across every process
 * and host that shares the database (wiki planned/host-local-state, step 2).
 *
 * Claude, Codex and most MCP servers rotate their refresh tokens: each one can
 * be spent once. Two processes refreshing the same credential (on tavya.io the
 * gateway and its activity worker, `KARMAX_WORKER_MODE=process`) spend it
 * twice; the provider rejects the second, or revokes the whole token family,
 * and the user is signed out. An in-process mutex cannot see the other process.
 *
 * So a refresh first takes a lease: a row of `credential_refresh_leases` keyed
 * by the credential, inserted, or taken over only once it has expired (a
 * crashed holder's lease lapses after `ttlMs`). The holder heartbeats it while
 * the provider call runs, re-reads the credential once it holds it, and writes
 * the result back with a compare-and-set against the credential it read, in a
 * transaction that also checks it still holds the lease. A waiter does not
 * refresh again: once the stored credential differs from the one it saw, the
 * winner has refreshed, and it uses the winner's.
 *
 * The holder token is random per acquisition, so it is also the fence: a
 * holder whose lease expired and was taken over can never write.
 */
export const REFRESH_LEASE_TTL_MS = 2 * 60_000;

export interface RefreshLease { credential: string; holder: string }

export interface LeaseOptions {
  /** How long a lease lasts without a heartbeat (a crashed holder's). */
  ttlMs?: number;
  /** How often a waiter looks again. */
  pollMs?: number;
  /** How long a waiter waits for the lease before giving up. */
  waitMs?: number;
}

/** What a leased refresh did. `raced`: another holder refreshed first and its
 * credential is `stored`; `lost`: this refresh's write-back was refused (the
 * credential or the lease changed under it), so its result was discarded. */
export type RefreshOutcome = 'refreshed' | 'unchanged' | 'raced' | 'lost';

export interface LeasedRefresh<T> {
  /** The lease key: names the credential, not the caller. */
  credential: string;
  /** The stored credential now (undefined: none). */
  read(): Promise<string | undefined>;
  /** The credential the caller saw when it decided to refresh. Once the stored
   * one differs, another holder has refreshed: use it, never refresh again.
   * Omit it to refresh (or run) under the lease regardless. */
  since?: { value: string | undefined };
  /** The provider call, on the credential as read under the lease. `next`
   * undefined or equal to `current`: nothing to write (the provider declined). */
  refresh(current: string | undefined): Promise<{ next?: string; result?: T }>;
  /** Compare-and-set: store `next` only if the credential is still `current`.
   * Runs in a transaction that has checked the lease is still held. */
  write(current: string | undefined, next: string): Promise<boolean>;
  /** Still holding the lease, with whatever is stored at the end. */
  settled?(stored: string | undefined): Promise<void>;
}

export class RefreshLeases {
  readonly ttlMs: number;
  private pollMs: number;
  private waitMs: number;

  constructor(readonly db: SqlDatabase, options: LeaseOptions = {}) {
    this.ttlMs = options.ttlMs ?? REFRESH_LEASE_TTL_MS;
    this.pollMs = options.pollMs ?? 250;
    // A holder's provider call is bounded well inside a lease; a crashed one's lapses with it.
    this.waitMs = options.waitMs ?? this.ttlMs + 60_000;
  }

  /** Take the lease if it is free or expired. */
  async acquire(credential: string): Promise<RefreshLease | undefined> {
    const holder = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const taken = await this.db.prepare(`INSERT INTO credential_refresh_leases (credential, holder, expiresAt) VALUES (?, ?, ?)
      ON CONFLICT(credential) DO UPDATE SET holder=excluded.holder, expiresAt=excluded.expiresAt
      WHERE credential_refresh_leases.expiresAt <= ?`).run(credential, holder, now + this.ttlMs, now);
    return Number(taken.changes) ? { credential, holder } : undefined;
  }

  /** Extend a held lease; false once it is no longer this holder's. */
  async heartbeat(lease: RefreshLease): Promise<boolean> {
    const result = await this.db.prepare('UPDATE credential_refresh_leases SET expiresAt=? WHERE credential=? AND holder=?')
      .run(Date.now() + this.ttlMs, lease.credential, lease.holder);
    return Number(result.changes) > 0;
  }

  /** Is the lease still this holder's and unexpired? Inside a transaction on
   * PostgreSQL it also locks the row, so no one can take it over before commit. */
  async holds(lease: RefreshLease): Promise<boolean> {
    const lock = this.db.dialect === 'postgres' && this.db.inTransaction() ? ' FOR UPDATE' : '';
    return !!await this.db.prepare(`SELECT 1 AS held FROM credential_refresh_leases WHERE credential=? AND holder=? AND expiresAt > ?${lock}`)
      .get(lease.credential, lease.holder, Date.now());
  }

  async release(lease: RefreshLease): Promise<void> {
    await this.db.prepare('DELETE FROM credential_refresh_leases WHERE credential=? AND holder=?').run(lease.credential, lease.holder);
  }

  /**
   * Run `work` holding the credential's lease, heartbeating it meanwhile.
   * While another process holds it, `waiting` is asked after each look: a
   * value ends the wait without the lease (a waiter that found the winner's
   * credential). Gives up after `waitMs`.
   */
  async hold<R>(credential: string, work: (lease: RefreshLease) => Promise<R>, waiting?: () => Promise<{ value: R } | undefined>): Promise<R> {
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      const lease = await this.acquire(credential);
      if (lease) {
        const beat = setInterval(() => { void this.heartbeat(lease).catch(() => false); }, Math.max(50, Math.floor(this.ttlMs / 3)));
        beat.unref?.();
        try { return await work(lease); }
        finally {
          clearInterval(beat);
          await this.release(lease).catch((error) => console.error(`[refresh-lease] could not release ${credential}:`, error));
        }
      }
      const done = await waiting?.();
      if (done) return done.value;
      if (Date.now() >= deadline) throw new Error(`gave up after ${Math.round(this.waitMs / 1000)}s waiting for another process to finish refreshing ${credential}`);
      await new Promise((resolve) => setTimeout(resolve, this.pollMs + Math.random() * this.pollMs));
    }
  }

  /** A refresh under the lease, with the write-back compare-and-set (above). */
  async refresh<T>(spec: LeasedRefresh<T>): Promise<{ outcome: RefreshOutcome; stored: string | undefined; result?: T }> {
    const changed = (stored: string | undefined) => spec.since !== undefined && stored !== spec.since.value;
    return this.hold<{ outcome: RefreshOutcome; stored: string | undefined; result?: T }>(spec.credential, async (lease) => {
      const finish = async (outcome: RefreshOutcome, stored: string | undefined, result?: T) => {
        await spec.settled?.(stored);
        return { outcome, stored, ...(result === undefined ? {} : { result }) };
      };
      const current = await spec.read();
      if (changed(current)) return finish('raced', current);
      const { next, result } = await spec.refresh(current);
      if (next === undefined || next === current) return finish('unchanged', current, result);
      const written = await this.db.transaction(async () => await this.holds(lease) && await spec.write(current, next))
        .catch((error) => { console.error(`[refresh-lease] writing back ${spec.credential} failed:`, error); return false; });
      if (written) return finish('refreshed', next, result);
      // The credential or the lease changed during the provider call. This
      // refresh may have spent a token another holder also spent: discard it
      // and take whatever is stored, loudly.
      console.error(`[refresh-lease] ${spec.credential}: the stored credential changed while it was being refreshed; `
        + 'the refresh was discarded (a refresh token may have been spent twice)');
      return finish('lost', await spec.read(), result);
    }, async () => {
      if (spec.since === undefined) return undefined;
      const stored = await spec.read();
      return changed(stored) ? { value: { outcome: 'raced', stored } } : undefined;
    });
  }
}
