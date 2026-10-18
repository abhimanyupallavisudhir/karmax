import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

// A world restored from a checkpoint (a resize, a hibernation) is a new
// generation, while the workflow keeps passing the handle it was given at
// creation. Generation-bound calls (propose_project_resource) check the token
// against the world's current generation, so the token must carry that one
// (andhbhakt video-explainers #1: every proposal refused after a resize).
describe('agent token world generation', () => {
  it('stamps the generation of the world the turn opened, not the stale workflow handle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-token-generation-'));
    const previous = { home: process.env.KARMAX_HOME, memory: process.env.KARMAX_AGENT_MIN_FREE_MB, load: process.env.KARMAX_AGENT_MAX_LOAD_FACTOR };
    process.env.KARMAX_HOME = dir;
    process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
    process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
    try {
      const store = (await Store.create(':memory:'));
      const project = (await store.createProject('Generations'));
      const task = (await store.createTask({ projectId: project.id, title: 'Render', workflow: 'software-dev',
        workflowVersion: '1.30.0', params: { prompt: 'work' } }));
      const tokens = new TokenAuthority(store);
      const mint = vi.spyOn(tokens, 'mint');
      const adapter = {
        provider: 'mock' as const,
        async runTurn() { return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'done' }; },
      };
      const worlds = new WorldRegistry();
      const core = makeCoreActivities({ store, worlds, tokens,
        adapters: new Map([['mock', adapter]]), profiles: new ProfileResolver(store, 'mock') });
      const stale = await core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
      expect(stale.generation).toBe(1);
      const restored = (await store.registerWorld({ ...stale, generation: 2 }, project.id));
      expect((await store.currentWorld(stale.id))?.generation).toBe(2);

      await core.runAgentTurn({ taskId: task.id, role: 'do', worldHandle: stale, messages: [],
        task: { projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'software-dev' } as any });

      expect(mint).toHaveBeenCalled();
      expect(mint.mock.calls.at(-1)![0].worldGeneration).toBe(restored.generation);
    } finally {
      for (const [key, value] of [['KARMAX_HOME', previous.home], ['KARMAX_AGENT_MIN_FREE_MB', previous.memory], ['KARMAX_AGENT_MAX_LOAD_FACTOR', previous.load]] as const)
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
