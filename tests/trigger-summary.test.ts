import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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

const context = vm.createContext({ S: { tasks: [] as Record<string, any>[] } });
vm.runInContext([extractFunction('dependencySatisfied'), extractFunction('triggerSummary')].join('\n'), context);

const triggerSummary = context.triggerSummary as (triggers: unknown) => string;

function withTasks(tasks: { id: string; status?: string }[]): void {
  context.S.tasks = tasks.map((t) => ({ id: t.id, lastView: t.status ? { status: t.status } : undefined }));
}

describe('triggerSummary — dependency counts', () => {
  it('counts only the dependencies that are still outstanding', () => {
    withTasks([{ id: 'a', status: 'done' }, { id: 'b', status: 'active' }, { id: 'c', status: 'active' }]);
    expect(triggerSummary([{ kind: 'dependency', tasks: ['a', 'b', 'c'] }])).toBe('after 2 tasks');
  });

  it('singularizes when one dependency remains', () => {
    withTasks([{ id: 'a', status: 'done' }, { id: 'b', status: 'done' }, { id: 'c', status: 'active' }]);
    expect(triggerSummary([{ kind: 'dependency', tasks: ['a', 'b', 'c'] }])).toBe('after 1 task');
  });

  it('says so when every dependency is met', () => {
    withTasks([{ id: 'a', status: 'done' }, { id: 'b', status: 'done' }]);
    expect(triggerSummary([{ kind: 'dependency', tasks: ['a', 'b'] }])).toBe('dependencies met');
  });

  it('treats an unknown or statusless dependency as remaining', () => {
    withTasks([{ id: 'a', status: 'done' }, { id: 'b' }]);
    expect(triggerSummary([{ kind: 'dependency', tasks: ['a', 'b', 'gone'] }])).toBe('after 2 tasks');
  });

  it('honours the `on` condition when deciding what counts as satisfied', () => {
    withTasks([{ id: 'a', status: 'failed' }, { id: 'b', status: 'cancelled' }, { id: 'c', status: 'done' }]);
    const tasks = ['a', 'b', 'c'];
    expect(triggerSummary([{ kind: 'dependency', tasks, on: 'success' }])).toBe('after 2 tasks');
    expect(triggerSummary([{ kind: 'dependency', tasks, on: 'done' }])).toBe('after 2 tasks');
    expect(triggerSummary([{ kind: 'dependency', tasks, on: 'failed' }])).toBe('after 2 tasks');
    expect(triggerSummary([{ kind: 'dependency', tasks, on: 'settled' }])).toBe('dependencies met');
  });

  it('leaves the other trigger kinds alone', () => {
    withTasks([{ id: 'a', status: 'active' }]);
    expect(triggerSummary([{ kind: 'schedule', cron: '0 9 * * *' }, { kind: 'dependency', tasks: ['a'] }])).toBe(
      'cron 0 9 * * *  ·  after 1 task',
    );
    expect(triggerSummary([{ kind: 'event', type: 'github.pr-merged' }])).toBe('on github.pr-merged');
  });
});
