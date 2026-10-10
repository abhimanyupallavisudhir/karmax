import type { Message } from '../domain/types.js';

/** How long a journaled follow-up keeps the workflow query open while it has
 * not come back: the journal entry follows Temporal accepting the signal, but a
 * query can still race the workflow task that applies it, and a message for a
 * different agent never appears in this turn's transcript at all. */
export const FOLLOW_UP_SETTLE_MS = 10_000;
/** A writer that journals nothing (an operator's raw Temporal signal) is still
 * delivered in-turn, within this bound. */
export const FOLLOW_UP_BACKSTOP_MS = 30_000;
/** With wake marks, the journal is read again at least this often anyway:
 * a writer this process does not hear from (another replica) is seen within it. */
export const FOLLOW_UP_JOURNAL_RECHECK_MS = 5_000;

/**
 * Gate a running turn's follow-up pulls (SPEC §5.6, LT-13). Streaming adapters
 * poll about once a second; each pull used to query the workflow, which replays
 * its whole history whenever it has left the worker's small cache. The API
 * journals every follow-up as a `conversation.message` event once Temporal has
 * accepted it, and a workflow that appends a message itself mid-turn (a mode
 * switch) publishes its view, so a cheap indexed read tells whether a query can
 * find anything. Polling cadence, and so delivery latency, is unchanged. The
 * first pull always queries: a message may have landed between the workflow
 * scheduling the turn and the turn starting.
 */
export function gateFollowUps(options: {
  query: (fromIndex: number) => Promise<Message[]>;
  /** Highest event sequence now; journal entries after it are new. */
  cursor: () => Promise<number>;
  /** Journal entries after `seq`: a follow-up carries its message id, a view
   *  publication none. `pending` marks a message about to be signalled whose id
   *  the journal cannot know (a parent's answer, #396 review item 8): the gate
   *  keeps asking until the settle window lapses. */
  journaled: (seq: number) => Promise<{ seq: number; messageId?: string; pending?: boolean }[]>;
  /** The task's follow-up wake mark (`followUpMark`): the journal is read only
   * once it moves, or after FOLLOW_UP_JOURNAL_RECHECK_MS. Undefined: read on
   * every pull. */
  mark?: () => number | undefined;
  now?: () => number;
}): (fromIndex: number) => Promise<Message[]> {
  const now = options.now ?? Date.now;
  let seen: number | undefined;
  let readMark: number | undefined;
  let readAt = -Infinity;
  let movedAt = -Infinity;
  let askedAt = 0;
  let publication = false;
  let pendingUntil = 0;
  // Journaled message id → when to stop waiting for it to come back.
  const awaited = new Map<string, number>();
  // A query can return a message before its journal entry is written.
  const returned = new Set<string>();
  const worthAsking = async (): Promise<boolean> => {
    const mark = options.mark?.();
    if (seen === undefined) { seen = await options.cursor(); readMark = mark; readAt = now(); return true; }
    if (mark !== readMark) movedAt = now();
    // After a move, read for a second more: on PostgreSQL the read stops at the
    // commit watermark, which a lower seq still in flight can briefly hold back.
    const unchanged = mark !== undefined && mark === readMark && now() - movedAt >= 1_000
      && now() - readAt < FOLLOW_UP_JOURNAL_RECHECK_MS;
    const entries = unchanged ? [] : await options.journaled(seen);
    // `mark` was taken before reading: an entry committed during the read moves it again.
    if (!unchanged) { readMark = mark; readAt = now(); }
    for (const entry of entries) {
      seen = Math.max(seen, entry.seq);
      if (entry.pending) pendingUntil = now() + FOLLOW_UP_SETTLE_MS;
      else if (!entry.messageId) publication = true;
      else if (!returned.has(entry.messageId)) awaited.set(entry.messageId, now() + FOLLOW_UP_SETTLE_MS);
    }
    for (const [id, until] of awaited) if (until <= now()) awaited.delete(id);
    return publication || awaited.size > 0 || pendingUntil > now() || now() - askedAt >= FOLLOW_UP_BACKSTOP_MS;
  };
  return async (fromIndex) => {
    // An unreadable journal cannot rule a follow-up out: ask the workflow.
    if (!(await worthAsking().catch(() => true))) return [];
    publication = false;
    askedAt = now();
    const messages = await options.query(fromIndex);
    for (const message of messages) { awaited.delete(message.id); returned.add(message.id); }
    return messages;
  };
}
