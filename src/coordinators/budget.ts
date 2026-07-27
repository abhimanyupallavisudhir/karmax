import {
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
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

export async function budgetCoordinator(input: { state?: Partial<BudgetState> }): Promise<void> {
  const scopes = input.state?.scopes ?? {};
  let pending = input.state?.pending ?? [];
  const defaultCap = input.state?.defaultCap ?? 5000; // cents
  const threshold = input.state?.threshold ?? 2000;
  let processed = input.state?.processed ?? 0;
  const queue: { reqId: string; taskId: string; scope: string; amount: number; merchant?: string }[] = [];

  const capOf = (scope: string) => (scopes[scope] ??= { cap: defaultCap, spent: 0 });

  async function notify(taskId: string, reqId: string, result: { ok: boolean; reason?: string; pending?: boolean }) {
    try {
      await getExternalWorkflowHandle(taskId).signal(SIG_SPEND_RESULT, { reqId, ...result });
    } catch (e) {
      log.warn('spend result signal failed', { e: String(e) });
    }
  }

  setHandler(requestSpendSignal, (req) => {
    queue.push(req);
  });
  setHandler(approveSpendSignal, ({ reqId }) => {
    const i = pending.findIndex((p) => p.reqId === reqId);
    if (i >= 0) {
      const req = pending[i]!;
      pending = pending.filter((_, j) => j !== i);
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
    await condition(() => queue.length > 0 || processed >= CONTINUE_AFTER);
    if (processed >= CONTINUE_AFTER && queue.length === 0 && pending.length === 0) {
      await continueAsNew<typeof budgetCoordinator>({ state: { scopes, pending, defaultCap, threshold, processed: 0 } });
    }
    while (queue.length > 0) {
      const req = queue.shift()!;
      processed++;
      const s = capOf(req.scope);
      if (s.spent + req.amount > s.cap) {
        await notify(req.taskId, req.reqId, { ok: false, reason: 'over budget cap (declined)' });
      } else if (req.amount > threshold) {
        pending.push(req); // needs review-gate approval
        await notify(req.taskId, req.reqId, { ok: false, pending: true, reason: 'above threshold — awaiting approval' });
      } else {
        s.spent += req.amount;
        await notify(req.taskId, req.reqId, { ok: true });
      }
    }
  }
}
