import { describe, it, expect } from 'vitest';
import { parseTransition } from '../src/resolve/transitions.js';
import { runTurn } from '../src/agent/runtime.js';
import { MockAdapter } from '../src/agent/mock.js';

describe('parseTransition (bounded recovery vocabulary)', () => {
  it('accepts the simple verbs (via action or do key)', () => {
    expect(parseTransition({ action: 'resume' })).toEqual({ do: 'resume' });
    expect(parseTransition({ do: 'retryStage' })).toEqual({ do: 'retryStage' });
  });

  it('escalate carries a reason (with a default)', () => {
    expect(parseTransition({ action: 'escalate', reason: 'needs a card' })).toEqual({ do: 'escalate', reason: 'needs a card' });
    expect(parseTransition({ action: 'escalate' })).toMatchObject({ do: 'escalate' });
  });

  it('gotoStage only allows earlier, non-terminal, pre-PONR stages', () => {
    expect(parseTransition({ action: 'gotoStage', stage: 'do' })).toEqual({ do: 'gotoStage', stage: 'do' });
    expect(parseTransition({ action: 'gotoStage', stage: 'done' })).toBeNull();
    expect(parseTransition({ action: 'gotoStage', stage: 'nonsense' })).toBeNull();
    expect(parseTransition({ action: 'gotoStage', stage: 'merge', params: { target: 'release' } })).toEqual({
      do: 'gotoStage',
      stage: 'merge',
      params: { target: 'release' },
    });
  });

  it('parkUntil defaults its then-action to resume', () => {
    expect(parseTransition({ action: 'parkUntil', event: { kind: 'account' } })).toEqual({
      do: 'parkUntil',
      event: { kind: 'account' },
      then: { do: 'resume' },
    });
  });

  it('rejects garbage', () => {
    expect(parseTransition({ action: 'nonsense' })).toBeNull();
    expect(parseTransition(null)).toBeNull();
    expect(parseTransition('resume')).toBeNull();
  });
});

describe('resolve decision flows adapter → ctx → TurnResult', () => {
  const world: any = { handle: { id: 'w1', root: '/tmp/x', branch: 'b', base: 'main' } };
  const profile: any = { id: 'p', name: 'm', provider: 'mock', role: 'resolve', capabilities: [] };
  const adapters = new Map<any, any>([['mock', new MockAdapter()]]);

  it('captures an escalate decision from the mock @decide directive', async () => {
    const res = await runTurn(
      { profile, world, messages: [{ id: 'm', role: 'user', text: '@decide escalate :: cannot fix', ts: 0 }], systemPrompt: '', role: 'resolve' } as any,
      { adapters },
    );
    expect(res.resolution).toEqual({ do: 'escalate', reason: 'cannot fix' });
    expect(res.completed).toBe(true);
  });

  it('captures a gotoStage decision', async () => {
    const res = await runTurn(
      { profile, world, messages: [{ id: 'm', role: 'user', text: '@decide gotoStage do :: rewind', ts: 0 }], systemPrompt: '', role: 'resolve' } as any,
      { adapters },
    );
    expect(res.resolution).toEqual({ do: 'gotoStage', stage: 'do' });
  });
});
