/**
 * The task query language (PLAN-search-views) — a Linear/Jira-style token syntax that
 * round-trips a `TaskQuery` to and from a single search string. This is what powers the
 * one search box: humans type it, saved views store it, and the UI's filter chips both
 * read and write it.
 *
 *   status:active,waiting        enum clause, comma = OR
 *   -tag:bug                     leading '-' negates
 *   priority:>=2  priority:high  number clause, comparison ops or level names
 *   created:<7d   updated:>2026-01-01   date clause (relative age or absolute)
 *   is:draft  is:open  has:pr    facets (boolean-ish predicates)
 *   conversation:"merge conflict"   quotes keep a multi-word clause value together
 *   label:frontend               'label' is an alias for 'tag' (parent matches children)
 *   sort:priority-desc  sort:-created   sort directive
 *   group:status                 grouping directive
 *   "multi word"  free text      anything not a known field becomes full-text
 *
 * PURE — no Node imports; unit-tested in tests/search.test.ts.
 */
import { TaskQuery, FilterClause, SortClause, FilterOp } from './types.js';
import { fieldByKey } from './search.js';

/**
 * Split on whitespace but keep quoted spans together (and remember they were quoted).
 * A `key:` prefix binds to its value even when the value carries quotes — so
 * `conversation:"merge conflict"` and `status:done,"in progress"` stay one token
 * (`value` keeps the quotes; `splitValues` strips them per comma-separated part).
 * This is the form `stringifyQuery`/`addClause` already emit for spaced values.
 */
function tokenize(input: string): { text: string; quoted: boolean; key?: string; value?: string }[] {
  const toks: { text: string; quoted: boolean; key?: string; value?: string }[] = [];
  const re = /([-!]{0,2}[A-Za-z_#][\w.#-]*):((?:"[^"]*"|[^\s"])*)|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m[1] !== undefined) toks.push({ text: m[0], quoted: false, key: m[1], value: m[2] ?? '' });
    else if (m[3] !== undefined) toks.push({ text: m[3], quoted: true });
    else toks.push({ text: m[4]!, quoted: false });
  }
  return toks;
}

/** Split a clause value on commas outside quotes, stripping the quotes per part. */
function splitValues(raw: string): string[] {
  const vals: string[] = [];
  const re = /"([^"]*)"|([^,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const v = (m[1] !== undefined ? m[1] : m[2]!).trim();
    if (v) vals.push(v);
  }
  return vals;
}

const OP_PREFIX: { p: string; op: FilterOp }[] = [
  { p: '>=', op: 'gte' },
  { p: '<=', op: 'lte' },
  { p: '>', op: 'gt' },
  { p: '<', op: 'lt' },
  { p: '=', op: 'is' },
];

/** Parse a query string into a structured `TaskQuery`. Never throws — best-effort. */
export function parseQuery(input: string): TaskQuery {
  const q: TaskQuery = {};
  const filters: FilterClause[] = [];
  const sort: SortClause[] = [];
  const textParts: string[] = [];

  for (const tok of tokenize(input)) {
    // A quoted bare token, or one with no `key:` prefix, is free text.
    if (tok.key === undefined) {
      if (tok.text) textParts.push(tok.text);
      continue;
    }
    let key = tok.key;
    let rest = tok.value!;
    let negate = false;
    if (key.startsWith('-')) { negate = true; key = key.slice(1); }
    if (key.startsWith('!')) { negate = true; key = key.slice(1); }

    // directives
    if (key === 'sort') { sort.push(parseSort(rest)); continue; }
    if (key === 'group') { q.group = fieldByKey(rest)?.key ?? rest; continue; }

    const field = fieldByKey(key);
    if (!field) {
      // Unknown field key ⇒ treat the whole token as free text (so `foo:bar` still searches).
      textParts.push(tok.text);
      continue;
    }

    // comparison op prefix on the value (number/date), else default per field type.
    // A quote-led value is literal — no op sniffing inside it.
    let op: FilterOp = field.type === 'text' ? 'contains' : 'is';
    if (!rest.startsWith('"')) {
      for (const { p, op: o } of OP_PREFIX) {
        if (rest.startsWith(p)) { op = o; rest = rest.slice(p.length); break; }
      }
    }
    const values = splitValues(rest);
    if (values.length) filters.push({ field: field.key, op, values, ...(negate ? { negate: true } : {}) });
  }

  if (filters.length) q.filters = filters;
  if (sort.length) q.sort = sort;
  const text = textParts.join(' ').trim();
  if (text) q.text = text;
  return q;
}

function parseSort(spec: string): SortClause {
  let dir: 'asc' | 'desc' | undefined;
  let key = spec;
  if (key.startsWith('-')) { dir = 'desc'; key = key.slice(1); }
  else if (key.startsWith('+')) { dir = 'asc'; key = key.slice(1); }
  const dash = key.match(/^(.*)[-:](asc|desc)$/i);
  if (dash) { key = dash[1]!; dir = dash[2]!.toLowerCase() as 'asc' | 'desc'; }
  const field = fieldByKey(key);
  const resolved = field?.key ?? key;
  // Natural default direction: newest/highest first for date/number, A→Z for text.
  if (!dir) dir = field && (field.type === 'date' || field.type === 'number') ? 'desc' : 'asc';
  return { field: resolved, dir };
}

/** Serialize a `TaskQuery` back to its canonical query string (round-trips `parseQuery`). */
export function stringifyQuery(q: TaskQuery): string {
  const parts: string[] = [];
  for (const c of q.filters ?? []) {
    const prefix = c.negate ? '-' : '';
    const opStr = c.op === 'gt' ? '>' : c.op === 'gte' ? '>=' : c.op === 'lt' ? '<' : c.op === 'lte' ? '<=' : '';
    const vals = c.values.map((v) => (v.includes(' ') ? `"${v}"` : v)).join(',');
    parts.push(`${prefix}${c.field}:${opStr}${vals}`);
  }
  for (const s of q.sort ?? []) parts.push(`sort:${s.field}-${s.dir}`);
  if (q.group) parts.push(`group:${q.group}`);
  if (q.text) parts.push(q.text.includes(' ') ? `"${q.text}"` : q.text);
  return parts.join(' ');
}
