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

/** Detect only formats panagent can faithfully ingest as uploaded conversation files. */
export function detectConversationImport(data: Buffer): ConversationImportFormat {
  if (!data.length) throw new ConversationImportError('conversation file is empty');
  if (data.length > MAX_CONVERSATION_IMPORT_BYTES)
    throw new ConversationImportError('conversation file exceeds 20 MiB');
  const text = data.toString('utf8').replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/).find((line) => line.trim())?.trim();
  if (!first) throw new ConversationImportError('conversation file is empty');
  let value: any;
  try { value = JSON.parse(first); }
  catch {
    try { value = JSON.parse(text); }
    catch { throw new ConversationImportError('expected a Codex or Claude JSON/JSONL conversation file'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConversationImportError('conversation records must be JSON objects');
  // A portable panagent document and Claude browser export are single JSON files,
  // so parse the complete payload when the first line alone is inconclusive.
  if (value.schema === 'https://panagent.dev/schema/conversation/v1') return 'panagent';
  if (value.chat_messages || (value.conversation && typeof value.conversation === 'object')) return 'claude-export';
  if (value.type === 'session_meta'
    || (['response_item', 'event_msg'].includes(value.type) && value.payload)) return 'codex';
  if (['user', 'assistant', 'system', 'summary', 'file-history-snapshot'].includes(value.type)
    && (value.message || value.sessionId)) return 'claude-code';
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
