import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { probeClaudeUsage } from '../src/agent/usage.js';

it('reaps a timed-out usage CLI that ignores SIGTERM before returning', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-usage-kill-'));
  const previous = process.env.KARMAX_CLAUDE_USAGE_CMD;
  const marker = path.join(home, 'pid');
  const stub = path.join(home, 'usage-stub');
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', refreshToken: 'fixture-refresh' } }));
  fs.writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
setInterval(() => {}, 100);
`, { mode: 0o700 });
  process.env.KARMAX_CLAUDE_USAGE_CMD = stub;
  try {
    expect(await probeClaudeUsage({ configHome: home, timeoutMs: 1_000 }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('timed out') });
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (fs.existsSync(marker)) { try { process.kill(Number(fs.readFileSync(marker, 'utf8')), 'SIGKILL'); } catch { /* already reaped */ } }
    if (previous === undefined) delete process.env.KARMAX_CLAUDE_USAGE_CMD;
    else process.env.KARMAX_CLAUDE_USAGE_CMD = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
