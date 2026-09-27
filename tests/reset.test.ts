import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.each(['app.lock', 'worker.lock'])('refuses to wipe state while %s is held', async lockName => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-reset-'));
  const instances = path.join(home, 'state', 'instances');
  fs.mkdirSync(instances, { recursive: true });
  const sentinel = path.join(home, 'state', 'preserve');
  fs.writeFileSync(sentinel, 'live');
  const lock = path.join(instances, lockName);
  const holder = spawn('flock', ['-x', lock, 'sleep', '10'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 20; i++) {
      if (spawnSync('flock', ['-n', lock, 'true']).status !== 0) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/reset.ts'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, KARMAX_HOME: home }, encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('live');
  } finally {
    holder.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it('wipes inactive state while preserving stable instance lock files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-reset-idle-'));
  try {
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.mkdirSync(path.join(home, 'temporal'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'old.db'), 'old');
    fs.writeFileSync(path.join(home, 'temporal', 'old.db'), 'old');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/reset.ts'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, KARMAX_HOME: home }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, 'state', 'old.db'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'temporal', 'old.db'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'state', 'instances', 'app.lock'))).toBe(true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('refuses to wipe state when a recorded pid belongs to another process', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-reset-pid-'));
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.mkdirSync(path.join(home, 'temporal'), { recursive: true });
    const sentinel = path.join(home, 'state', 'preserve');
    fs.writeFileSync(sentinel, 'live');
    fs.writeFileSync(path.join(home, 'temporal', 'dev-server.json'),
      JSON.stringify({ pid: other.pid, address: '127.0.0.1:7233' }));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/reset.ts'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: { ...process.env, KARMAX_HOME: home }, encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not the Temporal dev server');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('live');
    expect(() => process.kill(other.pid!, 0)).not.toThrow();
  } finally {
    other.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
