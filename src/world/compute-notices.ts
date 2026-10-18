import type { Store } from '../store/db.js';
import { computeCredit } from './managed-compute.js';

const dollars = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Tell an organization's owners, once a month, that its managed compute
 * credit is spent: an inbox item (withdrawn once there is credit again) and an
 * email. Its tasks on managed computers wait meanwhile ("Out of compute").
 * Hourly, hosted only (wiki features/managed-compute). */
export async function notifyComputeCredit(deps: {
  store: Store;
  email?: { configured(): Promise<boolean>; send(message: { to: string; subject: string; text: string }): Promise<void> };
  userEmail: (userId: string) => Promise<string | undefined>;
  publicUrl?: string;
  siteName: () => Promise<string>;
}, now = Date.now()): Promise<number> {
  const { store } = deps;
  if (!store.hosted) return 0;
  let told = 0;
  for (const organization of await store.listOrganizations()) {
    const credit = await computeCredit(store, organization.id, now);
    const spent = credit.creditMicros != null && credit.usedMicros > 0 && credit.usedMicros >= credit.creditMicros;
    const owners = (await store.listOrganizationMemberships(organization.id))
      .filter((membership) => membership.role === 'owner').map((membership) => membership.userId);
    const notice = spent ? { month: day(credit.from).slice(0, 7), usedMicros: credit.usedMicros, creditMicros: credit.creditMicros!, renewsAt: credit.to } : undefined;
    const fresh = await store.syncComputeInbox(organization.id, owners, notice, now);
    if (!fresh || !notice || !deps.email || !(await deps.email.configured())) continue;
    told += fresh;
    const site = await deps.siteName();
    const manage = deps.publicUrl ? `\n\nAdd compute: ${deps.publicUrl.replace(/\/$/, '')}/settings` : '';
    const message = {
      subject: `${organization.name} has used this month's ${site} compute`,
      text: `${organization.name} has used ${dollars(notice.usedMicros)} of its ${dollars(notice.creditMicros)} of compute this month on ${site}. `
        + `Tasks on ${site}'s computers wait until there is more: add a compute pack or change the plan in Plan & billing, `
        + `or connect your own provider account in Settings → Computers. The compute renews on ${day(notice.renewsAt)}.${manage}`,
    };
    for (const userId of owners) {
      const to = await deps.userEmail(userId).catch(() => undefined);
      if (to) await deps.email.send({ to, ...message }).catch((error) =>
        console.warn(`compute notice to ${userId}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return told;
}
