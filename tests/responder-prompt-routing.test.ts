import { describe, expect, it } from 'vitest';
import { GLOBAL_INSTRUCTIONS } from '../src/agent/instructions.js';
import { assemblePrompt } from '../src/agent/prompt.js';
import type { AgentProfile, TaskInput } from '../src/domain/types.js';

const profile: AgentProfile = {
  id: 'profile_do', role: 'do', name: 'Do', provider: 'mock',
};
const world = {
  id: 'world', kind: 'memory' as const, root: '/world', workdir: '/world', branch: 'task', base: 'main', target: 'main',
};
const task = (responder: TaskInput['responder']): TaskInput => ({
  taskId: 'task', projectId: 'project', title: 'Ask cleanly', prompt: 'Do the work', project: {}, responder,
});

describe('Do-agent input routing instructions', () => {
  it('tells Do to yield ordinary questions to an agent Responder', () => {
    const prompt = assemblePrompt({ profile, role: 'do', task: task({ kind: 'agent', provider: 'mock' }), world });
    expect(prompt).toContain('ordinary Waiting-for-input Responder is an agent');
    expect(prompt).toContain('End the turn without open_pr');
    expect(prompt).toContain('Use escalate_to_human only for what only a person can give');
  });

  // #533: How to work and the tool list told agents to use escalate_to_human
  // for any decision, and a sub-task asked a person what its parent could.
  it('tells every agent to ask its usual route, and a person only for what only a person can give', () => {
    const prompt = assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }), world });
    expect(prompt).toContain('escalate_to_human(audience, message, urgency?): ask named people');
    expect(prompt).toContain('only a person can give');
    expect(prompt).not.toMatch(/If you need a human decision first, use escalate_to_human/);
    expect(GLOBAL_INSTRUCTIONS).toContain('If you need input before completion, end your turn with the question');
    expect(GLOBAL_INSTRUCTIONS).toContain('Use escalate_to_human, naming who to ask, only for what only a person can give');
  });

  it('does not add agent-routing instructions for a human Responder', () => {
    const prompt = assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }), world });
    expect(prompt).not.toContain('ordinary Waiting-for-input Responder is an agent');
  });
});

describe('the computer in the World section', () => {
  it('names a cloud world\'s machine and how the agent can make it bigger', () => {
    const prompt = assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }),
      world: { ...world, meta: { computer: { cpu: 2, memoryMb: 2048, diskGb: 20 } } } as any });
    expect(prompt).toContain('Computer: 2 CPU · 2 GB · 20 GB disk.');
    expect(prompt).toMatch(/platform_request\(PATCH, "\/api\/tasks\/[^/]+\/params", \{"params": \{"computer": \{"diskGb": \d+\}\}\}\)/);
    // A local world has no machine of its own to resize.
    expect(assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }), world })).not.toContain('Computer:');
  });

  // compute-disk item 2: the real ceiling, not a generic "diskGb: 50".
  it('names the disk in use and the largest the account allows, and offers exactly that', () => {
    const e2b = { ...world, kind: 'e2b', meta: { computer: { cpu: 2, memoryMb: 2048 } } } as any;
    const limits = { cpu: 8, memoryMb: 8192, diskGb: 29, source: { cpu: 'provider', memoryMb: 'provider', diskGb: 'provider' } as const };
    const disk = { totalKb: 22 * 2 ** 20, usedKb: 17 * 2 ** 20, availKb: 5 * 2 ** 20 };
    const prompt = assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }), world: e2b, limits, disk,
      computer: { cpu: 2, memoryMb: 2048 } });
    expect(prompt).toContain('Computer: 2 CPU · 2 GB · 22 GB disk (17 GB used). This E2B account allows up to 8 CPU, 8 GB memory and 29 GB disk.');
    expect(prompt).toContain('{"params": {"computer": {"diskGb": 29}}}');
    expect(prompt).not.toContain('"diskGb": 50');
    // At the ceiling there is no bigger disk to offer: free space instead.
    const full = assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }),
      world: { ...e2b, meta: { computer: { cpu: 2, memoryMb: 2048, diskGb: 29 } } }, limits,
      disk: { totalKb: 29 * 2 ** 20, usedKb: 28 * 2 ** 20, availKb: 2 ** 20 }, computer: { cpu: 2, memoryMb: 2048, diskGb: 29 } });
    expect(full).toContain('Its disk is the largest this account allows');
    expect(full).not.toContain('"diskGb"');
    expect(full).toContain('{"params": {"computer": {"memoryMb": 8192}}}');
  });

  // pramana#3: the agent paused on its rebuild job after its owner chose 50 GB;
  // a pause that waits on jobs never parks, so the machine never moved.
  it('says a resize needs a pause without jobs, and names a size the task asks for but has not reached', () => {
    const cloud = { ...world, meta: { computer: { cpu: 2, memoryMb: 2048 } } } as any;
    const steady = assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }), world: cloud,
      computer: { cpu: 2, memoryMb: 2048 } });
    expect(steady).toContain('pause(3) without jobs');
    expect(steady).toContain('A pause that waits on jobs keeps this machine');
    expect(steady).not.toContain('This task\'s computer is now');
    const pending = assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }), world: cloud,
      computer: { cpu: 2, memoryMb: 2048, diskGb: 50 } });
    expect(pending).toContain('Computer: 2 CPU · 2 GB. This task\'s computer is now 2 CPU · 2 GB · 50 GB disk: you move to it when the task parks');
  });
});

// pramana#3: every sub-task copied all 10.5 GB of raw_data. An on-demand
// resource arrives as a listing, and the prompt says how big it is and how to
// fetch, and free, only what the task needs.
describe('on-demand data in the World section', () => {
  it('names each on-demand resource with its size and the tavya-data command', () => {
    const prompt = assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }),
      world: { ...world, meta: { resourceProjections: {
        r1: { target: 'raw_data', access: 'write', onDemand: true, bytes: 10_500_000_000, files: 777_367, parts: 12, held: 0 },
        r2: { target: 'secrets.env', access: 'read' } } } } as any });
    expect(prompt).toContain('Project data on demand: raw_data (10.5 GB, 777,367 files in 12 top-level parts; 0 B on this disk).');
    expect(prompt).toContain('`/world/.karmax-injection/bin/tavya-data get <folder>` fetches a part');
    expect(prompt).toContain('free space with drop, never rm');
    expect(assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }), world })).not.toContain('on demand');
  });
});
