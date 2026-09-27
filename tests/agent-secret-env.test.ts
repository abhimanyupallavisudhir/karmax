import { VaultItems } from '../src/autonomy/vault-items.js';
import { describe, expect, it, vi } from 'vitest';
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
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Secret agent'));
    const task = (await store.createTask({ projectId: project.id, title: 'Use the service', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const worlds = new WorldRegistry();
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    const credential = 'resource:test:agent-token';
    (await broker.registerHandle(credential, 'secret-project-token'));
    const initial = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Agent token', driver: 'secret@1', target: { kind: 'environment', name: 'PROJECT_TOKEN' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [credential], publish: 'discard' }));

    let received: TurnInput | undefined;
    const adapter = {
      provider: 'mock' as const,
      async runTurn(input: TurnInput, _ctx?: any) {
        received = input;
        return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'done' };
      },
    };
    const core = makeCoreActivities({ store, worlds, resources, broker,
      adapters: new Map([['mock', adapter]]), profiles: new ProfileResolver(store, 'mock') });
    let handle = await core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
    const serviceHandle = await resources.registerServiceEnvironment(handle, { DATABASE_URL: 'postgres://task-service' });
    handle = (await store.updateWorldMeta(handle, {
      serviceEnvironmentHandles: serviceHandle.meta?.serviceEnvironmentHandles,
    }));
    try {
      await broker.registerHandle('leased:model-key', 'leased-secret');
      await core.runAgentTurn({
        taskId: task.id,
        accountApiKeyHandle: 'leased:model-key',
        role: 'do',
        worldHandle: handle,
        messages: [{ id: 'm1', role: 'user', text: 'work', ts: 0 }],
        task: { projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'software-dev' } as any,
      });
      expect(received?.resolvedAuth?.apiKey).toBe('leased-secret');
      expect(received?.secretEnv).toEqual({
        DATABASE_URL: 'postgres://task-service',
        PROJECT_TOKEN: 'secret-project-token',
      });
      expect(received?.extraEnv ?? {}).not.toHaveProperty('PROJECT_TOKEN');
      const vaultEnvironment = vi.spyOn(VaultItems.prototype, 'envFor').mockResolvedValue({ ANTHROPIC_API_KEY: 'granted-app-key' });
      try {
        await core.runAgentTurn({ taskId: task.id, role: 'do', worldHandle: handle, messages: [],
          task: { projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'software-dev' } as any });
        expect(received?.secretEnv?.ANTHROPIC_API_KEY).toBe('granted-app-key');
        expect(received?.extraEnv ?? {}).not.toHaveProperty('ANTHROPIC_API_KEY');
        const localWorld = await worlds.open(handle);
        const open = vi.spyOn(worlds, 'open').mockResolvedValue(localWorld);
        try {
          await core.runAgentTurn({ taskId: task.id, role: 'do', worldHandle: { ...handle, kind: 'e2b' }, messages: [],
            task: { projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'software-dev' } as any });
          expect(received?.secretEnv?.ANTHROPIC_API_KEY).toBe('granted-app-key');
        } finally { open.mockRestore(); }

      } finally { vaultEnvironment.mockRestore(); }
      // A resumed turn opens the same world, without materializing its files again.
      const lateHandle = 'resource:test:late-token';
      (await broker.registerHandle(lateHandle, 'late-project-token'));
      const late = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
        name: 'Late token', driver: 'secret@1', target: { kind: 'environment', name: 'LATE_TOKEN' },
        access: 'read', isolation: 'fork', source: {}, credentialHandles: [lateHandle], publish: 'discard' }));
      const resume = () => core.runAgentTurn({ taskId: task.id, role: 'do', worldHandle: handle,
        messages: [{ id: 'm2', role: 'user', text: 'continue', ts: 1 }],
        task: { projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'software-dev' } as any });
      await resume();
      expect(received?.secretEnv?.LATE_TOKEN).toBe('late-project-token');
      const leases = (await store.listResourceLeases(handle.id, handle.generation));
      expect(leases.filter((lease) => lease.attachmentId === late.id && lease.state === 'active')).toHaveLength(1);
      await resume();
      expect((await store.listResourceLeases(handle.id, handle.generation))).toEqual(leases);
      (await store.updateResourceAttachment(initial.id, { enabled: false }));
      (await broker.registerHandle(lateHandle, 'rotated-project-token'));
      await resume();
      expect(received?.secretEnv).toEqual({ DATABASE_URL: 'postgres://task-service', LATE_TOKEN: 'rotated-project-token' });
      (await store.updateResourceLease(leases.find((lease) => lease.attachmentId === late.id)!.id, 'released'));
      await resume();
      expect(received?.secretEnv).toEqual({ DATABASE_URL: 'postgres://task-service' });
      // A secret added while the agent is already running reaches that same turn.
      const midHandle = 'resource:test:mid-turn-token';
      (await broker.registerHandle(midHandle, 'mid-turn-token'));
      let midTurn: Record<string, string> | undefined;
      let midTurnWorld: TurnInput['world'] | undefined;
      adapter.runTurn = async (input: TurnInput, ctx?: any) => {
        received = input;
        const changed = new Promise<void>((resolve) => ctx.onSecretEnvChange(resolve));
        for (const target of [{ kind: 'environment', name: 'MID_TURN_TOKEN' }, { kind: 'path', path: '.mid-turn-key' }] as const)
          (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
            name: target.kind, driver: 'secret@1', target, access: 'read', isolation: 'fork', source: {},
            credentialHandles: [midHandle], publish: 'discard' }));
        await changed;
        midTurn = { ...input.secretEnv };
        midTurnWorld = input.world;
        return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'done' };
      };
      await resume();
      expect(midTurn).toEqual({ DATABASE_URL: 'postgres://task-service', MID_TURN_TOKEN: 'mid-turn-token' });
      expect(await midTurnWorld!.readFile('.mid-turn-key')).toBe('mid-turn-token');
      expect(JSON.stringify((await store.currentWorld(task.id)))).not.toContain('mid-turn-token');
      expect(JSON.stringify((await store.currentWorld(task.id)))).not.toContain('late-project-token');
      expect(JSON.stringify((await store.currentWorld(task.id)))).not.toContain('postgres://task-service');
      expect(JSON.stringify((await store.currentWorld(task.id)))).not.toContain('secret-project-token');
    } finally {
      await core.destroyWorld(handle);
      await resources.deleteProject(project.id);
      (await store.close());
      fs.rmSync(dir, { recursive: true, force: true });
      restoreEnv('KARMAX_HOME', previousHome);
      restoreEnv('KARMAX_AGENT_MIN_FREE_MB', previousMemoryFloor);
      restoreEnv('KARMAX_AGENT_MAX_LOAD_FACTOR', previousLoadFactor);
    }
  });
});

/**
 * RT-12: the agent can print any value it was handed — `env`, `cat .env`,
 * `echo $KARMAX_TOKEN` — and its live output, activity items and final answer
 * are archived in the event log and task view. Values karmax itself delivered
 * to the turn are scrubbed wherever they would be archived.
 */
describe('agent output archiving', () => {
  it('scrubs the turn’s own secrets from output, activity and the final answer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-agent-scrub-'));
    const previous = { home: process.env.KARMAX_HOME, floor: process.env.KARMAX_AGENT_MIN_FREE_MB, load: process.env.KARMAX_AGENT_MAX_LOAD_FACTOR };
    process.env.KARMAX_HOME = dir;
    process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
    process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Scrub'));
    const task = (await store.createTask({ projectId: project.id, title: 'Print env', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const worlds = new WorldRegistry();
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    (await broker.registerHandle('resource:test:db', 'postgres://admin:hunter2-db-pass@db.internal/app'));
    (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'Database', driver: 'secret@1', target: { kind: 'environment', name: 'DATABASE_URL' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: ['resource:test:db'], publish: 'discard' }));
    const { TokenAuthority } = await import('../src/platform/tokens.js');
    const tokens = new TokenAuthority(store);
    let karmaxToken = '';
    const adapter = { provider: 'mock' as const, async runTurn(input: TurnInput, ctx: any) {
      karmaxToken = input.extraEnv?.KARMAX_TOKEN ?? '';
      const leaked = `DATABASE_URL=${input.secretEnv?.DATABASE_URL}\n${karmaxToken}`;
      ctx.emit(`$ env\n${leaked}`);
      await ctx.emitActivity({ id: 'cmd-1', kind: 'command', phase: 'completed', title: `echo ${karmaxToken}`, detail: leaked });
      return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: `Here is the env:\n${leaked}` };
    } };
    const core = makeCoreActivities({ store, worlds, resources, broker, tokens,
      adapters: new Map([['mock', adapter]]), profiles: new ProfileResolver(store, 'mock') });
    const handle = await core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
    try {
      const result = await core.runAgentTurn({ taskId: task.id, role: 'do', worldHandle: handle,
        messages: [{ id: 'm1', role: 'user', text: 'work', ts: 0 }],
        task: { projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'software-dev' } as any });
      expect(karmaxToken).toMatch(/^kt_/);
      const archived = JSON.stringify((await store.eventsSince(task.id, 0)).filter((event) =>
        event.type === 'agent.output' || event.type === 'agent.activity'));
      expect(archived).toContain('DATABASE_URL=');
      for (const secret of ['hunter2-db-pass', karmaxToken]) {
        expect(archived).not.toContain(secret);
        expect(result.output).not.toContain(secret);
      }
      expect(result.output).toContain('[redacted]');
    } finally {
      await core.destroyWorld(handle);
      await resources.deleteProject(project.id);
      (await store.close());
      fs.rmSync(dir, { recursive: true, force: true });
      restoreEnv('KARMAX_HOME', previous.home);
      restoreEnv('KARMAX_AGENT_MIN_FREE_MB', previous.floor);
      restoreEnv('KARMAX_AGENT_MAX_LOAD_FACTOR', previous.load);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
