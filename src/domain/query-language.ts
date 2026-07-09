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
 *   label:frontend               'label' is an alias for 'tag' (parent matches children)
 *   sort:priority-desc  sort:-created   sort directive
 *   group:status                 grouping directive
 *   "multi word"  free text      anything not a known field becomes full-text
 *
 * PURE — no Node imports; unit-tested in tests/search.test.ts.
 */
import { TaskQuery, FilterClause, SortClause, FilterOp } from './types.js';
import { fieldByKey } from './search.js';

/** Split on whitespace but keep quoted spans together (and remember they were quoted). */
function tokenize(input: string): { text: string; quoted: boolean }[] {
  const toks: { text: string; quoted: boolean }[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    if (m[1] !== undefined) toks.push({ text: m[1], quoted: true });
    else toks.push({ text: m[2]!, quoted: false });
  }
  return toks;
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
    // A quoted bare token, or one with no colon, is free text.
    const colon = tok.quoted ? -1 : tok.text.indexOf(':');
    if (colon < 0) {
      if (tok.text) textParts.push(tok.text);
      continue;
    }
    let key = tok.text.slice(0, colon);
    let rest = tok.text.slice(colon + 1);
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
    let op: FilterOp = field.type === 'text' ? 'contains' : 'is';
    for (const { p, op: o } of OP_PREFIX) {
      if (rest.startsWith(p)) { op = o; rest = rest.slice(p.length); break; }
    }
    const values = rest.split(',').map((s) => s.trim()).filter(Boolean);
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
