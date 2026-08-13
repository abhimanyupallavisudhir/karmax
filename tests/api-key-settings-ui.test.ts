import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');
const editor = source.slice(source.indexOf('async function renderCredentialEditor('), source.indexOf('function wireCredDrag('));

function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe('API key settings UI', () => {
  it('offers all three API-key availability modes and persists them exclusively', () => {
    expect(editor).toContain('<option value="on"');
    expect(editor).toContain('<option value="off"');
    expect(editor).toContain('<option value="explainer-only"');
    expect(editor).toContain('on.delete(key); off.delete(key); explainerOnly.delete(key)');
    expect(editor).toContain('explainerOnly: [...explainerOnly]');
  });

  it('keeps API keys binary on Task forms and renders inherited explainer-only as Off', () => {
    const modeOf = Function(`${extractFunction('credentialEditorMode')}; return credentialEditorMode;`)() as (
      scope: string, credential: { key: string; kind: string }, modes: Record<string, string>, isOn: boolean,
    ) => string;
    const key = { key: 'key:handle:openrouter:explain', kind: 'key' };
    expect(modeOf('global', key, { [key.key]: 'explainer-only' }, false)).toBe('explainer-only');
    expect(modeOf('project', key, { [key.key]: 'explainer-only' }, false)).toBe('explainer-only');
    expect(modeOf('task', key, { [key.key]: 'explainer-only' }, false)).toBe('off');
    expect(modeOf('task', key, { [key.key]: 'off' }, false)).toBe('off');
    expect(modeOf('task', key, { [key.key]: 'explainer-only' }, true)).toBe('on');
    expect(editor).toContain("c.kind === 'key' && scope !== 'task'");
    expect(editor).toContain('<button class="cred-toggle ${mode}"');
    expect(editor).toContain('<div class="cred-row ${esc(mode)}"');
    expect(editor).toContain('explainerOnly.delete(key)');
  });

  it('offers write-only edit and delete controls for saved API keys', () => {
    expect(editor).toContain('class="cred-key-edit"');
    expect(editor).toContain('class="cred-key-del"');
    expect(editor).toContain('type="password" autocomplete="new-password"');
    expect(editor).toContain("method: 'PATCH'");
    expect(editor).toContain("method: 'DELETE'");
    expect(editor).toContain('/accounts/keys/');
  });
});
