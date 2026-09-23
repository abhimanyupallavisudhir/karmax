const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const state = { installationAccess: false, organizationId: 'org a' };
const context = vm.createContext({ S: state, siteNameMarkup: () => 'tavya', esc: String,
  taskUrl: id => `/tasks/${id}`, numLabel: String, fmtDur: String, PROC_KIND_LABEL: {} });
vm.runInContext(source.slice(source.indexOf('function diagnosticsPath('), source.indexOf('async function refreshHostDiag(')), context);
vm.runInContext(source.slice(source.indexOf('function procPanelHtml('), source.indexOf('function wireProcPanel(')), context);
assert.equal(context.diagnosticsPath('diagnostics'), '/api/diagnostics?organizationId=org%20a');
state.projectId = 'project';
assert.equal(context.diagnosticsPath('processes'), '/api/processes?projectId=project');
state.installationAccess = true;
assert.equal(context.diagnosticsPath('processes'), '/api/processes');
const sample = { supported: true, ts: Date.now(), canKill: false,
  groups: [{ key: '123', kind: 'agent', label: 'Agent', taskId: 'task', cpuPct: 1, rssMb: 2,
    procs: [{ pid: 123, cmd: 'agent', cpuPct: 1, rssMb: 2, ageSec: 1 }] }],
  totals: { procs: 1, cpuPct: 1, rssMb: 2 } };
assert.ok(!context.procPanelHtml(sample).includes('proc-kill'));
assert.ok(context.procPanelHtml({ ...sample, canKill: true }).includes('proc-kill'));
console.log('Diagnostics scope and read-only controls passed');
