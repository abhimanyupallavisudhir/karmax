import { splitStatements, translate } from './postgres-sql.mjs';
import { workerData } from 'node:worker_threads';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const { Client, types } = pg;
// Store's public model has always used JS numbers for SQLite INTEGER values.
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1700, (value) => Number(value));

const port = workerData.port;
const control = new Int32Array(workerData.control);
const payload = new Uint8Array(workerData.payload);
const encoder = new TextEncoder();
let startupError;
const client = new Client({ connectionString: workerData.connectionString });
// PostgreSQL reports I (idle), T (transaction), or E (failed transaction).
// Use the server state: a batch can end in COMMIT after unrelated statements,
// and a failed transaction still needs ROLLBACK before it becomes idle.
let transactionOpen = false;
client.connection.on('readyForQuery', ({ status }) => { transactionOpen = status !== 'I'; });
const connected = client.connect().catch((error) => { startupError = error; });

function response(value) {
  const bytes = encoder.encode(JSON.stringify({ ok: true, value, transactionOpen }));
  let delivered = bytes;
  if (bytes.length > payload.length) {
    const file = path.join(os.tmpdir(), `karmax-postgres-${process.pid}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    delivered = encoder.encode(JSON.stringify({ ok: true, spill: file }));
  }
  payload.set(delivered);
  Atomics.store(control, 1, delivered.length);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}

function failure(error) {
  const bytes = encoder.encode(JSON.stringify({ ok: false, transactionOpen, error: {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    code: error?.code,
  } }));
  payload.set(bytes.subarray(0, payload.length));
  Atomics.store(control, 1, Math.min(bytes.length, payload.length));
  Atomics.store(control, 0, -1);
  Atomics.notify(control, 0);
}

port.on('message', async (message) => {
  let activeSql;
  try {
    await connected;
    if (startupError) throw startupError;
    if (message.op === 'ready') return response(true);
    if (message.op === 'close') { await client.end(); return response(true); }
    if (message.op === 'exec') {
      for (const statement of splitStatements(message.sql)) {
        const translated = translate(statement);
        if (!translated.skip) { activeSql = translated.sql; await client.query(translated.sql, translated.forcedParams ?? []); }
      }
      return response(undefined);
    }
    if (message.op === 'query') {
      const translated = translate(message.sql);
      if (translated.skip) return response(message.mode === 'all' ? [] : undefined);
      activeSql = translated.sql;
      const result = await client.query(translated.sql, translated.forcedParams ?? message.params ?? []);
      if (message.mode === 'all') return response(result.rows);
      if (message.mode === 'get') return response(result.rows[0]);
      return response({
        changes: result.rowCount ?? 0,
        lastInsertRowid: result.rows[0]?.seq ?? 0,
      });
    }
    throw new Error(`unknown PostgreSQL worker operation: ${message.op}`);
  } catch (error) {
    if (activeSql && error instanceof Error) error.message += `\nSQL: ${activeSql}`;
    failure(error);
  }
});
