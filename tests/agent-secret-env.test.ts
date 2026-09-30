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
import { SecretScrubber } from '../src/agent/activity.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import { resourceSecretHandle } from '../src/domain/resource-drivers.js';

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
    const credential = resourceSecretHandle('resource_agent_token');
    (await broker.registerHandle(credential, 'secret-project-token'));
    const initial = (await store.createResourceAttachment({ id: 'resource_agent_token', organizationId: project.organizationId!, projectId: project.id,
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
      const lateHandle = resourceSecretHandle('resource_late_token');
      (await broker.registerHandle(lateHandle, 'late-project-token'));
      const late = (await store.createResourceAttachment({ id: 'resource_late_token', organizationId: project.organizationId!, projectId: project.id,
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
      let midTurn: Record<string, string> | undefined;
      let midTurnWorld: TurnInput['world'] | undefined;
      adapter.runTurn = async (input: TurnInput, ctx?: any) => {
        received = input;
        const changed = new Promise<void>((resolve) => ctx.onSecretEnvChange(resolve));
        for (const target of [{ kind: 'environment', name: 'MID_TURN_TOKEN' }, { kind: 'path', path: '.mid-turn-key' }] as const) {
          // Each resource owns its own copy of the value.
          const id = `resource_mid_${target.kind}`;
          (await broker.registerHandle(resourceSecretHandle(id), 'mid-turn-token'));
          (await store.createResourceAttachment({ id, organizationId: project.organizationId!, projectId: project.id,
            name: target.kind, driver: 'secret@1', target, access: 'read', isolation: 'fork', source: {},
            credentialHandles: [resourceSecretHandle(id)], publish: 'discard' }));
        }
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
    (await broker.registerHandle(resourceSecretHandle('resource_db'), 'postgres://admin:hunter2-db-pass@db.internal/app'));
    (await store.createResourceAttachment({ id: 'resource_db', organizationId: project.organizationId!, projectId: project.id,
      name: 'Database', driver: 'secret@1', target: { kind: 'environment', name: 'DATABASE_URL' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [resourceSecretHandle('resource_db')], publish: 'discard' }));
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

/**
 * #396 review item 1: live output is the text so far of a block still being
 * generated, published every window, so a cut can fall inside a secret. Whole-
 * value scrubbing cannot see a half value; the tail that could still become one
 * is held back until more text arrives.
 */
describe('streamed partial text', () => {
  const secret = 'sk-ant-api03-Ab"Cd\\Ef-0123456789';
  const escaped = JSON.stringify(secret).slice(1, -1);
  const fragments = (value: string) => Array.from({ length: value.length - 3 }, (_, i) => value.slice(0, i + 4));
  const leaks = (text: string) => [secret, escaped].flatMap(fragments).filter((fragment) => text.includes(fragment));

  it('never ends a publication with the start of a secret, in any encoding', () => {
    const scrubber = new SecretScrubber();
    scrubber.add(secret);
    for (const message of [`the key is ${secret} ok`, `{"key":"${escaped}","n":1}`, secret]) {
      for (let end = 0; end <= message.length; end++) {
        const published = scrubber.scrubPartial(message.slice(0, end));
        expect(leaks(published), `${JSON.stringify(message.slice(0, end))} → ${JSON.stringify(published)}`).toEqual([]);
        expect(message.slice(0, end).startsWith(published.replace(/\[redacted\].*$/s, ''))).toBe(true);
      }
      expect(scrubber.scrubPartial(message)).toBe(scrubber.scrub(message));
    }
  });

  it('holds a split secret back across every publication window of a real turn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-agent-partial-'));
    const previous = { home: process.env.KARMAX_HOME, floor: process.env.KARMAX_AGENT_MIN_FREE_MB, load: process.env.KARMAX_AGENT_MAX_LOAD_FACTOR };
    process.env.KARMAX_HOME = dir;
    process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
    process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
    const store = (await Store.create(':memory:'));
    const project = (await store.createProject('Partial'));
    const task = (await store.createTask({ projectId: project.id, title: 'Print the key', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'work' } }));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const worlds = new WorldRegistry();
    const resources = new ProjectResourceService(store, worlds,
      new ObjectSnapshotEngine(new LocalObjectStore(path.join(dir, 'objects')), broker), broker);
    (await broker.registerHandle(resourceSecretHandle('resource_key'), secret));
    (await store.createResourceAttachment({ id: 'resource_key', organizationId: project.organizationId!, projectId: project.id,
      name: 'Key', driver: 'secret@1', target: { kind: 'environment', name: 'API_KEY' },
      access: 'read', isolation: 'fork', source: {}, credentialHandles: [resourceSecretHandle('resource_key')], publish: 'discard' }));
    const { KarmaxBus } = await import('../src/contrib/bus.js');
    const bus = new KarmaxBus();
    const published: string[] = [];
    bus.onAny((event) => { if (event.type === 'agent.output') published.push(String((event.payload as any).text)); });
    const message = `the key is ${secret}, and as JSON {"key":"${escaped}"} done`;
    const adapter = { provider: 'mock' as const, async runTurn(_input: TurnInput, ctx: any) {
      // Each activity flushes the coalesced text, so every offset is a window cut.
      for (let end = 1; end <= message.length; end++) {
        ctx.emit(message.slice(0, end), 'assistant');
        await ctx.emitActivity({ id: `tick-${end}`, kind: 'status', phase: 'updated', title: 'tick' });
      }
      return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: message };
    } };
    const core = makeCoreActivities({ store, worlds, resources, broker, bus,
      adapters: new Map([['mock', adapter]]), profiles: new ProfileResolver(store, 'mock') });
    const handle = await core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
    try {
      await core.runAgentTurn({ taskId: task.id, role: 'do', worldHandle: handle,
        messages: [{ id: 'm1', role: 'user', text: 'work', ts: 0 }],
        task: { projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'software-dev' } as any });
      const stored = (await store.eventsSince(task.id, 0)).filter((event) => event.type === 'agent.output')
        .map((event) => String((event.payload as any).text));
      expect(published.length).toBeGreaterThan(20);
      for (const text of [...published, ...stored]) expect(leaks(text), text).toEqual([]);
      expect(published.at(-1)).toBe('the key is [redacted], and as JSON {"key":"[redacted]"} done');
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
