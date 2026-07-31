import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');

describe('organization provider connection UI', () => {
  it('shows the effective built-in E2B headless-template default', () => {
    expect(source).toContain('class="provider-template" value="${esc(config.template || \'\')}" placeholder="codex"');
    expect(source).not.toContain('placeholder="karmax-browser-v1"');
  });

  it('labels reconciled compute as monthly instead of an unspecified query period', () => {
    expect(source).toContain('Provider-reconciled compute · ${usagePeriod}');
    expect(source).toContain(" : 'This month';");
    expect(source).not.toContain('This query period ·');
  });
});
