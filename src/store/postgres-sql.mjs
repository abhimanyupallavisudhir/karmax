/** SQL dialect translation shared by both PostgreSQL adapters. */
export function splitStatements(sql) {
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

export function translate(statement) {
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
    .replace(/json_remove\s*\(\s*([\w.]+)\s*((?:,\s*'\$\.[^']+'\s*)+)\)/gi,
      (_match, expression, paths) => {
        const keys = [...paths.matchAll(/'\$\.([^']+)'/g)].map((match) => match[1].split('.').join(','));
        return `(${keys.reduce((value, key) => `(${value} #- '{${key}}')`, `(${expression})::jsonb`)})::text`;
      })
    .replace(/json_set\s*\(\s*([^,]+),\s*'\$\.([^']+)'\s*,\s*json\s*\(\s*\?\s*\)\s*\)/gi,
      (_match, expression, key) => `jsonb_set((${expression})::jsonb, '{${key}}', ?::jsonb)::text`)
    .replace(/COALESCE\s*\(\s*json_extract\(([^,]+),\s*'\$\.draft'\),\s*0\s*\)/gi,
      (_match, expression) => `(CASE WHEN COALESCE((${expression})::jsonb -> 'draft', 'null'::jsonb)
        IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb) THEN 0 ELSE 1 END)`)
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
