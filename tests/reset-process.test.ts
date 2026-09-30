import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['null', 'false', '{broken'])('WF-21: refuses reset for an invalid server record %s', (record) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-reset-record-'));
  try {
    fs.mkdirSync(path.join(home, 'temporal'));
    fs.mkdirSync(path.join(home, 'state'));
    fs.writeFileSync(path.join(home, 'temporal', 'dev-server.json'), record);
    fs.writeFileSync(path.join(home, 'state', 'keep'), 'state');
    const result = spawnSync(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('../src/scripts/reset.ts', import.meta.url))], {
      env: { ...process.env, KARMAX_HOME: home }, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(home, 'state', 'keep'), 'utf8')).toBe('state');
    expect(fs.existsSync(path.join(home, 'temporal', 'dev-server.json'))).toBe(true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
