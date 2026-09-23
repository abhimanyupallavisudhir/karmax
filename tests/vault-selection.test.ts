import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { VAULT_USAGE_HALF_LIFE_MS as month } from '../src/util/vault-usage.js';

const at = 1_800_000_000_000;
const auth = (...ids: string[]) => ({ capabilities: ids.map(id => `use-credential:item:${id}`) });

describe('saved credential selection history', () => {
  let store: Store;
  let projectId: string;
  const create = (ids: string[], intentId?: string) => store.createTask({ projectId, intentId,
    title: 'Selection test', workflow: 'software-dev', workflowVersion: '1',
    params: { prompt: '', draft: true, _authorization: auth(...ids) } });
  const history = () => store.vaultSelectionHistory('org_personal', Date.now());
  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(at);
    store = await Store.create(':memory:');
    projectId = (await store.createProject('Selections')).id;
  });
  afterEach(async () => { await store.close(); vi.restoreAllMocks(); });

  it('records new grants once, leaving draft autosaves, policy edits and unrelated updates neutral', async () => {
    const task = await create(['a', 'a']);
    vi.mocked(Date.now).mockReturnValue(at + month);
    await Promise.all([
      store.patchTaskParams(task.id, { _authorization: { ...auth('a'), credentialPolicies: { a: { use: 'ask' } } } }),
      store.patchTaskParams(task.id, { _authorization: auth('a') }),
    ]);
    await store.patchTaskParams(task.id, { prompt: 'edited', _authorization: undefined });
    await store.updateTaskParams(task.id, (await store.getTask(task.id))!.params);
    expect((await history()).a).toMatchObject({ selectionCount: 1, selectionFrecencyScore: 0.5, lastSelectedAt: at });
    await store.patchTaskParams(task.id, { _authorization: auth('a', 'b') });
    expect((await history()).b).toMatchObject({ selectionCount: 1, selectionFrecencyScore: 1, lastSelectedAt: at + month });
    expect((await history()).a!.selectionFrecencyScore).toBe(0.5);
    expect((await store.getTask(task.id))!.params.prompt).toBe('edited');
  });

  it('preserves selection history on removal and refreshes recency without inflating count on re-add', async () => {
    const task = await create(['a']);
    await store.updateTaskParams(task.id, { prompt: '', _authorization: auth() });
    expect((await history()).a!.selectionCount).toBe(1);
    vi.mocked(Date.now).mockReturnValue(at + month);
    await store.updateTaskParams(task.id, { prompt: '', _authorization: auth('a') });
    expect((await history()).a).toMatchObject({ selectionCount: 1, selectionFrecencyScore: 1, lastSelectedAt: at + month });
  });

  it('counts independent tasks but deduplicates attempts and preserves timestamps across retries', async () => {
    const task = await create(['a']);
    vi.mocked(Date.now).mockReturnValue(at + month);
    const alternate = await create(['a'], task.id);
    expect((await history()).a).toMatchObject({ selectionCount: 1, selectionFrecencyScore: 0.5, lastSelectedAt: at });
    await store.patchTaskParams(alternate.id, { _authorization: auth('a', 'b') });
    vi.mocked(Date.now).mockReturnValue(at + 2 * month);
    await create(['a', 'b'], task.id);
    expect((await history()).b).toMatchObject({ selectionCount: 1, selectionFrecencyScore: 0.5, lastSelectedAt: at + month });
    await create(['a']);
    expect((await history()).a).toMatchObject({ selectionCount: 2, selectionFrecencyScore: 1.25 });
  });

  it('backfills legacy grants from creation time and only timestamps newly added grants', async () => {
    const task = await create(['a']);
    await store.db.prepare('UPDATE tasks SET credentialSelections = NULL WHERE id = ?').run(task.id);
    vi.mocked(Date.now).mockReturnValue(at + month);
    await store.setTaskArchived(task.id, true);
    expect((await history()).a).toMatchObject({ selectionCount: 1, selectionFrecencyScore: 0.5, lastSelectedAt: at });
    await store.patchTaskParams(task.id, { _authorization: auth('a', 'b') });
    expect((await history()).a!.lastSelectedAt).toBe(at);
    expect((await history()).b!.lastSelectedAt).toBe(at + month);
  });

  it('does not rejuvenate legacy attempts when their authorization is autosaved', async () => {
    const task = await create(['a']);
    vi.mocked(Date.now).mockReturnValue(at + month);
    const retry = await create(['a'], task.id);
    await store.db.prepare('UPDATE tasks SET credentialSelections = NULL').run();
    await store.patchTaskParams(retry.id, { _authorization: auth('a') });
    expect((await history()).a).toMatchObject({ selectionCount: 1, selectionFrecencyScore: 0.5, lastSelectedAt: at });
  });

  it('includes every page of task history', async () => {
    for (let i = 0; i < 501; i++) await create(['a']);
    expect((await history()).a).toMatchObject({ selectionCount: 501, selectionFrecencyScore: 501 });
  });

  it('keeps organizations isolated and ignores wildcard/domain grants and agent accesses', async () => {
    await create(['a', '*', 'a:password']);
    const other = await store.createOrganization({ name: 'Other' });
    const otherProject = await store.createProject('Other project', {}, other.id);
    await store.createTask({ projectId: otherProject.id, title: 'Other task', workflow: 'software-dev', workflowVersion: '1',
      params: { prompt: '', _authorization: auth('b') } });
    await store.appendAudit({ principalId: 'system', action: 'vault.used', detail: { itemId: 'b' } });
    expect(Object.keys(await history())).toEqual(['a']);
    expect(Object.keys(await store.vaultSelectionHistory(other.id, at))).toEqual(['b']);
  });

  it('rolls back grant timestamps with a rejected task write', async () => {
    const task = await create(['a']);
    await expect(store.transaction(async () => {
      await store.patchTaskParams(task.id, { _authorization: auth('a', 'b') });
      throw new Error('aborted');
    })).rejects.toThrow('aborted');
    expect(Object.keys(await history())).toEqual(['a']);
  });
});
