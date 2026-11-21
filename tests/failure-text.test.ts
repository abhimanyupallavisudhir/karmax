import { describe, expect, it } from 'vitest';
import { ActivityFailure, ApplicationFailure, RetryState, TimeoutFailure, TimeoutType } from '@temporalio/common';
import { describeFailure } from '../src/domain/failure-text.js';

// tavya-error 33f6295a8ac41d4a (2026-11-16): a sub-task stopped for its parent
// with "infrastructure: Activity task timed out → activity Heartbeat timeout
// (still failing after 5 waits)". Every activity of the Do stage heartbeats, so
// that text named nothing to look at: which activity stopped responding was
// only in Temporal's history, of a task its fixer could not open.
describe('describeFailure', () => {
  const timedOut = (activityType: string, timeoutType: TimeoutType, message: string) =>
    new ActivityFailure('Activity task timed out', activityType, '42', RetryState.TIMEOUT, 'worker',
      new TimeoutFailure(message, undefined, timeoutType));

  it('names the activity that timed out', () => {
    expect(describeFailure(timedOut('runAgentTurn', TimeoutType.HEARTBEAT, 'activity Heartbeat timeout')))
      .toBe('Activity runAgentTurn timed out → activity Heartbeat timeout');
    expect(describeFailure(timedOut('createWorld', TimeoutType.START_TO_CLOSE, 'activity StartToClose timeout')))
      .toBe('Activity createWorld timed out → activity StartToClose timeout');
  });

  it('keeps a failed activity as it was: its cause says what went wrong', () => {
    const failed = new ActivityFailure('Activity task failed', 'openPr', '7', RetryState.NON_RETRYABLE_FAILURE, 'worker',
      ApplicationFailure.nonRetryable('could not push branch', 'git-push'));
    expect(describeFailure(failed)).toBe('Activity task failed → could not push branch');
  });

  it('joins any cause chain without repeating a message', () => {
    const inner = new Error('same');
    const outer = Object.assign(new Error('same'), { cause: inner });
    expect(describeFailure(Object.assign(new Error('top'), { cause: outer }))).toBe('top → same');
    expect(describeFailure('plain')).toBe('plain');
  });
});
