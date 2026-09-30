import {
  defineSignal,
  defineUpdate,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  proxyActivities,
  sleep,
  log,
  workflowInfo,
  patched,
} from '@temporalio/workflow';
import {
  SIG_LEASE_ACCOUNT,
  SIG_CANCEL_ACCOUNT,
  SIG_RETURN_ACCOUNT,
  SIG_ACCOUNT_GRANTED,
  RELIST_ACCOUNT_GRANT,
  SIG_RELIST_ACCOUNT_LEASES,
  SIG_REGISTER_ACCOUNTS,
  SIG_REPORT_EXHAUSTED,
  SIG_SET_ACCOUNT_AVAILABILITY,
  UPD_REPORT_EXHAUSTED,
  UPD_SET_ACCOUNT_AVAILABILITY,
  QRY_ACCOUNTS,
  QRY_ACCOUNT_LEASE,
  QRY_ACCOUNT_TASK_LEASES,
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
export type AccountProvider = string;
/** available → leasable; exhausted → auto-refreshes at resetAt; manual-off → user
 *  turned it off; needs-attention → a HARD failure (billing/auth) that needs a human. */
export type AccountStatus = 'available' | 'exhausted' | 'manual-off' | 'needs-attention';
export type LimitWindow = '5h' | 'weekly' | 'model';

/** Secret-safe provenance for the most recent automatic credential quarantine.
 * Raw provider payloads must never enter workflow history. */
export interface AccountTransition {
  source: 'provider-failure' | 'usage-recheck' | 'manual';
  sourceTaskId?: string;
  sourceActivityId?: string;
  kind?: 'quota' | 'credential';
  provider?: string;
  at: number;
  diagnostic?: {
    message?: string;
    code?: string;
    status?: number;
    requestId?: string;
    model?: string;
    operation?: string;
    willRetry?: boolean;
    retryAttempt?: number;
    retryMax?: number;
  };
}

export type CredKind = 'login' | 'ambient' | 'key';

export interface AccountState {
  id: string; // the credential key: login:<p>:<a> | ambient:<p> | key:<p> | key:handle:<h>
  configHome: string;
  provider: AccountProvider;
  /** Credential kind (login/ambient/key) — drives default concurrency + UI. */
  kind?: CredKind;
  /** For a key credential: the broker handle to resolve JIT (else the env key). */
  apiKeyHandle?: string;
  /** Model/API vendor represented by this credential. */
  credentialProvider?: string;
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
  /** Latest automatic failure that quarantined this credential. Retained after a
   * successful recheck so an operator can explain an intermittent incident. */
  lastTransition?: AccountTransition;
}

/**
 * A lease that has actually been GRANTED and is still held by a live turn.
 * Tracked (like the agent queue's `current`) so a lease can be reclaimed when its
 * owner goes away without running its `finally`: `stopTaskActivity` TERMINATES the
 * task workflow, and workflow termination cannot run deterministic finally blocks,
 * so the `returnAccount` call that normally balances `inUse` never happens. Before
 * this existed each such event permanently burned one `inUse` until, after
 * `maxConcurrent` of them, every request parked forever on a credential that was
 * still reported `available` (so not `deniable` either) — permanent starvation.
 */
export interface GrantedAccountLease {
  taskId: string;
  turnId: string;
  /** When the lease was granted. `sweepDeadLeases` questions an owner's liveness
   *  only after the lease has gone unreturned for `LEASE_TIMEOUT_MS`; without this
   *  a lease granted seconds ago was probed on the coordinator's very next wake,
   *  and a task that was merely CANCELLING (its workflow already closing while its
   *  turn winds down) reads as not-alive — so the sweep reclaimed a live task's
   *  credential and perturbed its shutdown. Optional: records carried across a
   *  continue-as-new from before this field default to the restore instant, which
   *  restarts the clock rather than sweeping them blind. */
  grantedAt?: number;
  /** The credential whose `inUse` this lease is holding. Passthrough grants
   *  consume no capacity and are not tracked. */
  accountId: string;
}

export interface AccountCoordinatorState {
  accounts: AccountState[];
  /** `allowed` = the credential policy's ordered, enabled keys for the turn (SPEC §7/§9). */
  queue: { taskId: string; turnId: string; provider?: AccountProvider; allowed?: string[] }[];
  /** Granted-but-not-yet-returned leases; carried across continue-as-new. */
  granted?: GrantedAccountLease[];
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
  lastTransition?: AccountTransition;
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
  credentialProvider?: string;
  maxConcurrent?: number;
}

export const leaseAccountSignal = defineSignal<[{ taskId: string; turnId: string; provider?: AccountProvider; allowed?: string[] }]>(SIG_LEASE_ACCOUNT);
export const cancelAccountSignal = defineSignal<[{ taskId: string; turnId: string }]>(SIG_CANCEL_ACCOUNT);
export const returnAccountSignal =
  defineSignal<[{ accountId: string; taskId?: string; turnId?: string }]>(SIG_RETURN_ACCOUNT);
export const registerAccountsSignal = defineSignal<[{ accounts: RegisteredAccount[] }]>(SIG_REGISTER_ACCOUNTS);
export const relistAccountLeasesSignal = defineSignal<[]>(SIG_RELIST_ACCOUNT_LEASES);
/** Ground-truth exhaustion feed (from the reportAccountExhausted activity). */
export const reportExhaustedSignal = defineSignal<[{ accountId: string; window: LimitWindow; resetAt: number; note?: string; transition?: AccountTransition }]>(SIG_REPORT_EXHAUSTED);
/** Manual availability override (UI/MCP). `resetAt` sets a new reset instant. */
export const setAccountAvailabilitySignal = defineSignal<[{ accountId: string; status: AccountStatus; resetAt?: number; onlyIfStatus?: AccountStatus; transition?: AccountTransition }]>(SIG_SET_ACCOUNT_AVAILABILITY);
export const reportExhaustedUpdate = defineUpdate<void, [{ accountId: string; window: LimitWindow; resetAt: number; note?: string; transition?: AccountTransition }]>(UPD_REPORT_EXHAUSTED);
export const setAccountAvailabilityUpdate = defineUpdate<void, [{ accountId: string; status: AccountStatus; resetAt?: number; onlyIfStatus?: AccountStatus; transition?: AccountTransition }]>(UPD_SET_ACCOUNT_AVAILABILITY);
export const accountsQuery = defineQuery<AccountsView>(QRY_ACCOUNTS);
export const accountLeaseQuery = defineQuery<
  { waiting: boolean; earliestResetAt?: number; detail?: string },
  [{ taskId: string; turnId?: string }]
>(QRY_ACCOUNT_LEASE);
export const accountTaskLeasesQuery = defineQuery<string[], [string]>(QRY_ACCOUNT_TASK_LEASES);

// A long backstop poll so the park loop periodically re-checks even absent a
// signal; refresh timing itself is driven by each account's `resetAt`.
const BACKSTOP_PARK_MS = 6 * 60 * 60 * 1000;
const CONTINUE_AFTER = 1000;
/** How long a granted lease may go unreturned before we re-check its owner's
 *  liveness (mirrors the merge/agent queues' LEASE_TIMEOUT). */
const LEASE_TIMEOUT_MS = 5 * 60 * 1000;

const act = proxyActivities<{ isTaskAlive(taskId: string): Promise<boolean> }>({ startToCloseTimeout: '20s' });

export async function accountCoordinator(input: { state?: AccountCoordinatorState }): Promise<void> {
  let accounts = input.state?.accounts ?? [];
  let queue = input.state?.queue ?? [];
  let granted = (input.state?.granted ?? []).map((g) => ({ ...g, grantedAt: g.grantedAt ?? Date.now() }));
  let processed = input.state?.processed ?? 0;
  // Whether `returnAccount` gives capacity back ONLY when it can attribute the
  // return to a granted-lease record (see the handler below). Gated like
  // `account-coordinator-lease-sweep-v1`: the pre-fix handler decremented `inUse`
  // unconditionally, so an execution whose history was written that way must keep
  // replaying it — the resulting `inUse` sequence is baked into the grant/park
  // decisions already recorded. Evaluated here (before any handler can run, so the
  // marker lands in the first workflow task of a new run) and refreshed each loop
  // pass, so a coordinator that is already live escapes the buggy path at the live
  // edge rather than waiting for its next continue-as-new. Handlers read the
  // variable, never `patched()` directly (`requestRelist` is the documented
  // exception), which keeps their behavior a pure function of the reproduced
  // activation order.
  let identifiedReturnsRelease = patched('account-coordinator-return-identity-v1');
  // A credential wall (every allowed credential needs a person) parks like a
  // quota wait instead of denying the turn, and parked requests re-resolve their
  // allow-lists when credentials change. Pre-marker histories keep denying.
  // Refreshed each loop pass, like the marker above, and adopted by a credential
  // change (see `requestRelist`).
  let waitForCredentials = patched('account-coordinator-credential-wait-v1');
  // Set when credentials changed under parked requests (a credential sync or a
  // policy edit); the loop then asks each parked owner to request again.
  let relistRequested = false;
  /**
   * Parked allow-lists were resolved against the credentials of their day. A
   * sync is the only notice the coordinator gets that they changed, and only
   * policy knows which credentials a request may use, so every sync re-lists
   * rather than guessing from ids: a login signed back in keeps its id, and a
   * login added before this code ran is already known (task 385 kept waiting on
   * an exhausted login after a new one was added).
   *
   * The one handler that consults `patched()` directly: a coordinator parked
   * before the marker waits on the legacy predicate until its wait ends, which
   * for a quota wait is hours. Adopting the marker here wakes it now. Replay
   * sees the marker in the same activation as the signal, so it is stable.
   */
  const requestRelist = () => {
    if (!queue.length) return;
    relistRequested = true;
    if (!waitForCredentials) waitForCredentials = patched('account-coordinator-credential-wait-v1');
  };

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
  // A request that can NEVER be served because every compatible credential needs
  // human action (needs-attention / manual-off / missing), with none available or
  // auto-refreshing (exhausted). Applies to both explicit policy allow-lists and the
  // provider fallback used by mock/legacy adapters; otherwise a hard quota failure in
  // fallback mode parks forever after correctly marking its only account bad.
  const deniable = (req: Req): boolean => {
    if (req.allowed !== undefined) {
      return (
        req.allowed.length > 0 &&
        !req.allowed.some((key) => {
          const a = accounts.find((x) => x.id === key);
          return a && (a.status === 'available' || a.status === 'exhausted');
        })
      );
    }
    if (!req.provider) return false;
    const compatible = accounts.filter((a) => a.provider === req.provider);
    return compatible.length > 0 && compatible.every((a) => a.status === 'needs-attention' || a.status === 'manual-off');
  };

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
        existing.credentialProvider = a.credentialProvider || undefined;
        if (a.maxConcurrent != null) existing.maxConcurrent = a.maxConcurrent; // apply raises/lowers
      } else {
        accounts.push({
          id: a.id,
          configHome: a.configHome,
          provider: a.provider ?? 'claude',
          ...(a.kind ? { kind: a.kind } : {}),
          ...(a.apiKeyHandle ? { apiKeyHandle: a.apiKeyHandle } : {}),
          ...(a.credentialProvider ? { credentialProvider: a.credentialProvider } : {}),
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
    requestRelist();
  });
  setHandler(relistAccountLeasesSignal, requestRelist);
  setHandler(leaseAccountSignal, (req) => {
    if (!queue.find((q) => q.taskId === req.taskId && q.turnId === req.turnId)) {
      queue.push({ taskId: req.taskId, turnId: req.turnId, provider: req.provider, allowed: req.allowed });
    }
  });
  /** Give a granted lease's capacity back to its credential. */
  const releaseGranted = (lease: GrantedAccountLease): void => {
    const a = accounts.find((x) => x.id === lease.accountId);
    if (a && a.inUse > 0) a.inUse--;
  };
  setHandler(cancelAccountSignal, ({ taskId, turnId }) => {
    queue = queue.filter((q) => q.taskId !== taskId || q.turnId !== turnId);
    // Withdraw an already-GRANTED lease too, not just a queued request. This is the
    // path `stopTaskActivity` uses after terminating the task workflow, and a
    // terminated workflow never runs the `finally` that calls returnAccount.
    const i = granted.findIndex((g) => g.taskId === taskId && g.turnId === turnId);
    if (i >= 0) {
      releaseGranted(granted[i]!);
      granted.splice(i, 1);
    }
  });
  setHandler(returnAccountSignal, ({ accountId, taskId, turnId }) => {
    // Find the granted-lease record this return retires — and drop the RIGHT one.
    // Records for one credential are NOT interchangeable, because `sweepDeadLeases`
    // keys off `lease.taskId`: with maxConcurrent >= 2, if task A grants first and
    // task B second, B returning used to splice A's record. The ledger then
    // attributed the surviving lease to B, so once B's workflow ended the sweep
    // "reclaimed" it and drove `inUse` to 0 while A was still actively using the
    // credential — real over-subscription of a login, which is the exact thing this
    // coordinator exists to prevent (and what trips provider rate-limit lockouts).
    // `accountTaskLeasesQuery` was mis-attributed the same way, so
    // `stopTaskActivity` cancelled the wrong task's turn.
    //
    // Fall back to the oldest record for the credential when the signal carries no
    // lease identity: that is the pre-existing payload shape, still emitted by task
    // workflows on older behavior versions, and the old imprecise attribution is the
    // only option for those.
    const i = taskId
      ? granted.findIndex((g) => g.accountId === accountId && g.taskId === taskId
        && (turnId === undefined || g.turnId === turnId))
      : granted.findIndex((g) => g.accountId === accountId);
    if (!identifiedReturnsRelease) {
      // Legacy path, replayed byte-for-byte for histories written before the fix:
      // decrement first, unconditionally, and only then consult the ledger.
      const a = accounts.find((x) => x.id === accountId);
      if (a && a.inUse > 0) a.inUse--;
      if (i >= 0) granted.splice(i, 1);
      return;
    }
    // Capacity comes back ONLY together with the record that was holding it, so a
    // return is naturally idempotent. Without this, any duplicate or racing return —
    // an activity retry after its signal already landed, or `cancelAccountSignal`
    // reclaiming a granted lease followed by a late `returnAccount` from an
    // already-scheduled activity — decremented `inUse` twice and over-subscribed the
    // login: the mirror image of the leak the ledger was added to fix.
    if (i >= 0) {
      releaseGranted(granted[i]!);
      granted.splice(i, 1);
    }
    // No matching record (already swept/cancelled, or a duplicate return): the slot
    // has already been given back. Leave both `inUse` and the ledger alone rather
    // than refunding twice or evicting someone else's lease.
  });
  const reportExhausted = ({ accountId, window, resetAt, note, transition }: {
    accountId: string; window: LimitWindow; resetAt: number; note?: string; transition?: AccountTransition;
  }) => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return;
    a.status = 'exhausted';
    a.window = window;
    a.resetAt = resetAt;
    if (window === 'weekly') a.weeklyResetAt = resetAt;
    if (note) a.note = note;
    if (transition) a.lastTransition = transition;
    // Its in-flight turn already failed on the limit; free its slots so the count
    // is accurate while it cools down.
    a.inUse = 0;
    log.warn(`account ${accountId} exhausted (${window}), resets at ${resetAt}`, {
      transition: transition ?? 'legacy report without provenance',
    });
  };
  const setAvailability = ({ accountId, status, resetAt, onlyIfStatus, transition }: {
    accountId: string; status: AccountStatus; resetAt?: number; onlyIfStatus?: AccountStatus; transition?: AccountTransition;
  }) => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) return;
    // Automated health reconciliation may clear its own quarantine, but it must
    // never race with and override a user's manual disable (or another newer
    // state transition). The guard is evaluated atomically in this workflow.
    if (onlyIfStatus !== undefined && a.status !== onlyIfStatus) return;
    a.status = status;
    if (status !== 'available' && transition) {
      a.lastTransition = transition;
      log.warn(`account ${accountId} changed to ${status}`, { transition });
    }
    if (status === 'available') {
      a.window = undefined;
      a.resetAt = undefined;
      a.note = undefined;
    } else if (resetAt != null) {
      a.resetAt = resetAt;
    }
  };
  // Signals remain public for backwards compatibility and direct/manual callers.
  // Activities use updates, whose acknowledged result means this mutation has
  // actually run before a failed turn can request another lease.
  setHandler(reportExhaustedSignal, reportExhausted);
  setHandler(reportExhaustedUpdate, reportExhausted);
  setHandler(setAccountAvailabilitySignal, setAvailability);
  setHandler(setAccountAvailabilityUpdate, setAvailability);
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
      lastTransition: a.lastTransition,
    })),
    waiting: queue.length,
  }));
  setHandler(accountLeaseQuery, ({ taskId, turnId }) => {
    const req = queue.find((r) => r.taskId === taskId && (turnId === undefined || r.turnId === turnId));
    if (!req) return { waiting: false };
    const compatible = accounts.filter((a) => req.allowed !== undefined
      ? req.allowed.includes(a.id) : a.provider === req.provider);
    if (compatible.some((a) => a.status === 'available'))
      return { waiting: true, detail: 'Waiting for a free slot on an allowed account' };
    const resets = compatible.filter((a) => a.status === 'exhausted' && a.resetAt != null)
      .map((a) => a.resetAt!);
    if (resets.length) return {
      waiting: true,
      earliestResetAt: Math.min(...resets),
      detail: 'Provider usage limit reached; the task resumes automatically when quota resets',
    };
    return { waiting: true, detail: 'Every allowed credential needs attention — sign in again or add one' };
  });
  // Every turn of `taskId` this coordinator still owes something for — queued
  // requests AND granted leases. Shape stays `string[]` of turnIds so the caller
  // (`stopTaskActivity`) can keep feeding them straight back into
  // `cancelAccountSignal` without knowing which half a turn is in.
  setHandler(accountTaskLeasesQuery, (taskId) => [
    ...queue.filter((req) => req.taskId === taskId).map((req) => req.turnId),
    ...granted.filter((g) => g.taskId === taskId).map((g) => g.turnId),
  ]);

  for (;;) {
    refreshDue();
    identifiedReturnsRelease = patched('account-coordinator-return-identity-v1');
    waitForCredentials = patched('account-coordinator-credential-wait-v1');
    // Keep the legacy branch byte-for-byte for histories created before this fix.
    // `patched` is deliberately evaluated on every loop: it remains false while
    // replaying marker-less history, then flips true at the live edge. That lets a
    // coordinator already trapped in the legacy immediate-condition spin escape.
    if (!patched('account-coordinator-rotation-v2')) {
      await condition(() => queue.length > 0 || processed >= CONTINUE_AFTER);
      if (processed >= CONTINUE_AFTER && queue.length === 0 && !accounts.some((a) => a.status === 'exhausted')) {
        await continueAsNew<typeof accountCoordinator>({ state: { accounts, queue, processed: 0 } });
      }
    } else {
      // Account reset instants are carried into the new run as ordinary state, so
      // cooling-down credentials do not need to pin an ever-growing history. Honor
      // Temporal's own size/event-count recommendation as well as our cheap counter.
      const shouldRotate = () =>
        queue.length === 0
        && (processed >= CONTINUE_AFTER || workflowInfo().continueAsNewSuggested);
      await condition(() => queue.length > 0 || shouldRotate());
      if (shouldRotate()) {
        // `granted` must survive rotation: dropping it would resurrect the leak it
        // exists to close (`inUse` would stay charged with no record of who owes it).
        await continueAsNew<typeof accountCoordinator>({ state: { accounts, queue, granted, processed: 0 } });
      }
    }

    while (queue.length > 0) {
      refreshDue();
      // Serve the first request whose credential allow-list has capacity (avoids
      // head-of-line blocking: each request carries its own ordered list).
      const idx = queue.findIndex((q) => serveable(q));
      if (idx < 0) {
        if (waitForCredentials && relistRequested) {
          // Nothing here is serveable with the allow-lists it arrived with. Hand
          // every parked request back so its owner re-resolves them against the
          // current credentials and policy; the coordinator never guesses policy.
          relistRequested = false;
          for (const req of queue.splice(0)) {
            processed++;
            try {
              await getExternalWorkflowHandle(req.taskId).signal(SIG_ACCOUNT_GRANTED, { turnId: req.turnId, accountId: RELIST_ACCOUNT_GRANT });
            } catch (e) {
              log.warn(`account relist signal to ${req.taskId} failed`, { e: String(e) });
            }
          }
          continue;
        }
        // Historical behavior: deny a request that can never be served (all its
        // credentials need human action) so the task escalates.
        const denyIdx = waitForCredentials ? -1 : queue.findIndex((q) => deniable(q));
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
        // The reason a request can be unserveable is that every compatible
        // credential is at `maxConcurrent` — which is also exactly what a LEAKED
        // lease looks like. Bound the park by the lease window so we re-check the
        // holders' liveness instead of sleeping for six hours behind a dead one.
        // Gated by a patch marker: the sweep schedules activities, so a live
        // singleton replaying marker-less history must not emit them.
        const sweepLeases = patched('account-coordinator-lease-sweep-v1');
        const parkMs = sweepLeases && granted.length ? Math.min(sleepMs, LEASE_TIMEOUT_MS) : sleepMs;
        const woke = await Promise.race([
          // Cancellation of the last parked request must wake this branch too;
          // otherwise the coordinator can remain asleep until the six-hour
          // backstop despite its query already reporting an empty queue. Manual
          // status changes that make a request deniable must wake it as well.
          condition(() => queue.length === 0 || (waitForCredentials
            ? relistRequested || queue.some((q) => serveable(q))
            : queue.some((q) => serveable(q) || deniable(q)))).then(() => true),
          sleep(parkMs).then(() => false),
        ]);
        if (sweepLeases && !woke && granted.length) await sweepDeadLeases();
        continue;
      }
      const req = queue.splice(idx, 1)[0]!;
      // First available credential from the request's ordered allow-list; passthrough
      // (profile default) when the list is empty.
      const free = pickFor(req);
      if (free) {
        free.inUse++;
        // Remember who holds it, so the lease can be reclaimed if its owner is
        // terminated (no finally) or dies (liveness sweep above).
        granted.push({ taskId: req.taskId, turnId: req.turnId, accountId: free.id, grantedAt: Date.now() });
      }
      processed++;
      try {
        await getExternalWorkflowHandle(req.taskId).signal(SIG_ACCOUNT_GRANTED, {
          turnId: req.turnId,
          accountId: free?.id ?? '(passthrough)',
          configHome: free?.configHome,
          ...(free?.apiKeyHandle ? { apiKeyHandle: free.apiKeyHandle } : {}),
          ...(free?.kind ? { credentialKind: free.kind } : {}),
          ...(free?.credentialProvider ? { credentialProvider: free.credentialProvider } : {}),
        });
      } catch (e) {
        log.warn(`account grant signal to ${req.taskId} failed; freeing`, { e: String(e) });
        if (free) {
          free.inUse--;
          const i = granted.findIndex((g) => g.taskId === req.taskId && g.turnId === req.turnId);
          if (i >= 0) granted.splice(i, 1);
        }
      }
    }
  }

  /**
   * Reclaim granted leases whose owning task workflow is gone. The merge queue and
   * the agent queue both do this; accounts had neither this nor the granted-lease
   * ledger, so a terminated task leaked its `inUse` forever.
   */
  async function sweepDeadLeases(): Promise<void> {
    // Only leases that have gone unreturned for the full lease window are
    // candidates. A freshly granted lease belongs to a turn that is simply still
    // running, and a task in the middle of cancelling looks dead to `isTaskAlive`
    // while it is still tidying up — probing either is how a live task loses its
    // credential mid-turn.
    const now = Date.now();
    const stale = granted.filter((g) => now - (g.grantedAt ?? now) >= LEASE_TIMEOUT_MS);
    if (!stale.length) return;
    const holders = [...new Set(stale.map((g) => g.taskId))];
    const alive = await Promise.all(holders.map((taskId) => act.isTaskAlive(taskId)));
    const dead = new Set(holders.filter((_, i) => !alive[i]));
    if (!dead.size) return;
    for (const lease of stale) {
      if (dead.has(lease.taskId)) {
        log.warn(`account lease held by dead task ${lease.taskId}; reclaiming ${lease.accountId}`);
        releaseGranted(lease);
      }
    }
    const staleIds = new Set(stale.map((g) => `${g.taskId}:${g.turnId}`));
    granted = granted.filter((g) => !(dead.has(g.taskId) && staleIds.has(`${g.taskId}:${g.turnId}`)));
  }
}
