#!/usr/bin/env node
// `npm audit --audit-level=high` with reviewed exceptions. An exception names
// one advisory, the package it is in, and the top-level dependencies it may be
// reached through, and it expires: a new path to the same advisory, any other
// high or critical advisory, or an expired exception fails.
//
//   node scripts/audit.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEVERE = new Set(['high', 'critical']);

/** Messages for every high or critical advisory no exception covers. */
export function auditFailures(report, allowlist, today = new Date().toISOString().slice(0, 10)) {
  const vulnerabilities = report.vulnerabilities ?? {};
  const dependents = new Map();
  for (const [name, entry] of Object.entries(vulnerabilities))
    for (const via of entry.via ?? []) if (typeof via === 'string') dependents.set(via, [...dependents.get(via) ?? [], name]);
  // The top-level packages a vulnerable package is reached through.
  const roots = (name, seen = new Set()) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const up = dependents.get(name) ?? [];
    return up.length ? [...new Set(up.flatMap((parent) => roots(parent, seen)))] : [name];
  };
  const failures = [];
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    for (const via of entry.via ?? []) {
      if (typeof via !== 'object' || !SEVERE.has(via.severity)) continue;
      const id = String(via.url ?? '').split('/').pop();
      const exception = allowlist.find((item) => item.id === id && item.package === name);
      const reached = roots(name).sort();
      if (!exception) failures.push(`${name}: ${via.title} (${id}, ${via.severity})`);
      else if (exception.expires < today) failures.push(`${name}: the exception for ${id} expired on ${exception.expires}; review it`);
      else {
        const unexpected = reached.filter((root) => !exception.roots.includes(root));
        if (unexpected.length) failures.push(`${name}: ${id} is now also reached through ${unexpected.join(', ')}`);
      }
    }
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let output;
  try { output = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (error) { output = error.stdout; } // npm audit exits non-zero whenever it finds anything
  const allowlist = JSON.parse(fs.readFileSync(new URL('./audit-allowlist.json', import.meta.url), 'utf8'));
  const failures = auditFailures(JSON.parse(output), allowlist);
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exit(1);
  console.log(`npm audit: no unreviewed high or critical advisories (${allowlist.length} reviewed exception${allowlist.length === 1 ? '' : 's'})`);
}
