import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ProjectSecrets, parseEnv, secretHandle } from '../src/autonomy/project-secrets.js';
import { materializeFileSecrets, secretFileManifest } from '../src/world/secrets.js';
import { envExampleNames } from '../src/autonomy/project-secrets.js';
import { remoteAgentEnv } from '../src/agent/remote-process.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';

function memoryKv() {
  const kv = new Map<string, string>();
  return { kvGet: (k: string) => kv.get(k), kvSet: (k: string, v: string) => void kv.set(k, v) };
}

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

describe('ProjectSecrets', () => {
  let dir: string;
  let broker: CredentialBroker;
  let secrets: ProjectSecrets;
  const projectId = 'proj_test';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-secrets-'));
    broker = new CredentialBroker(new Vault(dir));
    secrets = new ProjectSecrets(memoryKv(), broker);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stores values write-only in the vault; the registry carries names/shape only', () => {
    const rec = secrets.save(projectId, { name: 'DATABASE_URL', value: 'postgres://x' });
    expect(rec).toEqual({ name: 'DATABASE_URL' });
    expect(JSON.stringify(secrets.list(projectId))).not.toContain('postgres');
    expect(broker.hasHandle(secretHandle(projectId, 'DATABASE_URL'))).toBe(true);
    expect(secrets.env(projectId, {})).toEqual({ DATABASE_URL: 'postgres://x' });
  });

  it('keeps the stored value on a shape-only re-save, and rejects a new secret without one', () => {
    secrets.save(projectId, { name: 'SA_JSON', value: '{"k":1}' });
    const rec = secrets.save(projectId, { name: 'SA_JSON', file: 'creds/sa.json' });
    expect(rec.file).toBe('creds/sa.json');
    expect(secrets.files(projectId, {})).toEqual([{ path: 'creds/sa.json', mode: 0o600, value: '{"k":1}' }]);
    expect(secrets.env(projectId, {})).toEqual({}); // file-shaped ⇒ no env var
    expect(() => secrets.save(projectId, { name: 'NEW_ONE' })).toThrow(/no stored value/);
  });

  it('validates names and file paths', () => {
    expect(() => secrets.save(projectId, { name: 'bad name', value: 'x' })).toThrow(/env-var-shaped/);
    expect(() => secrets.save(projectId, { name: 'OK', value: 'x', file: '../escape' })).toThrow(/escapes/);
    expect(() => secrets.save(projectId, { name: 'OK', value: 'x', file: '/abs' })).toThrow(/relative/);
  });

  it('imports a pasted .env and deletes both record and vault value', () => {
    expect(secrets.importEnv(projectId, 'A=1\nB="2"\n# c\nD=')).toEqual(['A', 'B']);
    expect(secrets.envNames(projectId)).toEqual(['A', 'B']);
    secrets.delete(projectId, 'A');
    expect(secrets.envNames(projectId)).toEqual(['B']);
    expect(broker.hasHandle(secretHandle(projectId, 'A'))).toBe(false);
  });

  it('resolution is broker-audited under the project wildcard capability', () => {
    secrets.save(projectId, { name: 'KEY', value: 'v' });
    secrets.env(projectId, { taskId: 't1' });
    const grants = broker.audit_log().filter((e) => e.granted);
    expect(grants.some((e) => e.handle === secretHandle(projectId, 'KEY') && e.taskId === 't1')).toBe(true);
  });
});

describe('remote env forwarding (phase 2)', () => {
  it('forwards declared secret names across the allowlist boundary, nothing else', () => {
    const source = { KARMAX_TOKEN: 'kt', DATABASE_URL: 'postgres://x', HOST_ONLY: 'leak' };
    const env = remoteAgentEnv('claude', '/home/user/.claude-home', source, ['DATABASE_URL']);
    expect(env.DATABASE_URL).toBe('postgres://x');
    expect(env.KARMAX_TOKEN).toBe('kt');
    expect(env.HOST_ONLY).toBeUndefined();
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

describe('importCopyGlobs (the copyGlobs exit ramp)', () => {
  it('classifies matched files into env secrets, file secrets, and objects', async () => {
    const { Store } = await import('../src/store/db.js');
    const { LocalObjectStore } = await import('../src/store/objects.js');
    const { ProjectObjects } = await import('../src/store/project-objects.js');
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
      const secrets = new ProjectSecrets(store, broker);
      const objects = new ProjectObjects(store, new LocalObjectStore(path.join(state, 'objects')));
      const result = await importCopyGlobs({ project, secrets, objects });
      expect(result.envSecrets.sort()).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
      expect(result.fileSecrets).toEqual(['service-account.json']);
      expect(result.objects).toEqual(['weights.bin']);
      // .env parsed into env secrets; the json became a file-shaped secret at its path.
      expect(secrets.env(project.id, {}).DATABASE_URL).toBe('postgres://x');
      expect(secrets.files(project.id, {})).toEqual([
        { path: 'service-account.json', mode: 0o600, value: '{"key":"small text"}' }]);
      expect(objects.list(project.id)).toEqual([expect.objectContaining({ path: 'weights.bin', mode: 'seed', bytes: 4 })]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
});

describe('materializeFileSecrets (real worktree)', () => {
  let home: string;
  let repo: string;
  let dir: string;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-worlds-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-repo-'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'index.js'), 'console.log(1)\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });
  afterEach(() => {
    for (const p of [home, repo, dir]) fs.rmSync(p, { recursive: true, force: true });
  });

  it('writes 0600 files that git status, add -A, and the checkpoint never see', async () => {
    const world = await new WorktreeProvider(home).create({ taskId: 'sec1', repo, base: 'main', target: 'main' });
    const manifest = await materializeFileSecrets(world, [
      { path: '.env.local', mode: 0o600, value: 'DATABASE_URL=postgres://x\n' },
      { path: 'creds/sa.json', mode: 0o600, value: '{"k":1}' },
    ]);
    expect(manifest).toEqual(['.env.local', 'creds/sa.json']);
    expect(await world.readFile('creds/sa.json')).toBe('{"k":1}');
    expect(fs.statSync(path.join(world.handle.root, '.env.local')).mode & 0o777).toBe(0o600);
    // Excluded by construction: status is clean, and a blanket add stages nothing.
    const status = await world.exec('git', ['status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');
    await world.exec('git', ['add', '-A']);
    const staged = await world.exec('git', ['diff', '--cached', '--name-only']);
    expect(staged.stdout.trim()).toBe('');
    // The manifest round-trips through handle meta for the checkpoint backstop.
    world.handle.meta = { ...world.handle.meta, secretFiles: manifest };
    expect(secretFileManifest(world.handle.meta)).toEqual(new Set(['.env.local', 'creds/sa.json']));
    await world.destroy();
  });

  it('sibling worlds off the same repo do not inherit each other’s exclusions', async () => {
    const provider = new WorktreeProvider(home);
    const first = await provider.create({ taskId: 'sec2a', repo, base: 'main', target: 'main' });
    await materializeFileSecrets(first, [{ path: 'secret.txt', mode: 0o600, value: 's' }]);
    const second = await provider.create({ taskId: 'sec2b', repo, base: 'main', target: 'main' });
    await second.writeFile('secret.txt', 'ordinary file, not a secret here');
    const status = await second.exec('git', ['status', '--porcelain']);
    expect(status.stdout).toContain('secret.txt');
    await first.destroy();
    await second.destroy();
  });
});
