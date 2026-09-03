import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
const start = app.indexOf('function paramsSection(v)');
const end = app.indexOf('function paramCurrentValue(', start);
if (start < 0 || end < 0) throw new Error('Could not find the task parameter renderer');
const source = app.slice(start, end);

const state: Record<string, any> = { paramDefaults: {}, paramEditDrafts: {} };
const paramsSection = new Function(
  'taskRecord',
  'schemaFor',
  'paramCurrentValue',
  'displayParam',
  'renderField',
  'eff',
  'esc',
  'S',
  'TERMINAL_STAGES',
  `${source}; return paramsSection;`,
)(
  () => ({ params: { prompt: 'Ship the retained configuration' } }),
  () => [{ name: 'prompt', label: 'Prompt', type: 'text', bind: 'prompt', scopes: ['task'] }],
  (_field: unknown, _view: unknown, record: { params: { prompt: string } }) => record.params.prompt,
  (_field: unknown, value: unknown) => String(value),
  () => '<input>',
  (own: unknown, inherited: unknown) => own ?? inherited,
  (value: unknown) => String(value),
  state,
  ['done', 'cancelled', 'failed'],
) as (view: Record<string, unknown>) => string;

describe('completed task parameters', () => {
  it.each(['done', 'cancelled', 'failed'])('keeps parameters visible and read-only at %s', (stage) => {
    const html = paramsSection({
      taskId: 'task-1',
      workflow: 'software-dev',
      stage,
      editableParams: ['prompt'],
    });

    expect(html).toContain('>Parameters<');
    expect(html).toContain('Ship the retained configuration');
    expect(html).toContain('This task has finished. Parameters are read-only.');
    expect(html).not.toContain('id="params-save"');
  });
});

describe('editable in-flight task parameters', () => {
  it('starts with an explicit saved state and enables saving only for a retained edit', () => {
    const view = {
      taskId: 'task-1',
      workflow: 'software-dev',
      stage: 'do',
      editableParams: ['prompt'],
    };

    const saved = paramsSection(view);
    expect(saved).toContain('data-save-state="saved"');
    expect(saved).toContain('All parameter changes saved');
    expect(saved).toMatch(/id="params-save" disabled/);

    state.paramEditDrafts = {
      'task-1': {
        saved: { prompt: 'Ship the retained configuration' },
        values: { prompt: 'Ship it after the current turn' },
        dirtyNames: ['prompt'],
      },
    };
    const dirty = paramsSection(view);
    expect(dirty).toContain('data-save-state="dirty"');
    expect(dirty).toContain('Unsaved parameter changes');
    expect(dirty).not.toMatch(/id="params-save" disabled/);
    state.paramEditDrafts = {};
  });
});

describe('in-flight parameter dirty comparison', () => {
  it('marks changed fields and clears them again when values are reverted', () => {
    const fnSource = app.match(/function paramDirtyNames\([\s\S]*?\n}/)?.[0];
    expect(fnSource).toBeTruthy();
    const dirtyNames = new Function('sameJson', `${fnSource}; return paramDirtyNames;`)(
      (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null),
    );
    const fields = [{ name: 'target' }, { name: 'agent:do' }];
    const saved = { target: 'main', 'agent:do': { provider: 'codex' } };

    expect(dirtyNames(saved, { ...saved, target: 'release' }, fields)).toEqual(['target']);
    expect(dirtyNames(saved, { ...saved }, fields)).toEqual([]);
  });
});
