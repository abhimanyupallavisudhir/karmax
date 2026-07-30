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
  S: {
    taskEvents: [
      {
        seq: 1,
        ts: 100,
        type: 'agent.activity',
        payload: {
          id: 'turn',
          kind: 'turn',
          phase: 'started',
          title: 'Agent started working',
          role: 'do',
          turnId: 'task-353#6',
        },
      },
      {
        seq: 2,
        ts: 200,
        type: 'agent.activity',
        payload: {
          id: 'turn',
          kind: 'turn',
          phase: 'failed',
          title: 'Agent turn failed',
          detail: 'Claude provider server_error: API Error: 529 Overloaded.',
          role: 'do',
          turnId: 'task-353#6',
        },
      },
      {
        seq: 3,
        ts: 300,
        type: 'agent.activity',
        payload: {
          id: 'turn',
          kind: 'turn',
          phase: 'started',
          title: 'Agent started working',
          role: 'do',
          turnId: 'task-353#6',
        },
      },
    ],
  },
});
vm.runInContext(extractFunction('conversationEntries'), context);

const conversationEntries = context.conversationEntries as (transcript: Record<string, any>) => Record<string, any>[];

describe('agent retry activity timeline', () => {
  it('keeps the failed attempt separate from the resumed attempt', () => {
    const entries = conversationEntries({ role: 'do', messages: [] });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.activity).toMatchObject({
      phase: 'failed',
      detail: 'Claude provider server_error: API Error: 529 Overloaded.',
    });
    expect(entries[1]?.activity).toMatchObject({
      phase: 'started',
      title: 'Agent retry started',
    });
    expect(entries[1]?.activity.detail).toBeUndefined();
  });
});
