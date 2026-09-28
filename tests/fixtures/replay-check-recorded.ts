// The code the running workflows in tests/replay-check.test.ts were recorded by.
import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

const { step, blob } = proxyActivities<{ step(): Promise<string>; blob(): Promise<string> }>({ startToCloseTimeout: '1 minute' });
const release = defineSignal('release');

async function parkAfterStep(): Promise<void> {
  let released = false;
  setHandler(release, () => { released = true; });
  await step();
  await condition(() => released);
}

export async function parked(): Promise<void> { await parkAfterStep(); }
export async function steady(): Promise<void> { await parkAfterStep(); }
export async function retired(): Promise<void> { await parkAfterStep(); }
export async function finishes(): Promise<void> { await step(); }

// Three large results put more than gRPC's default 4 MiB in one history page.
export async function bulky(): Promise<void> {
  let released = false;
  setHandler(release, () => { released = true; });
  for (let i = 0; i < 3; i++) await blob();
  await condition(() => released);
}
