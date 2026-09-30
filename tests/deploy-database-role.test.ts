import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const deployDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy');
const read = (name: string) => fs.readFileSync(path.join(deployDir, name), 'utf8');
const roleSql = read('postgres/karmax-role.sql');

type Service = { environment?: Record<string, string>; secrets?: string[]; depends_on?: Record<string, { condition: string }>;
  entrypoint?: string[]; volumes?: string[]; image?: string };
const turnkey = parse(read('compose.turnkey.yml')) as { services: Record<string, Service>; secrets: Record<string, { file: string }>;
  volumes: Record<string, unknown> };

// The turnkey app used to connect as `temporal`, the cluster's bootstrap
// superuser: a compromised app could read every Temporal history, create
// roles and run programs as the database server (CI-7).
describe('turnkey PostgreSQL credentials', () => {
  const app = turnkey.services.app!;
  const job = turnkey.services['karmax-database']!;

  // An update runs the installed release's deploy/karmax, which cannot know
  // a host secret file this release adds, and Compose refuses to mount a
  // missing one. So the role job generates the app's URL into a volume.
  it('gives the app its own database URL from the role job, never the superuser password', () => {
    expect(app.environment?.KARMAX_DATABASE_URL).toBeUndefined();
    expect(app.environment?.KARMAX_DATABASE_URL_FILE).toBe('/run/karmax-database/database_url');
    expect(app.volumes).toContain('karmax_database:/run/karmax-database:ro');
    expect(app.secrets).not.toContain('database_url');
    expect(Object.keys(turnkey.secrets).sort()).toEqual(['auth_secret', 'vault_key', 'world_ref_key']);
    expect(Object.keys(turnkey.volumes)).toContain('karmax_database');
    expect(JSON.stringify(app)).not.toContain('POSTGRES_PASSWORD');
  });

  it('creates the role after Temporal creates the karmax database, and before the app starts', () => {
    expect(job.image).toBe('postgres:${POSTGRES_VERSION:-16}');
    expect(job.depends_on?.['temporal-schema']?.condition).toBe('service_completed_successfully');
    expect(app.depends_on?.['karmax-database']?.condition).toBe('service_completed_successfully');
    expect(job.environment?.PGUSER).toBe('temporal');
    expect(job.secrets).toBeUndefined();
    expect(job.volumes).toContain('karmax_database:/run/karmax-database');
    expect(job.entrypoint).toEqual(['/bin/sh', '/scripts/karmax-role.sh']);
  });
});

describe('deploy/postgres/karmax-role.sh', () => {
  /** Run the script with a `psql` stub that records what it was given, in a
   *  credentials directory holding `url` (none when undefined). */
  function run(url: string | undefined, home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-role-script-'))) {
    const bin = path.join(home, 'bin');
    const file = path.join(home, 'credentials', 'database_url');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(bin, 'psql'), `#!/bin/sh\nprintf '%s\\n' "$PGOPTIONS" "$*" > "${home}/psql"\n`, { mode: 0o755 });
    fs.rmSync(path.join(home, 'psql'), { force: true });
    if (url !== undefined) fs.writeFileSync(file, `${url}\n`);
    const result = spawnSync('sh', [path.join(deployDir, 'postgres', 'karmax-role.sh')], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, KARMAX_DATABASE_URL_FILE: file },
    });
    const psql = fs.existsSync(path.join(home, 'psql')) ? fs.readFileSync(path.join(home, 'psql'), 'utf8').split('\n') : undefined;
    return { status: result.status, stderr: result.stderr, psql, file, home };
  }
  const homes: string[] = [];
  afterAll(() => { for (const home of homes) fs.rmSync(home, { recursive: true, force: true }); });
  const tracked = (url: string | undefined) => { const result = run(url); homes.push(result.home); return result; };

  it('applies the role SQL to the karmax database with the password from the app URL', () => {
    const password = 'ab'.repeat(32);
    const { status, psql } = tracked(`postgres://karmax:${password}@postgresql:5432/karmax`);
    expect(status).toBe(0);
    expect(psql![0]).toBe(`-c karmax.app_role=karmax -c karmax.app_password=${password} `
      + '-c karmax.private_databases=temporal,temporal_visibility');
    expect(psql![1]).toBe(`-v ON_ERROR_STOP=1 -d karmax -f ${path.join(deployDir, 'postgres', 'karmax-role.sql')}`);
  });

  it('generates the URL once, readable by the app, when the volume has none', () => {
    const first = tracked(undefined);
    expect(first.status, first.stderr).toBe(0);
    const url = fs.readFileSync(first.file, 'utf8');
    const [, password] = /^postgres:\/\/karmax:([0-9a-f]{64})@postgresql:5432\/karmax\n$/.exec(url) ?? [];
    expect(password).toBeDefined();
    expect(first.psql![0]).toContain(`-c karmax.app_password=${password} `);
    expect(fs.statSync(first.file).mode & 0o777).toBe(0o644);
    const again = run(undefined, first.home);
    expect(again.status, again.stderr).toBe(0);
    expect(fs.readFileSync(first.file, 'utf8')).toBe(url);
    expect(fs.readdirSync(path.dirname(first.file))).toEqual(['database_url']);
  });

  // The password travels inside a connection option, so it must be exactly
  // what deploy/karmax generates: nothing that could end the option early.
  it.each([
    'postgres://temporal:abc@postgresql:5432/karmax',
    `postgres://karmax:${'ab'.repeat(32)} -c x=y@postgresql:5432/karmax`,
    'postgres://karmax:short@postgresql:5432/karmax',
  ])('refuses a URL it did not generate: %s', (url) => {
    const { status, stderr, psql } = tracked(url);
    expect(status).not.toBe(0);
    expect(stderr).toContain('database_url');
    expect(psql).toBeUndefined();
  });
});

// Temporal and the setup jobs use the superuser password, and releases before
// the karmax role handed it to the app too, so it is rotated after the switch.
describe('deploy/karmax rotate-postgres-password', () => {
  const operator = read('karmax');
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
  const before = 'KARMAX_DOMAIN=example.test\nPOSTGRES_PASSWORD=old\nSMTP_URL=smtp://kept.example.test\n';

  function rotate(refuse: boolean) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-rotate-')); roots.push(root);
    const deploy = path.join(root, 'deploy');
    fs.mkdirSync(deploy);
    const envFile = path.join(deploy, '.turnkey.env');
    fs.writeFileSync(envFile, before, { mode: 0o600 });
    // The real command with only its infrastructure stubbed: psql's stdin is
    // kept, since that is where the password must travel.
    const script = operator.slice(0, operator.indexOf('\nusage() {')) + `
need_docker() { :; }
dc() {
  printf '%s\\n' "$*" >> "$ROOT_DIR/operations"
  case "$*" in *psql*) cat > "$ROOT_DIR/psql-stdin"; [ ${refuse ? 1 : 0} = 0 ] ;; esac
}
wait_ready() { :; }
report_app_role() { echo reported >> "$ROOT_DIR/operations"; }
cmd_rotate_postgres_password
`;
    fs.writeFileSync(path.join(deploy, 'fixture-rotate'), script);
    const result = spawnSync('sh', [path.join(deploy, 'fixture-rotate')], { cwd: root, encoding: 'utf8' });
    const readIf = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return { ...result, envFile, deploy, operations: readIf(path.join(root, 'operations')),
      stdin: readIf(path.join(root, 'psql-stdin')), env: fs.readFileSync(envFile, 'utf8') };
  }

  it('changes the password through psql\'s stdin, then the env file, then the services', () => {
    const result = rotate(false);
    expect(result.status, result.stderr).toBe(0);
    const [, password] = /^ALTER ROLE temporal PASSWORD '([0-9a-f]{64})';\n$/.exec(result.stdin) ?? [];
    expect(password).toBeDefined();
    expect(result.env).toBe(`KARMAX_DOMAIN=example.test\nSMTP_URL=smtp://kept.example.test\nPOSTGRES_PASSWORD=${password}\n`);
    expect(fs.statSync(result.envFile).mode & 0o777).toBe(0o600);
    expect(result.operations).not.toContain(password);
    expect(result.operations).toMatch(/psql[^\n]*\nup -d --no-build --remove-orphans\nreported\n$/);
    expect(fs.readdirSync(result.deploy).sort()).toEqual(['.turnkey.env', 'fixture-rotate']);
  });

  it('changes nothing when PostgreSQL refuses the new password', () => {
    const result = rotate(true);
    expect(result.status).not.toBe(0);
    expect(result.env).toBe(before);
    expect(result.operations).not.toContain('up -d');
    expect(fs.readdirSync(result.deploy).sort()).toEqual(['.turnkey.env', 'fixture-rotate']);
  });
});

const postgres = process.env.KARMAX_TEST_POSTGRES_URL;

describe.skipIf(!postgres)('karmax-role.sql against PostgreSQL', () => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const role = `karmax_role_${suffix}`;
  const database = `karmax_role_db_${suffix}`;
  const other = `karmax_role_private_${suffix}`;
  const password = crypto.randomBytes(32).toString('hex');
  const admin = new pg.Pool({ connectionString: postgres, max: 1 });
  const target = (db: string, user?: { name: string; password: string }) => {
    const url = new URL(postgres!);
    url.pathname = `/${db}`;
    if (user) { url.username = user.name; url.password = user.password; }
    return url.href;
  };
  const connect = async (db: string, user?: { name: string; password: string }, options?: string) => {
    const client = new pg.Client({ connectionString: target(db, user), ...(options ? { options } : {}) });
    await client.connect();
    return client;
  };
  const apply = async () => {
    const client = await connect(database, undefined,
      `-c karmax.app_role=${role} -c karmax.app_password=${password} -c karmax.private_databases=${other}`);
    try { await client.query(roleSql); } finally { await client.end(); }
  };
  let app: pg.Client;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.query(`CREATE DATABASE ${other}`);
    // The state an existing install is in: tables the superuser created.
    const legacy = await connect(database);
    try {
      await legacy.query('CREATE TABLE tasks (id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL)');
      await legacy.query("INSERT INTO tasks (title) VALUES ('before the role existed')");
      await legacy.query('CREATE INDEX tasks_title ON tasks (title)');
    } finally { await legacy.end(); }
    // Every start re-applies it, so it must be idempotent.
    await apply();
    await apply();
    app = await connect(database, { name: role, password });
  });

  afterAll(async () => {
    await app?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${other} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('logs in with its password as an ordinary role', async () => {
    const { rows: [self] } = await app.query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(self).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
  });

  it('takes over the tables an older release created and keeps their data writable', async () => {
    const { rows } = await app.query("SELECT tableowner FROM pg_tables WHERE schemaname = 'public'");
    expect(rows).toEqual([{ tableowner: role }]);
    await app.query("INSERT INTO tasks (title) VALUES ('after')");
    expect((await app.query('SELECT title FROM tasks ORDER BY id')).rows.map((row) => row.title))
      .toEqual(['before the role existed', 'after']);
    await app.query('CREATE TABLE later (id BIGSERIAL PRIMARY KEY)');
    await app.query('ALTER TABLE tasks ADD COLUMN done BOOLEAN');
    await app.query('DROP TABLE later');
  });

  it('cannot reach other databases, create roles or run programs as the server', async () => {
    await expect(connect(other, { name: role, password })).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`CREATE ROLE ${role}_escalated`)).rejects.toMatchObject({ code: '42501' });
    await expect(app.query("COPY tasks TO PROGRAM 'true'")).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects a wrong password', async () => {
    await expect(connect(database, { name: role, password: 'ff'.repeat(32) })).rejects.toMatchObject({ code: '28P01' });
  });
});
