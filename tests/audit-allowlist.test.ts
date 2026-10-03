import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditFindings, type AllowedAdvisory, type AuditReport } from '../scripts/audit.js';

const braces = { name: 'braces', url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm', severity: 'high', range: '<=3.0.3' };
// The shape npm audit --json reported on 2026-10-03: the advisory sits on
// braces; the packages above it only name the dependency they reach it through.
const report: AuditReport = { vulnerabilities: {
  '@daytona/sdk': { severity: 'high', via: ['fast-glob'] },
  'fast-glob': { severity: 'high', via: ['micromatch'] },
  micromatch: { severity: 'high', via: ['braces'] },
  braces: { severity: 'high', via: [braces] },
} };
const allowed: AllowedAdvisory = { id: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', reason: 'unreachable', expires: '2026-11-15' };

describe('npm audit with reviewed exceptions', () => {
  it('fails every package on the chain without an allowlist entry', () => {
    expect(auditFindings(report, [], '2026-10-03').failures).toHaveLength(4);
  });

  it('passes the chain of an allowlisted advisory until it expires', () => {
    expect(auditFindings(report, [allowed], '2026-10-03')).toEqual({ failures: [], unused: [] });
    const expired = auditFindings(report, [allowed], '2026-11-15').failures;
    expect(expired).toHaveLength(4);
    expect(expired[0]).toMatch(/allowlisted until 2026-11-15/);
  });

  it('still fails any other high or critical advisory, also one reached through an allowlisted chain', () => {
    const other = { name: 'micromatch', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'critical', range: '<5' };
    const failures = auditFindings({ vulnerabilities: { ...report.vulnerabilities,
      micromatch: { severity: 'critical', via: ['braces', other] } } }, [allowed], '2026-10-03').failures;
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((line) => line.includes('GHSA-aaaa-bbbb-cccc'))).toBe(true);
    // An entry for the advisory but another package does not excuse it.
    expect(auditFindings(report, [{ ...allowed, package: 'micromatch' }], '2026-10-03').failures).toHaveLength(4);
  });

  it('ignores moderate advisories, as --audit-level=high does, and names stale entries', () => {
    const moderate = { vulnerabilities: { braces: { severity: 'moderate', via: [{ ...braces, severity: 'moderate' }] } } };
    expect(auditFindings(moderate, [allowed], '2026-10-03')).toEqual({ failures: [], unused: [allowed] });
  });

  it('keeps every committed entry reasoned and expiring', () => {
    const committed = JSON.parse(fs.readFileSync('scripts/audit-allowlist.json', 'utf8')) as AllowedAdvisory[];
    for (const entry of committed) {
      expect(entry.id).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i);
      expect(entry.package).toBeTruthy();
      expect(entry.reason.length).toBeGreaterThan(40);
      expect(entry.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
