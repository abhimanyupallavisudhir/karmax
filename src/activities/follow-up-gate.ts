import type { Message } from '../domain/types.js';

/** How long a journaled follow-up keeps the workflow query open while it has
 * not come back: the journal entry follows Temporal accepting the signal, but a
 * query can still race the workflow task that applies it, and a message for a
 * different agent never appears in this turn's transcript at all. */
export const FOLLOW_UP_SETTLE_MS = 10_000;
/** A writer that journals nothing (an operator's raw Temporal signal, a parent
 * workflow's comment) is still delivered in-turn, within this bound. */
export const FOLLOW_UP_BACKSTOP_MS = 30_000;

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
   *  publication none. */
  journaled: (seq: number) => Promise<{ seq: number; messageId?: string }[]>;
  now?: () => number;
}): (fromIndex: number) => Promise<Message[]> {
  const now = options.now ?? Date.now;
  let seen: number | undefined;
  let askedAt = 0;
  let publication = false;
  // Journaled message id → when to stop waiting for it to come back.
  const awaited = new Map<string, number>();
  // A query can return a message before its journal entry is written.
  const returned = new Set<string>();
  const worthAsking = async (): Promise<boolean> => {
    if (seen === undefined) { seen = await options.cursor(); return true; }
    for (const entry of await options.journaled(seen)) {
      seen = Math.max(seen, entry.seq);
      if (!entry.messageId) publication = true;
      else if (!returned.has(entry.messageId)) awaited.set(entry.messageId, now() + FOLLOW_UP_SETTLE_MS);
    }
    for (const [id, until] of awaited) if (until <= now()) awaited.delete(id);
    return publication || awaited.size > 0 || now() - askedAt >= FOLLOW_UP_BACKSTOP_MS;
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
