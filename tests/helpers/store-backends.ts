import crypto from 'node:crypto';
import pg from 'pg';
import { onTestFinished } from 'vitest';
import { Store } from '../../src/store/db.js';

/**
 * The databases a store-level suite runs against: in-memory SQLite always, and
 * PostgreSQL when `KARMAX_TEST_POSTGRES_URL` names one (every CI shard has it).
 * Hosted deployments run on PostgreSQL, so a suite that covers tenancy or
 * billing state should run on both:
 *
 *   describe.each(storeBackends)('invitations ($name)', ({ open }) => { … open() … });
 *
 * Each PostgreSQL store gets a schema of its own, so suites never see each
 * other's rows and need no global reset. It is closed and its schema dropped
 * when the test that opened it finishes, if the test has not closed it: an
 * open store holds a worker thread and server connections, and a shard of
 * tests that leave in-memory SQLite stores to the garbage collector would
 * otherwise exhaust the server's connection limit.
 */
export interface StoreBackend {
  name: 'SQLite' | 'PostgreSQL';
  open(options?: { hosted?: boolean }): Promise<Store>;
}

const postgresUrl = process.env.KARMAX_TEST_POSTGRES_URL;

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

async function openPostgres(options?: { hosted?: boolean }): Promise<Store> {
  const schema = `karmax_test_${crypto.randomBytes(6).toString('hex')}`;
  await admin((client) => client.query(`CREATE SCHEMA ${schema}`));
  const url = new URL(postgresUrl!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const store = await Store.create(url.toString(), options);
  const close = store.close.bind(store);
  let dropped: Promise<void> | undefined;
  store.close = () => dropped ??= (async () => {
    await close();
    await admin((client) => client.query(`DROP SCHEMA ${schema} CASCADE`));
  })();
  // Opened in a suite hook rather than a test: the suite's own teardown closes it.
  try { onTestFinished(() => store.close()); } catch { /* not inside a test */ }
  return store;
}

export const storeBackends: StoreBackend[] = [
  { name: 'SQLite', open: (options) => Store.create(':memory:', options) },
  ...(postgresUrl ? [{ name: 'PostgreSQL' as const, open: openPostgres }] : []),
];
