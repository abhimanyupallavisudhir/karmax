import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** Includes the canonical-decoder fix for decimal values in rollout records. */
export const CODEX_VERSION = '0.156.1';
export const CODEX_PACKAGE = `@openai/codex@${CODEX_VERSION}`;

export class CodexHistoryError extends Error {
  constructor(message: string) { super(`Codex history: ${message}`); }
}

export interface CodexHistoryFile { file: string; content: Buffer }
export interface CodexHistorySnapshot {
  session: string;
  filename: string;
  content: Buffer;
  repaired: boolean;
  sources: Array<{ session: string; file: string; bytes: number; sha256: string }>;
}
interface RecordLine { value: any; end: number; decimal: boolean }
interface Segment { session: string; source: CodexHistoryFile; first: any }

function containsDecimalToken(raw: string): boolean {
  // Avoid a repeated-alternation string regex: megabyte tool-output strings can
  // overflow V8's regexp stack despite being valid JSON.
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '"') {
      for (i++; i < raw.length; i++) {
        if (raw[i] === '\\') i++;
        else if (raw[i] === '"') break;
      }
    } else if (raw[i] === '-' || (raw[i]! >= '0' && raw[i]! <= '9')) {
      for (i++; i < raw.length && /[0-9.eE+-]/.test(raw[i]!); i++) {
        if (raw[i] === '.' || raw[i] === 'e' || raw[i] === 'E') return true;
      }
      i--;
    }
  }
  return false;
}

export const validCodexSessionId = (id: string): boolean => /^[a-zA-Z0-9_-]{8,160}$/.test(id);
const hash = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

export function codexRolloutFilename(timestamp: string | undefined, session: string): string {
  if (!validCodexSessionId(session)) throw new CodexHistoryError('invalid session identity');
  const date = new Date(timestamp ?? '1970-01-01T00:00:00Z');
  if (!Number.isFinite(date.getTime())) throw new CodexHistoryError('invalid session timestamp');
  return `rollout-${date.toISOString().slice(0, 19).replaceAll(':', '-')}-${session}.jsonl`;
}

/** A deterministic choice is safe only when all copies describe the same log. */
export function selectCodexHistoryCopy(copies: CodexHistoryFile[], session: string): CodexHistoryFile {
  if (!copies.length) throw new CodexHistoryError(`missing source rollout ${session}`);
  const sorted = [...copies].sort((a, b) => b.content.length - a.content.length || a.file.localeCompare(b.file));
  const kept = sorted[0]!;
  for (const other of sorted.slice(1)) {
    if (!kept.content.subarray(0, other.content.length).equals(other.content))
      throw new CodexHistoryError(`conflicting copies for ${session}: histories diverge; preserving both`);
  }
  return kept;
}

export function codexHistoryMetadata(content: Buffer): any {
  const end = content.indexOf(10);
  let record: any;
  try { record = JSON.parse(content.subarray(0, end < 0 ? content.length : end).toString('utf8')); }
  catch { throw new CodexHistoryError('invalid leading session metadata'); }
  if (record?.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object')
    throw new CodexHistoryError('missing leading session metadata');
  return record.payload;
}

function parseLines(content: Buffer, session: string): RecordLine[] {
  const lines: RecordLine[] = [];
  forEachRecord(content, 0, session, (value, end, raw) => { lines.push({ value, end, decimal: containsDecimalToken(raw) }); });
  return lines;
}

function forEachRecord(content: Buffer, start: number, session: string, visit: (value: any, end: number, raw: string) => void): void {
  if (!content.length || content.at(-1) !== 10)
    throw new CodexHistoryError(`incomplete JSONL tail for ${session}; retry after its writer has stopped`);
  while (start < content.length) {
    const end = content.indexOf(10, start) + 1;
    const raw = content.subarray(start, end).toString('utf8');
    let value: any;
    try { value = JSON.parse(raw); }
    catch { throw new CodexHistoryError(`invalid JSONL in ${session} at byte ${start}`); }
    if (!value || typeof value !== 'object' || typeof value.type !== 'string')
      throw new CodexHistoryError(`invalid record in ${session} at byte ${start}`);
    visit(value, end, raw);
    start = end;
  }
}

/** What validating a history's bytes established, and where it stopped: an
 * append-only rollout that still starts with those bytes (by digest) is
 * validated from there on, not from its first record again (AD-13). */
interface Scan {
  first: any;
  /** Paginated histories only: the next ordinal, whether the last record held a
   * decimal token, a proven decimal-tail repair, and the first ordinal fault. */
  expected: number;
  previousDecimal: boolean;
  repaired: boolean;
  fault?: string;
}
const scans = new Map<string, { bytes: number; digest: string; scan: Scan }>();
const SCAN_CACHE_ENTRIES = 64;

function scanHistory(key: string, session: string, content: Buffer): Scan {
  const digest = crypto.createHash('sha256');
  const cached = scans.get(key);
  let hashed = 0, scan: Scan | undefined, start = 0;
  if (cached && cached.bytes <= content.length) {
    digest.update(content.subarray(0, hashed = cached.bytes));
    if (digest.copy().digest('hex') === cached.digest) { scan = { ...cached.scan }; start = cached.bytes; }
  }
  forEachRecord(content, start, session, (value, _end, raw) => {
    if (!scan) {
      const base = value.payload?.history_base?.end_ordinal_exclusive;
      scan = { first: value, expected: Number.isSafeInteger(base) ? base : 0, previousDecimal: false, repaired: false };
    }
    if (scan.first.payload?.history_mode !== 'paginated' || scan.fault) return;
    const ordinal = value.ordinal;
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) { scan.fault = `missing or invalid ordinal in ${session}`; return; }
    if (ordinal !== scan.expected) {
      // The proven decoder failure skips a durable decimal-valued tail on
      // restart and reuses its ordinal. Keep BOTH records, never deduplicate.
      if (ordinal === scan.expected - 1 && scan.previousDecimal) scan.repaired = true;
      else { scan.fault = `unsupported ordinal sequence in ${session}: expected ${scan.expected}, got ${ordinal}`; return; }
    }
    scan.expected = ordinal + 1;
    // Examine JSON tokens, not quoted message/tool content. serde's flattened
    // envelope rejected decimal numbers anywhere inside an otherwise valid item.
    scan.previousDecimal = containsDecimalToken(raw);
  });
  digest.update(content.subarray(hashed));
  scans.delete(key);
  scans.set(key, { bytes: content.length, digest: digest.digest('hex'), scan: scan! });
  if (scans.size > SCAN_CACHE_ENTRIES) scans.delete(scans.keys().next().value!);
  return scan!;
}

function leadingMetadata(record: any): any {
  if (record?.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object')
    throw new CodexHistoryError('missing leading session metadata');
  return record.payload;
}

/** Resolve bytes before interpreting ordinals: old corrupt ordinals must never
 * change the frozen prefix inherited by an already-created child. The callback
 * is confined to one authorized home by the caller. It also works for sandboxes.
 */
export async function prepareCodexHistory(session: string,
  read: (session: string) => Promise<CodexHistoryFile>,
  options: { snapshot?: boolean; dynamicTools?: unknown[]; identity?: string } = {},
): Promise<CodexHistorySnapshot | undefined> {
  if (!validCodexSessionId(session)) throw new CodexHistoryError('invalid session identity');
  const seen = new Set<string>();
  const segments: Segment[] = [];
  let repaired = false;
  async function visit(id: string, cutoff?: { bytes: number; ordinal: number }): Promise<void> {
    if (seen.has(id)) throw new CodexHistoryError(`cyclic lineage at ${id}`);
    seen.add(id);
    const source = await read(id);
    const bytes = cutoff?.bytes ?? source.content.length;
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > source.content.length || source.content[bytes - 1] !== 10)
      throw new CodexHistoryError(`invalid cutoff byte offset for ${id}`);
    const content = source.content.subarray(0, bytes);
    const scan = scanHistory(cutoff ? `${id}@${bytes}` : id, id, content);
    const meta = leadingMetadata(scan.first);
    if ((meta.id ?? meta.session_id) !== id) throw new CodexHistoryError(`metadata identity mismatch for ${id}`);
    const base = meta.history_base;
    if (base != null) {
      if (!validCodexSessionId(base.thread_id ?? '') || !Number.isSafeInteger(base.end_ordinal_exclusive)
        || base.end_ordinal_exclusive < 1 || meta.history_mode !== 'paginated')
        throw new CodexHistoryError(`invalid history_base for ${id}`);
      await visit(base.thread_id, { bytes: base.end_byte_offset, ordinal: base.end_ordinal_exclusive });
    }
    if (meta.history_mode === 'paginated') {
      if (scan.fault) throw new CodexHistoryError(scan.fault);
      if (scan.repaired) repaired = true;
      if (cutoff && scan.expected !== cutoff.ordinal)
        throw new CodexHistoryError(`cutoff ordinal does not match the frozen bytes for ${id}`);
    } else if (cutoff) throw new CodexHistoryError(`paginated ancestor ${id} is not paginated`);
    segments.push({ session: id, source: { ...source, content }, first: scan.first });
  }
  await visit(session);
  const leaf = segments.at(-1)!;
  const metadata = structuredClone(leaf.first);
  const toolsChanged = options.dynamicTools !== undefined
    && !isDeepStrictEqual(metadata.payload.dynamic_tools, options.dynamicTools);
  const canonicalName = /(?:^|\/)rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl$/i.test(leaf.source.file);
  if (!options.snapshot && !repaired && !toolsChanged && canonicalName) return undefined;
  const sources = segments.map((segment) => ({ session: segment.session, file: segment.source.file,
    bytes: segment.source.content.length, sha256: hash(segment.source.content) }));
  // Changing captured bytes or tools produces another identity. Never overwrite
  // the snapshot a descendant might already reference.
  const hex = hash(JSON.stringify(['codex-history-v1', session,
    sources.map(({ session: id, sha256 }) => [id, sha256]), options.dynamicTools ?? metadata.payload.dynamic_tools])).slice(0, 32).split('');
  hex[12] = '4'; hex[16] = '8';
  const identity = hex.join('');
  const next = options.identity ?? `${identity.slice(0, 8)}-${identity.slice(8, 12)}-${identity.slice(12, 16)}-${identity.slice(16, 20)}-${identity.slice(20)}`;
  // Only a new identity needs every record; validation above did not keep them.
  const lines = segments.map((segment) => parseLines(segment.source.content, segment.session));
  const body = lines.flatMap((segment) => segment.slice(1));
  const out = [metadata, ...body.map((line) => structuredClone(line.value))];
  const meta = metadata.payload;
  if (meta.subagent_history_start_ordinal != null) {
    const boundary = meta.subagent_history_start_ordinal;
    if (!Number.isSafeInteger(boundary) || boundary < 0
      || body.some((line) => !Number.isSafeInteger(line.value.ordinal))
      || boundary > lines.at(-1)!.at(-1)!.value.ordinal + 1)
      throw new CodexHistoryError('invalid subagent history boundary');
    meta.subagent_history_start_ordinal = boundary === 0 ? 0
      : 1 + body.filter((line) => line.value.ordinal < boundary).length;
  }
  meta.id = next;
  if ('session_id' in meta) meta.session_id = next;
  meta.history_mode = 'paginated';
  delete meta.history_base;
  delete meta.forked_from_id;
  delete meta.forked_from_ordinal_exclusive;
  if (options.dynamicTools !== undefined) meta.dynamic_tools = options.dynamicTools;
  for (const [ordinal, record] of out.entries()) record.ordinal = ordinal;
  return { session: next, filename: codexRolloutFilename(meta.timestamp, next),
    content: Buffer.from(out.map((record) => JSON.stringify(record)).join('\n') + '\n'), repaired, sources };
}
