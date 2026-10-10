import type { KarmaxEvent } from '../domain/types.js';

/**
 * Which tasks' follow-up journals have changed, so a running turn reads its
 * journal (`gateFollowUps`) when there may be something new, not on every poll.
 * Adapters poll every 0.1–1.2 s, and each read cost a watermark check and an
 * indexed select: a few commits a second per running turn, idle or not (2026-10
 * load test). Marks come from the events this process commits
 * (`Store.onEventRecorded`) and, in a separate activity worker, from the
 * events its supervisor commits (`worker.journaled`). Until something wires
 * them, the gate reads on every poll as before.
 */
export const FOLLOW_UP_JOURNAL_TYPES: readonly string[] = ['conversation.message', 'view.updated', 'subtask.parent-response'];
const JOURNAL_TYPES = new Set(FOLLOW_UP_JOURNAL_TYPES);

const marks = new Map<string, number>();
let counter = 0;
let wired = false;

/** A follow-up journal entry for `taskId` has committed. */
export function followUpJournaled(taskId: string): void {
  // Forgetting marks is safe: a turn that sees its mark change reads again.
  if (marks.size >= 50_000) marks.clear();
  marks.set(taskId, ++counter);
}
/** `followUpJournaled` for an event, if it is a journal entry. */
export function noteFollowUpEvent(event: Pick<KarmaxEvent, 'taskId' | 'type'>): boolean {
  if (!JOURNAL_TYPES.has(event.type)) return false;
  followUpJournaled(event.taskId);
  return true;
}
/** This process now hears about every follow-up journal entry. */
export function wireFollowUpWakes(): void { wired = true; }
/** The latest mark for `taskId`, or undefined when marks are not wired. */
export function followUpMark(taskId: string): number | undefined {
  return wired ? marks.get(taskId) ?? 0 : undefined;
}
