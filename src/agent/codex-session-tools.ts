import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** Rollouts are append-only: descendants address their ancestors by byte offset.
 * Even reserializing equivalent metadata can invalidate those offsets. A tools
 * migration therefore gets a new identity, leaving every existing byte intact.
 * The copied body and its history_base still refer to the unchanged ancestors.
 */
export function codexSessionWithTools(original: Buffer, dynamicTools: unknown[]):
  { session: string; filename: string; content: Buffer } | undefined {
  const newline = original.indexOf(10);
  const metadata = JSON.parse(original.subarray(0, newline < 0 ? original.length : newline).toString('utf8'));
  if (metadata?.type !== 'session_meta' || !metadata.payload || typeof metadata.payload !== 'object')
    throw new Error('Codex session is missing its leading session_meta record');
  if (isDeepStrictEqual(metadata.payload.dynamic_tools, dynamicTools)) return undefined;
  const session = crypto.randomUUID();
  metadata.payload.id = session;
  if ('session_id' in metadata.payload) metadata.payload.session_id = session;
  metadata.payload.dynamic_tools = dynamicTools;
  const timestamp = new Date(metadata.payload.timestamp ?? Date.now()).toISOString().slice(0, 19).replaceAll(':', '-');
  return { session, filename: `rollout-${timestamp}-${session}.jsonl`, content: Buffer.concat([Buffer.from(JSON.stringify(metadata)),
    newline < 0 ? Buffer.alloc(0) : original.subarray(newline)]) };
}
