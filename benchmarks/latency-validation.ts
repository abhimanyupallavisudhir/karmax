import type { TimingRow } from '../src/timing/index.js';

/** A successful model turn is not necessarily a successful benchmark workload. */
export function benchmarkOutcome(scenario: string, observations: TimingRow[]) {
  const actions = observations.filter(row => row.name === 'service.execution' && row.phase === 'end');
  const expectedActions = scenario === 'conversation' ? 0 : scenario === 'one-action' ? 1 : 3;
  return { expectedActions, observedActions: actions.length,
    valid: actions.length === expectedActions && actions.every(row => row.status === 'ok') };
}
