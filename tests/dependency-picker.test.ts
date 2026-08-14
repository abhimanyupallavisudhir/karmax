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

const context = vm.createContext({
  esc: (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] as string)),
});
vm.runInContext([extractFunction('numberedTaskTitle'), extractFunction('dependencyChipHtml')].join('\n'), context);

const dependencyChipHtml = context.dependencyChipHtml as (task: { id: string; num?: number; title: string }) => string;

describe('task dependency picker', () => {
  it('shows the task number alongside the title in selected dependency chips', () => {
    expect(dependencyChipHtml({ id: 'task_build', num: 42, title: 'Do this and that' }))
      .toContain('>#42 Do this and that<button');
  });

  it('keeps a title-only fallback when a task number is unavailable', () => {
    expect(dependencyChipHtml({ id: 'task_legacy', title: 'Legacy task' }))
      .toContain('>Legacy task<button');
  });
});
