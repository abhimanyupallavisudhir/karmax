import type { Message, TaskView } from './types.js';

export type ViewConversation = Pick<TaskView, 'messages' | 'transcripts'>;
export type PublishedView = Omit<TaskView, 'messages' | 'transcripts'> & Partial<ViewConversation>
  & { conversationPatch?: ConversationPatch };

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

export type ConversationPublisher = ((view: TaskView) => Promise<void>) & {
  /** How `messages` extends the last acknowledged snapshot, when it does. */
  turnBase(messages: Message[], role: string): { base?: TurnConversationBase; messages: Message[] };
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
  const publish = async (view: TaskView) => {
    const { messages, transcripts, ...status } = view;
    const json = JSON.stringify({ messages, transcripts });
    const cached = previous?.json === json ? previous : undefined;
    const reference = cached?.reference ?? `${runId}:${revision++}`;
    const conversation: ViewConversation = JSON.parse(json);
    await write(cached ? status
      : previous && options.patches?.()
        ? { ...status, conversationPatch: diffConversation(previous.conversation, { messages, transcripts }, previous.reference) }
        : { ...status, ...conversation }, reference);
    previous = { json, reference, conversation };
  };
  return Object.assign(publish, {
    turnBase(messages: Message[], role: string) {
      const count = previous ? sharedPrefix(transcriptOf(previous.conversation, role), messages) : 0;
      return count && previous
        ? { base: { reference: previous.reference, role, count }, messages: messages.slice(count) }
        : { messages };
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

/** These waits still own live work or are about to enter a turn. */
export function hasLiveWorldWork(view: Pick<TaskView, 'waitingFor'>): boolean {
  return view.waitingFor?.kind === 'agentSlot' || view.waitingFor?.kind === 'subagent'
    || view.waitingFor?.kind === 'shell';
}
