import { proxyActivities, defineSignal, defineQuery, setHandler, condition } from '@temporalio/workflow';
import type { pingActivities } from '../activities/ping.js';

const act = proxyActivities<typeof pingActivities>({ startToCloseTimeout: '10s' });

export const bump = defineSignal<[number]>('bump');
export const finish = defineSignal('finish');
export const countQuery = defineQuery<number>('count');

/**
 * Smoke-test workflow: exercises the SPEC §3.2 primitives — activity (side
 * effect, journaled), signal (async event), query (read-only re-run), and a
 * durable wait (condition). Proves the deterministic replay model works.
 */
export async function pingWorkflow(start: string): Promise<{ started: string; at: number; count: number }> {
  let count = 0;
  let done = false;
  setHandler(countQuery, () => count);
  setHandler(bump, (n) => {
    count += n;
  });
  setHandler(finish, () => {
    done = true;
  });

  const at = await act.now();
  await act.echo(start);
  await condition(() => done);
  return { started: start, at, count };
}
