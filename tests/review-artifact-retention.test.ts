import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { WorldRegistry } from '../src/world/registry.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { findFreePortFrom } from '../src/util/ports.js';
import type { TaskView } from '../src/domain/types.js';
import { MAX_REVIEW_ARTIFACT_BYTES, preserveReviewArtifacts, savedReviewArtifact } from '../src/store/review-artifacts.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-retention-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = (await Store.create(path.join(root, 'state.sqlite')));
  cleanup.push(async () => (await store.close()));
  const objects = new LocalObjectStore(path.join(root, 'objects'));
  const project = (await store.createProject('Review retention'));
  const task = (await store.createTask({ projectId: project.id, title: 'Report', workflow: 'just-do',
    workflowVersion: '1.0.0', params: { prompt: 'report' } }));
  const worlds = new WorldRegistry();
  const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
  cleanup.push(() => world.destroy());
  const info = { actions: [{ kind: 'open' as const, label: 'Read report', target: 'report.md' }] };
  const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow,
    stage: 'review', status: 'waiting', state: {}, messages: [], actions: [], updatedAt: 1,
    world: world.handle, reviewInfo: info };
  (await store.saveView(task.id, view));
  await world.writeFile('report.md', '# Saved report');
  const core = makeCoreActivities({ store, worlds, objects, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
  const tokens = new TokenAuthority();
  const caps = ['task:read', 'task:review:execute'];
  const token = (await tokens.mint({ taskId: task.id, profileId: 'test', principal: `task:${task.id}`,
    organizationId: project.organizationId, ceiling: caps, grantorCaps: caps })).token;
  const client = { workflow: { getHandle: () => ({ query: async () => (await store.getTask(task.id))?.lastView }) } } as any;
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test' });
  const gateway = (await Gateway.create({ api, store, tokens, client, worlds, objects, taskQueue: 'test',
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
    staticDir: 'web', agentInfo: { provider: 'mock', reason: 'test' } }));
  const server = await gateway.listen(await findFreePortFrom(49_800));
  cleanup.push(() => server.close());
  const request = (url: string, body?: unknown) => fetch(`${server.url}${url}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  return { root, store, objects, task, project, worlds, world, core, info, view, request };
}

describe('durable Review attachments', () => {
  it('serves an uncommitted attachment through the original authenticated link after cleanup and world removal', async () => {
    const f = await fixture();
    const open = await f.request(`/api/tasks/${f.task.id}/review-action`, { index: 0 });
    expect(open.status).toBe(200);
    const { url } = await open.json() as { url: string };
    await f.core.destroyWorld(f.world.handle);
    expect(fs.existsSync(f.world.handle.root)).toBe(false);
    (await f.store.saveView(f.task.id, { ...f.view, stage: 'done', status: 'done', world: undefined }));
    const response = await f.request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toContain('report.md');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(await response.text()).toBe('# Saved report');
    const other = (await f.store.createTask({ projectId: f.project.id, title: 'Other', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'other' } }));
    expect((await f.request(url.replace(f.task.id, other.id))).status).not.toBe(200);
  });

  it('preserves attachments before acknowledging the tool even if the turn then escalates', async () => {
    const f = await fixture();
    const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any, ctx: any) {
      const handlers = platformToolHandlers(input.world, ctx);
      await expect(handlers.create_review_info!({ actions: [
        { kind: 'open', label: 'Missing', target: 'missing.png' },
      ] })).rejects.toThrow();
      await handlers.create_review_info!(f.info);
      expect((await f.store.listPromotedArtifacts(f.task.id))).toHaveLength(1);
      expect((await f.store.getTask(f.task.id))?.lastView?.reviewInfo?.actions).toEqual(f.info.actions);
      // Caption-only updates must not recapture or require an already saved file.
      fs.unlinkSync(path.join(f.world.handle.root, 'report.md'));
      await handlers.create_review_info!({ caption: 'Read the saved report' });
      expect((await f.store.getTask(f.task.id))?.lastView?.reviewInfo?.caption).toBe('Read the saved report');
      throw new Error('escalated');
    } }]]) as any;
    const core = makeCoreActivities({ store: f.store, worlds: f.worlds, objects: f.objects,
      adapters, profiles: new ProfileResolver(f.store, 'mock') });
    await expect(core.runAgentTurn({ taskId: f.task.id, role: 'do', agentTurnId: `${f.task.id}#0`,
      agentSlotGranted: true, worldHandle: f.world.handle, messages: [], task: {
        taskId: f.task.id, projectId: f.project.id, title: 'Report', prompt: 'report', project: {},
        workflow: 'just-do', agents: { do: { provider: 'mock' } },
      } } as any)).rejects.toThrow('escalated');
  });

  it('does not destroy the last copy when durable storage fails', async () => {
    const f = await fixture();
    f.objects.put = async () => { throw new Error('storage offline'); };
    await expect(f.core.destroyWorld(f.world.handle)).rejects.toThrow('storage offline');
    expect(await f.world.readFile('report.md')).toBe('# Saved report');
  });

  it('does not let cleanup from a failed upload delete a concurrent successful retry', async () => {
    const f = await fixture();
    let deleteStarted!: () => void;
    const deleting = new Promise<void>((resolve) => { deleteStarted = resolve; });
    let releaseDelete!: () => void;
    const release = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const originalDelete = f.objects.delete.bind(f.objects);
    vi.spyOn(f.objects, 'put').mockRejectedValueOnce(new Error('first upload failed'));
    vi.spyOn(f.objects, 'delete').mockImplementationOnce(async (key) => {
      deleteStarted();
      await release;
      await originalDelete(key);
    });
    const save = () => preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info);
    const first = save().catch((error) => error);
    await deleting;
    try { await save(); } finally { releaseDelete(); }
    expect((await first).message).toBe('first upload failed');
    const response = await f.request(`/api/tasks/${f.task.id}/artifact?path=report.md`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# Saved report');
  });

  it('keeps both attachments when the agent calls the tool concurrently', async () => {
    const f = await fixture();
    await f.world.writeFile('second.md', 'second');
    const second = { actions: [{ kind: 'open' as const, label: 'Second', target: 'second.md' }] };
    const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any, ctx: any) {
      const handlers = platformToolHandlers(input.world, ctx);
      await Promise.all([handlers.create_review_info!(f.info), handlers.create_review_info!(second)]);
      expect((await f.store.getTask(f.task.id))?.lastView?.reviewInfo?.actions)
        .toEqual([...f.info.actions, ...second.actions]);
      throw new Error('escalated');
    } }]]) as any;
    const core = makeCoreActivities({ store: f.store, worlds: f.worlds, objects: f.objects,
      adapters, profiles: new ProfileResolver(f.store, 'mock') });
    await expect(core.runAgentTurn({ taskId: f.task.id, role: 'do', agentTurnId: `${f.task.id}#0`,
      agentSlotGranted: true, worldHandle: f.world.handle, messages: [], task: {
        taskId: f.task.id, projectId: f.project.id, title: 'Report', prompt: 'report', project: {},
        workflow: 'just-do', agents: { do: { provider: 'mock' } },
      } } as any)).rejects.toThrow('escalated');
  });

  it('deduplicates overlapping successful uploads and deletes only the unused object', async () => {
    const f = await fixture();
    const put = f.objects.put.bind(f.objects);
    const keys: string[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(f.objects, 'put').mockImplementation(async (key, data) => {
      keys.push(key);
      if (keys.length === 2) release();
      await bothStarted;
      await put(key, data);
    });
    const save = () => preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info);
    await Promise.all([save(), save()]);
    const records = (await f.store.listPromotedArtifacts(f.task.id));
    expect(records).toHaveLength(1);
    expect(new Set(keys).size).toBe(2);
    expect((await f.objects.get(records[0]!.objectKey)).toString()).toBe('# Saved report');
    await expect(f.objects.get(keys.find((key) => key !== records[0]!.objectKey)!)).rejects.toThrow();
    expect((await f.store.db.prepare("SELECT * FROM usage_events WHERE taskId=? AND kind='resource.storage'")
      .all(f.task.id))).toHaveLength(1);
  });

  it('does not resurrect an artifact when the task is deleted during its upload', async () => {
    const f = await fixture();
    const put = f.objects.put.bind(f.objects);
    let uploaded!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { uploaded = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    let uploadedKey = '';
    vi.spyOn(f.objects, 'put').mockImplementation(async (key, data) => {
      uploadedKey = key;
      await put(key, data);
      uploaded();
      await released;
    });
    const saving = preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info);
    const rejected = expect(saving).rejects.toThrow('deleted during upload');
    await started;
    (await f.store.deleteTask(f.task.id));
    release();
    await rejected;
    expect((await f.store.listPromotedArtifacts(f.task.id))).toHaveLength(0);
    expect((await f.store.kvGet(`review-artifacts:${f.task.id}`))).toBeUndefined();
    await expect(f.objects.get(uploadedKey)).rejects.toThrow();
  });

  it('loads saved links and bytes from fresh database and object-store instances', async () => {
    const f = await fixture();
    await preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info);
    await f.world.destroy();
    const reopened = (await Store.create(path.join(f.root, 'state.sqlite')));
    cleanup.push(async () => (await reopened.close()));
    const objects = new LocalObjectStore(path.join(f.root, 'objects'));
    const saved = (await savedReviewArtifact(reopened, f.task.id, 'report.md'))!;
    expect((await objects.get(saved.objectKey)).toString()).toBe('# Saved report');
  });

  it('deduplicates retries and preserves the reviewed bytes when the workspace later changes', async () => {
    const f = await fixture();
    const save = () => preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info);
    await save(); await save();
    expect((await f.store.listPromotedArtifacts(f.task.id))).toHaveLength(1);
    await f.world.writeFile('report.md', 'unreviewed changes');
    await f.core.destroyWorld(f.world.handle);
    const response = await f.request(`/api/tasks/${f.task.id}/artifact?path=report.md`);
    expect(await response.text()).toBe('# Saved report');
    // Teardown retries do not reopen a destroyed world to save it again.
    await f.core.destroyWorld(f.world.handle);
  });

  it('allows explicit replacement and fails closed if the stored bytes are corrupt', async () => {
    const f = await fixture();
    const save = () => preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info);
    await save();
    await f.world.writeFile('report.md', 'revised report');
    await save();
    const saved = (await savedReviewArtifact(f.store, f.task.id, 'report.md'))!;
    expect((await f.objects.get(saved.objectKey)).toString()).toBe('revised report');
    await f.objects.put(saved.objectKey, Buffer.from('corrupted'));
    const response = await f.request(`/api/tasks/${f.task.id}/artifact?path=report.md`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('integrity');
  });

  it('rejects oversized files before reading them or deleting the workspace', async () => {
    const f = await fixture();
    fs.truncateSync(path.join(f.world.handle.root, 'report.md'), MAX_REVIEW_ARTIFACT_BYTES + 1);
    const read = vi.spyOn(f.world, 'readFileBuffer');
    await expect(preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info))
      .rejects.toThrow('100 MiB');
    expect(read).not.toHaveBeenCalled();
    await expect(f.core.destroyWorld(f.world.handle)).rejects.toThrow('100 MiB');
    expect(fs.existsSync(f.world.handle.root)).toBe(true);
  });

  it('accepts a file exactly at the 100 MiB boundary', async () => {
    const f = await fixture();
    fs.truncateSync(path.join(f.world.handle.root, 'report.md'), MAX_REVIEW_ARTIFACT_BYTES);
    await preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info);
    expect((await savedReviewArtifact(f.store, f.task.id, 'report.md'))?.bytes).toBe(MAX_REVIEW_ARTIFACT_BYTES);
  });

  it('enforces managed quotas and releases upload reservations on failure', async () => {
    const f = await fixture();
    (await f.store.saveStorageLocation({ id: 'managed-test', organizationId: f.project.organizationId!,
      name: 'Managed', kind: 'managed', config: {}, isDefault: true, status: 'ready',
      quotaBytes: 1, createdAt: Date.now(), updatedAt: Date.now() }));
    await expect(preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info))
      .rejects.toThrow('quota');
    expect((await f.store.listPromotedArtifacts(f.task.id))).toHaveLength(0);
    (await f.store.saveStorageLocation({ ...(await f.store.getStorageLocation('managed-test'))!, quotaBytes: 1024 }));
    f.objects.put = async () => { throw new Error('offline'); };
    await expect(preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info)).rejects.toThrow('offline');
    expect((await f.store.db.prepare('SELECT * FROM storage_upload_reservations').all())).toHaveLength(0);
    expect((await savedReviewArtifact(f.store, f.task.id, 'report.md'))).toBeUndefined();
  });

  it('confines relative paths, absolute paths and symlinks to the world', async () => {
    const f = await fixture();
    const outside = path.join(os.tmpdir(), `outside-${f.task.id}.txt`);
    fs.writeFileSync(outside, 'outside');
    cleanup.push(() => fs.rmSync(outside, { force: true }));
    fs.symlinkSync(outside, path.join(f.world.handle.root, 'escape.txt'));
    for (const target of ['../outside.txt', outside, 'escape.txt', `${f.world.handle.root}/../outside.txt`]) {
      await expect(preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id,
        { actions: [{ kind: 'open', label: 'escape', target }] })).rejects.toThrow(/escape|relative/);
    }
    const target = path.join(f.world.handle.root, 'report.md');
    await preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id,
      { actions: [{ kind: 'open', label: 'absolute', target }] });
    expect((await savedReviewArtifact(f.store, f.task.id, target))).toBeDefined();
  });

  it('leaves external URLs and run actions alone and removes indexes on task deletion', async () => {
    const f = await fixture();
    const put = vi.spyOn(f.objects, 'put');
    await preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, { actions: [
      { kind: 'open', label: 'website', target: 'https://example.com/report' },
      { kind: 'run', label: 'demo', command: 'echo demo' },
    ] });
    expect(put).not.toHaveBeenCalled();
    await preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info);
    (await f.store.deleteTask(f.task.id));
    expect((await f.store.kvGet(`review-artifacts:${f.task.id}`))).toBeUndefined();
  });

  it('resolves targets from the agent working directory inside a multi-checkout world', async () => {
    const f = await fixture();
    f.world.handle.workdir = path.join(f.world.handle.root, 'checkout');
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    await f.world.writeFileBuffer!('checkout/logo.png', bytes);
    await preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id,
      { actions: [{ kind: 'open', label: 'Logo', target: 'logo.png' }] });
    await f.world.destroy();
    (await f.store.saveView(f.task.id, { ...f.view, stage: 'done', status: 'done', world: undefined }));
    const response = await f.request(`/api/tasks/${f.task.id}/artifact?path=logo.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
});
