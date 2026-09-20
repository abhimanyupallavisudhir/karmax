import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { timingReport, TimingTrace } from '../src/timing/index.js';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('const timingReports = new Map();'));
describe('Timing task tab', () => {
  it('renders unknowns, percentiles and escaped labels without requiring conversation events', () => {
    const rows: any[] = [];
    const trace = new TimingTrace({ taskId: 't', turnId: 'x', attempt: 1 }, r => rows.push(r));
    const end = trace.start('agent.attempt');
    trace.mark('adapter.invoked', { provider: 'mock', model: '<img onerror=bad>' }); end();
    const context = vm.createContext({
      esc: (s: unknown) => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
      report: timingReport(rows), S: { meta: {timingEnabled:true} },
    });
    vm.runInContext(helpers + '\ntimingReports.set("t", report);', context);
    const rendered = vm.runInContext('timingTab({taskId:"t"})', context);
    expect(rendered).toContain('Request → first text');
    expect(rendered).toContain('Unknown');
    expect(rendered).toContain('p95');
    expect(rendered).toContain('Unattributed');
    expect(rendered).toContain('&lt;img onerror=bad&gt;');
    expect(rendered).not.toContain('<img onerror=bad>');
    expect(rendered).toContain('Export JSON');
  });
});

it('hides cached historical reports and export controls when disabled', () => {
 const context = vm.createContext({ S: {meta:{}}, report: {} });
 vm.runInContext(helpers + '\ntimingReports.set("t", report);', context);
 expect(vm.runInContext('timingTab({taskId:"t"})', context)).toBe('');
});

it('removes the tab from navigation and clears cached measurements on a live disable', () => {
 const context = vm.createContext({ S: {meta:{timingEnabled:true},taskTab:'timing',activity:[{type:'timing'}],taskEvents:[{type:'timing'}]},document:{getElementById:()=>null} });
 vm.runInContext(helpers+'\ntimingReports.set("t", {}); applyTimingSetting(false);',context);
 expect(vm.runInContext('timingReports.size',context)).toBe(0);
 expect(vm.runInContext('S.taskTab',context)).toBe('overview');
 expect(vm.runInContext('S.activity.length + S.taskEvents.length',context)).toBe(0);
 const navigation=source.slice(source.indexOf('const TASK_TABS ='),source.indexOf('function visibleTaskTabs()'));
 const visible=source.slice(source.indexOf('function visibleTaskTabs()'),source.indexOf('function defaultTaskTab(v)'));
 vm.runInContext(navigation+visible,context);
 expect(vm.runInContext('visibleTaskTabs().some(t=>t.key==="timing")',context)).toBe(false);
 vm.runInContext('S.meta.timingEnabled=true',context);
 expect(vm.runInContext('visibleTaskTabs().some(t=>t.key==="timing")',context)).toBe(true);
});


it('does not restore timing rows from HTTP responses that finish after disabling', async () => {
 let resolve: (events: any[]) => void = () => {};
 const pending = new Promise<any[]>(done => { resolve = done; });
 const context = vm.createContext({ S: {meta:{timingEnabled:true},projectId:'p'},api:()=>pending,renderMain:()=>{} });
 const history = source.slice(source.indexOf('function mergeTaskHistory('),source.indexOf('async function refreshTaskHistory('));
 const activity = source.slice(source.indexOf('async function seedActivity('),source.indexOf('function activityView('));
 vm.runInContext(history+activity,context);
 const load = vm.runInContext('seedActivity()',context);
 vm.runInContext('S.meta.timingEnabled=false',context);
 resolve([{type:'timing',seq:1},{type:'fixture',seq:2}]); await load;
 vm.runInContext('mergeTaskHistory([{type:"timing",seq:1},{type:"fixture",seq:2}])',context);
 expect(vm.runInContext('S.activity.map(e=>e.type).join()',context)).toBe('fixture');
 expect(vm.runInContext('S.taskEvents.map(e=>e.type).join()',context)).toBe('fixture');
});
