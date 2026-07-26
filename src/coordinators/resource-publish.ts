import { condition, continueAsNew, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';
import {
  QRY_RESOURCE_PUBLISH,
  SIG_CANCEL_RESOURCE_PUBLISH,
  SIG_ENQUEUE_RESOURCE_PUBLISH,
  SIG_RELEASE_RESOURCE_PUBLISH,
} from './names.js';

export interface ResourcePublishItem { token: string; taskId: string }
export interface ResourcePublishView {
  attachmentId: string;
  queue: ResourcePublishItem[];
  current?: ResourcePublishItem;
}
interface ResourcePublishState extends ResourcePublishView { processed: number }

export const enqueueResourcePublishSignal = defineSignal<[ResourcePublishItem]>(SIG_ENQUEUE_RESOURCE_PUBLISH);
export const releaseResourcePublishSignal = defineSignal<[{ token: string }]>(SIG_RELEASE_RESOURCE_PUBLISH);
export const cancelResourcePublishSignal = defineSignal<[{ token: string }]>(SIG_CANCEL_RESOURCE_PUBLISH);
export const resourcePublishQuery = defineQuery<ResourcePublishView>(QRY_RESOURCE_PUBLISH);

const CONTINUE_AS_NEW_AFTER = 500;
const ABANDONED_LEASE_TIMEOUT = '30 minutes';

/**
 * Durable singleton publication queue for one project resource. Immutable
 * revisions may be captured concurrently, but changing the shared baseline is
 * ordered here. The database compare-and-swap remains the final fencing token.
 */
export async function resourcePublishCoordinator(input: {
  attachmentId: string;
  state?: ResourcePublishState;
}): Promise<void> {
  const attachmentId = input.attachmentId;
  let queue = input.state?.queue ?? [];
  let current = input.state?.current;
  let processed = input.state?.processed ?? 0;

  setHandler(enqueueResourcePublishSignal, (item) => {
    if (current?.token !== item.token && !queue.some((candidate) => candidate.token === item.token)) queue.push(item);
  });
  setHandler(releaseResourcePublishSignal, ({ token }) => {
    if (current?.token === token) current = undefined;
    else queue = queue.filter((item) => item.token !== token);
  });
  setHandler(cancelResourcePublishSignal, ({ token }) => {
    queue = queue.filter((item) => item.token !== token);
    if (current?.token === token) current = undefined;
  });
  setHandler(resourcePublishQuery, () => ({
    attachmentId,
    queue: queue.map((item) => ({ ...item })),
    ...(current ? { current: { ...current } } : {}),
  }));

  for (;;) {
    if (!current) {
      await condition(() => queue.length > 0 || processed >= CONTINUE_AS_NEW_AFTER);
      if (processed >= CONTINUE_AS_NEW_AFTER && queue.length === 0)
        await continueAsNew<typeof resourcePublishCoordinator>({ attachmentId,
          state: { attachmentId, queue, current, processed: 0 } });
      current = queue.shift();
      if (current) processed++;
    }
    if (current) {
      const token = current.token;
      const released = await condition(() => current?.token !== token, ABANDONED_LEASE_TIMEOUT);
      if (!released && current?.token === token) current = undefined;
    }
  }
}
