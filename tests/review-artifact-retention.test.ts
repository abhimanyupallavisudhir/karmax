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
  const store = new Store(':memory:');
  cleanup.push(() => store.close());
  const objects = new LocalObjectStore(path.join(root, 'objects'));
  const project = store.createProject('Review retention');
  const task = store.createTask({ projectId: project.id, title: 'Report', workflow: 'just-do',
    workflowVersion: '1.0.0', params: { prompt: 'report' } });
  const worlds = new WorldRegistry();
  const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
  cleanup.push(() => world.destroy());
  const info = { actions: [{ kind: 'open' as const, label: 'Read report', target: 'report.md' }] };
  const view: TaskView = { taskId: task.id, title: task.title, workflow: task.workflow,
    stage: 'review', status: 'waiting', state: {}, messages: [], actions: [], updatedAt: 1,
    world: world.handle, reviewInfo: info };
  store.saveView(task.id, view);
  await world.writeFile('report.md', '# Saved report');
  const core = makeCoreActivities({ store, worlds, objects, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
  const tokens = new TokenAuthority();
  const caps = ['task:read', 'task:review:execute'];
  const token = tokens.mint({ taskId: task.id, profileId: 'test', principal: `task:${task.id}`,
    organizationId: project.organizationId, ceiling: caps, grantorCaps: caps }).token;
  const client = { workflow: { getHandle: () => ({ query: async () => store.getTask(task.id)?.lastView }) } } as any;
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test' });
  const gateway = new Gateway({ api, store, tokens, client, worlds, objects, taskQueue: 'test',
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
    staticDir: 'web', agentInfo: { provider: 'mock', reason: 'test' } });
  const server = await gateway.listen(await findFreePortFrom(49_800));
  cleanup.push(() => server.close());
  const request = (url: string, body?: unknown) => fetch(`${server.url}${url}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  return { store, objects, task, project, worlds, world, core, info, view, request };
}

describe('durable Review attachments', () => {
  it('serves an uncommitted attachment through the original authenticated link after cleanup and world removal', async () => {
    const f = await fixture();
    const open = await f.request(`/api/tasks/${f.task.id}/review-action`, { index: 0 });
    expect(open.status).toBe(200);
    const { url } = await open.json() as { url: string };
    await f.core.destroyWorld(f.world.handle);
    expect(fs.existsSync(f.world.handle.root)).toBe(false);
    f.store.saveView(f.task.id, { ...f.view, stage: 'done', status: 'done', world: undefined });
    const response = await f.request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toContain('report.md');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(await response.text()).toBe('# Saved report');
    const other = f.store.createTask({ projectId: f.project.id, title: 'Other', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'other' } });
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
      expect(f.store.listPromotedArtifacts(f.task.id)).toHaveLength(1);
      expect(f.store.getTask(f.task.id)?.lastView?.reviewInfo?.actions).toEqual(f.info.actions);
      // Caption-only updates must not recapture or require an already saved file.
      fs.unlinkSync(path.join(f.world.handle.root, 'report.md'));
      await handlers.create_review_info!({ caption: 'Read the saved report' });
      expect(f.store.getTask(f.task.id)?.lastView?.reviewInfo?.caption).toBe('Read the saved report');
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

  it('deduplicates retries and preserves the reviewed bytes when the workspace later changes', async () => {
    const f = await fixture();
    const save = () => preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info);
    await save(); await save();
    expect(f.store.listPromotedArtifacts(f.task.id)).toHaveLength(1);
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
    const saved = savedReviewArtifact(f.store, f.task.id, 'report.md')!;
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

  it('enforces managed quotas and releases upload reservations on failure', async () => {
    const f = await fixture();
    f.store.saveStorageLocation({ id: 'managed-test', organizationId: f.project.organizationId!,
      name: 'Managed', kind: 'managed', config: {}, isDefault: true, status: 'ready',
      quotaBytes: 1, createdAt: Date.now(), updatedAt: Date.now() });
    await expect(preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info))
      .rejects.toThrow('quota');
    expect(f.store.listPromotedArtifacts(f.task.id)).toHaveLength(0);
    f.store.saveStorageLocation({ ...f.store.getStorageLocation('managed-test')!, quotaBytes: 1024 });
    f.objects.put = async () => { throw new Error('offline'); };
    await expect(preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id, f.info)).rejects.toThrow('offline');
    expect(f.store.db.prepare('SELECT * FROM storage_upload_reservations').all()).toHaveLength(0);
    expect(savedReviewArtifact(f.store, f.task.id, 'report.md')).toBeUndefined();
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
    expect(savedReviewArtifact(f.store, f.task.id, target)).toBeDefined();
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
    f.store.deleteTask(f.task.id);
    expect(f.store.kvGet(`review-artifacts:${f.task.id}`)).toBeUndefined();
  });

  it('resolves targets from the agent working directory inside a multi-checkout world', async () => {
    const f = await fixture();
    f.world.handle.workdir = path.join(f.world.handle.root, 'checkout');
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    await f.world.writeFileBuffer!('checkout/logo.png', bytes);
    await preserveReviewArtifacts(f.store, f.objects, f.world, f.task.id,
      { actions: [{ kind: 'open', label: 'Logo', target: 'logo.png' }] });
    await f.world.destroy();
    f.store.saveView(f.task.id, { ...f.view, stage: 'done', status: 'done', world: undefined });
    const response = await f.request(`/api/tasks/${f.task.id}/artifact?path=logo.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
});
