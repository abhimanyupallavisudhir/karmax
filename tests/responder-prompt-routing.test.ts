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
    expect(prompt).toMatch(/platform_request\(PATCH, "\/api\/tasks\/[^/]+\/params", \{"params": \{"computer": \{"diskGb": 50\}\}\}\)/);
    // A local world has no machine of its own to resize.
    expect(assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }), world })).not.toContain('Computer:');
  });
});
