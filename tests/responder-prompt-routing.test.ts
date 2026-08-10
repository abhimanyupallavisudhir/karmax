import { describe, expect, it } from 'vitest';
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
    expect(prompt).toContain('Use escalate_to_human only when');
  });

  it('does not add agent-routing instructions for a human Responder', () => {
    const prompt = assemblePrompt({ profile, role: 'do', task: task({ kind: 'human', audience: ['@creator'] }), world });
    expect(prompt).not.toContain('ordinary Waiting-for-input Responder is an agent');
  });
});
