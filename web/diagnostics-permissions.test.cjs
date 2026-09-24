const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const state = { installationAccess: false, organizationId: 'org a' };
const context = vm.createContext({ S: state, siteNameMarkup: () => 'tavya', esc: String,
  taskUrl: id => `/tasks/${id}`, numLabel: String, fmtDur: String, PROC_KIND_LABEL: {} });
// Host health is operator-only: it lives on the Installation page and always
// reads the unscoped, installation-wide endpoints — never a tenant-scoped view.
const health = source.slice(source.indexOf('async function refreshHostDiag('), source.indexOf('// ── agent account status'));
assert.ok(health.includes("api('/api/diagnostics')") && health.includes("api('/api/processes')"));
assert.ok(!health.includes('organizationId=') && !health.includes('projectId='));
assert.ok(!/S\.tab (?:!|=)== 'insights'/.test(health), 'host panels never refresh on the organization Insights page');
const organizationPage = source.slice(source.indexOf('// ── insights ──'), source.indexOf('function accountIncidentHtml('));
assert.ok(!organizationPage.includes('/api/diagnostics') && !organizationPage.includes('/api/processes'), 'Insights shows no host data');
vm.runInContext(source.slice(source.indexOf('function procPanelHtml('), source.indexOf('function wireProcPanel(')), context);
const sample = { supported: true, ts: Date.now(), canKill: false,
  groups: [{ key: '123', kind: 'agent', label: 'Agent', taskId: 'task', cpuPct: 1, rssMb: 2,
    procs: [{ pid: 123, cmd: 'agent', cpuPct: 1, rssMb: 2, ageSec: 1 }] }],
  totals: { procs: 1, cpuPct: 1, rssMb: 2 } };
assert.ok(!context.procPanelHtml(sample).includes('proc-kill'));
assert.ok(context.procPanelHtml({ ...sample, canKill: true }).includes('proc-kill'));
console.log('Diagnostics placement and read-only controls passed');
