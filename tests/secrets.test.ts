import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { parseEnv, envExampleNames } from '../src/autonomy/project-secrets.js';
import { remoteAgentEnv } from '../src/agent/remote-process.js';

describe('parseEnv', () => {
  it('parses KEY=value lines with export, quotes, and comments', () => {
    const entries = parseEnv([
      '# a comment',
      'DATABASE_URL=postgres://localhost/dev',
      'export STRIPE_KEY="sk_test_123"',
      "SINGLE='quoted value'",
      'TRAILING=plain # not part of the value',
      'EMPTY=',
      'not a var line',
      '',
    ].join('\n'));
    expect(entries).toEqual([
      { name: 'DATABASE_URL', value: 'postgres://localhost/dev' },
      { name: 'STRIPE_KEY', value: 'sk_test_123' },
      { name: 'SINGLE', value: 'quoted value' },
      { name: 'TRAILING', value: 'plain' },
    ]);
  });
});

describe('envExampleNames', () => {
  it('collects names from .env example files, blank values included', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-envex-'));
    try {
      fs.writeFileSync(path.join(dir, '.env.example'), '# infra\nDATABASE_URL=\nexport STRIPE_KEY=sk_replace_me\nnot a line\n');
      expect(envExampleNames([dir]).sort()).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
      expect(envExampleNames([path.join(dir, 'missing')])).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('remote env forwarding', () => {
  it('forwards declared secret names across the allowlist boundary, nothing else', () => {
    const source = { KARMAX_TOKEN: 'kt', DATABASE_URL: 'postgres://x', HOST_ONLY: 'leak' };
    const env = remoteAgentEnv('claude', '/home/user/.claude-home', source, ['DATABASE_URL']);
    expect(env.DATABASE_URL).toBe('postgres://x');
    expect(env.KARMAX_TOKEN).toBe('kt');
    expect(env.HOST_ONLY).toBeUndefined();
  });
});

describe('importCopyGlobs (the typed copyGlobs exit ramp)', () => {
  it('classifies matched files into env secrets, file secrets, and volume resources', async () => {
    const { Store } = await import('../src/store/db.js');
    const { LocalObjectStore } = await import('../src/store/objects.js');
    const { ObjectSnapshotEngine, ProjectResourceService } = await import('../src/world/resources.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const { importCopyGlobs } = await import('../src/store/state-import.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cg-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cgstate-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://x\nSTRIPE_KEY=sk_1\n');
      fs.writeFileSync(path.join(dir, 'service-account.json'), '{"key":"small text"}');
      fs.writeFileSync(path.join(dir, 'weights.bin'), Buffer.from([0, 1, 2, 3]));
      const store = new Store(':memory:');
      const project = store.createProject('CG', { repos: [dir], copyGlobs: ['.env', '*.json', 'weights.bin'] });
      const broker = new CredentialBroker(new Vault(path.join(state, 'vault')));
      const resources = new ProjectResourceService(store, new WorldRegistry(),
        new ObjectSnapshotEngine(new LocalObjectStore(path.join(state, 'objects')), broker), broker);
      const result = await importCopyGlobs({ project, store, broker, resources });
      expect(result.envSecrets.sort()).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
      expect(result.fileSecrets).toEqual(['service-account.json']);
      expect(result.objects).toEqual(['weights.bin']);
      // Everything landed as TYPED attachments — no legacy stores involved.
      const attachments = store.listResourceAttachments(project.id);
      const byName = Object.fromEntries(attachments.map((a) => [a.name, a]));
      expect(byName.DATABASE_URL).toMatchObject({ driver: 'secret@1', target: { kind: 'environment', name: 'DATABASE_URL' } });
      expect(byName.SERVICE_ACCOUNT_JSON).toMatchObject({ driver: 'secret@1', target: { kind: 'path', path: 'service-account.json' } });
      expect(byName.weights_bin).toMatchObject({ driver: 'volume@1', target: { kind: 'path', path: 'weights.bin' } });
      expect(byName.weights_bin!.currentRevisionId).toBeTruthy(); // initial revision imported
      // Values are in the vault, never on the records.
      expect(JSON.stringify(attachments)).not.toContain('postgres://x');
      expect(broker.hasHandle(`secret:${project.id}:DATABASE_URL`)).toBe(true);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});
