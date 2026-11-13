import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// A repeatable series' list row. Finished runs archive themselves, so the
// project's live pool (S.tasks) holds only the runs still going: the count comes
// from the search result, and an expanded row lists the runs read from /runs.
const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
function extractFunction(name: string): string {
  const start = app.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = app.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`${name} is unterminated`);
}

const S: Record<string, any> = {};
const context = vm.createContext({
  S, esc: (v: unknown) => String(v), ICON: { trash: '' }, triggerSummary: () => 'Daily',
  runSubRow: (r: any) => `<run ${r.id} ${r.lastView?.status}>`,
});
vm.runInContext([extractFunction('seriesRuns'), extractFunction('seriesRow')].join('\n'), context);
const seriesRow = context.seriesRow as (t: Record<string, any>) => string;
const series = { id: 's', num: 830, title: 'Watch', params: { repeatable: true, triggers: [{ kind: 'schedule' }] } };
const state = (over: Record<string, any>) => { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, over); };

describe('series row', () => {
  it('counts every run the server counted, archived ones included', () => {
    state({ _runsBySeries: {}, searchResult: { runCounts: { s: 9 } } });
    expect(seriesRow(series)).toContain('9 runs');
  });

  it('falls back to the live runs before a search answers', () => {
    state({ _runsBySeries: { s: [{ id: 'r1', createdAt: 1 }] } });
    expect(seriesRow(series)).toContain('1 run<');
  });

  it('expanded, lists the runs read from the server with live ones overlaid, newest first', () => {
    state({
      expandedSeries: new Set(['s']),
      _runsBySeries: { s: [{ id: 'r2', createdAt: 2, lastView: { status: 'active' } }, { id: 'r3', createdAt: 3, lastView: { status: 'active' } }] },
      seriesRuns: { s: [{ id: 'r2', createdAt: 2, lastView: { status: 'setup' } }, { id: 'r1', createdAt: 1, lastView: { status: 'done' }, params: { archived: true } }] },
      searchResult: { runCounts: { s: 3 } },
    });
    const html = seriesRow(series);
    expect(html).toContain('3 runs');
    expect(html.match(/<run [^>]+>/g)).toEqual(['<run r3 active>', '<run r2 active>', '<run r1 done>']);
  });
});
