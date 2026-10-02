import type { Store } from '../store/db.js';
import type { StorageNotice } from './managed-storage.js';

const GB = 1024 ** 3;
const size = (bytes: number) => bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Over-quota notices to an organization's owners: an inbox item (withdrawn
 * when the organization is back within its quota) and, for every stage, an
 * email, whatever their delivery preferences, because data will be deleted. */
export function storageNotifier(deps: {
  store: Store;
  email?: { configured(): Promise<boolean>; send(message: { to: string; subject: string; text: string }): Promise<void> };
  userEmail: (userId: string) => Promise<string | undefined>;
  publicUrl?: string;
  siteName: () => Promise<string>;
}): (notice: StorageNotice) => Promise<void> {
  return async (notice) => {
    const owners = (await deps.store.listOrganizationMemberships(notice.organizationId))
      .filter((membership) => membership.role === 'owner').map((membership) => membership.userId);
    (await deps.store.syncStorageInbox(notice.organizationId, owners,
      notice.stage === 'resolved' ? undefined : notice));
    if (notice.stage === 'resolved' || !deps.email || !(await deps.email.configured())) return;
    const organization = (await deps.store.getOrganization(notice.organizationId));
    const site = (await deps.siteName());
    const message = storageNoticeEmail(notice, organization?.name ?? notice.organizationId, site, deps.publicUrl);
    for (const userId of owners) {
      const to = (await deps.userEmail(userId).catch(() => undefined));
      if (to) await deps.email.send({ to, ...message }).catch((error) =>
        console.warn(`storage notice to ${userId}: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
}

export function storageNoticeEmail(notice: StorageNotice, organization: string, site: string, publicUrl?: string): { subject: string; text: string } {
  const used = `${size(notice.retainedBytes)} of ${size(notice.quotaBytes)}`;
  const manage = publicUrl ? `\n\nManage storage: ${publicUrl.replace(/\/$/, '')}/settings` : '';
  if (notice.stage === 'deleted') return {
    subject: `${organization}: stored data was deleted on ${site}`,
    text: `${organization} stayed over its ${site} storage limit for 12 months, so stored data was deleted, older versions first, until it fits (${used} used now).${manage}`,
  };
  const when = notice.stage === 'over' ? `on ${day(notice.deleteAt)}` : `on ${day(notice.deleteAt)} (${notice.stage === '7d' ? '7' : '30'} days)`;
  return {
    subject: `${organization} is over its ${site} storage limit`,
    text: `${organization} uses ${used} of storage on ${site}. Until it is within the limit, you can view, download and delete data but not add more.\n\nFree space or upgrade before ${when}; after that, stored data will be deleted, older versions first, until it fits.${manage}`,
  };
}
