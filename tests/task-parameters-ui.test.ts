import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
const start = app.indexOf('function paramsSection(v)');
const end = app.indexOf('function paramCurrentValue(', start);
if (start < 0 || end < 0) throw new Error('Could not find the task parameter renderer');
const source = app.slice(start, end);

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
  { paramDefaults: {} },
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
