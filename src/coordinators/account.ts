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
export type AccountStatus = 'available' | 'exhausted' | 'manual-off';
export type LimitWindow = '5h' | 'weekly' | 'model';

export interface AccountState {
  id: string;
  configHome: string;
  provider: AccountProvider;
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
  queue: { taskId: string; turnId: string; provider: AccountProvider }[];
  processed: number;
}

export interface AccountView {
  id: string;
  provider: AccountProvider;
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
  maxConcurrent?: number;
}

export const leaseAccountSignal = defineSignal<[{ taskId: string; turnId: string; provider?: AccountProvider }]>(SIG_LEASE_ACCOUNT);
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

  const providerHas = (p: AccountProvider) => accounts.some((a) => a.provider === p);
  const freeFor = (p: AccountProvider) =>
    accounts.find((a) => a.provider === p && a.status === 'available' && a.inUse < a.maxConcurrent);
  // A request is serveable now if a compatible login is free, OR no login of that
  // provider exists at all (→ passthrough grant: the turn runs on its profile's
  // own home rather than parking forever).
  const serveable = (p: AccountProvider) => !!freeFor(p) || !providerHas(p);

  setHandler(registerAccountsSignal, ({ accounts: incoming }) => {
    for (const a of incoming) {
      const existing = accounts.find((x) => x.id === a.id);
      if (existing) {
        existing.configHome = a.configHome;
        if (a.provider) existing.provider = a.provider;
        if (a.maxConcurrent) existing.maxConcurrent = a.maxConcurrent;
      } else {
        accounts.push({
          id: a.id,
          configHome: a.configHome,
          provider: a.provider ?? 'claude',
          maxConcurrent: a.maxConcurrent ?? 1,
          inUse: 0,
          status: 'available',
        });
      }
    }
  });
  setHandler(leaseAccountSignal, (req) => {
    const provider = req.provider ?? 'claude';
    if (!queue.find((q) => q.taskId === req.taskId && q.turnId === req.turnId)) {
      queue.push({ taskId: req.taskId, turnId: req.turnId, provider });
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
      // Serve the first request whose provider has capacity (avoids head-of-line
      // blocking: a claude request with no free claude login must not stall a
      // codex request behind it).
      const idx = queue.findIndex((q) => serveable(q.provider));
      if (idx < 0) {
        // Nothing serveable now — park (this is "waiting for quota refresh"). Wake
        // on any state change (a return, a refresh, a new account) or the soonest
        // reset instant among cooling-down accounts.
        const now = Date.now();
        const resets = accounts
          .filter((a) => a.status === 'exhausted' && a.resetAt != null)
          .map((a) => a.resetAt!);
        const sleepMs = resets.length ? Math.max(0, Math.min(...resets) - now) : BACKSTOP_PARK_MS;
        await Promise.race([
          condition(() => queue.some((q) => serveable(q.provider))),
          sleep(sleepMs),
        ]);
        continue;
      }
      const req = queue.splice(idx, 1)[0]!;
      const free = freeFor(req.provider);
      // Passthrough grant when no login of this provider exists: run on the
      // profile's own home rather than wedging the request.
      const configHome = free?.configHome;
      if (free) free.inUse++;
      processed++;
      try {
        await getExternalWorkflowHandle(req.taskId).signal(SIG_ACCOUNT_GRANTED, {
          turnId: req.turnId,
          accountId: free?.id ?? '(passthrough)',
          configHome,
        });
      } catch (e) {
        log.warn(`account grant signal to ${req.taskId} failed; freeing`, { e: String(e) });
        if (free) free.inUse--;
      }
    }
  }
}
