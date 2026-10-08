import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ConfigHomeManager, hasClaudeNativeCredential, isLoggedIn } from '../src/autonomy/config-homes.js';
import { LOGIN_SYNC_FILE, MODEL_LOGINS_MOVED_MARKER, ModelLogins, PENDING_LOGIN, modelLoginHandle, readLoginBundle }
  from '../src/autonomy/model-logins.js';
import { RefreshLeases } from '../src/autonomy/refresh-lease.js';
import { Vault } from '../src/autonomy/vault.js';
import { DatabaseVault } from '../src/autonomy/vault-database.js';
import { LocalKek, organizationScope } from '../src/autonomy/vault-keys.js';
import { refreshCodexLogin } from '../src/agent/usage.js';
import { DATA_EPOCH, assertDataEpoch, recordDataEpoch } from '../src/config/data-epoch.js';
import { LoginManager } from '../src/autonomy/login.js';
import { storeBackends } from './helpers/store-backends.js';
import type { Store } from '../src/store/db.js';

/**
 * Data epoch 6 (wiki planned/host-local-state, step 2): model logins are vault
 * entries of their organization, config homes cache them, and every change
 * reaches the vault through the login's refresh lease.
 */

const KEY = 'the-original-deployment-key-material-000';
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-model-logins-'));
  directories.push(dir);
  return dir;
}
const claudeCredential = (access: string, refresh: string, expiresAt = Date.now() + 8 * 3_600_000) =>
  JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt, refreshTokenExpiresAt: Date.now() + 20 * 86_400_000 } });
const codexAuth = (access: string, refresh: string) => JSON.stringify({ tokens: { access_token: access, refresh_token: refresh }, last_refresh: new Date().toISOString() });
function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

describe.each(storeBackends)('model logins in the vault ($name)', ({ open }) => {
  /** One installation: its database, its vault (the file vault on SQLite, rows
   * on PostgreSQL, as `openSecretVault` picks) and a config-homes root. */
  async function installation(store?: Store, root?: string) {
    vi.stubEnv('KARMAX_VAULT_KEY', KEY);
    const home = scratch();
    store ??= await open();
    const vault = store.db.dialect === 'postgres'
      ? await DatabaseVault.open(store.db, { kek: { current: LocalKek.fromText(KEY), others: [] } })
      : new Vault(path.join(home, 'vault'));
    const broker = new CredentialBroker(vault);
    root ??= path.join(home, 'config-homes');
    const logins = new ModelLogins(root, broker, new RefreshLeases(store.db, { pollMs: 10 }));
    const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
    const boot = { audit: async (action: string, detail: Record<string, unknown>) => { audits.push({ action, detail }); } };
    return { store, broker, logins, root, home, audits, boot, vaultDir: path.join(home, 'vault'), homes: new ConfigHomeManager(root, logins) };
  }
  const reveal = (broker: CredentialBroker, handle: string) => broker.resolve(handle, { caps: [`use-credential:${handle}`] });

  /** A data-epoch-5 host: logins as plain files in their homes. */
  function epoch5Homes(root: string) {
    write(path.join(root, 'claude-work', '.credentials.json'), claudeCredential('a0', 'r0'));
    write(path.join(root, 'claude-work', 'projects', 'p', 'session.jsonl'), '{"history":1}\n');
    write(path.join(root, 'codex-personal', 'auth.json'), codexAuth('c0', 'cr0'));
    write(path.join(root, 'codex-personal', 'config.toml'), '[mcp_servers.karmax]\n');
    write(path.join(root, 'organizations', 'org_a', 'claude-shared', 'karmax-oauth.json'), JSON.stringify({ token: 'sk-ant-setup' }));
    write(path.join(root, 'organizations', 'org_a', 'opencode-team', 'data', 'opencode', 'auth.json'), JSON.stringify({ anthropic: { type: 'oauth', refresh: 'x' } }));
    write(path.join(root, 'organizations', 'org_a', 'opencode-team', 'karmax-login.json'), JSON.stringify({ modelProvider: 'anthropic' }));
    // A disconnected home keeps its history and no credential.
    write(path.join(root, 'codex-old', '.karmax-disconnected'), '');
    write(path.join(root, 'codex-old', 'sessions', 's.jsonl'), '{}\n');
  }

  it('moves every login into its organization\'s vault entry, checks it, keeps the files, and leaves a cache', async () => {
    const { store, broker, logins, root, audits, boot } = await installation();
    epoch5Homes(root);
    const before = fs.readFileSync(path.join(root, 'claude-work', '.credentials.json'), 'utf8');
    expect(await logins.moveIntoVault(store.db, boot)).toEqual({ logins: 4 });
    expect(await ModelLogins.moved(store.db)).toBe(true);
    expect(audits).toEqual([{ action: 'model-logins.moved-to-vault', detail: { logins: 4, byProvider: { claude: 2, codex: 1, opencode: 1 } } }]);
    // Each entry is the home's credential files, owned by the account's organization.
    const work = modelLoginHandle('org_personal', 'claude', 'work');
    expect(JSON.parse(await reveal(broker, work)).files).toEqual({ '.credentials.json': before });
    expect(await broker.scopeOf(work)).toBe(organizationScope('org_personal'));
    expect(await broker.scopeOf(modelLoginHandle('org_a', 'opencode', 'team'))).toBe(organizationScope('org_a'));
    expect(JSON.parse(await reveal(broker, modelLoginHandle('org_a', 'opencode', 'team'))).files).toEqual({
      'data/opencode/auth.json': expect.any(String), 'karmax-login.json': JSON.stringify({ modelProvider: 'anthropic' }) });
    expect((await broker.listHandles()).filter((handle) => handle.startsWith('model-login:')).sort()).toEqual([
      'model-login:org_a:claude:shared', 'model-login:org_a:opencode:team', 'model-login:org_personal:claude:work', 'model-login:org_personal:codex:personal']);
    // The files are kept, unchanged, beside the cache.
    const retired = path.join(path.dirname(root), 'retired-epoch6', 'config-homes');
    expect(fs.readFileSync(path.join(retired, 'claude-work', '.credentials.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(retired, 'organizations', 'org_a', 'opencode-team', 'data', 'opencode', 'auth.json'))).toBe(true);
    // Histories and configuration stay where they were; the credential is now a cache of the vault.
    expect(fs.readFileSync(path.join(root, 'claude-work', 'projects', 'p', 'session.jsonl'), 'utf8')).toBe('{"history":1}\n');
    expect(fs.readFileSync(path.join(root, 'claude-work', '.credentials.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(root, 'claude-work', LOGIN_SYNC_FILE))).toBe(true);
    expect(hasClaudeNativeCredential(path.join(root, 'claude-work'))).toBe(true);
    // Repeating the boot changes nothing.
    expect(await logins.moveIntoVault(store.db, boot)).toBeUndefined();
    expect(audits).toHaveLength(1);
  });

  it('resumes an interrupted move: the files stay the login until the marker commits', async () => {
    const { store, broker, logins, root, boot } = await installation();
    epoch5Homes(root);
    const work = path.join(root, 'claude-work', '.credentials.json');
    for (const at of ['copied', 'verified'] as const) {
      await expect(logins.moveIntoVault(store.db, boot, (name) => { if (name === at) throw new Error(`crash after ${at}`); }))
        .rejects.toThrow(`crash after ${at}`);
      expect(await ModelLogins.moved(store.db)).toBe(false);
      expect(fs.existsSync(path.join(root, 'claude-work', LOGIN_SYNC_FILE))).toBe(false);
      // The files are still the login, and still change (a refresh before the next boot).
      write(work, claudeCredential(`a-${at}`, `r-${at}`));
    }
    // A crash after the marker: the next boot only finishes keeping the files.
    await expect(logins.moveIntoVault(store.db, boot, (name) => { if (name === 'marked') throw new Error('crash after marked'); }))
      .rejects.toThrow('crash after marked');
    expect(await ModelLogins.moved(store.db)).toBe(true);
    expect(fs.existsSync(path.join(root, 'claude-work', LOGIN_SYNC_FILE))).toBe(false);
    expect(await logins.moveIntoVault(store.db, boot)).toBeUndefined();
    // The vault holds the files as they were at the boot that completed the move.
    const stored = JSON.parse(await reveal(broker, modelLoginHandle('org_personal', 'claude', 'work'))).files['.credentials.json'];
    expect(stored).toBe(fs.readFileSync(work, 'utf8'));
    expect(JSON.parse(stored).claudeAiOauth.refreshToken).toBe('r-verified');
    expect(fs.existsSync(path.join(root, 'claude-work', LOGIN_SYNC_FILE))).toBe(true);
  });

  it('refuses a move whose read-back differs, and leaves the files the login', async () => {
    const { store, broker, logins, root, boot } = await installation();
    epoch5Homes(root);
    const resolve = broker.resolve.bind(broker);
    vi.spyOn(broker, 'resolve').mockImplementation(async (handle, ctx) => handle.endsWith(':work') ? 'garbled' : resolve(handle, ctx));
    await expect(logins.moveIntoVault(store.db, boot)).rejects.toThrow(/does not read back the same/);
    expect(await ModelLogins.moved(store.db)).toBe(false);
    expect(fs.existsSync(path.join(root, 'claude-work', LOGIN_SYNC_FILE))).toBe(false);
  });

  it('materializes the logins the vault holds on a host that has none (a new host, a lost volume)', async () => {
    const first = await installation();
    epoch5Homes(first.root);
    await first.logins.moveIntoVault(first.store.db, first.boot);
    // Same database and vault, an empty config-homes root.
    const second = new ModelLogins(path.join(scratch(), 'config-homes'), first.broker, first.store.db);
    await second.moveIntoVault(first.store.db, first.boot);
    expect(readLoginBundle(path.join(second.root, 'claude-work'), 'claude'))
      .toBe(readLoginBundle(path.join(first.root, 'claude-work'), 'claude'));
    expect(isLoggedIn('claude', path.join(second.root, 'organizations', 'org_a', 'claude-shared'))).toBe(true);
    expect(isLoggedIn('codex', path.join(second.root, 'codex-personal'))).toBe(true);
  });

  it('keeps the cache and the vault in agreement both ways, and the vault wins a conflict', async () => {
    const { store, broker, logins, root, boot } = await installation();
    epoch5Homes(root);
    await logins.moveIntoVault(store.db, boot);
    const home = path.join(root, 'claude-work');
    const handle = modelLoginHandle('org_personal', 'claude', 'work');
    const stored = async () => JSON.parse(JSON.parse(await reveal(broker, handle)).files['.credentials.json']).claudeAiOauth.refreshToken;
    const cached = () => JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken;
    // A CLI on this host changed the files (a local turn's own refresh): the vault follows.
    write(path.join(home, '.credentials.json'), claudeCredential('a1', 'r1'));
    await logins.sync(home);
    expect(await stored()).toBe('r1');
    // Another host changed the vault: the cache follows.
    const next = JSON.stringify({ format: 'karmax-model-login:v1', files: { '.credentials.json': claudeCredential('a2', 'r2') } });
    expect(await broker.replaceHandleIfUnchanged(handle, await reveal(broker, handle), next, organizationScope('org_personal'))).toBe(true);
    await logins.sync(home);
    expect(cached()).toBe('r2');
    // Both changed: the vault's is kept.
    write(path.join(home, '.credentials.json'), claudeCredential('a3', 'r3-local'));
    const vaulted = JSON.stringify({ format: 'karmax-model-login:v1', files: { '.credentials.json': claudeCredential('a3', 'r3-vault') } });
    await broker.replaceHandleIfUnchanged(handle, await reveal(broker, handle), vaulted, organizationScope('org_personal'));
    await logins.sync(home);
    expect(cached()).toBe('r3-vault');
    expect(await stored()).toBe('r3-vault');
  });

  it('disconnects, renames and deletes logins in the vault with their homes', async () => {
    const { store, broker, logins, root, boot, homes } = await installation();
    epoch5Homes(root);
    await logins.moveIntoVault(store.db, boot);
    const retired = path.join(path.dirname(root), 'retired-epoch6', 'config-homes');
    await homes.rename('claude', 'work', 'job');
    expect(await broker.hasHandle(modelLoginHandle('org_personal', 'claude', 'work'))).toBe(false);
    expect(await broker.hasHandle(modelLoginHandle('org_personal', 'claude', 'job'))).toBe(true);
    expect(fs.existsSync(path.join(retired, 'claude-job', '.credentials.json'))).toBe(true);
    await homes.remove('claude', 'job');
    expect(await broker.hasHandle(modelLoginHandle('org_personal', 'claude', 'job'))).toBe(false);
    expect(fs.existsSync(path.join(retired, 'claude-job'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'claude-job', '.credentials.json'))).toBe(false);
    // The history stays; the login does not come back at the next sync.
    expect(fs.existsSync(path.join(root, 'claude-job', 'projects', 'p', 'session.jsonl'))).toBe(true);
    await logins.sync(path.join(root, 'claude-job'));
    expect(fs.existsSync(path.join(root, 'claude-job', '.credentials.json'))).toBe(false);
    await homes.removeOrganization('org_a');
    expect((await broker.listHandles()).filter((handle) => handle.startsWith('model-login:org_a:'))).toEqual([]);
    expect(fs.existsSync(path.join(retired, 'organizations', 'org_a'))).toBe(false);
  });

  it('a sign-in completes beside the cache and replaces the login in the vault', async () => {
    const { store, broker, logins, root, boot, homes } = await installation();
    epoch5Homes(root);
    await logins.moveIntoVault(store.db, boot);
    const manager = new LoginManager(homes, (provider, home) => ({
      cmd: process.execPath,
      args: ['-e', `require('fs').writeFileSync(require('path').join(${JSON.stringify(home)}, '.credentials.json'), ${JSON.stringify(claudeCredential('fresh', 'fresh-r'))}); console.log('https://claude.ai/oauth/authorize?code=1')`],
      env: { ...process.env },
    }));
    const states: boolean[] = [];
    manager.onStateChange((state) => { states.push(state.loggedIn); });
    await manager.connect('claude', 'work', { force: true });
    for (let i = 0; i < 100 && !states.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(states).toEqual([true]);
    const bundle = JSON.parse(await reveal(broker, modelLoginHandle('org_personal', 'claude', 'work')));
    expect(JSON.parse(bundle.files['.credentials.json']).claudeAiOauth.refreshToken).toBe('fresh-r');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'claude-work', '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).toBe('fresh-r');
    expect(fs.existsSync(path.join(root, 'claude-work', PENDING_LOGIN))).toBe(false);
  });

  it('refreshes a Codex login once when two hosts race, and both end with the new credential', async () => {
    const a = await installation();
    write(path.join(a.root, 'codex-personal', 'auth.json'), codexAuth('c0', 'cr0'));
    await a.logins.moveIntoVault(a.store.db, a.boot);
    // A second host: the same database and vault, its own cache.
    const b = new ModelLogins(path.join(scratch(), 'config-homes'), a.broker, new RefreshLeases(a.store.db, { pollMs: 10 }));
    await b.moveIntoVault(a.store.db, a.boot);
    let live = 'cr0';
    const spent: string[] = [];
    // A stand-in for `codex app-server`'s refresh against a token endpoint whose refresh tokens are single-use.
    const run = async (home?: string) => {
      const auth = JSON.parse(fs.readFileSync(path.join(home!, 'auth.json'), 'utf8'));
      spent.push(auth.tokens.refresh_token);
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (auth.tokens.refresh_token !== live) throw new Error('refresh_token_reused');
      live = 'cr1';
      fs.writeFileSync(path.join(home!, 'auth.json'), codexAuth('c1', 'cr1'));
      return { rateLimits: {} };
    };
    await Promise.all([
      refreshCodexLogin({ configHome: path.join(a.root, 'codex-personal'), force: true, run, logins: a.logins }),
      refreshCodexLogin({ configHome: path.join(b.root, 'codex-personal'), force: true, run, logins: b }),
    ]);
    expect(spent).toEqual(['cr0']);
    for (const root of [a.root, b.root])
      expect(JSON.parse(fs.readFileSync(path.join(root, 'codex-personal', 'auth.json'), 'utf8')).tokens.refresh_token).toBe('cr1');
    expect(JSON.parse(JSON.parse(await reveal(a.broker, modelLoginHandle('org_personal', 'codex', 'personal'))).files['auth.json']).tokens.refresh_token).toBe('cr1');
  });

  it('marks the vault so the epoch 5 release refuses it, while this release still opens it', async () => {
    const { store, vaultDir, broker } = await installation();
    await broker.registerHandle('k', 'v', organizationScope('org_a'));
    if (store.db.dialect === 'postgres') {
      // As the epoch 5 move leaves it: the epoch 3 marker in entries/.
      fs.mkdirSync(path.join(vaultDir, 'entries'), { recursive: true });
      fs.writeFileSync(path.join(vaultDir, 'entries', '.migrated'), '');
      Vault.sealForEpoch6(vaultDir, true);
      // The epoch 5 release creates entries/ at every boot (Vault.retire); it cannot over a file.
      expect(() => fs.mkdirSync(path.join(vaultDir, 'entries'), { recursive: true })).toThrow(/EEXIST/);
      expect(fs.readFileSync(path.join(vaultDir, 'entries'), 'utf8')).toMatch(/data epoch 6/);
      Vault.retire(vaultDir); // this release's own boot step tolerates it
      Vault.sealForEpoch6(vaultDir, true);
      // A fresh install on PostgreSQL has no vault directory; the epoch 5 release would create one.
      const fresh = path.join(scratch(), 'vault');
      Vault.sealForEpoch6(fresh, true);
      expect(() => fs.mkdirSync(path.join(fresh, 'entries'), { recursive: true })).toThrow(/EEXIST/);
    } else {
      Vault.sealForEpoch6(vaultDir, false);
      expect(JSON.parse(fs.readFileSync(path.join(vaultDir, 'secrets.json'), 'utf8'))[0]).toBe('karmax-vault-moved-to-entries:epoch6');
      Vault.sealForEpoch6(vaultDir, false);
      // This release opens it and reads every secret.
      expect(await new Vault(vaultDir).reveal('k')).toBe('v');
    }
  });

  it('records the data epoch and refuses a database a newer release has used', async () => {
    const { store } = await installation();
    await assertDataEpoch(store.db);
    await recordDataEpoch(store.db);
    expect(await store.db.prepare('SELECT v FROM kv WHERE k = ?').get('data-epoch')).toEqual({ v: String(DATA_EPOCH) });
    await recordDataEpoch(store.db, DATA_EPOCH + 1);
    await expect(assertDataEpoch(store.db)).rejects.toThrow(/data epoch 7, and this release is epoch 6/);
    await expect(recordDataEpoch(store.db)).rejects.toThrow(/data epoch 7/);
  });

  it('the attached process refuses logins that have not moved', async () => {
    const { store } = await installation();
    expect(await ModelLogins.moved(store.db)).toBe(false);
    await store.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run(MODEL_LOGINS_MOVED_MARKER, '{}');
    expect(await ModelLogins.moved(store.db)).toBe(true);
  });
});

it('deploy/data-epoch is the epoch this release writes', () => {
  expect(Number(fs.readFileSync(path.join(import.meta.dirname, '..', 'deploy', 'data-epoch'), 'utf8').trim())).toBe(DATA_EPOCH);
});
