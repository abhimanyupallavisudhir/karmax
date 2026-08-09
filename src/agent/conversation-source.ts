import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/paths.js';

export const MAX_CONVERSATION_IMPORT_BYTES = 25 * 1024 * 1024;

export interface ConversationSourceMessage {
  role: 'user' | 'agent' | 'system';
  text: string;
}

export interface ConversationImportRef {
  id: string;
  name: string;
  bytes: number;
  provider?: 'claude' | 'codex' | 'chatgpt';
  messageCount: number;
}

export type ConversationShareProvider = 'claude' | 'chatgpt';

/** Public share URLs are deliberately allow-listed: this value eventually reaches
 * fetch(), so accepting arbitrary URLs would turn the worker into an SSRF proxy. */
export function conversationShareProvider(raw: string): ConversationShareProvider | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:') return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'share' || !parts[1]) return undefined;
    if (url.hostname === 'claude.ai') return 'claude';
    if (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') return 'chatgpt';
  } catch { /* a provider session id is not a URL */ }
  return undefined;
}

/** Content-addressed, out-of-band storage for uploaded provider transcripts.
 * Only the hash reference enters task params / Temporal history. */
export class ConversationImportStore {
  private readonly dir: string;

  constructor(home?: string) {
    this.dir = path.join(paths(home).attachments, 'conversations');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  put(buf: Buffer, filename: string): ConversationImportRef {
    const name = safeConversationFilename(filename);
    if (!buf.length) throw new ConversationImportError('empty conversation file');
    if (buf.length > MAX_CONVERSATION_IMPORT_BYTES)
      throw new ConversationImportError('conversation file is too large (25 MB max)');
    if (!/\.(?:jsonl?|ndjson)$/i.test(name))
      throw new ConversationImportError('choose a Codex or Claude .json/.jsonl conversation file');
    const parsed = parseConversationBuffer(buf, name);
    const id = crypto.createHash('sha256').update(buf).digest('hex');
    const file = this.pathFor(id);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    return { id, name, bytes: buf.length, provider: parsed.provider, messageCount: parsed.messages.length };
  }

  read(id: string): Buffer | undefined {
    if (!/^[a-f0-9]{64}$/.test(id)) return undefined;
    try { return fs.readFileSync(this.pathFor(id)); } catch { return undefined; }
  }

  delete(id: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(id)) return false;
    try { fs.rmSync(this.pathFor(id)); return true; } catch { return false; }
  }

  private pathFor(id: string): string { return path.join(this.dir, `${id}.conversation`); }
}

export class ConversationImportError extends Error {}

function safeConversationFilename(filename: string): string {
  const name = path.basename(String(filename || 'conversation.jsonl')).replace(/[\u0000-\u001f]/g, '').trim();
  return name.slice(0, 160) || 'conversation.jsonl';
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((part) => {
    const item = record(part);
    if (item && item.type && !['text', 'input_text', 'output_text'].includes(String(item.type))) return '';
    return contentText(item?.text ?? item?.content ?? item?.parts ?? part);
  }).filter(Boolean).join('\n').trim();
  const item = record(value);
  if (!item) return '';
  return contentText(item.text ?? item.parts ?? item.content);
}

function normalizeRole(value: unknown): ConversationSourceMessage['role'] | undefined {
  if (value === 'user' || value === 'human') return 'user';
  if (value === 'assistant' || value === 'agent' || value === 'ai') return 'agent';
  if (value === 'system' || value === 'developer') return 'system';
  return undefined;
}

function messageOf(value: unknown): ConversationSourceMessage | undefined {
  const item = record(value);
  if (!item) return undefined;
  const role = normalizeRole(item.role ?? item.sender ?? record(item.author)?.role);
  if (!role || (role === 'system' && item.type === 'system')) return undefined;
  const text = contentText(item.content ?? item.text ?? item.message);
  return text ? { role, text } : undefined;
}

function pushMessage(out: ConversationSourceMessage[], message?: ConversationSourceMessage): void {
  if (!message) return;
  const previous = out[out.length - 1];
  if (previous?.role === message.role && previous.text === message.text) return;
  out.push(message);
}

function mappingMessages(root: Record<string, any>): ConversationSourceMessage[] {
  const mapping = record(root.mapping);
  if (!mapping) return [];
  const ordered: Record<string, any>[] = [];
  let cursor = typeof root.current_node === 'string' ? root.current_node : undefined;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = record(mapping[cursor]);
    if (!node) break;
    ordered.push(node);
    cursor = typeof node.parent === 'string' ? node.parent : undefined;
  }
  if (ordered.length) ordered.reverse();
  else ordered.push(...Object.values(mapping).map(record).filter(Boolean) as Record<string, any>[]);
  const out: ConversationSourceMessage[] = [];
  for (const node of ordered) pushMessage(out, messageOf(node.message));
  return out;
}

function messagesFromJson(value: unknown): { messages: ConversationSourceMessage[]; provider?: ConversationImportRef['provider'] } {
  const out: ConversationSourceMessage[] = [];
  const root = record(value);
  if (root?.mapping) return { messages: mappingMessages(root), provider: 'chatgpt' };

  const array = Array.isArray(value) ? value : undefined;
  if (array) {
    // A ChatGPT data export is an array of conversations. A single uploaded file
    // should still be useful; replay every conversation in its exported order.
    if (array.some((entry) => record(entry)?.mapping)) {
      for (const entry of array) for (const message of mappingMessages(record(entry)!)) pushMessage(out, message);
      return { messages: out, provider: 'chatgpt' };
    }
    if (array.some((entry) => Array.isArray(record(entry)?.chat_messages))) {
      for (const entry of array) {
        for (const message of record(entry)?.chat_messages ?? []) pushMessage(out, messageOf(message));
      }
      return { messages: out, provider: 'claude' };
    }
    for (const entry of array) pushMessage(out, messageOf(entry));
    return { messages: out };
  }

  const chatMessages = root?.chat_messages;
  if (Array.isArray(chatMessages)) {
    for (const entry of chatMessages) pushMessage(out, messageOf(entry));
    return { messages: out, provider: 'claude' };
  }
  if (Array.isArray(root?.messages)) {
    for (const entry of root.messages) pushMessage(out, messageOf(entry));
    return { messages: out };
  }
  return { messages: out };
}

function messagesFromJsonl(lines: unknown[]): { messages: ConversationSourceMessage[]; provider?: ConversationImportRef['provider'] } {
  const out: ConversationSourceMessage[] = [];
  let provider: ConversationImportRef['provider'];
  for (const value of lines) {
    const item = record(value);
    if (!item) continue;
    // Claude Code session JSONL.
    if ((item.type === 'user' || item.type === 'assistant') && record(item.message)) {
      provider = provider ?? 'claude';
      pushMessage(out, messageOf(item.message));
      continue;
    }
    // Codex rollout JSONL. Ignore event_msg mirrors to avoid duplicate assistant
    // output; response_item is the durable provider conversation.
    if (item.type === 'response_item' && record(item.payload)?.type === 'message') {
      provider = provider ?? 'codex';
      pushMessage(out, messageOf(item.payload));
      continue;
    }
    // Tolerate normalized JSONL exports without mistaking tool events for chat.
    if (!item.type || item.type === 'message') pushMessage(out, messageOf(item.payload ?? item));
  }
  return { messages: out, provider };
}

export function parseConversationBuffer(buf: Buffer, filename = 'conversation.jsonl'):
  { messages: ConversationSourceMessage[]; provider?: ConversationImportRef['provider'] } {
  if (buf.length > MAX_CONVERSATION_IMPORT_BYTES)
    throw new ConversationImportError('conversation file is too large (25 MB max)');
  const text = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) throw new ConversationImportError('empty conversation file');
  let parsed: ReturnType<typeof messagesFromJson>;
  try {
    const value = JSON.parse(text);
    parsed = messagesFromJson(value);
    if (!parsed.messages.length) parsed = messagesFromJsonl([value]);
  } catch {
    const values: unknown[] = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try { values.push(JSON.parse(line)); }
      catch { throw new ConversationImportError(`invalid JSON on line ${index + 1}`); }
    }
    parsed = messagesFromJsonl(values);
  }
  if (!parsed.messages.length)
    throw new ConversationImportError(`no user or assistant messages found in ${safeConversationFilename(filename)}`);
  return parsed;
}

function findConversationPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (typeof value === 'string' && /(?:"mapping"|"chat_messages"|"messages")/.test(value)) {
    try { return findConversationPayload(JSON.parse(value), depth + 1); } catch { /* embedded router frame */ }
    for (const candidate of balancedJsonObjects(value)) {
      try {
        const found = findConversationPayload(JSON.parse(candidate), depth + 1);
        if (found) return found;
      } catch { /* unrelated object */ }
    }
  }
  const item = record(value);
  if (item && (item.mapping || item.chat_messages || Array.isArray(item.messages))) return item;
  if (Array.isArray(value)) {
    for (const child of value) { const found = findConversationPayload(child, depth + 1); if (found) return found; }
  } else if (item) {
    for (const child of Object.values(item)) { const found = findConversationPayload(child, depth + 1); if (found) return found; }
  }
  return undefined;
}

function balancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (start < 0) { if (char === '{') { start = index; depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      const candidate = text.slice(start, index + 1);
      if (/(?:"mapping"|"chat_messages"|"messages")/.test(candidate)) out.push(candidate);
      start = -1;
    }
  }
  return out;
}

function parseShareBody(body: string): ConversationSourceMessage[] {
  try {
    const found = findConversationPayload(JSON.parse(body));
    if (found) return messagesFromJson(found).messages;
  } catch { /* HTML below */ }
  for (const match of body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const script = match[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
    const candidates: unknown[] = [];
    try { candidates.push(JSON.parse(script)); } catch { /* not a JSON script */ }
    for (const push of script.matchAll(/__next_f\.push\((\[[\s\S]*?\])\)\s*;?/g)) {
      try { candidates.push(JSON.parse(push[1]!)); } catch { /* unrelated router frame */ }
    }
    for (const literal of script.matchAll(/JSON\.parse\(("(?:\\.|[^"\\])*")\)/g)) {
      try { candidates.push(JSON.parse(JSON.parse(literal[1]!))); } catch { /* malformed bootstrap */ }
    }
    for (const json of balancedJsonObjects(script)) {
      try { candidates.push(JSON.parse(json)); } catch { /* JavaScript object */ }
    }
    for (const candidate of candidates) {
      const found = findConversationPayload(candidate);
      if (!found) continue;
      const messages = messagesFromJson(found).messages;
      if (messages.length) return messages;
    }
  }
  return [];
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_CONVERSATION_IMPORT_BYTES) throw new ConversationImportError('shared conversation is too large');
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_CONVERSATION_IMPORT_BYTES) throw new ConversationImportError('shared conversation is too large');
  return body;
}

export async function loadSharedConversation(raw: string, fetchImpl: typeof fetch = fetch): Promise<ConversationSourceMessage[]> {
  const provider = conversationShareProvider(raw);
  if (!provider) throw new ConversationImportError('use a public ChatGPT or Claude share link');
  const url = new URL(raw.trim());
  const shareId = url.pathname.split('/').filter(Boolean)[1]!;
  const candidates = provider === 'claude'
    ? [`https://claude.ai/api/chat_snapshots/${encodeURIComponent(shareId)}`]
    : [`https://chatgpt.com/backend-api/share/${encodeURIComponent(shareId)}`, `https://chatgpt.com/share/${encodeURIComponent(shareId)}`];
  let lastStatus = 0;
  let lastError: string | undefined;
  for (const candidate of candidates) {
    let response: Response;
    try {
      response = await fetchImpl(candidate, {
        // Do not follow provider-controlled redirects: the exact hosts above are
        // the SSRF boundary, and a public share endpoint must not widen it.
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: provider === 'claude'
          ? { accept: 'application/json', 'anthropic-client-platform': 'web_claude_ai', referer: url.toString() }
          : { accept: 'application/json,text/html;q=0.9', 'user-agent': 'karmax/1.0' },
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'network error';
      continue;
    }
    lastStatus = response.status;
    if (!response.ok) continue;
    const messages = parseShareBody(await boundedText(response));
    if (messages.length) return messages;
  }
  throw new ConversationImportError(lastStatus === 403
    ? 'the provider blocked this share link; upload the conversation export instead'
    : lastStatus
      ? 'could not read this shared conversation; check that the link is public'
      : `could not load shared conversation: ${lastError ?? 'network error'}`);
}
