import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCoreActivities } from '../src/activities/core.js';
import type { TurnInput } from '../src/agent/types.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';

describe('agent project-secret delivery', () => {
  it('resolves attachment and service handles JIT into the dedicated turn channel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-agent-secret-env-'));
    const previousHome = process.env.KARMAX_HOME;
    const previousMemoryFloor = process.env.KARMAX_AGENT_MIN_FREE_MB;
    const previousLoadFactor = process.env.KARMAX_AGENT_MAX_LOAD_FACTOR;
    process.env.KARMAX_HOME = dir;
    process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
    process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
    const store = new Store(':memory:');
    const project = store.createProject('Secret agent');
    const task = store.createTask({ projectId: project.id, title: 'Use the service', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } });
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const worlds = new WorldRegistry();
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const credential = 'resource:test:agent-token';
    broker.registerHandle(credential, 'secret-project-token');
    store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Agent token', driver: 'secret@1', target: { kind: 'environment', name: 'PROJECT_TOKEN' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [credential], publish: 'discard' });

    let received: TurnInput | undefined;
    const adapter = {
      provider: 'mock' as const,
      async runTurn(input: TurnInput) {
        received = input;
        return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'done' };
      },
    };
    const core = makeCoreActivities({ store, worlds, resources, broker,
      adapters: new Map([['mock', adapter]]), profiles: new ProfileResolver(store, 'mock') });
    let handle = await core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
    const serviceHandle = resources.registerServiceEnvironment(handle, { DATABASE_URL: 'postgres://task-service' });
    handle = store.updateWorldMeta(handle, {
      serviceEnvironmentHandles: serviceHandle.meta?.serviceEnvironmentHandles,
    });
    try {
      await core.runAgentTurn({
        taskId: task.id,
        role: 'do',
        worldHandle: handle,
        messages: [{ id: 'm1', role: 'user', text: 'work', ts: 0 }],
        task: { projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'software-dev' } as any,
      });
      expect(received?.secretEnv).toEqual({
        DATABASE_URL: 'postgres://task-service',
        PROJECT_TOKEN: 'secret-project-token',
      });
      expect(JSON.stringify(store.currentWorld(task.id))).not.toContain('postgres://task-service');
      expect(JSON.stringify(store.currentWorld(task.id))).not.toContain('secret-project-token');
    } finally {
      await core.destroyWorld(handle);
      await resources.deleteProject(project.id);
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      restoreEnv('KARMAX_HOME', previousHome);
      restoreEnv('KARMAX_AGENT_MIN_FREE_MB', previousMemoryFloor);
      restoreEnv('KARMAX_AGENT_MAX_LOAD_FACTOR', previousLoadFactor);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
