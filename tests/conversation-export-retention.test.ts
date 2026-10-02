import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import {
  CONVERSATION_EXPORT_RETENTION_MS, backfillConversationExports, conversationExportKey, expireConversationExports,
} from '../src/store/conversation-exports.js';

const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
const stores: Store[] = [];
// The same suite runs on PostgreSQL (production's database) when
// KARMAX_TEST_POSTGRES_URL points at a disposable database.
const postgresUrl = process.env.KARMAX_TEST_POSTGRES_URL;
const admin = postgresUrl ? new Pool({ connectionString: postgresUrl }) : undefined;
const BACKENDS = ['sqlite', ...(postgresUrl ? ['postgres'] : [])];
let backend = 'sqlite';
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => { await admin?.end(); });

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-conversation-exports-')); dirs.push(dir);
  if (backend === 'postgres') await admin!.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const store = (await Store.create(backend === 'postgres' ? postgresUrl! : ':memory:'));
  stores.push(store);
  const project = (await store.createProject('Exports'));
  const task = (await store.createTask({ projectId: project.id, title: 'Exported', workflow: 'software-dev',
    workflowVersion: '1.0.0', params: { prompt: 'x', draft: true } }));
  const root = path.join(dir, 'objects');
  const objects = new LocalObjectStore(root);
  const put = async (exportId: string, bytes: number, at: number, role = 'do') => {
    const key = conversationExportKey(task.id, role, exportId);
    await objects.put(key, Buffer.alloc(bytes, 1));
    (await store.recordConversationExport({ objectKey: key, taskId: task.id, role, exportId, bytes, usedAt: at }));
    return key;
  };
  const exists = (key: string) => fs.existsSync(path.join(root, key));
  return { store, project, task, root, objects, put, exists };
}

for (const name of BACKENDS) describe(`conversation export retention (${name})`, () => {
  it('expires an export a week after its last use and keeps one used since', async () => {
    backend = name;
    const { store, objects, put, exists } = await fixture();
    const now = 100 * DAY;
    const stale = await put('11111111-1111-4111-8111-111111111111', 10, now - CONVERSATION_EXPORT_RETENTION_MS - 1);
    const used = await put('22222222-2222-4222-8222-222222222222', 20, now - CONVERSATION_EXPORT_RETENTION_MS - 1);
    // A later download of the frozen export counts as use.
    (await store.touchConversationExport(used, now - DAY));
    expect(await expireConversationExports(store, objects, now)).toBe(1);
    expect(exists(stale)).toBe(false);
    expect(exists(used)).toBe(true);
    expect((await store.conversationExport(stale))).toBeUndefined();
    expect((await store.conversationExport(used))).toMatchObject({ bytes: 20, usedAt: now - DAY });
  });

  it('re-exporting the same snapshot refreshes it instead of adding a row', async () => {
    backend = name;
    const { store, task, put } = await fixture();
    const key = await put('33333333-3333-4333-8333-333333333333', 5, 1 * DAY);
    await put('33333333-3333-4333-8333-333333333333', 5, 3 * DAY);
    expect((await store.conversationExport(key))).toMatchObject({ taskId: task.id, role: 'do', usedAt: 3 * DAY });
    expect((await store.db.prepare('SELECT COUNT(*) n FROM conversation_exports').get())).toMatchObject({ n: 1 });
  });

  it('expires the exports of a deleted task at once', async () => {
    backend = name;
    const { store, task, objects, put, exists } = await fixture();
    const now = 100 * DAY;
    const key = await put('44444444-4444-4444-8444-444444444444', 7, now);
    (await store.deleteTask(task.id));
    expect(await expireConversationExports(store, objects, now)).toBe(1);
    expect(exists(key)).toBe(false);
  });

  it('deletes exports with their project and lists them among its objects', async () => {
    backend = name;
    const { store, project, put } = await fixture();
    const key = await put('55555555-5555-4555-8555-555555555555', 7, 1);
    expect((await store.projectResources(project.id)).objectKeys).toContain(key);
    (await store.deleteProject(project.id));
    expect((await store.db.prepare('SELECT COUNT(*) n FROM conversation_exports').get())).toMatchObject({ n: 0 });
  });

  it('bounds one sweep', async () => {
    backend = name;
    const { store, objects, put } = await fixture();
    for (let i = 0; i < 5; i++) await put(`66666666-6666-4666-8666-66666666666${i}`, 1, 1);
    expect(await expireConversationExports(store, objects, 100 * DAY, 2)).toBe(2);
    expect(await expireConversationExports(store, objects, 100 * DAY, 2)).toBe(2);
    expect(await expireConversationExports(store, objects, 100 * DAY, 2)).toBe(1);
  });

  it('registers exports written before they were recorded, once, dated by the file', async () => {
    backend = name;
    const { store, task, root, objects } = await fixture();
    const exportId = '77777777-7777-4777-8777-777777777777';
    const key = conversationExportKey(task.id, 'do', exportId);
    fs.mkdirSync(path.dirname(path.join(root, key)), { recursive: true });
    fs.writeFileSync(path.join(root, key), Buffer.alloc(9));
    const mtime = new Date(5 * DAY);
    fs.utimesSync(path.join(root, key), mtime, mtime);
    // Not an export file: ignored.
    fs.writeFileSync(path.join(root, 'conversation-exports', 'stray.txt'), 'x');
    // An export of a task deleted long ago can't be recorded, so it is deleted.
    const orphan = conversationExportKey('task_gone', 'do', exportId);
    fs.mkdirSync(path.dirname(path.join(root, orphan)), { recursive: true });
    fs.writeFileSync(path.join(root, orphan), Buffer.alloc(3));
    expect(await backfillConversationExports(store, objects, root)).toBe(1);
    expect(fs.existsSync(path.join(root, orphan))).toBe(false);
    expect(fs.existsSync(path.join(root, 'conversation-exports', 'stray.txt'))).toBe(true);
    expect((await store.conversationExport(key))).toMatchObject({ taskId: task.id, role: 'do', exportId, bytes: 9, usedAt: 5 * DAY });
    // A second boot does nothing, even for a file it would have recorded.
    fs.rmSync(path.join(root, key));
    (await store.deleteConversationExport(key));
    expect(await backfillConversationExports(store, objects, root)).toBe(0);
  });
});
