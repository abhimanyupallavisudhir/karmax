import { describe, it, expect } from 'vitest';
import { bindPath, resolveWidgets, WidgetSpec } from '../src/contrib/widgets.js';

describe('declarative widget composition (SPEC §10.2 tier 2)', () => {
  const view = {
    stage: 'review',
    mergeQueue: { position: 2, total: 5 },
    reviewInfo: { changedFiles: ['src/a.ts', 'src/b.ts'] },
    messages: [
      { role: 'user', text: 'do it' },
      { role: 'agent', text: 'done' },
    ],
    counts: { passed: 3, failed: 1 },
    error: undefined,
  };

  it('binds dot/array paths against the view-model', () => {
    expect(bindPath(view, 'mergeQueue.position')).toBe(2);
    expect(bindPath(view, 'reviewInfo.changedFiles.0')).toBe('src/a.ts');
    expect(bindPath(view, 'missing.deep.path')).toBeUndefined();
    expect(bindPath(view, undefined)).toBe(view);
  });

  it('normalizes each widget type from its bound value', () => {
    const specs: WidgetSpec[] = [
      { type: 'badge', bind: 'stage', title: 'Stage' },
      { type: 'gauge', bind: 'mergeQueue', valueKey: 'position', maxKey: 'total' },
      { type: 'list', bind: 'reviewInfo.changedFiles', title: 'Files' },
      { type: 'thread', bind: 'messages' },
      { type: 'keyValue', bind: 'counts' },
    ];
    const r = resolveWidgets(specs, view);
    expect(r[0]).toMatchObject({ type: 'badge', title: 'Stage', data: 'review' });
    expect(r[1]!.data).toEqual({ value: 2, max: 5, pct: 40 });
    expect(r[2]!.data).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r[3]!.data).toEqual([
      { role: 'user', text: 'do it' },
      { role: 'agent', text: 'done' },
    ]);
    expect(r[4]!.data).toEqual([
      { label: 'passed', value: '3' },
      { label: 'failed', value: '1' },
    ]);
  });

  it('builds a table with explicit columns and stringifies cells', () => {
    const data = { rows: [{ file: 'a.ts', adds: 10 }, { file: 'b.ts', adds: 2 }] };
    const [t] = resolveWidgets([{ type: 'table', bind: 'rows', columns: ['file', 'adds'] }], data);
    expect(t!.data).toEqual({ columns: ['file', 'adds'], rows: [['a.ts', '10'], ['b.ts', '2']] });
  });

  it('degrades gracefully on missing/empty binds (the floor always renders)', () => {
    const specs: WidgetSpec[] = [
      { type: 'list', bind: 'reviewInfo.changedFiles', empty: 'none' },
      { type: 'gauge', bind: 'mergeQueue', valueKey: 'position', maxKey: 'total' },
      { type: 'badge', bind: 'error' },
    ];
    const r = resolveWidgets(specs, {});
    expect(r[0]!.data).toEqual([]); // empty list, UI shows `empty`
    expect(r[1]!.data).toEqual({ value: 0, max: 0, pct: 0 }); // no divide-by-zero
    expect(r[2]!.data).toBe('');
    expect(resolveWidgets(undefined, view)).toEqual([]);
  });

  it('keyValue uses explicit labelled fields when given', () => {
    const [kv] = resolveWidgets(
      [{ type: 'keyValue', fields: [{ label: 'Stage', bind: 'stage' }, { label: 'Pos', bind: 'mergeQueue.position' }] }],
      view,
    );
    expect(kv!.data).toEqual([{ label: 'Stage', value: 'review' }, { label: 'Pos', value: '2' }]);
  });
});
