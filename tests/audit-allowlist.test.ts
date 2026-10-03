import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs script without types
import { auditFailures } from '../scripts/audit.mjs';

const braces = { source: 1, name: 'braces', dependency: 'braces', title: 'braces stack exhaustion',
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm', severity: 'high', range: '<=3.0.3' };
const report = (extra: Record<string, unknown> = {}) => ({ vulnerabilities: {
  '@daytona/sdk': { severity: 'high', via: ['fast-glob'] },
  'fast-glob': { severity: 'high', via: ['micromatch'] },
  micromatch: { severity: 'high', via: ['braces'] },
  braces: { severity: 'high', via: [braces] },
  ...extra,
} });
const allowlist = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/audit-allowlist.json'), 'utf8'));

describe('npm audit exceptions', () => {
  it('accepts a reviewed advisory only through the dependencies it was reviewed for, until it expires', () => {
    expect(auditFailures(report(), allowlist, '2026-10-03')).toEqual([]);
    // Another dependency starting to use braces is a new exposure.
    expect(auditFailures(report({ anymatch: { severity: 'high', via: ['micromatch'] } }), allowlist, '2026-10-03'))
      .toEqual(['braces: GHSA-vfj7-8cjw-p6xm is now also reached through anymatch']);
    expect(auditFailures(report(), allowlist, '2099-01-01')[0]).toMatch(/expired/);
    // Any other high or critical advisory fails; moderate ones do not.
    expect(auditFailures(report({ tar: { severity: 'critical', via: [{ ...braces, name: 'tar', title: 'tar escape',
      url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz', severity: 'critical' }] } }), allowlist, '2026-10-03'))
      .toEqual(['tar: tar escape (GHSA-xxxx-yyyy-zzzz, critical)']);
    expect(auditFailures(report({ ws: { severity: 'moderate', via: [{ ...braces, name: 'ws', severity: 'moderate' }] } }),
      allowlist, '2026-10-03')).toEqual([]);
  });

  it('never builds Daytona images from Dockerfiles, the only path that loads braces (GHSA-vfj7-8cjw-p6xm)', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else if (/\.(ts|mjs|js)$/.test(entry.name)) files.push(full);
    } };
    walk(path.join(__dirname, '../src'));
    const offenders = files.filter((file) => /\b(fromDockerfile|dockerfileCommands|extractCopySources)\s*\(/.test(fs.readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
