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

describe('single-stage Responder form behavior', () => {
  it('uses the route renderer on task/default forms without Review layer controls', () => {
    const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
    const render = app.match(/function renderResponderField\([\s\S]*?\n}/)?.[0];
    expect(render, 'renderResponderField() should exist').toBeTruthy();
    expect(render).toContain('Human responds');
    expect(render).toContain('Agent responds');
    expect(render).not.toContain('cf-add');
    expect(render).not.toContain('cf-move');
    expect(app).toMatch(/COMMON_DEFAULT_NAMES[^\n]*'responder'/);
    expect(app).toMatch(/f\.type === 'responder'.*renderResponderField/);
  });

  it('resets the composite Responder and notifies draft autosave', () => {
    const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
    const reset = app.match(/function resetResponderField\([\s\S]*?\n}/)?.[0];
    expect(reset, 'resetResponderField() should exist').toBeTruthy();
    expect(reset).toMatch(/dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  });
});
