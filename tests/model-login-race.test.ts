import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { DatabaseVault } from '../src/autonomy/vault-database.js';
import { LocalKek } from '../src/autonomy/vault-keys.js';
import { ModelLogins, modelLoginHandle } from '../src/autonomy/model-logins.js';

/**
 * The live risk the refresh lease removes (wiki planned/host-local-state,
 * step 2): two processes on one database (on tavya.io the gateway and its
 * activity worker) refresh the same Claude login at once. Claude's refresh
 * tokens are single-use, so the second refresh is refused and the login is
 * signed out. Each racer here is a real process with its own Store, vault and
 * broker; the Claude CLI is a stand-in that refreshes in the CLI's own window
 * (the access token's last five minutes) against a stub token endpoint that
 * rejects a reused refresh token, and signs the login out when refused, as
 * Claude Code does.
 */

const KEY = 'the-original-deployment-key-material-000';
const postgresUrl = process.env.KARMAX_TEST_POSTGRES_URL;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-race-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A database both racers open: a SQLite file (WAL, a busy timeout), or a PostgreSQL schema of its own. */
const databases: Array<{ name: string; create(dir: string): Promise<string> }> = [
  { name: 'SQLite', create: async (dir) => path.join(dir, 'karmax.db') },
  ...(postgresUrl ? [{ name: 'PostgreSQL', create: async () => {
    const schema = `karmax_race_${crypto.randomBytes(6).toString('hex')}`;
    const admin = async (sql: string) => { const client = new pg.Client({ connectionString: postgresUrl }); await client.connect(); try { await client.query(sql); } finally { await client.end(); } };
    await admin(`CREATE SCHEMA ${schema}`);
    cleanups.push(() => admin(`DROP SCHEMA ${schema} CASCADE`));
    const url = new URL(postgresUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    return url.toString();
  } }] : []),
];

/** The provider's token endpoint: each refresh token works once. */
async function tokenEndpoint() {
  let live = 'r0';
  let issued = 0;
  const calls: Array<{ refreshToken: string; accepted: boolean }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { refresh_token: token } = JSON.parse(body);
      const accepted = token === live;
      calls.push({ refreshToken: token, accepted });
      if (!accepted) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' })); return; }
      issued++;
      live = `r${issued}`;
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: `a${issued}`, refresh_token: live, expires_in: 8 * 3600 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { calls, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/oauth/token` };
}

/** `claude -p /usage`, as far as a refresh goes. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');
const credential = JSON.parse(fs.readFileSync(file, 'utf8'));
const oauth = credential.claudeAiOauth;
(async () => {
  if (oauth.refreshToken && oauth.expiresAt - Date.now() < 5 * 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 300)); // startup, between reading the file and refreshing
    const response = await fetch(process.env.FAKE_CLAUDE_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken }) });
    if (response.ok) {
      const token = await response.json();
      Object.assign(oauth, { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 });
    } else Object.assign(oauth, { accessToken: '', refreshToken: '' }); // refused: signed out
    fs.writeFileSync(file + '.tmp', JSON.stringify(credential));
    fs.renameSync(file + '.tmp', file);
  }
  console.log('Current session: 3% used · resets Jul 5, 2:19am (Europe/London)');
})();
`;

async function race(setup: { target: string; vault: string; root: string; home: string; managed: boolean; tokenUrl: string; dir: string }) {
  const cli = path.join(setup.dir, 'claude');
  fs.writeFileSync(cli, FAKE_CLAUDE, { mode: 0o755 });
  const go = path.join(setup.dir, 'go');
  const racer = path.join(import.meta.dirname, 'helpers', 'model-login-racer.ts');
  const env = { ...process.env, KARMAX_VAULT_KEY: KEY, KARMAX_CLAUDE_USAGE_CMD: cli, FAKE_CLAUDE_TOKEN_URL: setup.tokenUrl };
  const racers = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--import', 'tsx', racer, JSON.stringify({ ...setup, go })], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(() => { child.kill('SIGKILL'); });
    let out = '';
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('ready\n')) resolve(); });
      child.once('exit', (code) => reject(new Error(`racer exited ${code} before it was ready: ${err}`)));
    });
    const done = new Promise<{ token?: string; error?: string }>((resolve, reject) => child.once('exit', (code) => {
      const line = out.split('\n').filter(Boolean).at(-1) ?? '';
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`racer exited ${code}: ${out}${err}`)); }
    }));
    return { ready, done };
  });
  await Promise.all(racers.map((racer) => racer.ready));
  fs.writeFileSync(go, '');
  return Promise.all(racers.map((racer) => racer.done));
}

const expired = () => JSON.stringify({ claudeAiOauth: { accessToken: 'a0', refreshToken: 'r0', expiresAt: Date.now() - 60_000,
  refreshTokenExpiresAt: Date.now() + 20 * 86_400_000, scopes: ['user:inference'] } });

describe.each(databases)('two processes refreshing one Claude login ($name)', ({ create }) => {
  it('refresh it once under the lease, and both end with the new credential', async () => {
    const dir = scratch();
    const target = await create(dir);
    const vaultDir = path.join(dir, 'vault');
    const root = path.join(dir, 'config-homes');
    const home = path.join(root, 'claude-work');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.credentials.json'), expired());
    // The primary's boot moves the login into the vault (data epoch 6).
    process.env.KARMAX_VAULT_KEY = KEY;
    cleanups.push(() => { delete process.env.KARMAX_VAULT_KEY; });
    const store = await Store.create(target);
    cleanups.push(() => store.close());
    const vault = store.db.dialect === 'postgres'
      ? await DatabaseVault.open(store.db, { kek: { current: LocalKek.fromText(KEY), others: [] } }) : new Vault(vaultDir);
    const broker = new CredentialBroker(vault);
    await new ModelLogins(root, broker, store.db).moveIntoVault(store.db, { audit: async () => {} });

    const endpoint = await tokenEndpoint();
    const results = await race({ target, vault: vaultDir, root, home, managed: true, tokenUrl: endpoint.url, dir });

    expect(endpoint.calls).toEqual([{ refreshToken: 'r0', accepted: true }]);
    expect(results).toEqual([{ token: 'a1' }, { token: 'a1' }]);
    const handle = modelLoginHandle('org_personal', 'claude', 'work');
    const stored = JSON.parse(JSON.parse(await broker.resolve(handle, { caps: [`use-credential:${handle}`] })).files['.credentials.json']);
    expect(stored.claudeAiOauth).toMatchObject({ accessToken: 'a1', refreshToken: 'r1' });
    expect(JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8')).claudeAiOauth).toMatchObject({ accessToken: 'a1', refreshToken: 'r1' });
    expect(Number((await store.db.prepare('SELECT COUNT(*) AS n FROM credential_refresh_leases').get() as { n: number }).n)).toBe(0);
  }, 90_000);

  it('without it (a home on disk, deduplicated per process), the same race spends the refresh token twice', async () => {
    const dir = scratch();
    const target = await create(dir);
    const root = path.join(dir, 'config-homes');
    const home = path.join(root, 'claude-work');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.credentials.json'), expired());
    const store = await Store.create(target);
    cleanups.push(() => store.close());
    const endpoint = await tokenEndpoint();
    const results = await race({ target, vault: path.join(dir, 'vault'), root, home, managed: false, tokenUrl: endpoint.url, dir });
    // The second refresh reused the spent token and was refused: Claude Code
    // then signs the login out, and whichever racer wrote last decides the file.
    expect(endpoint.calls).toEqual([{ refreshToken: 'r0', accepted: true }, { refreshToken: 'r0', accepted: false }]);
    expect(results).toHaveLength(2);
  }, 90_000);
});
