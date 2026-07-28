import {
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  workflowInfo,
  patched,
  log,
} from '@temporalio/workflow';
import {
  SIG_REQUEST_SPEND,
  SIG_APPROVE_SPEND,
  SIG_DENY_SPEND,
  SIG_SPEND_RESULT,
  QRY_BUDGET,
} from './names.js';

/**
 * The budget coordinator (SPEC §7.6) — the same lease pattern (§6) pointed at a
 * spend pool. A virtual card per profile/task is modeled as a budget lease with
 * a hard cap (over-cap requests are declined, as a card authorization would be)
 * and a review-gate threshold (spend above it needs human approval). Because the
 * budget is a lease, the underlying rail can be swapped (Stripe Issuing → v2
 * payment protocols) without touching callers.
 */
export interface BudgetState {
  /** scope (profileId or taskId) → { cap, spent } */
  scopes: Record<string, { cap: number; spent: number }>;
  /** default cap for unknown scopes */
  defaultCap: number;
  /** spend above this needs review-gate approval */
  threshold: number;
  pending: { reqId: string; taskId: string; scope: string; amount: number; merchant?: string }[];
  processed: number;
  /** Bounded FIFO of reqIds already settled (charged, declined, or resolved at
   * the review gate). Carried across continue-as-new — see SETTLED_MEMORY. */
  settled?: string[];
}

export interface BudgetView {
  scopes: Record<string, { cap: number; spent: number }>;
  threshold: number;
  defaultCap: number;
  pending: { reqId: string; scope: string; amount: number; merchant?: string }[];
}

export const requestSpendSignal = defineSignal<[{ reqId: string; taskId: string; scope: string; amount: number; merchant?: string }]>(SIG_REQUEST_SPEND);
export const approveSpendSignal = defineSignal<[{ reqId: string }]>(SIG_APPROVE_SPEND);
export const denySpendSignal = defineSignal<[{ reqId: string }]>(SIG_DENY_SPEND);
export const budgetQuery = defineQuery<BudgetView>(QRY_BUDGET);

const CONTINUE_AFTER = 1000;
/**
 * How many settled reqIds to remember. The set MUST be bounded: this is a
 * long-lived singleton that continue-as-news, so an unbounded set is both a
 * memory leak and permanently growing carried-over workflow input. A bound is
 * acceptable because the failure it defends against is signal *redelivery* — a
 * transport-level retry that arrives close in time to the original, long before
 * `SETTLED_MEMORY` further requests have been settled. Anything older than that
 * is a genuinely new request reusing an old idempotency key, which no dedupe
 * window could distinguish anyway.
 */
const SETTLED_MEMORY = 256;

export async function budgetCoordinator(input: { state?: Partial<BudgetState> }): Promise<void> {
  const scopes = input.state?.scopes ?? {};
  let pending = input.state?.pending ?? [];
  const defaultCap = input.state?.defaultCap ?? 5000; // cents
  const threshold = input.state?.threshold ?? 2000;
  let processed = input.state?.processed ?? 0;
  const queue: { reqId: string; taskId: string; scope: string; amount: number; merchant?: string }[] = [];
  // Ring of reqIds already answered, oldest first, plus a membership index over
  // the same contents. Seeded from the rotation's carried state so the dedupe
  // does not evaporate at continue-as-new.
  const settled: string[] = (input.state?.settled ?? []).slice(-SETTLED_MEMORY);
  const settledIds = new Set(settled);
  // Flipped by the patch marker in the main loop below (which runs synchronously
  // before any handler can be dispatched). Recording is gated so replaying a
  // pre-fix history keeps its exact legacy behaviour — an old history that DID
  // double-charge a redelivery must keep replaying that way, or the notify
  // commands diverge and the coordinator fails as nondeterministic.
  let rememberSettled = false;
  const settle = (reqId: string) => {
    if (!rememberSettled || settledIds.has(reqId)) return;
    settled.push(reqId);
    settledIds.add(reqId);
    while (settled.length > SETTLED_MEMORY) settledIds.delete(settled.shift()!);
  };

  const capOf = (scope: string) => (scopes[scope] ??= { cap: defaultCap, spent: 0 });

  async function notify(taskId: string, reqId: string, result: { ok: boolean; reason?: string; pending?: boolean }) {
    try {
      await getExternalWorkflowHandle(taskId).signal(SIG_SPEND_RESULT, { reqId, ...result });
    } catch (e) {
      log.warn('spend result signal failed', { e: String(e) });
    }
  }

  setHandler(requestSpendSignal, (req) => {
    // Dedupe, like every other coordinator enqueue handler (merge-queue.ts,
    // agent-queue.ts, account.ts). Temporal delivers signals AT LEAST once, so a
    // redelivered `requestSpend` would otherwise be charged against the scope
    // twice — a double spend on a real payment rail. `reqId` is the caller's
    // idempotency key: already queued, already awaiting approval, or ALREADY
    // SETTLED ⇒ ignore. The settled arm is the one that actually closes the
    // hole: a redelivery that lands after the request was drained finds nothing
    // in `queue`/`pending` and used to be charged all over again.
    if (queue.some((q) => q.reqId === req.reqId) || pending.some((p) => p.reqId === req.reqId)
      || settledIds.has(req.reqId)) return;
    queue.push(req);
  });
  setHandler(approveSpendSignal, ({ reqId }) => {
    const i = pending.findIndex((p) => p.reqId === reqId);
    if (i >= 0) {
      const req = pending[i]!;
      pending = pending.filter((_, j) => j !== i);
      settle(reqId);
      const s = capOf(req.scope);
      // Re-check the hard cap at approval time. The request-time check (below) can
      // pass for several pending requests independently; without this, approving
      // them all would push spent past the cap it is meant to enforce.
      if (s.spent + req.amount > s.cap) {
        void notify(req.taskId, reqId, { ok: false, reason: 'over budget cap (declined at approval)' });
      } else {
        s.spent += req.amount;
        void notify(req.taskId, reqId, { ok: true, reason: 'approved at review gate' });
      }
    }
  });
  setHandler(denySpendSignal, ({ reqId }) => {
    const i = pending.findIndex((p) => p.reqId === reqId);
    if (i >= 0) {
      const req = pending[i]!;
      pending = pending.filter((_, j) => j !== i);
      settle(reqId);
      void notify(req.taskId, reqId, { ok: false, reason: 'denied at review gate' });
    }
  });
  setHandler(budgetQuery, (): BudgetView => ({
    scopes: JSON.parse(JSON.stringify(scopes)),
    threshold,
    defaultCap,
    pending: pending.map((p) => ({ reqId: p.reqId, scope: p.scope, amount: p.amount, merchant: p.merchant })),
  }));

  for (;;) {
    // Second, independent marker: remembering settled reqIds changes which
    // `requestSpend` signals produce a charge, so it is gated exactly like the
    // rotation fix above. Evaluated every iteration for the same reason — false
    // while replaying marker-less history, true at the live edge. The first
    // iteration runs synchronously before any signal handler is dispatched, so
    // the handlers never observe a stale `rememberSettled`.
    rememberSettled = patched('budget-coordinator-settled-dedupe-v1');
    // Keep the legacy branch byte-for-byte for histories created before this fix
    // (same shape as account.ts). `patched` is deliberately evaluated on every loop
    // iteration: it stays false while replaying marker-less history and flips true
    // at the live edge, which is exactly what lets a coordinator already trapped in
    // the legacy spin escape instead of deadlock-failing forever.
    //
    // The legacy bug: once `processed >= CONTINUE_AFTER` AND `pending.length > 0`
    // (any spend awaiting human approval), the park predicate resolved
    // synchronously, the continue-as-new guard refused (it needs `pending` empty),
    // and the `while (queue.length > 0)` body was empty — an unbounded microtask
    // loop inside ONE workflow activation. Temporal's deadlock detector then killed
    // the coordinator permanently while it still accepted `requestSpend` signals.
    if (!patched('budget-coordinator-rotation-v2')) {
      await condition(() => queue.length > 0 || processed >= CONTINUE_AFTER);
      if (processed >= CONTINUE_AFTER && queue.length === 0 && pending.length === 0) {
        await continueAsNew<typeof budgetCoordinator>({ state: { scopes, pending, defaultCap, threshold, processed: 0, settled } });
      }
    } else {
      // Park only ever wakes for work we can actually do, or for a rotation we will
      // actually perform — the two must agree, or the loop spins. Spend awaiting a
      // human decision (`pending`) holds rotation off (its reqIds are the live
      // contract with the requesting tasks), so it must equally hold the park.
      // Honor Temporal's own size/event-count recommendation as well as our counter.
      const shouldRotate = () =>
        queue.length === 0
        && pending.length === 0
        && (processed >= CONTINUE_AFTER || workflowInfo().continueAsNewSuggested);
      await condition(() => queue.length > 0 || shouldRotate());
      if (shouldRotate()) {
        await continueAsNew<typeof budgetCoordinator>({ state: { scopes, pending, defaultCap, threshold, processed: 0, settled } });
      }
    }
    while (queue.length > 0) {
      const req = queue.shift()!;
      processed++;
      const s = capOf(req.scope);
      if (s.spent + req.amount > s.cap) {
        settle(req.reqId); // answered: a redelivery gets the same decline, not a second one
        await notify(req.taskId, req.reqId, { ok: false, reason: 'over budget cap (declined)' });
      } else if (req.amount > threshold) {
        pending.push(req); // needs review-gate approval — settled only once the gate decides
        await notify(req.taskId, req.reqId, { ok: false, pending: true, reason: 'above threshold — awaiting approval' });
      } else {
        s.spent += req.amount;
        settle(req.reqId); // charged — the reqId must never be chargeable again
        await notify(req.taskId, req.reqId, { ok: true });
      }
    }
  }
}
