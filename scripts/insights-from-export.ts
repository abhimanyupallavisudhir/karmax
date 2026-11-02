/**
 * Check Insights against an organization's real rows (wiki features/insights
 * § Verified): load an export made with `design/insights/export.sql` (read-only,
 * on the production database) into an in-memory store, run the page's own
 * aggregation, print the figures to compare with direct SQL, and write the
 * response for `design/insights/shoot.cjs`.
 *
 *   npx tsx scripts/insights-from-export.ts export.json out.json [days=30] [--operator]
 */
import fs from 'node:fs';
import { Store } from '../src/store/db.js';
import { organizationInsights } from '../src/platform/insights.js';
import { computeInsights } from '../src/platform/insights-usage.js';

const [input, output = '/tmp/insights.json', daysArg = '30'] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const operator = process.argv.includes('--operator');
if (!input) throw new Error('usage: insights-from-export.ts export.json out.json [days] [--operator]');
const data = JSON.parse(fs.readFileSync(input, 'utf8')) as Record<string, any>;
const store = await Store.create(':memory:', { hosted: true });
const value = (v: unknown) => v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v;
async function insert(table: string, rows: Array<Record<string, unknown>> | null | undefined) {
  for (const row of rows ?? []) {
    const columns = Object.keys(row);
    await store.db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map((column) => value(row[column])));
  }
}
const organization = data.organizations[0];
const organizationId = String(organization.id);
await insert('organizations', data.organizations);
for (let i = 0; i < Number(data.memberships ?? 1); i++)
  await insert('organization_memberships', [{ organizationId, userId: `user_${i}`, role: i ? 'member' : 'owner', joinedAt: 0 }]);
await insert('projects', data.projects);
await insert('task_lists', [...new Set((data.tasks ?? []).map((task: any) => `${task.projectId}\u0000${task.listId}`))].map((key) => {
  const [projectId, id] = String(key).split('\u0000');
  return { id, projectId, name: 'Tasks', createdAt: 0, ord: 0 };
}));
// Each task its own intent (the export keeps no attempts).
await insert('tasks', (data.tasks ?? []).map((task: any) => ({ ...task, intentId: task.id })));
await insert('task_intents', (data.tasks ?? []).map((task: any) => ({ id: task.id, principalAttemptId: task.id, createdAt: task.createdAt })));
await insert('usage_events', data.usage_events);
await insert('usage_admissions', data.usage_admissions);
await insert('events', data.routed);
await insert('kv', data.kv);
await insert('storage_locations', data.storage_locations);
await insert('world_checkpoints', data.world_checkpoints);
await insert('resource_attachments', data.resource_attachments);
await insert('resource_revisions', data.resource_revisions);
await insert('resource_repository_files', (data.repo_bytes ?? []).map((row: any, i: number) => ({ repository: `export-${i}`, attachmentId: row.attachmentId,
  organizationId, storageLocationId: row.storageLocationId, kind: 'data', name: 'all', bytes: row.bytes, createdAt: 0 })));
await insert('resource_snapshot_chunks', (data.chunk_bytes ?? []).map((row: any, i: number) => ({ organizationId, chunkId: `export-${i}`,
  storageLocationId: row.storageLocationId, refs: 1, bytes: row.bytes })));
await insert('promoted_artifacts', data.promoted_artifacts);
await insert('compute_pack_gifts', data.compute_pack_gifts);
await insert('storage_pack_gifts', data.storage_pack_gifts);
await insert('compute_topups', data.compute_topups);
await insert('compute_holds', data.compute_holds);
// Other organizations' managed machines: only for operators' budgets.
await insert('usage_events', (data.managed_all ?? []).map((row: any, i: number) => ({ id: `other-${i}`, organizationId: row.organizationId,
  provider: row.provider, kind: 'world.active', quantity: (row.endedAt - row.startedAt) / 1000, unit: 'second', costMicros: 0,
  startedAt: row.startedAt, endedAt: row.endedAt, fundingSource: 'managed', costClassification: 'none', metadata: { cpu: Number(row.cpu) || 0 } })));

const now = Date.now();
// tavya.io's managed accounts' budgets as entered/read on 2026-11-01 (wiki features/managed-compute § Budget).
const managedBudgets = [{ provider: 'e2b', pool: { machines: 20 } }, { provider: 'daytona', pool: { cpu: 10, diskGb: 30 } },
  { provider: 'fly', pool: { machines: 50 } }, { provider: 'hetzner', pool: { cpu: 10, diskGb: 324 } },
  { provider: 'aws', pool: { cpu: 96, diskGb: 51_200 } }, { provider: 'gcp', pool: { cpu: 24, machines: 24, diskGb: 5000 } }];
const insights = await organizationInsights(store, organizationId, { days: Number(daysArg), now, includeSpend: true, includeLogins: true,
  computeCredit: true, ...(operator ? { managedBudgets } : {}) });
// The logins' live readings, as GET …/accounts/usage gives them (for the screens).
const usage = Object.fromEntries((data.kv ?? []).filter((row: any) => row.k.startsWith('usage:')).map((row: any) => [row.k.slice('usage:'.length), JSON.parse(row.v)]));
fs.writeFileSync(output, JSON.stringify({ ...insights, _accounts: { pollable: Object.keys(usage), usage } }));

// Calendar months (UTC), through the same aggregation as the page.
const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;
for (const [label, from, to] of [['October', Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)], ['November so far', Date.UTC(2026, 10, 1), now]] as const) {
  const days = Math.ceil((to - from) / 86_400_000);
  const month = await computeInsights(store, organizationId, { days, from, previousFrom: from - days * 86_400_000, now: to - 1, offset: 0,
    firstDay: Math.floor(from / 86_400_000) }, { projectName: new Map(), task: () => undefined });
  console.log(`${label}: list ${usd(month.totals.listMicros)} (own ${usd(month.totals.own.listMicros)}, managed ${usd(month.totals.managed.listMicros)}), charged ${usd(month.totals.chargedMicros)}, machine ${(month.totals.activeSeconds / 3600).toFixed(1)} h`);
  for (const row of month.providers) console.log(`  ${row.key} ${row.funding}: list ${usd(row.listMicros)}, charged ${usd(row.chargedMicros)}, machine ${(row.activeSeconds / 3600).toFixed(1)} h, disk ${row.diskGbHours} GB·h`);
}
console.log(`Window (${insights.days} days): compute list ${usd(insights.compute.totals.listMicros)}, charged ${usd(insights.compute.totals.chargedMicros)}`);
if (insights.compute.credit) console.log(`Credit ${insights.compute.credit.month}: ${usd(insights.compute.credit.usedMicros)} of ${usd(insights.compute.credit.creditMicros + insights.compute.credit.topUpMicros)} (plan ${usd(insights.compute.credit.includedMicros)}, packs ${usd(insights.compute.credit.packMicros)}, gifts ${usd(insights.compute.credit.giftMicros)}), held ${usd(insights.compute.credit.heldMicros)}`);
console.log(`Routing: ${JSON.stringify(insights.compute.routing)}`);
console.log(`Storage: ${(insights.storage.bytes / 1024 ** 3).toFixed(2)} GiB of ${((insights.storage.quotaBytes ?? 0) / 1024 ** 3).toFixed(0)} GiB; by kind ${JSON.stringify(Object.fromEntries(Object.entries(insights.storage.byKind).map(([k, v]) => [k, `${(v / 1024 ** 3).toFixed(2)} GiB`])))}`);
for (const login of insights.logins ?? []) console.log(`Login ${login.id}: ${(login.share * 100).toFixed(0)}% · ${usd(login.usd * 1e6)} API-eq · ${login.turns} turns · capacity ${JSON.stringify(login.capacity ?? null)}`);
await store.close();
