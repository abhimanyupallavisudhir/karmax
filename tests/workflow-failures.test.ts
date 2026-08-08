import { ActivityFailure, ApplicationFailure } from '@temporalio/workflow';
import { describe, expect, it } from 'vitest';
import { isInfraFailure } from '../src/workflows/failures.js';

describe('workflow infrastructure failures', () => {
  it.each(['agent-infra', 'world-infra'])('backs off and retries %s activity failures', (type) => {
    const cause = ApplicationFailure.retryable('temporary outage', type);
    const failure = new ActivityFailure('activity failed', 'createWorld', '1',
      'MAXIMUM_ATTEMPTS_REACHED', 'worker', cause);

    expect(isInfraFailure(failure)).toBe(true);
  });

  it('does not park for ordinary activity failures', () => {
    const cause = ApplicationFailure.retryable('bad checkout', 'Error');
    const failure = new ActivityFailure('activity failed', 'createWorld', '1',
      'MAXIMUM_ATTEMPTS_REACHED', 'worker', cause);

    expect(isInfraFailure(failure)).toBe(false);
  });
});
