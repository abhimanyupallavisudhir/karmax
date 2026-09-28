import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');
const editor = source.slice(source.indexOf('async function renderCredentialEditor('), source.indexOf('function wireCredDrag('));

describe('API key settings UI', () => {
  it('offers all three API-key availability modes and persists them exclusively', () => {
    expect(editor).toContain('<option value="on"');
    expect(editor).toContain('<option value="off"');
    expect(editor).toContain('<option value="explainer-only"');
    expect(editor).toContain('on.delete(key); off.delete(key); explainerOnly.delete(key)');
    expect(editor).toContain('explainerOnly: [...explainerOnly]');
  });

  it('keeps API keys binary on Task forms and renders inherited explainer-only as Off', () => {
    expect(editor).toContain("const mode = scope === 'task' ? (isOn ? 'on' : 'off')");
    expect(editor).toContain("c.kind === 'key' ? (sd.modes?.[key] || (isOn ? 'on' : 'off'))");
    expect(editor).toContain("c.kind === 'key' && scope !== 'task'");
    expect(editor).toContain('<button class="cred-toggle ${mode}"');
    expect(editor).toContain(`<div class="cred-row \${esc(c.signedOut ? 'signed-out' : mode)}"`);
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
