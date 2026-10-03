/**
 * `npm audit --audit-level=high`, except for advisories reviewed in
 * `scripts/audit-allowlist.json`. Every allowlisted advisory states why it is
 * not exploitable here and expires: an expired entry fails CI again, so an
 * unfixed advisory is looked at again rather than forgotten. Any other high or
 * critical advisory, direct or transitive, still fails.
 *
 *   npm run audit
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AllowedAdvisory {
  /** The advisory's GHSA id, e.g. GHSA-vfj7-8cjw-p6xm. */
  id: string;
  package: string;
  /** Why tavya cannot be harmed by it, checked when it was added. */
  reason: string;
  /** YYYY-MM-DD; from this day on the advisory fails CI again. */
  expires: string;
}

interface Advisory { name: string; url: string; severity: string; range?: string }
interface Vulnerability { severity: string; via: Array<string | Advisory> }
export interface AuditReport { vulnerabilities?: Record<string, Vulnerability> }

const BLOCKING = new Set(['high', 'critical']);
const ghsa = (url: string) => url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0]?.toLowerCase();

/** The advisories a vulnerable package carries, following dependency chains. */
function rootAdvisories(report: AuditReport, name: string, seen = new Set<string>()): Advisory[] {
  if (seen.has(name)) return [];
  seen.add(name);
  return (report.vulnerabilities?.[name]?.via ?? []).flatMap((via) =>
    typeof via === 'string' ? rootAdvisories(report, via, seen) : [via]);
}

/** What fails the audit, and which allowlist entries no longer match anything. */
export function auditFindings(report: AuditReport, allowlist: AllowedAdvisory[], today: string):
  { failures: string[]; unused: AllowedAdvisory[] } {
  const failures: string[] = [];
  const used = new Set<AllowedAdvisory>();
  const reported = new Set<string>();
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    if (!BLOCKING.has(vulnerability.severity)) continue;
    for (const advisory of rootAdvisories(report, name)) {
      if (!BLOCKING.has(advisory.severity)) continue;
      const id = ghsa(advisory.url);
      const allowed = allowlist.find((entry) => entry.id.toLowerCase() === id && entry.package === advisory.name);
      const key = `${advisory.url} ${name}`;
      if (allowed && allowed.expires > today) { used.add(allowed); continue; }
      if (reported.has(key)) continue;
      reported.add(key);
      failures.push(allowed
        ? `${name}: ${advisory.url} (${advisory.name} ${advisory.range ?? ''}) was allowlisted until ${allowed.expires}; check for a fix or review it again`
        : `${name}: ${advisory.severity} ${advisory.url} (${advisory.name} ${advisory.range ?? ''})`);
    }
  }
  return { failures, unused: allowlist.filter((entry) => !used.has(entry)) };
}

function main(): number {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const allowlist = JSON.parse(fs.readFileSync(path.join(here, 'audit-allowlist.json'), 'utf8')) as AllowedAdvisory[];
  const run = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let report: AuditReport;
  try { report = JSON.parse(run.stdout); }
  catch { console.error(`npm audit did not produce a report:\n${run.stdout}\n${run.stderr}`); return 1; }
  const { failures, unused } = auditFindings(report, allowlist, new Date().toISOString().slice(0, 10));
  for (const entry of unused) console.warn(`audit: ${entry.id} (${entry.package}) is no longer reported; remove it from scripts/audit-allowlist.json`);
  if (failures.length) {
    console.error(`audit: high or critical advisories:\n${failures.map((line) => `  ${line}`).join('\n')}`);
    return 1;
  }
  console.log(`audit: no unreviewed high or critical advisories (${allowlist.length - unused.length} allowlisted)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
