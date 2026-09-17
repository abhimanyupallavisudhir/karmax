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
      report: timingReport(rows),
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
