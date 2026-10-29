import type { Store } from '../store/db.js';
import type { WorldHandleRef } from '../domain/types.js';
import { COMPUTE_TERMS, computeChargeMicros } from '../domain/entitlements.js';
import { isVmWorldProvider, worldMachine } from '../domain/computer.js';
import { computeCredit, machineRate } from './managed-compute.js';

const dollars = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Spent compute credit and parked disks (wiki features/managed-compute §
 * Spent credit): a parked managed VM keeps its disk, and its disk keeps
 * costing what the spent credit no longer covers. After `graceMs` — or
 * sooner, once the disks would have cost `overrunCapMicros` (at tavya's
 * prices) past the credit, but never under `minGraceMs` — they are
 * hibernated. Owners are told when the credit is spent (after it has stayed
 * spent `confirmMs`, so an auto top-up under way is not reported), a day
 * before, and once it is done. */
export const COMPUTE_SPENT = {
  graceMs: COMPUTE_TERMS.graceDays * 24 * 60 * 60_000,
  reminderBeforeMs: 24 * 60 * 60_000,
  overrunCapMicros: COMPUTE_TERMS.overrunCapMicros,
  minGraceMs: COMPUTE_TERMS.minGraceHours * 60 * 60_000,
  confirmMs: 10 * 60_000,
};

export type ComputeNoticeStage = 'spent' | 'reminder' | 'hibernated';

interface SpentState { since: number; notices: ComputeNoticeStage[]; hibernateAt?: number }

/** An organization's parked managed computers whose provider bills their
 * disk while parked (VM worlds), with what the disk costs an hour. */
export async function parkedManagedDisks(store: Store, organizationId: string): Promise<Array<{
  handle: WorldHandleRef; updatedAt: number; provider: string; diskGb?: number; diskMicrosPerHour: number }>> {
  const out = [];
  for (const candidate of await store.listWorldInstances('parked')) {
    const meta = candidate.handle.meta as { funding?: string; projectId?: string;
      machine?: { cpu?: number; memoryMb?: number; diskGb?: number }; computer?: { cpu?: number; memoryMb?: number; diskGb?: number } } | undefined;
    if (meta?.funding !== 'managed' || !isVmWorldProvider(candidate.handle.kind)) continue;
    if ((await store.getProject(String(meta.projectId ?? '')))?.organizationId !== organizationId) continue;
    const shape = worldMachine(meta);
    const rate = await machineRate(store, { organizationId, taskId: candidate.handle.id, provider: candidate.handle.kind, shape });
    out.push({ handle: candidate.handle, updatedAt: candidate.updatedAt, provider: candidate.handle.kind,
      ...(shape?.diskGb ? { diskGb: shape.diskGb } : {}), diskMicrosPerHour: rate.diskMicrosPerHour });
  }
  return out;
}

/** When parked disks that cost `perHour` (provider micros) are hibernated,
 * counted from when the credit was spent. */
export function hibernateAt(since: number, perHour: number): number {
  const capMs = perHour > 0 ? COMPUTE_SPENT.overrunCapMicros / computeChargeMicros(perHour) * 3_600_000 : Infinity;
  return since + Math.max(COMPUTE_SPENT.minGraceMs, Math.min(COMPUTE_SPENT.graceMs, capMs));
}

/** Every ten minutes (src/main.ts), hosted only: tell owners when their
 * organization's managed compute credit is spent (an inbox item, withdrawn
 * once there is credit again, and an email), and hibernate its parked
 * managed disks once their grace ends. Its tasks on managed computers wait
 * meanwhile ("Out of compute"). Returns how many owners were newly told. */
export async function notifyComputeCredit(deps: {
  store: Store;
  email?: { configured(): Promise<boolean>; send(message: { to: string; subject: string; text: string }): Promise<void> };
  userEmail: (userId: string) => Promise<string | undefined>;
  publicUrl?: string;
  siteName: () => Promise<string>;
  /** Hibernate these parked computers (WorldLifecycleManager.hibernateForCompute). */
  hibernate?: (worlds: Array<{ handle: WorldHandleRef; updatedAt: number }>) => Promise<number>;
}, now = Date.now()): Promise<number> {
  const { store } = deps;
  if (!store.hosted) return 0;
  let told = 0;
  for (const organization of await store.listOrganizations()) {
    const key = `compute-spent:${organization.id}`;
    let state: SpentState | undefined;
    try { state = JSON.parse((await store.kvGet(key)) ?? 'null') ?? undefined; } catch { state = undefined; }
    const credit = await computeCredit(store, organization.id, now);
    const spent = credit.availableMicros != null && credit.availableMicros <= 0 && (credit.usedMicros > 0 || credit.heldMicros > 0);
    // A top-up being charged settles within minutes: wait for it.
    const charging = (await store.computeTopUps(organization.id, now - 24 * 60 * 60_000))
      .some((topUp) => ['charging', 'uncertain', 'pending'].includes(topUp.state) && topUp.error !== 'declined');
    const owners = (await store.listOrganizationMemberships(organization.id))
      .filter((membership) => membership.role === 'owner').map((membership) => membership.userId);
    if (!spent) {
      if (state) (await store.kvDelete(key));
      (await store.syncComputeInbox(organization.id, owners, undefined, now));
      continue;
    }
    if (!state) {
      (await store.kvSet(key, JSON.stringify({ since: now, notices: [] } satisfies SpentState)));
      continue;
    }
    if (charging || now - state.since < COMPUTE_SPENT.confirmMs) continue;
    const disks = await parkedManagedDisks(store, organization.id);
    // Disks parked after the credit was spent get their grace from then.
    if (disks.length && state.hibernateAt === undefined)
      state.hibernateAt = hibernateAt(Math.max(state.since, now - COMPUTE_SPENT.confirmMs), disks.reduce((total, disk) => total + disk.diskMicrosPerHour, 0));
    let stage: ComputeNoticeStage | undefined;
    let hibernated = 0;
    if (disks.length && state.hibernateAt !== undefined && now >= state.hibernateAt && deps.hibernate) {
      hibernated = await deps.hibernate(disks.map(({ handle, updatedAt }) => ({ handle, updatedAt })));
      if (hibernated) { stage = 'hibernated'; state.hibernateAt = undefined; }
    } else if (state.hibernateAt !== undefined && now >= state.hibernateAt - COMPUTE_SPENT.reminderBeforeMs
      && state.hibernateAt - state.since > COMPUTE_SPENT.reminderBeforeMs && !state.notices.includes('reminder') && state.notices.includes('spent')) {
      stage = 'reminder';
    } else if (!state.notices.includes('spent')) stage = 'spent';
    if (stage) state.notices = [...state.notices, stage];
    (await store.kvSet(key, JSON.stringify(state)));
    if (!stage) continue;
    const notice = { month: day(credit.from).slice(0, 7), stage, usedMicros: credit.usedMicros,
      creditMicros: (credit.creditMicros ?? 0) + credit.topUpMicros, renewsAt: credit.to,
      ...(state.hibernateAt !== undefined ? { hibernateAt: state.hibernateAt, computers: disks.length } : {}),
      ...(hibernated ? { computers: hibernated } : {}) };
    const fresh = await store.syncComputeInbox(organization.id, owners, notice, now);
    if (!fresh || !deps.email || !(await deps.email.configured())) continue;
    told += fresh;
    const site = await deps.siteName();
    const message = computeNoticeEmail(organization.name, site, notice, deps.publicUrl);
    for (const userId of owners) {
      const to = await deps.userEmail(userId).catch(() => undefined);
      if (to) await deps.email.send({ to, ...message }).catch((error) =>
        console.warn(`compute notice to ${userId}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return told;
}

const LOST = 'Their repositories\' files and uncommitted changes are saved and come back when their tasks continue; '
  + 'files Git ignores (installed dependencies, build output, caches) are deleted.';

export function computeNoticeEmail(organization: string, site: string, notice: { stage: ComputeNoticeStage; usedMicros: number;
  creditMicros: number; renewsAt: number; hibernateAt?: number; computers?: number }, publicUrl?: string): { subject: string; text: string } {
  const manage = publicUrl ? `\n\nAdd compute: ${publicUrl.replace(/\/$/, '')}/settings` : '';
  const computers = (n = 0) => `${n} parked computer${n === 1 ? '' : 's'}`;
  const add = 'add a compute pack, turn on auto top-up or change the plan in Plan & billing, or connect your own provider account in Settings → Computers';
  if (notice.stage === 'hibernated') return {
    subject: `${organization}'s parked ${site} computers were hibernated`,
    text: `${organization} is out of compute on ${site}, so its ${computers(notice.computers)} ${notice.computers === 1 ? 'was' : 'were'} hibernated: `
      + `saved, and ${notice.computers === 1 ? 'its machine and disk' : 'their machines and disks'} deleted. ${LOST} `
      + `To carry on, ${add}. The compute renews on ${day(notice.renewsAt)}.${manage}`,
  };
  const disks = notice.hibernateAt !== undefined
    ? `\n\nIts ${computers(notice.computers)} keep${notice.computers === 1 ? 's its disk' : ' their disks'} until ${when(notice.hibernateAt)}, `
      + `then ${notice.computers === 1 ? 'it is' : 'they are'} hibernated so the disks stop costing compute. ${LOST}` : '';
  if (notice.stage === 'reminder') return {
    subject: `${organization}'s parked ${site} computers are hibernated on ${when(notice.hibernateAt!)}`,
    text: `${organization} is still out of compute on ${site}.${disks}\n\nTo keep them, ${add}.${manage}`,
  };
  return {
    subject: `${organization} has used this month's ${site} compute`,
    text: `${organization} has used ${dollars(notice.usedMicros)} of its ${dollars(notice.creditMicros)} of compute this month on ${site}. `
      + `Tasks on ${site}'s computers wait until there is more: ${add}. The compute renews on ${day(notice.renewsAt)}.${disks}${manage}`,
  };
}
