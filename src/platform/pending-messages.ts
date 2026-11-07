import type { Message, TaskView } from '../domain/types.js';

/**
 * Messages waiting for their task to take them (wiki features/queued-messages).
 *
 * A workflow offers `followUp` only where a message has a meaning it can act on
 * — not while the task sets up its computer, opens a pull request, resolves a
 * conflict, or publishes resources. A message said meanwhile is kept here, in
 * order, and delivered the moment the task offers `followUp` again, exactly as
 * if it had been sent then. Workflows never see the queue: their histories are
 * unchanged, so every running version gets it.
 */
export interface PendingMessage {
  /** The message as it will be delivered: its id, author and time are kept. */
  message: Message;
  /** The conversation it is for (`do` in a shared conversation). */
  role: string;
  /** Who sent it: only they may take it back. */
  by: string;
}

/** A message as its sender gets it back: `queued` until its task takes it. */
export type SentMessage = Message & { queued?: true };

export const pendingMessagesKey = (taskId: string): string => `pending-messages:${taskId}`;
export const PENDING_MESSAGES_PREFIX = 'pending-messages:';

/** A task that is still going: a message said to it can wait for its turn. */
const LIVE_STATUSES = new Set(['active', 'waiting', 'blocked']);
export function acceptsQueuedMessages(view: Pick<TaskView, 'status'> | undefined): boolean {
  return !view || LIVE_STATUSES.has(view.status);
}

/** The composer's action while messages wait: the same follow-up, marked so
 * the page and API callers know it is kept until the agent can take it. */
export const QUEUED_FOLLOW_UP_ACTION = (): TaskView['actions'][number] => ({
  name: 'followUp',
  kind: 'signal',
  label: 'Send follow-up',
  enabled: true,
  queues: true,
  args: [{ name: 'text', type: 'text', label: 'Message', required: true }],
  roles: ['do'],
});

export function parsePending(raw: string | undefined | null): PendingMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry?.message?.id && typeof entry.role === 'string') : [];
  } catch { return []; }
}

/** What a view shows of the queue: not who sent each, only whether the viewer did. */
export function pendingForView(queue: PendingMessage[], viewer?: string): NonNullable<TaskView['pendingMessages']> {
  return queue.map(({ message, role, by }) => ({ message, role, ...(viewer && by === viewer ? { mine: true } : {}) }));
}
