import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { createBackup, restoreBackup } from '../src/ops/backup.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('control-plane backup', () => {
  it('uses consistent SQLite snapshots, excludes worlds, verifies, and restores', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-'));
    const home = path.join(root, 'home');
    roots.push(root);
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.mkdirSync(path.join(home, 'worlds', 'secret-world'), { recursive: true });
    fs.writeFileSync(path.join(home, 'worlds', 'secret-world', 'not-backed-up'), 'work');
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'vault.json'), 'encrypted');
    const store = new Store(path.join(home, 'state', 'karmax.db'));
    store.kvSet('proof', 'before');

    const destination = path.join(root, 'snapshot');
    const result = await createBackup({ home, destination, externalTemporal: true });
    expect(result.manifest.worldsIncluded).toBe(false);
    expect(fs.existsSync(path.join(destination, 'payload', 'worlds'))).toBe(false);
    store.kvSet('proof', 'after');
    store.close();

    await restoreBackup(destination, { home });
    const restored = new Store(path.join(home, 'state', 'karmax.db'));
    expect(restored.kvGet('proof')).toBe('before');
    expect(fs.readFileSync(path.join(home, 'vault', 'vault.json'), 'utf8')).toBe('encrypted');
    restored.close();
  });

  it('rejects a backup whose payload changed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-backup-tamper-'));
    const home = path.join(root, 'home');
    roots.push(root);
    fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
    fs.writeFileSync(path.join(home, 'vault', 'value'), 'original');
    const destination = path.join(root, 'snapshot');
    await createBackup({ home, destination, externalTemporal: true });
    fs.writeFileSync(path.join(destination, 'payload', 'vault', 'value'), 'tampered');
    await expect(restoreBackup(destination, { home })).rejects.toThrow('integrity check failed');
  });
});
