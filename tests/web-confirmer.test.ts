import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('review-route form behavior', () => {
  it('notifies autosave when the composite confirmer field is reset', () => {
    const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
    const reset = app.match(/function resetConfirmerField\([\s\S]*?\n}/)?.[0];
    expect(reset, 'resetConfirmerField() should exist').toBeTruthy();
    expect(reset).toMatch(/dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  });
});
