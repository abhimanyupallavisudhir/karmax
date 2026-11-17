import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

// Whatever parks, hibernates or stops a world first asks whether it is in use
// (`WorldRegistry.hasActiveAccess`). An agent's turn was not such a use: only
// the moment of opening the world was, so a park decided on other grounds (a
// branch's pull request waiting for review, pramana#137, 2026-11-09) stopped
// the machine under the agent working in it.
describe('an agent turn is a use of its world', () => {
  async function fixture(runTurn: (inUse: () => Promise<boolean>) => Promise<unknown>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-turn-access-'));
    const previous = { home: process.env.KARMAX_HOME, memory: process.env.KARMAX_AGENT_MIN_FREE_MB, load: process.env.KARMAX_AGENT_MAX_LOAD_FACTOR };
    process.env.KARMAX_HOME = dir;
    process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
    process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
    const store = await Store.create(':memory:');
    const project = await store.createProject('Access');
    const task = await store.createTask({ projectId: project.id, title: 'Work', workflow: 'software-dev',
      workflowVersion: '1.30.0', params: { prompt: 'work' } });
    const worlds = new WorldRegistry();
    const inUse = () => worlds.hasActiveAccess(task.id);
    const core = makeCoreActivities({ store, worlds, profiles: new ProfileResolver(store, 'mock'),
      adapters: new Map([['mock', { provider: 'mock' as const, runTurn: () => runTurn(inUse) as any }]]) });
    const handle = await core.createWorld({ taskId: task.id, projectId: project.id, kind: 'memory', base: 'main' });
    const turn = () => core.runAgentTurn({ taskId: task.id, role: 'do', worldHandle: handle, messages: [],
      task: { projectId: project.id, title: task.title, prompt: 'work', project: {}, workflow: 'software-dev' } as any });
    const close = async () => {
      await store.close();
      for (const [key, value] of [['KARMAX_HOME', previous.home], ['KARMAX_AGENT_MIN_FREE_MB', previous.memory], ['KARMAX_AGENT_MAX_LOAD_FACTOR', previous.load]] as const)
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    };
    return { turn, inUse, close };
  }

  it('holds the world for as long as the turn runs, and no longer', async () => {
    let during: boolean | undefined;
    const f = await fixture(async (inUse) => {
      during = await inUse();
      return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'done' };
    });
    try {
      expect(await f.inUse()).toBe(false);
      await f.turn();
      expect(during).toBe(true);
      expect(await f.inUse()).toBe(false);
    } finally { await f.close(); }
  });

  it('lets go of it when the turn fails', async () => {
    const f = await fixture(async () => { throw new Error('the agent crashed'); });
    try {
      await expect(f.turn()).rejects.toThrow();
      expect(await f.inUse()).toBe(false);
    } finally { await f.close(); }
  });
});
