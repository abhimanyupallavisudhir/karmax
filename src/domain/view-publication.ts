import type { Message, TaskView } from './types.js';

export type ViewConversation = Pick<TaskView, 'messages' | 'transcripts'>;
export type PublishedView = Omit<TaskView, 'messages' | 'transcripts'> & Partial<ViewConversation>
  & { conversationPatch?: ConversationPatch;
    /** Earlier snapshots of the run that a delta or a turn may still read;
     * the store keeps them when this publication supersedes them. */
    conversationRetain?: string[] };

/** A transcript as the first `keep` messages of the base snapshot's transcript
 * plus `append`. Conversations mostly grow at the end, so this is the delta. */
interface TranscriptPatch { keep: number; append: Message[] }

/** A conversation expressed against an acknowledged snapshot, so publishing a
 * turn costs its new messages instead of the whole transcript (WF-4). */
export interface ConversationPatch {
  base: string;
  messages: TranscriptPatch;
  /** `sameAsMessages` marks the Do transcript, which is the `messages` array. */
  transcripts?: ({ role: string; label: string } & (TranscriptPatch | { sameAsMessages: true }))[];
}

/** Where a turn's transcript starts: the first `count` messages of `role` in
 * an acknowledged conversation snapshot. The turn's `messages` are the rest. */
export interface TurnConversationBase { reference: string; role: string; count: number }

function sharedPrefix(base: Message[], next: Message[]): number {
  let keep = 0;
  while (keep < base.length && keep < next.length && JSON.stringify(base[keep]) === JSON.stringify(next[keep])) keep++;
  return keep;
}

export function transcriptOf(conversation: ViewConversation, role: string): Message[] {
  return role === 'do' ? conversation.messages
    : conversation.transcripts?.find((transcript) => transcript.role === role)?.messages ?? [];
}

function diffTranscript(base: Message[], next: Message[]): TranscriptPatch {
  const keep = sharedPrefix(base, next);
  return { keep, append: next.slice(keep) };
}

export function diffConversation(base: ViewConversation, next: ViewConversation, reference: string): ConversationPatch {
  return {
    base: reference,
    messages: diffTranscript(base.messages, next.messages),
    ...(next.transcripts ? { transcripts: next.transcripts.map(({ role, label, messages }) => messages === next.messages
      ? { role, label, sameAsMessages: true as const }
      : { role, label, ...diffTranscript(transcriptOf(base, role), messages) }) } : {}),
  };
}

export function applyConversationPatch(base: ViewConversation, patch: ConversationPatch): ViewConversation {
  const apply = (from: Message[], { keep, append }: TranscriptPatch) => [...from.slice(0, keep), ...append];
  const messages = apply(base.messages, patch.messages);
  return {
    messages,
    ...(patch.transcripts ? { transcripts: patch.transcripts.map((transcript) => ({
      role: transcript.role, label: transcript.label,
      messages: 'sameAsMessages' in transcript ? messages : apply(transcriptOf(base, transcript.role), transcript),
    })) } : {}),
  };
}

/** One page of a conversation snapshot, at most `limitBytes` of messages
 * (one larger message still makes progress). `offset` counts messages across
 * the Do transcript and then every other role's transcript, in order, so a
 * continued run can read a transcript larger than one activity payload. */
export function conversationPage(conversation: ViewConversation, offset: number, limitBytes: number)
  : { roles: { role: string; messages: Message[] }[]; next?: number } {
  const transcripts = [{ role: 'do', messages: conversation.messages },
    ...(conversation.transcripts ?? []).filter((transcript) => transcript.role !== 'do')];
  const roles: { role: string; messages: Message[] }[] = [];
  let position = 0, bytes = 0, taken = 0;
  for (const { role, messages } of transcripts) {
    for (const message of messages) {
      if (position++ < offset) continue;
      const size = JSON.stringify(message).length;
      if (taken && bytes + size > limitBytes) return { roles, next: offset + taken };
      if (roles.at(-1)?.role !== role) roles.push({ role, messages: [] });
      roles.at(-1)!.messages.push(message);
      bytes += size;
      taken++;
    }
  }
  return { roles };
}

export type ConversationPublisher = ((view: TaskView) => Promise<void>) & {
  /** How `messages` extends the last acknowledged snapshot, when it does. */
  turnBase(messages: Message[], role: string): { base?: TurnConversationBase; messages: Message[] };
  /** The acknowledged snapshot's reference, if it is exactly this conversation. */
  acknowledges(view: ViewConversation): string | undefined;
  /** Adopt a snapshot acknowledged by an earlier run of the same task. */
  seed(reference: string, conversation: ViewConversation): void;
};

/** Keep immutable conversations out of repeated status activity arguments.
 * References are scoped to a workflow run and never depend on the mutable UI
 * projection. Replays rebuild this cache; only acknowledged writes are reused.
 * With `patches`, a changed conversation is written as a delta against the
 * previous snapshot; it is consulted only when a delta would be written. */
export function conversationPublisher(
  runId: string,
  write: (view: PublishedView, reference: string) => Promise<unknown>,
  options: { patches?: () => boolean } = {},
): ConversationPublisher {
  let previous: { json: string; reference: string; conversation: ViewConversation } | undefined;
  let revision = 0;
  // What the run may still read, so the store never drops it: each write in
  // flight and its delta base, each role's current turn base, and, once deltas
  // are written, the acknowledged snapshot the next delta will be based on.
  let deltas = false;
  const inFlight = new Map<number, string[]>();
  const turnBases = new Map<string, string>();
  let writes = 0;
  const publish = async (view: TaskView) => {
    const { messages, transcripts, ...status } = view;
    const json = JSON.stringify({ messages, transcripts });
    const cached = previous?.json === json ? previous : undefined;
    const reference = cached?.reference ?? `${runId}:${revision++}`;
    const conversation: ViewConversation = JSON.parse(json);
    const delta = !cached && previous && options.patches?.();
    if (delta) deltas = true;
    const id = writes++;
    inFlight.set(id, delta ? [reference, previous!.reference] : [reference]);
    const conversationRetain = [...new Set([...(deltas && previous ? [previous.reference] : []),
      ...[...inFlight.values()].flat(), ...turnBases.values()])].filter((held) => held !== reference);
    try {
      await write({ ...(cached ? status
        : delta ? { ...status, conversationPatch: diffConversation(previous!.conversation, { messages, transcripts }, previous!.reference) }
          : { ...status, ...conversation }), conversationRetain }, reference);
    } finally { inFlight.delete(id); }
    previous = { json, reference, conversation };
  };
  return Object.assign(publish, {
    turnBase(messages: Message[], role: string) {
      const count = previous ? sharedPrefix(transcriptOf(previous.conversation, role), messages) : 0;
      // A role runs one turn at a time: its next turn releases this base.
      if (count && previous) turnBases.set(role, previous.reference);
      else turnBases.delete(role);
      return count && previous
        ? { base: { reference: previous.reference, role, count }, messages: messages.slice(count) }
        : { messages };
    },
    acknowledges({ messages, transcripts }: ViewConversation) {
      return previous?.json === JSON.stringify({ messages, transcripts }) ? previous.reference : undefined;
    },
    seed(reference: string, { messages, transcripts }: ViewConversation) {
      const json = JSON.stringify({ messages, transcripts });
      previous = { json, reference, conversation: JSON.parse(json) };
      deltas = true;
    },
  });
}

/** Only lifecycle routing/state crosses the maintenance activity boundary. */
export type LifecyclePublication = Pick<TaskView, 'world' | 'stage' | 'status' | 'waitingFor' | 'updatedAt'> & {
  state: { recoveryWorld?: unknown };
};

export function lifecyclePublication(view: PublishedView): LifecyclePublication {
  return { world: view.world, stage: view.stage, status: view.status,
    waitingFor: view.waitingFor, updatedAt: view.updatedAt,
    state: { recoveryWorld: view.state?.recoveryWorld } };
}

/** The payload of a `view.updated` event: the task lifecycle feed that
 * dependency triggers, the inbox, completion stamps, collaboration requests
 * and live consoles follow. One builder, so every writer reports alike. */
export function lifecycleEventPayload(view: Pick<TaskView, 'stage' | 'status' | 'waitingFor' | 'agentTurn'>) {
  return {
    stage: view.stage,
    status: view.status,
    waitingFor: view.waitingFor?.kind ?? null,
    waitingDetail: view.waitingFor?.detail ?? null,
    waitingSummary: view.waitingFor?.summary ?? null,
    waitingProvider: view.waitingFor?.provider ?? null,
    waitingResetAt: view.waitingFor?.earliestResetAt ?? null,
    waitingUntil: view.waitingFor?.until ?? null,
    agentTurn: view.agentTurn?.state ?? null,
    agentRole: view.agentTurn?.role ?? null,
  };
}

/** These waits still own live work or are about to enter a turn (a retry after
 * an infrastructure failure is seconds to minutes away). */
export function hasLiveWorldWork(view: Pick<TaskView, 'waitingFor'>): boolean {
  return view.waitingFor?.kind === 'agentSlot' || view.waitingFor?.kind === 'subagent'
    || view.waitingFor?.kind === 'shell' || view.waitingFor?.kind === 'retry';
}
