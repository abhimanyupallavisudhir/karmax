import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareCodexHistory, selectCodexHistoryCopy } from '../src/agent/codex-history.js';
import { installLocalCodexSnapshot, publishLocalCodexHistory, readLocalCodexHistory } from '../src/agent/codex-history-files.js';
import { createCodexConversationExport, readCodexConversationExport } from '../src/store/conversation-exports.js';
import { LocalObjectStore } from '../src/store/objects.js';

const root = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const directories: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-history-')); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const jsonl = (records: any[]) => Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
const meta = (id: string, ordinal = 0, base?: unknown) => ({ ordinal, type: 'session_meta',
  payload: { id, history_mode: 'paginated', timestamp: '2026-09-09T00:00:00Z', ...(base ? { history_base: base } : {}) } });
const message = (ordinal: number, text: string) => ({ ordinal, type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

it('validates megabyte tool records without overflowing the scanner stack', async () => {
  const content = jsonl([meta(root), message(1, 'escaped " value 1.5 雪 '.repeat(150_000))]);
  const snapshot = await prepareCodexHistory(root, async () => ({ file: `${root}.jsonl`, content }), { snapshot: true });
  expect(snapshot?.repaired).toBe(false);
  expect(snapshot?.content.length).toBe(content.length);
});

it('repairs only proven decimal-tail ordinal reuse and preserves both distinct records', async () => {
  const original = Buffer.from(jsonl([meta(root), { ordinal: 1, type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary: { used_percent: 1.5 } } } },
    message(1, 'distinct user record'), { ordinal: 2, type: 'compacted', payload: { message: 'summary',
      replacement_history: [message(0, 'replacement').payload] } },
  ]));
  const read = async () => ({ file: `rollout-karmax-${root}.jsonl`, content: original });
  const snapshot = (await prepareCodexHistory(root, read))!;
  expect(snapshot.repaired).toBe(true);
  const records = snapshot.content.toString().trim().split('\n').map((line) => JSON.parse(line));
  expect(records.map((record) => record.ordinal)).toEqual([0, 1, 2, 3]);
  expect(records.slice(1).map((record) => record.payload)).toEqual(original.toString().trim().split('\n').map((line) => JSON.parse(line)).slice(1).map((record) => record.payload));
  expect(snapshot.session).not.toBe(root);
  expect((await prepareCodexHistory(root, read))!.session).toBe(snapshot.session);
  const home = temp();
  installLocalCodexSnapshot(home, root, snapshot);
  const advanced = Buffer.concat([snapshot.content, jsonl([message(4, 'continued after recovery')])]);
  publishLocalCodexHistory(home, { file: snapshot.filename, content: advanced }, snapshot.session);
  installLocalCodexSnapshot(home, root, snapshot);
  expect(readLocalCodexHistory(home, snapshot.session).content).toEqual(advanced);
});

it('freezes ancestor byte cutoffs, removes ancestor metadata, and keeps native tool and compaction records', async () => {
  const prefix = jsonl([meta(root), message(1, '雪 inherited'), { ordinal: 2, type: 'response_item',
    payload: { type: 'function_call', name: 'exec', call_id: 'call_1', arguments: '{}' } },
    { ordinal: 3, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'native tool output' } }]);
  const files = new Map([[root, Buffer.concat([prefix, jsonl([message(4, 'future parent suffix excluded')])])],
    [child, jsonl([meta(child, 4, { thread_id: root, end_byte_offset: prefix.length, end_ordinal_exclusive: 4 }), message(5, 'leaf')])]]);
  const leaf = JSON.parse(files.get(child)!.toString().split('\n')[0]!);
  leaf.payload.subagent_history_start_ordinal = 2;
  files.set(child, jsonl([leaf, message(5, 'leaf')]));
  const snapshot = (await prepareCodexHistory(child, async (id) => ({ file: `${id}.jsonl`, content: files.get(id)! }), { snapshot: true }))!;
  const records = snapshot.content.toString().trim().split('\n').map((line) => JSON.parse(line));
  expect(records.filter((record) => record.type === 'session_meta')).toHaveLength(1);
  expect(records[0].payload.history_base).toBeUndefined();
  expect(records[0].payload.subagent_history_start_ordinal).toBe(2);
  expect(records.map((record) => record.ordinal)).toEqual([0, 1, 2, 3, 4]);
  expect(snapshot.content.toString()).toContain('雪 inherited');
  expect(snapshot.content.toString()).toContain('native tool output');
  expect(snapshot.content.toString()).not.toContain('future parent suffix');
});

it.each(['gap', 'unexplained duplicate', 'partial tail', 'bad JSON', 'missing ancestor', 'cycle', 'cutoff'])('rejects %s without publishing a partial repair', async (kind) => {
  let content = jsonl([meta(root), message(kind === 'gap' ? 2 : 1, 'message')]);
  if (kind === 'unexplained duplicate') content = Buffer.concat([content, jsonl([message(1, 'other')])]);
  if (kind === 'partial tail') content = content.subarray(0, -1);
  if (kind === 'bad JSON') content = Buffer.concat([content, Buffer.from('{bad}\n')]);
  if (['missing ancestor', 'cycle', 'cutoff'].includes(kind)) content = jsonl([meta(root, 2, {
    thread_id: kind === 'cycle' ? root : child, end_byte_offset: 1, end_ordinal_exclusive: 2,
  })]);
  await expect(prepareCodexHistory(root, async (id) => {
    if (id !== root && kind === 'missing ancestor') return selectCodexHistoryCopy([], id);
    return { file: `${id}.jsonl`, content };
  }, { snapshot: true })).rejects.toThrow('Codex history:');
});

it('never truncates a destination or discards divergent aliases', () => {
  const home = temp(), filename = `rollout-2026-09-09T00-00-00-${root}.jsonl`;
  const content = jsonl([meta(root), message(1, 'longer')]);
  publishLocalCodexHistory(home, { file: filename, content }, root);
  publishLocalCodexHistory(home, { file: filename, content: jsonl([meta(root)]) }, root);
  expect(readLocalCodexHistory(home, root).content).toEqual(content);
  expect(() => publishLocalCodexHistory(home, { file: filename, content: jsonl([meta(root), message(1, 'diverged')]) }, root)).toThrow('histories diverge');
  expect(readLocalCodexHistory(home, root).content).toEqual(content);
});

it('binds export downloads to frozen content and the task/role authorization scope', async () => {
  const home = temp(), objects = new LocalObjectStore(temp());
  const file = `rollout-2026-09-09T00-00-00-${root}.jsonl`;
  const content = jsonl([meta(root), message(1, 'first snapshot')]);
  publishLocalCodexHistory(home, { file, content }, root);
  const first = await createCodexConversationExport(objects, 'task_a', 'do', root, { home });
  publishLocalCodexHistory(home, { file, content: Buffer.concat([content, jsonl([message(2, 'next turn')])]) }, root);
  const second = await createCodexConversationExport(objects, 'task_a', 'do', root, { home });
  expect(first.exportId).not.toBe(second.exportId);
  expect((await readCodexConversationExport(objects, 'task_a', 'do', first.exportId)).data).toEqual(first.data);
  await expect(readCodexConversationExport(objects, 'task_b', 'do', first.exportId)).rejects.toThrow();
  await expect(readCodexConversationExport(objects, 'task_a', 'merge', first.exportId)).rejects.toThrow();
});

it('AD-13 validates only what a history gained since it was last validated', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const file = `sessions/rollout-2026-09-09T00-00-00-${id}.jsonl`;
  const records = [meta(id), ...Array.from({ length: 200 }, (_, i) => message(i + 1, `turn ${i} 1.5`))];
  const read = (content: Buffer) => async () => ({ file, content });
  expect(await prepareCodexHistory(id, read(jsonl(records)))).toBeUndefined();
  const grown = [...records, message(201, 'next'), message(202, 'next')];
  const parse = vi.spyOn(JSON, 'parse');
  expect(await prepareCodexHistory(id, read(jsonl(grown)))).toBeUndefined();
  expect(parse.mock.calls.length).toBeLessThanOrEqual(2);
  parse.mockRestore();
  // A new tool set still snapshots every record, not just the new ones.
  const snapshot = (await prepareCodexHistory(id, read(jsonl(grown)), { dynamicTools: [{ name: 'new_tool' }] }))!;
  expect(snapshot.content.toString().trim().split('\n').map((line) => JSON.parse(line).ordinal)).toEqual(grown.map((_, i) => i));
  // A prefix that changed underneath is validated again from the start.
  const rewritten = [...grown.slice(0, 100), message(150, 'rewritten'), ...grown.slice(101)];
  await expect(prepareCodexHistory(id, read(jsonl(rewritten)))).rejects.toThrow('unsupported ordinal sequence');
});

it('AD-13 bounds what the validation cache holds by bytes, not only by entries', async () => {
  // Each history leads with a 2 MiB session_meta record, which the cache keeps.
  const history = (id: string, records = 3) => ({
    file: `sessions/rollout-2026-09-09T00-00-00-${id}.jsonl`,
    content: jsonl([{ ...meta(id), payload: { ...meta(id).payload, base_instructions: 'x'.repeat(2 * 1024 * 1024) } },
      ...Array.from({ length: records }, (_, i) => message(i + 1, `turn ${i}`))]),
  });
  const ids = Array.from({ length: 9 }, (_, i) => `4444444${i}-4444-4444-8444-444444444444`);
  for (const id of ids) expect(await prepareCodexHistory(id, async () => history(id))).toBeUndefined();
  // The first one no longer fits beside the eight after it: validated again from its first record.
  const parse = vi.spyOn(JSON, 'parse');
  expect(await prepareCodexHistory(ids[0]!, async () => history(ids[0]!, 4))).toBeUndefined();
  expect(parse.mock.calls.length).toBeGreaterThan(2);
  parse.mockClear();
  // The last one still fits: only its new record is parsed.
  expect(await prepareCodexHistory(ids[8]!, async () => history(ids[8]!, 4))).toBeUndefined();
  expect(parse.mock.calls.length).toBeLessThanOrEqual(2);
  parse.mockRestore();
});
