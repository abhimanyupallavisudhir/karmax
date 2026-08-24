import crypto from 'node:crypto';
import path from 'node:path';
import type { ObjectStore } from './objects.js';

export const MAX_CONVERSATION_IMPORT_BYTES = 20 * 1024 * 1024;

export type ConversationImportFormat = 'codex' | 'claude-code' | 'claude-export' | 'panagent';

export interface ConversationImportRef {
  id: string;
  name: string;
  bytes: number;
  format: ConversationImportFormat;
  projectId: string;
}

const CLAUDE_TRANSCRIPT_TYPES = new Set([
  'agent-name',
  'ai-title',
  'assistant',
  'attachment',
  'custom-title',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'progress',
  'queue-operation',
  'summary',
  'system',
  'user',
]);

/** Detect only formats panagent can faithfully ingest as uploaded conversation files. */
export function detectConversationImport(data: Buffer): ConversationImportFormat {
  if (!data.length) throw new ConversationImportError('conversation file is empty');
  if (data.length > MAX_CONVERSATION_IMPORT_BYTES)
    throw new ConversationImportError('conversation file exceeds 20 MiB');
  const text = data.toString('utf8').replace(/^\uFEFF/, '');
  // A portable panagent document and Claude browser export are single JSON files,
  // so try the complete payload before treating it as an object stream.
  let complete: any;
  try { complete = JSON.parse(text); } catch { /* native histories are JSONL */ }
  if (complete && typeof complete === 'object' && !Array.isArray(complete)) {
    if (complete.schema === 'https://panagent.dev/schema/conversation/v1') return 'panagent';
    if (complete.chat_messages
      || (complete.conversation && typeof complete.conversation === 'object')) return 'claude-export';
  }

  // Native sessions are append-only logs. Real Claude Code clients often write
  // metadata (snapshot, attachment, title, queue state) before the first message,
  // so inspect the complete JSONL stream rather than guessing from line one.
  const records: any[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let value: any;
    try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch {
      throw new ConversationImportError(
        `expected a Codex or Claude JSON/JSONL conversation file (invalid JSONL at line ${index + 1})`,
      );
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ConversationImportError(`JSONL line ${index + 1} is not an object`);
    records.push(value);
  }

  // session_meta is the canonical identity record in current and legacy Codex
  // rollout JSONL, including newer ordinalized/paginated histories.
  if (records.some((record) => record.type === 'session_meta'
    && record.payload && typeof record.payload === 'object'
    && (record.payload.id || record.payload.session_id))) return 'codex';

  // Claude's global history.jsonl also contains sessionId, but has no typed
  // transcript records. Requiring a typed project-session entry keeps it from
  // being accepted as a resumable conversation while allowing metadata-first logs.
  if (records.some((record) => typeof record.sessionId === 'string' && record.sessionId
    && typeof record.type === 'string'
    && (CLAUDE_TRANSCRIPT_TYPES.has(record.type)
      || (record.message && typeof record.message === 'object')))) return 'claude-code';
  throw new ConversationImportError('file is not a recognized Codex or Claude conversation');
}

export function conversationImportObjectKey(projectId: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId) || !/^[a-f0-9]{64}$/.test(id))
    throw new ConversationImportError('invalid conversation import reference');
  return `conversation-imports/${projectId}/${id}.json`;
}

export async function putConversationImport(
  objects: ObjectStore,
  projectId: string,
  data: Buffer,
  filename?: string,
): Promise<ConversationImportRef> {
  const format = detectConversationImport(data);
  const id = crypto.createHash('sha256').update(data).digest('hex');
  const rawName = path.basename(filename || 'conversation.jsonl').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
  const name = rawName || 'conversation.jsonl';
  await objects.put(conversationImportObjectKey(projectId, id), data, 'application/x-ndjson');
  return { id, name, bytes: data.length, format, projectId };
}

export class ConversationImportError extends Error {}
