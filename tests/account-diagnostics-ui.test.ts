import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('credential incident panel', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'web/app.js'), 'utf8');

  it('distinguishes needs-attention from quota exhaustion and renders native provenance', () => {
    expect(app).toContain("status === 'needs-attention'");
    expect(app).toContain('Credential incident');
    expect(app).toContain('lastTransition');
    expect(app).toContain('requestId');
    expect(app).toContain('sourceTask');
  });
});
