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

function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (c === quote && next === quote) { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '-' && next === '-') { lineComment = true; i++; continue; }
    if (c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (c === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function quoteIdentifiersAndParams(sql) {
  let result = '';
  let parameter = 0;
  for (let i = 0; i < sql.length;) {
    const c = sql[i], next = sql[i + 1];
    if (c === "'" || c === '"') {
      const quote = c;
      const start = i++;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue; }
        if (sql[i++] === quote) break;
      }
      result += sql.slice(start, i);
      continue;
    }
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      if (end < 0) return result + sql.slice(i);
      result += sql.slice(i, end + 1); i = end + 1; continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      result += sql.slice(i, stop); i = stop; continue;
    }
    if (c === '?') { result += `$${++parameter}`; i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end++;
      const word = sql.slice(i, end);
      result += /[a-z][A-Za-z0-9_]*[A-Z]/.test(word) || word.toLowerCase() === 'user' ? `"${word}"` : word;
      i = end;
      continue;
    }
    result += c; i++;
  }
  return result;
}

function translate(statement) {
  const pragma = statement.match(/^PRAGMA\s+table_info\(([^)]+)\)$/i);
  if (pragma) {
    return {
      sql: `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`,
      forcedParams: [pragma[1].replace(/^['"]|['"]$/g, '')],
    };
  }
  if (/^PRAGMA\b/i.test(statement)) return { skip: true };
  const index = statement.match(/^SELECT 1 FROM sqlite_master WHERE type='index' AND name='([^']+)'$/i);
  if (index) {
    return {
      sql: 'SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname=$1',
      forcedParams: [index[1]],
    };
  }

  if (/^SELECT\s+page_count\s*\*\s*page_size\s+bytes\s+FROM\s+pragma_page_count\(\),\s*pragma_page_size\(\)$/i.test(statement)) {
    return { sql: 'SELECT pg_database_size(current_database()) AS bytes' };
  }

  let sql = statement
    .replace(/\bBEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/gi, 'BEGIN')
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGSERIAL PRIMARY KEY')
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/\(\s*([A-Za-z_][\w.]*)\s+COLLATE\s+NOCASE\s*\)/gi, '(lower($1))')
    .replace(/\bIFNULL\s*\(/gi, 'COALESCE(')
    .replace(/length\s*\(\s*CAST\s*\(\s*data\s+AS\s+BLOB\s*\)\s*\)/gi, "octet_length(convert_to(data, 'UTF8'))")
    .replace(/json_remove\s*\(\s*([^,]+),\s*'\$\.([^']+)'\s*,\s*'\$\.([^']+)'\s*,\s*'\$\.([^']+)'\s*\)/gi,
      (_match, expression, first, second, third) =>
        `((${expression})::jsonb - '${first}' - '${second}' - '${third}')::text`)
    .replace(/json_set\s*\(\s*([^,]+),\s*'\$\.([^']+)'\s*,\s*json\s*\(\s*\?\s*\)\s*\)/gi,
      (_match, expression, key) => `jsonb_set((${expression})::jsonb, '{${key}}', ?::jsonb)::text`)
    .replace(/COALESCE\s*\(\s*json_extract\(([^,]+),\s*'\$\.draft'\),\s*0\s*\)/gi,
      "COALESCE(($1::jsonb #>> '{draft}')::integer, 0)")
    .replace(/json_extract\(([^,]+),\s*'\$\.([^']+)'\)/gi, (_match, expression, path) =>
      `(${expression}::jsonb #>> '{${String(path).split('.').join(',')}}')`)
    .replace(/(FROM\s+task_subscribers\b[\s\S]*?ORDER\s+BY\s+createdAt)\s*,\s*rowid/gi, '$1, principalKey')
    .replace(/\broot\.rowid\b/gi, 'root.id')
    .replace(/\browid\b/gi, 'id');
  const ignore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  if (ignore) sql = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
  sql = quoteIdentifiersAndParams(sql);
  if (ignore) sql += ' ON CONFLICT DO NOTHING';
  if (/^\s*INSERT\s+INTO\s+(?:"?events"?|"?audit_log"?)\b/i.test(sql) && !/\bRETURNING\b/i.test(sql))
    sql += ' RETURNING seq';
  return { sql };
}

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
