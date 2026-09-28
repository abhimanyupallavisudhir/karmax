import type { ObjectStore } from './objects.js';
import { CODEX_VERSION, CodexHistoryError, prepareCodexHistory } from '../agent/codex-history.js';
import { readLocalCodexHistory } from '../agent/codex-history-files.js';
import type { PanagentWarning } from '../agent/panagent.js';

interface ConversationExport {
  exportId: string;
  filename: string;
  requiredCodexVersion: string;
  source: 'native' | 'generated';
  data: Buffer;
  /** Conversion warnings of a generated export, kept with the frozen snapshot. */
  warnings: PanagentWarning[];
}

function key(task: string, role: string, id: string): string {
  if (![task, role, id].every((part) => /^[a-zA-Z0-9_-]+$/.test(part)))
    throw new CodexHistoryError('invalid export identity');
  return `conversation-exports/${task}/${role}/${id}.json`;
}

/** Freeze logical history once. The command and download reference this exact
 * snapshot even if the task resumes, forks, or changes providers afterwards. */
export async function createCodexConversationExport(objects: ObjectStore, task: string, role: string,
  session: string, source: { home: string } | { generated: { data: Buffer; warnings: PanagentWarning[] } }): Promise<ConversationExport> {
  const snapshot = await prepareCodexHistory(session, async (id) => {
    if ('home' in source) return readLocalCodexHistory(source.home, id);
    if (id !== session) throw new CodexHistoryError(`generated history has an unresolved ancestor ${id}`);
    return { file: `${id}.jsonl`, content: source.generated.data };
  }, { snapshot: true });
  const result: ConversationExport = { exportId: snapshot!.session, filename: snapshot!.filename,
    requiredCodexVersion: CODEX_VERSION, source: 'home' in source ? 'native' : 'generated', data: snapshot!.content,
    warnings: 'generated' in source ? source.generated.warnings : [] };
  await objects.put(key(task, role, result.exportId), Buffer.from(JSON.stringify({ ...result,
    data: result.data.toString('base64'), sources: snapshot!.sources, repaired: snapshot!.repaired })), 'application/json');
  return result;
}

export async function readCodexConversationExport(objects: ObjectStore, task: string, role: string,
  id: string): Promise<ConversationExport> {
  const result = JSON.parse((await objects.get(key(task, role, id))).toString());
  return { warnings: [], ...result, data: Buffer.from(result.data, 'base64') };
}
