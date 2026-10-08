import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { startDevServer } from '../src/temporal/dev-server.js';
import { findFreePort } from '../src/util/ports.js';
import { MOVED_TO_DATABASE, RETIRED_VAULT, Vault } from '../src/autonomy/vault.js';
import { LocalKek, organizationScope } from '../src/autonomy/vault-keys.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const postgres = process.env.KARMAX_TEST_POSTGRES_URL;
const test = postgres && process.platform === 'linux' ? it : it.skip;

// Every other boot test runs src/main.ts as a self-host. This one boots it the
// way both compose profiles do (CI-13, CI-38o): a hosted single-node cell with
// its secrets in files, a separate activity-worker process, and PostgreSQL
// reached through the ordinary role deploy/postgres/karmax-role.sql creates.
test('boots src/main.ts as a hosted cell on PostgreSQL and Temporal without a superuser', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-hosted-main-'));
  const suffix = crypto.randomBytes(6).toString('hex');
  const role = `karmax_hosted_${suffix}`;
  const database = `karmax_hosted_${suffix}`;
  const password = crypto.randomBytes(32).toString('hex');
  const admin = new pg.Pool({ connectionString: postgres, max: 1 });
  const url = (user?: { name: string; password: string }) => {
    const target = new URL(postgres!);
    target.pathname = `/${database}`;
    if (user) { target.username = user.name; target.password = user.password; }
    return target.href;
  };
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let app: ChildProcess | undefined;
  let exit: Promise<number | null> | undefined;
  const log = fs.openSync(path.join(home, 'main.log'), 'a');
  const logTail = () => fs.readFileSync(path.join(home, 'main.log'), 'utf8').slice(-8000);
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const setupRole = new pg.Client({ connectionString: url(),
      options: `-c karmax.app_role=${role} -c karmax.app_password=${password}` });
    await setupRole.connect();
    try { await setupRole.query(fs.readFileSync(path.join(repoRoot, 'deploy', 'postgres', 'karmax-role.sql'), 'utf8')); }
    finally { await setupRole.end(); }

    const secrets = path.join(home, 'secrets');
    fs.mkdirSync(secrets);
    const secret = (name: string, value: string) => {
      fs.writeFileSync(path.join(secrets, name), `${value}\n`);
      return path.join(secrets, name);
    };
    // The vault as the epoch 4 release leaves it on the volume; the first boot moves it into PostgreSQL.
    const vaultKey = crypto.randomBytes(48).toString('hex');
    const vaultDir = path.join(home, 'data', 'vault');
    const fileVault = new Vault(vaultDir, { kek: { current: LocalKek.fromText(vaultKey), others: [] } });
    for (const value of ['e2b-key-1', 'e2b-key-2']) await fileVault.put('world-provider:org_personal:e2b:api-key', value, organizationScope('org_personal'));
    const entryFile = fs.readdirSync(path.join(vaultDir, 'entries')).find((name) => name.endsWith('.json'))!;
    const fileEntry = JSON.parse(fs.readFileSync(path.join(vaultDir, 'entries', entryFile), 'utf8'));
    server = await startDevServer({ headless: true, logLevel: 'never' });
    const port = await findFreePort();
    const base = `http://127.0.0.1:${port}`;
    const env = {
      PATH: process.env.PATH, HOME: home, KARMAX_HOME: path.join(home, 'data'),
      KARMAX_DEPLOYMENT: 'hosted', KARMAX_SINGLE_NODE: '1', KARMAX_CELL_ID: 'cell-test',
      KARMAX_PUBLIC_URL: 'https://karmax.example.test', KARMAX_PREVIEW_ORIGIN: 'https://preview.karmax.example.test',
      KARMAX_HOST: '127.0.0.1', KARMAX_PORT: String(port), KARMAX_WORKER_MODE: 'process',
      KARMAX_AUTH_SECRET_FILE: secret('auth_secret', crypto.randomBytes(48).toString('hex')),
      KARMAX_VAULT_KEY_FILE: secret('vault_key', vaultKey),
      KARMAX_WORLD_REF_KEY_FILE: secret('world_ref_key', crypto.randomBytes(48).toString('hex')),
      KARMAX_DATABASE_URL_FILE: secret('database_url', url({ name: role, password })),
      KARMAX_TEMPORAL_ADDRESS: server.address, KARMAX_TEMPORAL_NAMESPACE: server.namespace,
      KARMAX_TASK_QUEUE: `hosted-main-${suffix}`, KARMAX_OBJECT_STORE: 'local', KARMAX_CLOUD_WORLD_PROVIDER: 'e2b',
      KARMAX_AGENT_PROVIDER: 'mock',
    };
    const boot = async () => {
      app = spawn(process.execPath, ['--import', 'tsx', '--max-old-space-size=512', 'src/main.ts'], {
        cwd: repoRoot, stdio: ['ignore', log, log], env,
      });
      exit = new Promise(resolve => app!.once('exit', code => resolve(code)));
      await expect.poll(async () => {
        if (app!.exitCode !== null || app!.signalCode !== null) throw new Error(logTail());
        try { return (await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(1000) })).status; }
        catch { return 0; }
      }, { timeout: 60_000, interval: 200 }).toBe(200);
    };
    await boot();

    expect(await (await fetch(`${base}/api/meta`)).json()).toMatchObject({ hosted: true, hostLocal: false, cellId: 'cell-test' });
    // The vault moved: the same ciphertext is in the database, and only the sentinel is left on the volume.
    const vaultRows = new pg.Pool({ connectionString: url(), max: 1 });
    try {
      const moved = (await vaultRows.query('SELECT scope, blob, previous FROM vault_entries WHERE handle = $1', ['world-provider:org_personal:e2b:api-key'])).rows;
      expect(moved).toEqual([{ scope: 'organization:org_personal', blob: fileEntry.blob, previous: JSON.stringify(fileEntry.previous) }]);
      // The boot's own installation keys are written to the database too.
      expect((await vaultRows.query("SELECT 1 FROM vault_entries WHERE handle = 'world-reference:key:v2'")).rowCount).toBe(1);
      expect((await vaultRows.query("SELECT 1 FROM audit_log WHERE action = 'vault.moved-to-database'")).rowCount).toBe(1);
    } finally { await vaultRows.end(); }
    expect(JSON.parse(fs.readFileSync(path.join(vaultDir, 'secrets.json'), 'utf8'))).toEqual(MOVED_TO_DATABASE);
    expect(fs.readdirSync(path.join(vaultDir, 'entries'))).toEqual(['.migrated']);
    expect(fs.existsSync(path.join(vaultDir, 'keys'))).toBe(false);
    // Kept, unchanged and unread, until a later release deletes it.
    expect(JSON.parse(fs.readFileSync(path.join(vaultDir, RETIRED_VAULT, 'entries', entryFile), 'utf8'))).toEqual(fileEntry);
    expect(logTail()).toContain('Vault: moved 1 secret into the database (data epoch 5)');
    expect((await fetch(`${base}/api/projects`)).status).toBe(401);

    // Signing up the first administrator writes the identity and authorization
    // tables through the app's own role.
    const setup = await fetch(`${base}/api/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://karmax.example.test' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com', password: 'long-enough-password' }),
    });
    expect(setup.status, await setup.clone().text()).toBe(200);
    const cookie = setup.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0]
      ?? setup.headers.get('set-cookie')?.match(/__Secure-better-auth\.session_token=[^;]+/)?.[0] ?? '';
    const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json() as { user?: { email?: string } };
    expect(session.user?.email).toBe('alice@example.com');
    // Repository code never runs in the control-plane container.
    const policy = `${base}/api/organizations/org_personal/execution-policy`;
    expect((await (await fetch(policy, { headers: { cookie } })).json() as any).worldProvider).toBe('e2b');
    const local = await fetch(policy, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ policy: { worldProvider: 'worktree' } }) });
    expect(local.status).toBe(400);
    expect((await local.json() as any).error).toContain('remote world provider');

    const { rows } = await admin.query(
      `SELECT DISTINCT a.usename, r.rolsuper FROM pg_stat_activity a JOIN pg_roles r ON r.rolname = a.usename
        WHERE a.datname = $1 AND a.pid <> pg_backend_pid()`, [database]);
    expect(rows).toEqual([{ usename: role, rolsuper: false }]);

    // A clean stop, then a second boot migrates the same database as that role.
    app!.kill('SIGTERM');
    expect(await exit).toBe(0);
    await boot();
    expect((await (await fetch(`${base}/api/session`, { headers: { cookie } })).json() as any).user?.email).toBe('alice@example.com');
    expect(logTail().match(/Vault: moved/g)).toHaveLength(1); // the second boot only attaches
  } catch (error) {
    console.error(logTail());
    throw error;
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) {
      app.kill('SIGTERM');
      const kill = setTimeout(() => app!.kill('SIGKILL'), 10_000);
      await exit;
      clearTimeout(kill);
    }
    await server?.stop();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
    fs.closeSync(log);
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 180_000);
