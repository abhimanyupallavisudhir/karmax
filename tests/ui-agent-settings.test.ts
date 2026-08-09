import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('agent settings UI', () => {
  const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');

  it('does not offer the hermetic mock adapter as an agent provider', () => {
    const providers = source.match(/const AGENT_PROVIDERS = \[([^\]]*)\]/)?.[1] ?? '';
    expect(providers).not.toContain('mock');
    expect(providers).toContain('claude');
    expect(providers).toContain('codex');
  });

  it('has no separate Do/Merge agent editor', () => {
    expect(source).not.toContain('Separate Do and Merge agent configurations');
    expect(source).not.toContain('class="agent-separate"');
  });
});
