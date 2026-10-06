import { describe, expect, it } from 'vitest';
import {
  addressedTo, calledAgents, composeRecipients, conversationFor, enqueueAgents, isParticipantKey,
  mentionedPeople, nextAgentKey, participantLabel, participantRole, reviewerKey,
} from '../src/domain/participants.js';
import type { Message } from '../src/domain/types.js';

const msg = (m: Partial<Message> & Pick<Message, 'role' | 'text'>, i = 0): Message => ({ id: `m${i}`, ts: i, ...m });

describe('task participants', () => {
  it('names, roles and keys', () => {
    expect(['do', 'responder', 'confirm', 'confirm-2', 'agent-3'].every(isParticipantKey)).toBe(true);
    expect(['', 'merge', 'agent-0', 'confirm-1', 'agent-x', 'agent-1000'].some(isParticipantKey)).toBe(false);
    expect(['do', 'responder', 'confirm', 'confirm-2', 'agent-3'].map(participantLabel))
      .toEqual(['Agent', 'Responder', 'Reviewer', 'Reviewer 2', 'Agent 3']);
    expect(['do', 'responder', 'confirm-2', 'agent-3'].map(participantRole))
      .toEqual(['do', 'responder', 'confirm', 'agent']);
    expect([0, 1, 2].map(reviewerKey)).toEqual(['confirm', 'confirm-2', 'confirm-3']);
  });

  it('numbers a new agent after every listed one', () => {
    expect(nextAgentKey(['do'])).toBe('agent-1');
    expect(nextAgentKey(['do', 'responder', 'confirm'])).toBe('agent-3');
    expect(nextAgentKey(['do', 'responder', 'agent-2'])).toBe('agent-3');
  });

  it('a message without recipients is for the main agent only', () => {
    const human = msg({ role: 'user', text: 'go' });
    expect(addressedTo(human, 'do')).toBe(true);
    expect(addressedTo(human, 'agent-1')).toBe(false);
    expect(calledAgents(human)).toEqual(['do']);
    const own = msg({ role: 'agent', text: 'done' });
    expect(calledAgents(own)).toEqual([]);
    const reviewer = msg({ role: 'agent', author: 'confirm', text: 'looks good' });
    expect(calledAgents(reviewer)).toEqual([]);
  });

  it('explicit recipients call agents in order and list people separately', () => {
    const m = msg({ role: 'user', text: 'x', to: ['agent:agent-2', 'user:u1', 'agent:do', 'agent:agent-2', '@creator'] });
    expect(calledAgents(m)).toEqual(['agent-2', 'do']);
    expect(mentionedPeople(m)).toEqual(['user:u1', '@creator']);
    // An agent never calls itself.
    expect(calledAgents(msg({ role: 'agent', author: 'agent-2', text: 'x', to: ['agent:agent-2', 'agent:do'] }))).toEqual(['do']);
  });

  it('text before the first mention also reaches the main agent, first', () => {
    expect(composeRecipients('Fix it. @Reviewer check', [{ selector: 'agent:confirm', index: 8 }]))
      .toEqual(['agent:do', 'agent:confirm']);
    expect(composeRecipients('@Reviewer check, then @Alice', [
      { selector: 'user:a', index: 22 }, { selector: 'agent:confirm', index: 0 }]))
      .toEqual(['agent:confirm', 'user:a']);
    expect(composeRecipients('  @Agent 3 look', [{ selector: 'agent:agent-3', index: 2 }])).toEqual(['agent:agent-3']);
    expect(composeRecipients('plain follow-up', [])).toEqual(['agent:do']);
  });

  it('each agent reads the others as labelled input, one message per message', () => {
    const thread: Message[] = [
      msg({ role: 'user', text: 'Build X' }, 0),
      msg({ role: 'agent', text: 'Should X use Y?' }, 1),
      msg({ role: 'agent', author: 'responder', text: 'Yes, Y.', to: ['agent:do'] }, 2),
      msg({ role: 'user', author: 'user:u2', authorLabel: 'Bea', text: '@Reviewer also check Z' }, 3),
      msg({ role: 'system', text: 'confirm_decision: revise' }, 4),
    ];
    const forDo = conversationFor(thread, 'do');
    expect(forDo.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Build X'], ['agent', 'Should X use Y?'], ['user', 'Responder: Yes, Y.'],
      ['user', 'Bea: @Reviewer also check Z'], ['system', 'confirm_decision: revise'],
    ]);
    const forResponder = conversationFor(thread, 'responder');
    expect(forResponder.map((m) => [m.role, m.text]).slice(1, 3)).toEqual([
      ['user', 'Agent: Should X use Y?'], ['agent', 'Yes, Y.'],
    ]);
    expect(forResponder).toHaveLength(thread.length);
  });

  it('queues called agents once, never the running one', () => {
    expect(enqueueAgents(['agent-2'], ['confirm', 'agent-2', 'do'], 'do')).toEqual(['agent-2', 'confirm']);
  });
});

describe('what agents see of each other', () => {
  it('a digest of another agent\'s work precedes its message', async () => {
    const { workDigest } = await import('../src/domain/participants.js');
    expect(workDigest([
      { kind: 'command', title: 'npm test', phase: 'completed' },
      { kind: 'file', title: 'Edited src/a.ts', phase: 'completed' },
      { kind: 'command', title: 'npm run lint', phase: 'failed' },
      { kind: 'reasoning', title: 'thinking', phase: 'completed' },
      { kind: 'command', title: 'still going', phase: 'started' },
    ])).toBe('(ran `npm test`; Edited src/a.ts; ran `npm run lint` ✗)');
    expect(workDigest([])).toBeUndefined();
    const thread: Message[] = [msg({ role: 'agent', author: 'confirm', text: 'Looks good.', sourceActivity: { turnId: 't', id: 'x', attempt: 1 } }, 0)];
    expect(conversationFor(thread, 'do', undefined, () => '(ran `npm test`)')[0]!.text).toBe('Reviewer: (ran `npm test`)\nLooks good.');
    expect(conversationFor(thread, 'confirm', undefined, () => '(ran `npm test`)')[0]!.text).toBe('Looks good.');
  });
});
