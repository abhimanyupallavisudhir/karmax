import type { Store } from '../store/db.js';
import { allows } from '../platform/capabilities.js';
import type { ServiceLimitAlert } from './service-limits.js';

const formatNumber = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 1 });
function amount(value: number, unit: string | undefined): string {
  if (unit === 'bytes') return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
  if (unit === 'hours') return `${formatNumber(value)} h`;
  return formatNumber(value);
}

/** One line per alert, in the operator's words. */
export function serviceLimitAlertText(alert: ServiceLimitAlert): { title: string; line: string } {
  if (alert.level === 'failed') return {
    title: `Can't read ${alert.serviceName} usage`,
    line: `Can't read ${alert.serviceName} usage: ${alert.error}. Its limits aren't being watched until this is fixed.`,
  };
  const percent = Math.floor(((alert.used ?? 0) / (alert.limit || 1)) * 100);
  return {
    title: `${alert.serviceName} is at ${percent}% of its limit`,
    line: `${alert.serviceName}: ${alert.label} ${amount(alert.used ?? 0, alert.unit)} of ${amount(alert.limit ?? 0, alert.unit)} (${percent}%).${alert.link ? ` Upgrade: ${alert.link}` : ''}`,
  };
}

/**
 * Service-limit alerts go to the installation's operators: everyone whose
 * installation-wide grant includes `settings:write` (God, unless an operator
 * customised it). Each gets an inbox item in their default organization,
 * withdrawn when the alert clears, and an email for every newly reached level
 * whatever their delivery preferences, like the storage over-quota notices.
 */
export function serviceLimitNotifier(deps: {
  store: Store;
  /** The capabilities of a principal's global grants. */
  capabilities: (principalId: string) => Promise<string[]>;
  email?: { configured(): Promise<boolean>; send(message: { to: string; subject: string; text: string }): Promise<void> };
  userEmail: (userId: string) => Promise<string | undefined>;
  publicUrl?: string;
  siteName: () => Promise<string>;
}): (alerts: ServiceLimitAlert[]) => Promise<void> {
  return async (alerts) => {
    const operators = await installationOperators(deps.store, deps.capabilities);
    const entries = [];
    for (const userId of operators) {
      const organizationId = (await deps.store.defaultOrganization(userId, true))?.id;
      if (!organizationId) continue;
      for (const alert of alerts) entries.push({
        userId, organizationId, key: `${alert.key}:${alert.level}:${alert.period}`,
        urgency: alert.level === 95 ? 'critical' as const : alert.level === 80 ? 'high' as const : 'normal' as const,
        deliver: alert.fresh,
        subject: { service: alert.serviceId, serviceName: alert.serviceName, meter: alert.meterId, label: alert.label,
          level: alert.level, period: alert.period, used: alert.used, limit: alert.limit, unit: alert.unit, error: alert.error },
      });
    }
    (await deps.store.syncServiceLimitInbox(entries));
    const fresh = alerts.filter((alert) => alert.fresh);
    if (!fresh.length || !deps.email || !(await deps.email.configured())) return;
    const message = serviceLimitEmail(fresh, await deps.siteName(), deps.publicUrl);
    for (const userId of operators) {
      const to = await deps.userEmail(userId).catch(() => undefined);
      if (to) await deps.email.send({ to, ...message }).catch((error) =>
        console.warn(`service-limit alert to ${userId}: ${error instanceof Error ? error.message : String(error)}`));
    }
  };
}

export function serviceLimitEmail(alerts: ServiceLimitAlert[], site: string, publicUrl?: string): { subject: string; text: string } {
  const page = publicUrl ? `\n\nService limits: ${publicUrl.replace(/\/$/, '')}/installation#installation-limits` : '';
  const lines = alerts.map((alert) => serviceLimitAlertText(alert));
  return {
    subject: alerts.length === 1 ? `${site}: ${lines[0]!.title}` : `${site}: ${alerts.length} service limits need attention`,
    text: `${lines.map((line) => line.line).join('\n')}${page}`,
  };
}

/** Users whose installation-wide grant can change installation settings. */
export async function installationOperators(store: Store, capabilities: (principalId: string) => Promise<string[]>): Promise<string[]> {
  const principals = new Set((await store.listPrincipalGrants())
    .filter((grant) => grant.scopeKey === 'global' && String(grant.principalId).startsWith('user:'))
    .map((grant) => String(grant.principalId)));
  const operators: string[] = [];
  for (const principal of principals)
    if (allows(await capabilities(principal), 'settings:write')) operators.push(principal.slice(5));
  return operators.sort();
}
