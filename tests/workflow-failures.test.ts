import { ActivityFailure, ApplicationFailure } from '@temporalio/workflow';
import { describe, expect, it } from 'vitest';
import { isInfraFailure, limitFailureClassification } from '../src/workflows/failures.js';

describe('workflow infrastructure failures', () => {
  it.each(['agent-infra', 'world-infra'])('backs off and retries %s activity failures', (type) => {
    const cause = ApplicationFailure.retryable('temporary outage', type);
    const failure = new ActivityFailure('activity failed', 'createWorld', '1',
      'MAXIMUM_ATTEMPTS_REACHED', 'worker', cause);

    expect(isInfraFailure(failure)).toBe(true);
  });

  it.each(['credit balance is too low', '429: try again in 2.5s'])(
    'preserves replay routing for an old untyped limit: %s', (message) => {
      const cause = ApplicationFailure.nonRetryable(message, 'agent-limit');
      const failure = new ActivityFailure('activity failed', 'runAgentTurn', '1',
        'NON_RETRYABLE_FAILURE', 'worker', cause);
      expect(limitFailureClassification(failure)).toEqual({ limited: true, kind: 'quota', window: '5h' });
    },
  );

  it('never quarantines or retries a serialized safety failure', () => {
    const cause = ApplicationFailure.nonRetryable('Codex safety rejection: misalignmentPolicyViolation HTTP 401', 'agent-policy');
    const failure = new ActivityFailure('activity failed', 'runAgentTurn', '1',
      'NON_RETRYABLE_FAILURE', 'worker', cause);
    expect(isInfraFailure(failure)).toBe(false);
    expect(limitFailureClassification(failure)).toBeUndefined();
  });

  it('does not park for ordinary activity failures', () => {
    const cause = ApplicationFailure.retryable('bad checkout', 'Error');
    const failure = new ActivityFailure('activity failed', 'createWorld', '1',
      'MAXIMUM_ATTEMPTS_REACHED', 'worker', cause);

    expect(isInfraFailure(failure)).toBe(false);
  });
});
