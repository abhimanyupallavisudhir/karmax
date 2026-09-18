import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function readTaskPayments(box)'), app.indexOf('async function wireTaskPayments('));
const read = new Function(`${source}; return readTaskPayments;`)() as (box: unknown) => unknown;
const box = (value: string, valid = true) => ({
  dataset: { policy: JSON.stringify({ cardIds: ['work', 'personal'] }) },
  querySelector: () => ({ value, checkValidity: () => valid }),
});

describe('compact payment controls', () => {
  it('distinguishes zero budget from unlimited and sends integer cents', () => {
    expect(read(box('0'))).toEqual({ cardIds: ['work', 'personal'], budget: 0 });
    expect(read(box(''))).toEqual({ cardIds: ['work', 'personal'], budget: null });
    expect(read(box('12.34'))).toEqual({ cardIds: ['work', 'personal'], budget: 1234 });
  });
  it('never serializes an invalid or overflowing budget as unlimited', () => {
    expect(() => read(box('-1', false))).toThrow();
    expect(() => read(box('1e308'))).toThrow();
  });
  it('does not overwrite a policy while the controls are loading', () => {
    expect(read({ dataset: {} })).toBeUndefined();
  });
});
