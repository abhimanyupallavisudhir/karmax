import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { MemoryWorldProvider } from '../src/world/memory.js';
import { ProjectResourceService } from '../src/world/resources.js';

function task(store: Store, projectId: string, title = 'Task') {
  return store.createTask({
    projectId, title, workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'test' },
  });
}

describe('project resources', () => {
  it('encrypts uploads, injects secrets just in time, and pins immutable revisions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resources-'));
    const store = new Store(':memory:');
    try {
      const objects = new LocalObjectStore(path.join(dir, 'objects'));
      const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
      const service = new ProjectResourceService(store, objects, broker);
      const project = store.createProject('Resources');
      const firstTask = task(store, project.id, 'First');
      service.create(project.id, {
        name: 'API token',
        spec: { kind: 'secret', inject: { env: 'API_TOKEN', path: '.private/token' } },
        value: 'not-in-metadata',
      });
      const file = service.create(project.id, {
        name: 'Local config',
        spec: { kind: 'file', inject: { path: 'config/local.json' } },
      });
      const firstRevision = await service.upload(file.id, Buffer.from('{"revision":1}'), 'application/json');
      const rawObject = await objects.get(store.getProjectResourceRevision(firstRevision.id)!.objectKey);
      expect(rawObject.subarray(0, 4).toString()).toBe('KXR1');
      expect(rawObject.toString()).not.toContain('revision');

      const provider = new MemoryWorldProvider();
      const firstWorld = await provider.create({ taskId: firstTask.id, base: 'main' });
      await service.materialize(firstTask.id, project.id, firstWorld);
      expect(await firstWorld.readFile('config/local.json')).toBe('{"revision":1}');
      expect(await firstWorld.readFile('.private/token')).toBe('not-in-metadata');
      expect(service.environment(firstTask.id, firstWorld, project.id)).toEqual({ API_TOKEN: 'not-in-metadata' });
      expect(JSON.stringify(service.list(project.id))).not.toContain('not-in-metadata');

      await service.upload(file.id, Buffer.from('{"revision":2}'), 'application/json');
      await service.materialize(firstTask.id, project.id, firstWorld);
      expect(await firstWorld.readFile('config/local.json')).toBe('{"revision":1}');
      const secondTask = task(store, project.id, 'Second');
      const secondWorld = await provider.create({ taskId: secondTask.id, base: 'main' });
      await service.materialize(secondTask.id, project.id, secondWorld);
      expect(await secondWorld.readFile('config/local.json')).toBe('{"revision":2}');

      await firstWorld.destroy();
      await secondWorld.destroy();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('freezes an empty resource selection and supports task-local SQLite URLs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-resource-snapshot-'));
    const store = new Store(':memory:');
    try {
      const service = new ProjectResourceService(
        store,
        new LocalObjectStore(path.join(dir, 'objects')),
        new CredentialBroker(new Vault(path.join(dir, 'vault'))),
      );
      const project = store.createProject('Snapshot');
      const earlyTask = task(store, project.id, 'Before resources');
      expect(service.pins(earlyTask.id, project.id)).toEqual([]);
      service.create(project.id, {
        name: 'Database',
        spec: { kind: 'database', driver: 'sqlite', path: '.data/dev.sqlite', env: 'DATABASE_URL' },
      });
      expect(service.pins(earlyTask.id, project.id)).toEqual([]);

      const laterTask = task(store, project.id, 'After resources');
      const world = await new MemoryWorldProvider().create({ taskId: laterTask.id, base: 'main' });
      await service.materialize(laterTask.id, project.id, world);
      expect(service.environment(laterTask.id, world, project.id).DATABASE_URL)
        .toBe(`sqlite:${path.join(world.handle.root, '.data/dev.sqlite')}`);
      expect(await world.readFileBuffer('.data/dev.sqlite')).toHaveLength(0);
      await world.destroy();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
