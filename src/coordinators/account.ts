import {
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  sleep,
  log,
} from '@temporalio/workflow';
import {
  SIG_LEASE_ACCOUNT,
  SIG_RETURN_ACCOUNT,
  SIG_ACCOUNT_GRANTED,
  SIG_REGISTER_ACCOUNTS,
  SIG_REPORT_EXHAUSTED,
  SIG_SET_ACCOUNT_AVAILABILITY,
  QRY_ACCOUNTS,
} from './names.js';

/**
 * The token / account coordinator (SPEC §6.2). Same lease pattern as the merge
 * queue, leasing agent-account capacity instead of merge slots. It is the single
 * source of truth for login availability and refresh times:
 *  - leases a config home for a turn to an *available* account of the *right
 *    provider* (claude logins for claude agents, codex for codex);
 *  - marks a login `exhausted` on a ground-truth report from auto-resolve, arming
 *    a refresh timer keyed on the real reset instant, and flips it back to
 *    `available` when that time passes;
 *  - parks lease requests it can't serve yet (that IS "waiting for quota refresh")
 *    and grants them the moment a compatible login frees or refreshes;
 *  - exposes availability + refresh times for the dashboard, and accepts manual
 *    overrides (upgrade a plan, force-enable, edit the reset time).
 *
 * Determinism: `Date.now()`/`sleep()` inside workflow code are provided
 * deterministically by the Temporal SDK (replay-safe), so absolute reset instants
 * are stored in state and converted to sleeps here; the wall-clock/timezone math
 * that PRODUCES a reset instant lives in the reporting activity (SPEC §3.1).
 */
export type AccountProvider = 'claude' | 'codex' | 'mock';
/** available → leasable; exhausted → auto-refreshes at resetAt; manual-off → user
 *  turned it off; needs-attention → a HARD failure (billing/auth) that needs a human. */
export type AccountStatus = 'available' | 'exhausted' | 'manual-off' | 'needs-attention';
export type LimitWindow = '5h' | 'weekly' | 'model';

export type CredKind = 'login' | 'ambient' | 'key';

export interface AccountState {
  id: string; // the credential key: login:<p>:<a> | ambient:<p> | key:<p> | key:handle:<h>
  configHome: string;
  provider: AccountProvider;
  /** Credential kind (login/ambient/key) — drives default concurrency + UI. */
  kind?: CredKind;
  /** For a key credential: the broker handle to resolve JIT (else the env key). */
  apiKeyHandle?: string;
  /** Max concurrent turns on this account. */
  maxConcurrent: number;
  inUse: number;
  status: AccountStatus;
  /** Which limit exhausted it (for display). */
  window?: LimitWindow;
  /** Absolute epoch ms the current limit resets (drives the refresh + UI countdown). */
  resetAt?: number;
  /** Last-known weekly-window reset instant (informational). */
  weeklyResetAt?: number;
  /** Human note, e.g. "Opus limit". */
  note?: string;
}

export interface AccountCoordinatorState {
  accounts: AccountState[];
  /** `allowed` = the credential policy's ordered, enabled keys for the turn (SPEC §7/§9). */
  queue: { taskId: string; turnId: string; provider?: AccountProvider; allowed?: string[] }[];
  processed: number;
}

export interface AccountView {
  id: string;
  provider: AccountProvider;
  kind?: CredKind;
  status: AccountStatus;
  inUse: number;
  maxConcurrent: number;
  window?: LimitWindow;
  resetAt?: number;
  weeklyResetAt?: number;
  note?: string;
}

export interface AccountsView {
  accounts: AccountView[];
  waiting: number;
}

export interface RegisteredAccount {
  id: string;
  configHome: string;
  provider?: AccountProvider;
  kind?: CredKind;
  apiKeyHandle?: string;
  maxConcurrent?: number;
}

export const leaseAccountSignal = defineSignal<[{ taskId: string; turnId: string; provider?: AccountProvider; allowed?: string[] }]>(SIG_LEASE_ACCOUNT);
export const returnAccountSignal = defineSignal<[{ accountId: string }]>(SIG_RETURN_ACCOUNT);
export const registerAccountsSignal = defineSignal<[{ accounts: RegisteredAccount[] }]>(SIG_REGISTER_ACCOUNTS);
/** Ground-truth exhaustion feed (from the reportAccountExhausted activity). */
export const reportExhaustedSignal = defineSignal<[{ accountId: string; window: LimitWindow; resetAt: number; note?: string }]>(SIG_REPORT_EXHAUSTED);
/** Manual availability override (UI/MCP). `resetAt` sets a new reset instant. */
export const setAccountAvailabilitySignal = defineSignal<[{ accountId: string; status: AccountStatus; resetAt?: number }]>(SIG_SET_ACCOUNT_AVAILABILITY);
export const accountsQuery = defineQuery<AccountsView>(QRY_ACCOUNTS);

// A long backstop poll so the park loop periodically re-checks even absent a
// signal; refresh timing itself is driven by each account's `resetAt`.
const BACKSTOP_PARK_MS = 6 * 60 * 60 * 1000;
const CONTINUE_AFTER = 1000;

export async function accountCoordinator(input: { state?: AccountCoordinatorState }): Promise<void> {
  let accounts = input.state?.accounts ?? [];
  let queue = input.state?.queue ?? [];
  let processed = input.state?.processed ?? 0;

  /** Flip any exhausted account whose reset instant has passed back to available. */
  function refreshDue(): void {
    const now = Date.now();
    for (const a of accounts) {
      if (a.status === 'exhausted' && a.resetAt != null && a.resetAt <= now) {
        a.status = 'available';
        a.window = undefined;
        a.resetAt = undefined;
        a.note = undefined;
      }
    }
  }

  type Req = { provider?: AccountProvider; allowed?: string[] };
  const available = (a: AccountState) => a.status === 'available' && a.inUse < a.maxConcurrent;
  // The first AVAILABLE credential to grant a request. Two modes:
  //  - allow-list (real turns): the credential policy's ordered enabled keys — grant
  //    the first available one, in precedence order.
  //  - provider fallback (no allow-list — mock/legacy): first available of the provider.
  const pickFor = (req: Req): AccountState | undefined => {
    if (req.allowed !== undefined) {
      for (const key of req.allowed) {
        const a = accounts.find((x) => x.id === key);
        if (a && available(a)) return a;
      }
      return undefined;
    }
    return req.provider ? accounts.find((a) => a.provider === req.provider && available(a)) : undefined;
  };
  // Serveable now if a credential is free, OR there's nothing to wait for (an empty
  // allow-list, or no account of that provider) → passthrough grant. Each request
  // carries its own list, so this never head-of-line-blocks across requests.
  const serveable = (req: Req): boolean => {
    if (req.allowed !== undefined) return !!pickFor(req) || req.allowed.length === 0;
    if (!req.provider) return true;
    return !!pickFor(req) || !accounts.some((a) => a.provider === req.provider);
  };
  // A request that can NEVER be served — an allow-list whose every credential needs
  // human action (needs-attention / manual-off / missing), with none available or
  // auto-refreshing (exhausted). Such a request is DENIED so the task escalates to a
  // human instead of parking forever (SPEC §5.2, #5).
  const deniable = (req: Req): boolean =>
    req.allowed !== undefined &&
    req.allowed.length > 0 &&
    !req.allowed.some((key) => {
      const a = accounts.find((x) => x.id === key);
      return a && (a.status === 'available' || a.status === 'exhausted');
    });

  setHandler(registerAccountsSignal, ({ accounts: incoming }) => {
    for (const a of incoming) {
      const existing = accounts.find((x) => x.id === a.id);
      // Default concurrency per credential kind (user-configurable per login; the
      // caller passes a resolved value, and UNLIMITED for an unbounded login). Concurrency
      // doesn't cost extra quota, so the default is generous; leasing still respects
      // precedence order and re-leases on exhaustion.
      const defMax = a.maxConcurrent ?? (a.kind === 'login' ? 10 : 100);
      if (existing) {
        existing.configHome = a.configHome;
        if (a.provider) existing.provider = a.provider;
        if (a.kind) existing.kind = a.kind;
        if (a.apiKeyHandle !== undefined) existing.apiKeyHandle = a.apiKeyHandle || undefined;
        if (a.maxConcurrent != null) existing.maxConcurrent = a.maxConcurrent; // apply raises/lowers
      } else {
        accounts.push({
          id: a.id,
          configHome: a.configHome,
          provider: a.provider ?? 'claude',
          ...(a.kind ? { kind: a.kind } : {}),
          ...(a.apiKeyHandle ? { apiKeyHandle: a.apiKeyHandle } : {}),
          maxConcurrent: defMax,
          inUse: 0,
          status: 'available',
        });
      }
    }
    // Reconcile: both callers (main boot + gateway refreshLoginPool) pass the FULL,
    // authoritative credential set, so an account no longer in it is a stale entry
    // (e.g. an API-key handle that was removed) — prune it once idle, so removed
    // credentials don't linger on the dashboard or get leased. Keep any that are
    // still in-use; a later sync prunes them when their turn finishes.
    const live = new Set(incoming.map((a) => a.id));
    accounts = accounts.filter((a) => live.has(a.id) || a.inUse > 0);
  });
  setHandler(leaseAccountSignal, (req) => {
    if (!queue.find((q) => q.taskId === req.taskId && q.turnId === req.turnId)) {
      queue.push({ taskId: req.taskId, turnId: req.turnId, provider: req.provider, allowed: req.allowed });
    }
  });
  setHandler(returnAccountSignal, ({ accountId }) => {
    const a = accounts.find((x) => x.id === accountId);
    if (a && a.inUse > 0) a.inUse--;
  });
  setHandler(reportExhaustedSignal, ({ accountId, window, resetAt, note }) => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return;
    a.status = 'exhausted';
    a.window = window;
    a.resetAt = resetAt;
    if (window === 'weekly') a.weeklyResetAt = resetAt;
    if (note) a.note = note;
    // Its in-flight turn already failed on the limit; free its slots so the count
    // is accurate while it cools down.
    a.inUse = 0;
    log.info(`account ${accountId} exhausted (${window}), resets at ${resetAt}`);
  });
  setHandler(setAccountAvailabilitySignal, ({ accountId, status, resetAt }) => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return;
    a.status = status;
    if (status === 'available') {
      a.window = undefined;
      a.resetAt = undefined;
      a.note = undefined;
    } else if (resetAt != null) {
      a.resetAt = resetAt;
    }
  });
  setHandler(accountsQuery, (): AccountsView => ({
    accounts: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      kind: a.kind,
      status: a.status,
      inUse: a.inUse,
      maxConcurrent: a.maxConcurrent,
      window: a.window,
      resetAt: a.resetAt,
      weeklyResetAt: a.weeklyResetAt,
      note: a.note,
    })),
    waiting: queue.length,
  }));

  for (;;) {
    refreshDue();
    await condition(() => queue.length > 0 || processed >= CONTINUE_AFTER);
    // Recycle history only when idle and nothing is cooling down (so no pending
    // refresh instant is stranded across the reset of `processed`).
    if (processed >= CONTINUE_AFTER && queue.length === 0 && !accounts.some((a) => a.status === 'exhausted')) {
      await continueAsNew<typeof accountCoordinator>({ state: { accounts, queue, processed: 0 } });
    }

    while (queue.length > 0) {
      refreshDue();
      // Serve the first request whose credential allow-list has capacity (avoids
      // head-of-line blocking: each request carries its own ordered list).
      const idx = queue.findIndex((q) => serveable(q));
      if (idx < 0) {
        // Deny any request that can never be served (all its credentials need human
        // action) so the task escalates instead of parking forever.
        const denyIdx = queue.findIndex((q) => deniable(q));
        if (denyIdx >= 0) {
          const req = queue.splice(denyIdx, 1)[0]!;
          processed++;
          try {
            await getExternalWorkflowHandle(req.taskId).signal(SIG_ACCOUNT_GRANTED, { turnId: req.turnId, accountId: '(denied)' });
          } catch (e) {
            log.warn(`account deny signal to ${req.taskId} failed`, { e: String(e) });
          }
          continue;
        }
        // Nothing serveable now — park (this is "waiting for quota refresh"). Wake
        // on any state change (a return, a refresh, a new account) or the soonest
        // reset instant among cooling-down accounts.
        const now = Date.now();
        const resets = accounts
          .filter((a) => a.status === 'exhausted' && a.resetAt != null)
          .map((a) => a.resetAt!);
        const sleepMs = resets.length ? Math.max(0, Math.min(...resets) - now) : BACKSTOP_PARK_MS;
        await Promise.race([
          condition(() => queue.some((q) => serveable(q))),
          sleep(sleepMs),
        ]);
        continue;
      }
      const req = queue.splice(idx, 1)[0]!;
      // First available credential from the request's ordered allow-list; passthrough
      // (profile default) when the list is empty.
      const free = pickFor(req);
      if (free) free.inUse++;
      processed++;
      try {
        await getExternalWorkflowHandle(req.taskId).signal(SIG_ACCOUNT_GRANTED, {
          turnId: req.turnId,
          accountId: free?.id ?? '(passthrough)',
          configHome: free?.configHome,
          ...(free?.apiKeyHandle ? { apiKeyHandle: free.apiKeyHandle } : {}),
        });
      } catch (e) {
        log.warn(`account grant signal to ${req.taskId} failed; freeing`, { e: String(e) });
        if (free) free.inUse--;
      }
    }
  }
}
