import { condition, defineSignal, setHandler } from '@temporalio/workflow';
import { SIG_ACCOUNT_GRANTED } from '../../src/coordinators/names.js';

/** Stands in for a task workflow: stays open so account grants land in its history. */
export async function accountGrantee(): Promise<void> {
  setHandler(defineSignal<[unknown]>(SIG_ACCOUNT_GRANTED), () => undefined);
  await condition(() => false);
}
