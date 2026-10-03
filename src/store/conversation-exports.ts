import fs from 'node:fs';
import path from 'node:path';
import type { ObjectStore } from './objects.js';
import type { Store } from './db.js';
import { CODEX_VERSION, CodexHistoryError, prepareCodexHistory } from '../agent/codex-history.js';
import { readLocalCodexHistory } from '../agent/codex-history-files.js';
import type { PanagentWarning } from '../agent/panagent.js';
import type { SecretScrubber } from '../agent/activity.js';

interface ConversationExport {
  exportId: string;
  filename: string;
  requiredCodexVersion: string;
  source: 'native' | 'generated';
  data: Buffer;
  /** Conversion warnings of a generated export, kept with the frozen snapshot. */
  warnings: PanagentWarning[];
}

/** Exports are frozen copies of a conversation for the download and the Work
 * locally command. A fresh one is made whenever either is opened, so an export
 * unused for a week is deleted (and its task's exports with the task). */
export const CONVERSATION_EXPORT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PREFIX = 'conversation-exports';

export function conversationExportKey(task: string, role: string, id: string): string {
  if (![task, role, id].every((part) => /^[a-zA-Z0-9_-]+$/.test(part)))
    throw new CodexHistoryError('invalid export identity');
  return `${PREFIX}/${task}/${role}/${id}.json`;
}

type ExportRegistry = Pick<Store, 'recordConversationExport' | 'touchConversationExport'>;

/** Freeze logical history once. The command and download reference this exact
 * snapshot even if the task resumes, forks, or changes providers afterwards. */
export async function createCodexConversationExport(objects: ObjectStore, task: string, role: string,
  session: string, source: { home: string } | { generated: { data: Buffer; warnings: PanagentWarning[] } },
  registry?: ExportRegistry,
  /** The task's secrets, masked byte for byte in the frozen copy (SS-3). */
  secrets?: Pick<SecretScrubber, 'mask'>): Promise<ConversationExport> {
  const snapshot = await prepareCodexHistory(session, async (id) => {
    if ('home' in source) return readLocalCodexHistory(source.home, id);
    if (id !== session) throw new CodexHistoryError(`generated history has an unresolved ancestor ${id}`);
    return { file: `${id}.jsonl`, content: source.generated.data };
  }, { snapshot: true });
  const result: ConversationExport = { exportId: snapshot!.session, filename: snapshot!.filename,
    requiredCodexVersion: CODEX_VERSION, source: 'home' in source ? 'native' : 'generated',
    data: secrets ? secrets.mask(snapshot!.content) : snapshot!.content,
    warnings: 'generated' in source ? source.generated.warnings : [] };
  const objectKey = conversationExportKey(task, role, result.exportId);
  const body = Buffer.from(JSON.stringify({ ...result,
    data: result.data.toString('base64'), sources: snapshot!.sources, repaired: snapshot!.repaired }));
  // Record first: a sweep must never find an object it doesn't know about.
  (await registry?.recordConversationExport({ objectKey, taskId: task, role, exportId: result.exportId, bytes: body.length }));
  await objects.put(objectKey, body, 'application/json');
  return result;
}

export async function readCodexConversationExport(objects: ObjectStore, task: string, role: string,
  id: string, registry?: ExportRegistry): Promise<ConversationExport> {
  const objectKey = conversationExportKey(task, role, id);
  let raw: Buffer;
  try { raw = await objects.get(objectKey); }
  catch (error) { throw notFound(error) ? new ConversationExportExpired() : error; }
  (await registry?.touchConversationExport(objectKey));
  const result = JSON.parse(raw.toString());
  return { warnings: [], ...result, data: Buffer.from(result.data, 'base64') };
}

export class ConversationExportExpired extends Error {
  constructor() { super('this conversation export has expired; open the download or Work locally again for a fresh one'); }
}

/** Delete up to `limit` exports unused for the retention period or whose task
 * is gone. Returns how many were deleted. */
export async function expireConversationExports(store: Store, objects: ObjectStore, now = Date.now(),
  limit = 100): Promise<number> {
  let deleted = 0;
  for (const objectKey of (await store.expiredConversationExports(now - CONVERSATION_EXPORT_RETENTION_MS, limit))) {
    try { await objects.delete(objectKey); }
    catch (error) {
      console.error(`[conversation-exports] could not delete ${objectKey}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    (await store.deleteConversationExport(objectKey));
    deleted++;
  }
  return deleted;
}

const BACKFILLED = 'conversation-exports:backfilled';

/** Exports written before they were recorded (before 2026-10) were never
 * deleted. Register the ones in a local object directory once, dated by the
 * file, so the sweep can expire them; delete those whose task is gone. Returns
 * how many were registered. */
export async function backfillConversationExports(store: Store, objects: ObjectStore, objectsRoot: string): Promise<number> {
  if (await store.kvGet(BACKFILLED)) return 0;
  let registered = 0;
  const root = path.join(objectsRoot, PREFIX);
  for (const task of await entries(root)) for (const role of await entries(path.join(root, task)))
    for (const file of await entries(path.join(root, task, role))) {
      const exportId = file.endsWith('.json') ? file.slice(0, -'.json'.length) : '';
      let objectKey: string;
      try { objectKey = conversationExportKey(task, role, exportId); } catch { continue; }
      const stat = await fs.promises.stat(path.join(root, task, role, file)).catch(() => undefined);
      if (!stat?.isFile()) continue;
      if (await store.recordConversationExport({ objectKey, taskId: task, role, exportId, bytes: stat.size,
        usedAt: Math.floor(stat.mtimeMs), onlyIfAbsent: true })) registered++;
      else if (!(await store.getTask(task))) await objects.delete(objectKey).catch(() => undefined);
    }
  (await store.kvSet(BACKFILLED, String(Date.now())));
  return registered;
}

/** A missing local file or an S3 404; anything else (an outage) is not expiry. */
function notFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    || /\(404\)|NoSuchKey/.test(error instanceof Error ? error.message : String(error));
}

async function entries(dir: string): Promise<string[]> {
  return fs.promises.readdir(dir).catch(() => []);
}
