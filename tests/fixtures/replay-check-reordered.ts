// A release that reorders `parked` (a timer before its recorded activity) and
// drops `retired`; `steady` is unchanged.
import { condition, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';

const { step, blob } = proxyActivities<{ step(): Promise<string>; blob(): Promise<string> }>({ startToCloseTimeout: '1 minute' });
const release = defineSignal('release');

export async function parked(): Promise<void> {
  let released = false;
  setHandler(release, () => { released = true; });
  await sleep('1 second');
  await step();
  await condition(() => released);
}

export async function steady(): Promise<void> {
  let released = false;
  setHandler(release, () => { released = true; });
  await step();
  await condition(() => released);
}

export async function finishes(): Promise<void> { await step(); }

// Three large results put more than gRPC's default 4 MiB in one history page.
export async function bulky(): Promise<void> {
  let released = false;
  setHandler(release, () => { released = true; });
  for (let i = 0; i < 3; i++) await blob();
  await condition(() => released);
}
