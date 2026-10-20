import type { Store } from '../store/db.js';
import type { ObjectStore } from '../store/objects.js';
import { publicConversationHtml, publicShare } from '../gateway/conversation-sharing.js';
import { ConversationImportError, detectConversationImport, MAX_CONVERSATION_IMPORT_BYTES, putConversationImport, type ConversationImportFormat,
  type ConversationImportRef } from '../store/conversation-imports.js';
import { PanagentError, summarizeConversation } from './panagent.js';
import { fetchShare, isShareFormat, publicConversationShare, SHARE_APPS, ShareLinkError } from './conversation-shares.js';

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
  if (!share) throw new PanagentError(`Use a public HTTPS share link of ${SHARE_APPS}, or upload a conversation file`);
  // A share of this installation is read from the store, as its page shows it.
  const local = share.id ? await publicShare(deps.store, share.id) : undefined;
  const source = local ? { data: Buffer.from(publicConversationHtml(local)), name: 'share.html' } : await fetchShare(share).catch((error) => {
    throw error instanceof ShareLinkError ? new PanagentError(error.message) : error;
  });
  if (source.data.length > MAX_CONVERSATION_IMPORT_BYTES) throw new PanagentError('This conversation is larger than 20 MiB');
  const { format: _read, ...summary } = await summarizeConversation(source.data, source.name, share.format);
  return putConversationImport(deps.objects, projectId, source.data, source.name, { format: share.format, share: share.url, ...summary });
}

/** An uploaded Codex/Claude/panagent conversation file, checked the same way. */
export async function importConversationUpload(objects: ObjectStore | undefined, projectId: string, data: Buffer,
  filename?: string): Promise<ConversationImportRef> {
  let format: ConversationImportFormat;
  try { format = detectConversationImport(data); } catch (error) {
    // A share's answer saved from a browser (the way out when a site asks for
    // a browser check) is panagent's to recognise.
    if (!(error instanceof ConversationImportError)) throw error;
    const read = await summarizeConversation(data, filename || 'conversation.json').catch(() => undefined);
    if (!read || !isShareFormat(read.format)) throw error;
    const { format: shareFormat, ...summary } = read;
    return putConversationImport(objects, projectId, data, filename, { format: shareFormat, ...summary });
  }
  const { format: _read, ...summary } = await summarizeConversation(data, filename || 'conversation.jsonl');
  return putConversationImport(objects, projectId, data, filename, { format, ...summary });
}
