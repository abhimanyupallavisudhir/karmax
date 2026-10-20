import type { Store } from '../store/db.js';
import type { ObjectStore } from '../store/objects.js';
import { BRAND } from '../domain/brand.js';
import { publicConversationHtml, publicShare } from '../gateway/conversation-sharing.js';
import { detectConversationImport, MAX_CONVERSATION_IMPORT_BYTES, putConversationImport, type ConversationImportRef } from '../store/conversation-imports.js';
import { fetchShare, PanagentError, publicConversationShare, summarizeConversation } from './panagent.js';

/**
 * A conversation to fork from, checked when it is given (pasted in the task
 * form, uploaded, or named in a task's params by the API) rather than at the
 * agent's first turn: it is read exactly as that turn will read it, and kept as
 * a content-addressed conversation import, so the turn starts from this copy.
 * Throws PanagentError, saying what to do, when it cannot be read.
 */
export async function importConversationShare(deps: { store: Store; objects?: ObjectStore }, projectId: string,
  link: string): Promise<ConversationImportRef> {
  const share = publicConversationShare(link);
  if (!share) throw new PanagentError(`Use a public HTTPS ChatGPT, Claude, Gemini or ${BRAND} share link, or upload a conversation file`);
  // A share of this installation is read from the store, as its page shows it.
  const local = share.id ? await publicShare(deps.store, share.id) : undefined;
  const source = local ? { data: Buffer.from(publicConversationHtml(local)), name: 'share.html' } : await fetchShare(share);
  if (source.data.length > MAX_CONVERSATION_IMPORT_BYTES) throw new PanagentError('This conversation is larger than 20 MiB');
  const summary = await summarizeConversation(source.data, source.name, share.format);
  return putConversationImport(deps.objects, projectId, source.data, source.name, { format: share.format, share: share.url, ...summary });
}

/** An uploaded Codex/Claude/panagent conversation file, checked the same way. */
export async function importConversationUpload(objects: ObjectStore | undefined, projectId: string, data: Buffer,
  filename?: string): Promise<ConversationImportRef> {
  const format = detectConversationImport(data);
  const summary = await summarizeConversation(data, filename || 'conversation.jsonl');
  return putConversationImport(objects, projectId, data, filename, { format, ...summary });
}
