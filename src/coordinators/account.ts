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
  QRY_ACCOUNTS,
} from './names.js';

/**
 * The token / account coordinator (SPEC §6.2). Same lease pattern as the merge
 * queue, leasing agent-account capacity instead of merge slots. Tracks each
 * account's window usage + concurrency, leases a config home to a turn, and
 * parks turns when the pool is exhausted until a refresh timer fires.
 */
export interface AccountState {
  id: string;
  configHome: string;
  /** Max concurrent turns on this account. */
  maxConcurrent: number;
  inUse: number;
  /** Requests allowed per 5-hour window. */
  fiveHourLimit: number;
  fiveHourUsed: number;
  /** Wall-clock ms when the 5h window resets (0 = not started). */
  windowResetAt: number;
}

export interface AccountCoordinatorState {
  accounts: AccountState[];
  queue: { taskId: string; turnId: string }[];
  processed: number;
}

export interface AccountsView {
  accounts: { id: string; inUse: number; maxConcurrent: number; fiveHourUsed: number; fiveHourLimit: number; windowResetAt: number }[];
  waiting: number;
}

export const leaseAccountSignal = defineSignal<[{ taskId: string; turnId: string }]>(SIG_LEASE_ACCOUNT);
export const returnAccountSignal = defineSignal<[{ accountId: string }]>(SIG_RETURN_ACCOUNT);
export const accountsQuery = defineQuery<AccountsView>(QRY_ACCOUNTS);
/** Upsert accounts into the pool — lets connected logins register after start. */
export const registerAccountsSignal = defineSignal<[{ accounts: RegisteredAccount[] }]>(SIG_REGISTER_ACCOUNTS);

export interface RegisteredAccount {
  id: string;
  configHome: string;
  maxConcurrent?: number;
  fiveHourLimit?: number;
}

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const CONTINUE_AFTER = 1000;

export async function accountCoordinator(input: { state?: AccountCoordinatorState }): Promise<void> {
  let accounts = input.state?.accounts ?? [];
  let queue = input.state?.queue ?? [];
  let processed = input.state?.processed ?? 0;

  function headroom(a: AccountState, nowMs: number): boolean {
    const windowOk = a.windowResetAt === 0 || nowMs >= a.windowResetAt || a.fiveHourUsed < a.fiveHourLimit;
    return a.inUse < a.maxConcurrent && windowOk;
  }

  setHandler(registerAccountsSignal, ({ accounts: incoming }) => {
    for (const a of incoming) {
      const existing = accounts.find((x) => x.id === a.id);
      if (existing) {
        existing.configHome = a.configHome;
        existing.maxConcurrent = a.maxConcurrent ?? existing.maxConcurrent;
        existing.fiveHourLimit = a.fiveHourLimit ?? existing.fiveHourLimit;
      } else {
        accounts.push({
          id: a.id,
          configHome: a.configHome,
          maxConcurrent: a.maxConcurrent ?? 1,
          inUse: 0,
          fiveHourLimit: a.fiveHourLimit ?? 1_000_000,
          fiveHourUsed: 0,
          windowResetAt: 0,
        });
      }
    }
  });
  setHandler(leaseAccountSignal, (req) => {
    if (!queue.find((q) => q.taskId === req.taskId && q.turnId === req.turnId)) queue.push(req);
  });
  setHandler(returnAccountSignal, ({ accountId }) => {
    const a = accounts.find((x) => x.id === accountId);
    if (a && a.inUse > 0) a.inUse--;
  });
  setHandler(accountsQuery, (): AccountsView => ({
    accounts: accounts.map((a) => ({
      id: a.id,
      inUse: a.inUse,
      maxConcurrent: a.maxConcurrent,
      fiveHourUsed: a.fiveHourUsed,
      fiveHourLimit: a.fiveHourLimit,
      windowResetAt: a.windowResetAt,
    })),
    waiting: queue.length,
  }));

  for (;;) {
    await condition(() => queue.length > 0 || processed >= CONTINUE_AFTER);
    if (processed >= CONTINUE_AFTER && queue.length === 0) {
      await continueAsNew<typeof accountCoordinator>({ state: { accounts, queue, processed: 0 } });
    }

    // Refresh elapsed windows (use a workflow timer as the deterministic clock).
    // We approximate "now" with a monotonic counter of processed turns since the
    // dev model has no per-account real metering; refresh resets on window timer.
    while (queue.length > 0) {
      const req = queue[0]!;
      const free = accounts.find((a) => a.inUse < a.maxConcurrent && (a.windowResetAt === 0 || a.fiveHourUsed < a.fiveHourLimit));
      if (!free) {
        // Pool exhausted — park until a return frees a slot or a window refreshes.
        const refreshed = await Promise.race([
          condition(() => accounts.some((a) => a.inUse < a.maxConcurrent)),
          sleep(FIVE_HOURS).then(() => {
            for (const a of accounts) {
              a.fiveHourUsed = 0;
              a.windowResetAt = 0;
            }
            return true;
          }),
        ]);
        void refreshed;
        continue;
      }
      queue.shift();
      free.inUse++;
      free.fiveHourUsed++;
      if (free.windowResetAt === 0) free.windowResetAt = FIVE_HOURS; // relative marker
      processed++;
      try {
        await getExternalWorkflowHandle(req.taskId).signal(SIG_ACCOUNT_GRANTED, {
          turnId: req.turnId,
          accountId: free.id,
          configHome: free.configHome,
        });
      } catch (e) {
        log.warn(`account grant signal to ${req.taskId} failed; freeing`, { e: String(e) });
        free.inUse--;
      }
    }
  }
}
