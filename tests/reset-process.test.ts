import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRecordedTemporalProcess } from '../src/scripts/reset-process.js';

describe('reset Temporal process identity', () => {
  const record = { pid: 123, address: '127.0.0.1:7233' };

  it('accepts only the recorded Temporal dev server and port', () => {
    expect(isRecordedTemporalProcess(record,
      ['/usr/bin/temporal', 'server', 'start-dev', '--headless', '--port', '7233'])).toBe(true);
    expect(isRecordedTemporalProcess(record,
      ['/usr/bin/node', 'app.js', 'temporal server start-dev --port 7233'])).toBe(false);
    expect(isRecordedTemporalProcess(record,
      ['/usr/bin/temporal', 'server', 'start-dev', '--headless', '--port', '7234'])).toBe(false);
    expect(isRecordedTemporalProcess({ ...record, address: 'bad' },
      ['/usr/bin/temporal', 'server', 'start-dev', '--headless', '--port', '7233'])).toBe(false);
  });
});

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
