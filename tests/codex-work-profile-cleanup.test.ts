import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { codexWorkProfile } from '../src/agent/work-environment.js';

it('removes profiles whose owner died while preserving a live turn profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-work-profile-'));
  const stale = path.join(home, `karmax-work-2147483647-${crypto.randomUUID()}.config.toml`);
  const live = path.join(home, `karmax-work-${process.pid}-${crypto.randomUUID()}.config.toml`);
  fs.writeFileSync(stale, 'secret'); fs.writeFileSync(live, 'secret');
  const kill = vi.spyOn(process, 'kill').mockImplementation(pid => {
    if (pid === 2147483647) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  try {
    const profile = codexWorkProfile({ secretEnv: { APP_TOKEN: 'test' }, resolvedAuth: { configHome: home } } as any);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    profile.cleanup();
    expect(fs.readdirSync(home)).toEqual([path.basename(live)]);
  } finally { kill.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
});
