import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { startDevServer } from '../src/temporal/dev-server.js';
import { makeClient } from '../src/temporal/client.js';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { WorldCheckpointService } from '../src/world/checkpoint.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ensureIdentity, gitOrThrow } from '../src/world/git.js';
import type { TaskView } from '../src/domain/types.js';

it('delivers follow-ups during real streamed checkpoint capture without parking or losing resource data', async () => {
  const server = await startDevServer({ headless: true, logLevel: 'never' });
  const native = await NativeConnection.connect({ address: server.address });
  const { client, close } = await makeClient({ address: server.address, namespace: server.namespace });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-followup-'));
  const store = await Store.create(':memory:');
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  await gitOrThrow(repo, ['init', '-q', '-b', 'main']); await ensureIdentity(repo);
  await gitOrThrow(repo, ['commit', '--allow-empty', '-qm', 'base']);
  const worlds = new WorldRegistry();
  const provider = new WorktreeProvider(path.join(dir, 'worlds'));
  Object.assign(provider, { parkable: true });
  worlds.register(provider);
  const park = vi.spyOn(worlds, 'park').mockImplementation(async handle => handle);
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
  const checkpoints = new WorldCheckpointService(store, worlds, objects, broker, undefined, resources);
  const core = makeCoreActivities({ store, worlds, adapters: new Map(), profiles: new ProfileResolver(store, 'mock'), checkpoints });
  const worker = await Worker.create({ connection: native, namespace: server.namespace, taskQueue: 'checkpoint-followup',
    workflowsPath: fileURLToPath(new URL('./fixtures/checkpoint-followup.ts', import.meta.url)), activities: core,
    maxCachedWorkflows: 2, maxConcurrentWorkflowTaskExecutions: 2, maxConcurrentActivityTaskExecutions: 2 });
  const running = worker.run();
  try {
    for (const separate of [false, true]) {
      const project = await store.createProject(`Checkpoint follow-up ${separate}`, { repos: [repo] });
      const task = await store.createTask({ projectId: project.id, title: 'Waiting for a code', workflow: 'software-dev',
        workflowVersion: '1.26.0', params: { prompt: 'work' } });
      const world = await worlds.create('worktree', { taskId: task.id, repos: [repo], base: 'main' });
      world.handle.meta = { projectId: project.id };
      const volume = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
        name: `Data ${separate}`, driver: 'volume@1', target: { kind: 'path', path: `data-${separate}` }, access: 'write',
        isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
      const original = await resources.importFiles(volume.id, [{ path: 'large.bin', data: Buffer.from('original') }]);
      await resources.materialize(project.id, task.id, world, 1);
      world.handle = await store.registerWorld(world.handle, project.id) as typeof world.handle;
      const bytes = Buffer.alloc(17 * 1024 * 1024, 7);
      await world.writeFileBuffer!(`data-${separate}/large.bin`, bytes);
      const open = vi.spyOn(worlds, 'open').mockResolvedValue(world);
      let reads = 0;
      let entered!: () => void, release!: () => void;
      const atChunk = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const stream = world.readFileStream!.bind(world);
      const commands = vi.spyOn(world, 'readFileStream').mockImplementation(async function* (name: string) {
        reads++; entered(); await gate;
        yield* stream(name);
      });
      const view = { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'waiting',
        waitingFor: { kind: 'human', audience: ['@creator'] }, messages: [], actions: [], updatedAt: 1,
        state: {}, world: world.handle } as TaskView;
      try {
        const handle = await client.workflow.start('checkpointFollowUp', { workflowId: task.id, taskQueue: 'checkpoint-followup',
          args: [view, separate] });
        await Promise.race([atChunk, handle.result().then(() => { throw new Error('workflow completed before capture'); })]);
        const message = { id: 'reply', role: 'user' as const, text: 'Continue', ts: Date.now() };
        await handle.signal('followUp', message);
        await store.appendEvent({ taskId: task.id, type: 'conversation.message', ts: message.ts, payload: { role: 'do', message } });
        release();
        expect(await handle.result()).toEqual([message]);
        expect(reads).toBe(1);
        expect(park).not.toHaveBeenCalled();
        expect((await store.currentWorld(task.id) as any).checkpointId).toBeUndefined();
        expect((await world.readFileBuffer(`data-${separate}/large.bin`)).equals(bytes)).toBe(true);
        expect((await store.getResourceAttachment(volume.id))?.currentRevisionId).toBe(original.id);
        expect(await store.eventsOfType(task.id, 'checkpoint.warning')).toHaveLength(0);
      } finally { release(); commands.mockRestore(); open.mockRestore(); }
    }
  } finally {
    worker.shutdown(); await running;
    await close(); await native.close(); await server.stop(); await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
