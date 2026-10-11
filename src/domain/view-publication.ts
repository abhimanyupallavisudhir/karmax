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

export function transcriptOf(conversation: ViewConversation, role: string): Message[] {
  return role === 'do' ? conversation.messages
    : conversation.transcripts?.find((transcript) => transcript.role === role)?.messages ?? [];
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

/** A message's identity for change detection: the length of its JSON and two
 * independent 32-bit hashes of it (FNV-1a and a Murmur-style mix). Deciding
 * which messages a snapshot already has needs only this, so a publisher keeps
 * these instead of a copy of the conversation (RT-35). Treating a changed
 * message as unchanged takes a 64-bit collision between two versions of the
 * message at the same position, and would only stale that task's own view. */
function fingerprint(message: Message): string {
  const json = JSON.stringify(message);
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return `${json.length.toString(36)}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

/** The fingerprints of a conversation, shaped like it. */
interface ConversationPrint {
  messages: string[];
  transcripts?: { role: string; label: string; messages: string[] }[];
}

function printOf({ messages, transcripts }: ViewConversation): ConversationPrint {
  const prints = messages.map(fingerprint);
  return { messages: prints, ...(transcripts ? { transcripts: transcripts.map(({ role, label, messages: own }) =>
    ({ role, label, messages: own === messages ? prints : own.map(fingerprint) })) } : {}) };
}

function printedTranscript(print: ConversationPrint, role: string): string[] {
  return role === 'do' ? print.messages : print.transcripts?.find((transcript) => transcript.role === role)?.messages ?? [];
}

function printedPrefix(base: string[], next: string[]): number {
  let keep = 0;
  while (keep < base.length && keep < next.length && base[keep] === next[keep]) keep++;
  return keep;
}

/** How `next` extends the base snapshot, from the base's fingerprints: per
 * transcript, the shared prefix to keep and the messages to append. */
function diffPrinted(base: ConversationPrint, print: ConversationPrint, next: ViewConversation, reference: string): ConversationPatch {
  const patch = (from: string[], to: string[], messages: Message[]): TranscriptPatch => {
    const keep = printedPrefix(from, to);
    return { keep, append: messages.slice(keep) };
  };
  return {
    base: reference,
    messages: patch(base.messages, print.messages, next.messages),
    ...(next.transcripts ? { transcripts: next.transcripts.map(({ role, label, messages }, index) => messages === next.messages
      ? { role, label, sameAsMessages: true as const }
      : { role, label, ...patch(printedTranscript(base, role), print.transcripts![index]!.messages, messages) }) } : {}),
  };
}

/** Keep immutable conversations out of repeated status activity arguments.
 * References are scoped to a workflow run and never depend on the mutable UI
 * projection. Replays rebuild this cache; only acknowledged writes are reused.
 * With `patches`, a changed conversation is written as a delta against the
 * previous snapshot; it is consulted only when a delta would be written.
 *
 * It remembers the last snapshot only as fingerprints: workflows stay cached
 * for weeks in the worker's workflow heap, and a copy of every conversation
 * there was what exhausted it (RT-35). The patches it writes are the ones a
 * copy would produce, so replay schedules the same activities. */
export function conversationPublisher(
  runId: string,
  write: (view: PublishedView, reference: string) => Promise<unknown>,
  options: { patches?: () => boolean } = {},
): ConversationPublisher {
  let previous: { key: string; reference: string; print: ConversationPrint } | undefined;
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
    const print = printOf({ messages, transcripts });
    const key = JSON.stringify(print);
    const cached = previous?.key === key ? previous : undefined;
    const reference = cached?.reference ?? `${runId}:${revision++}`;
    const delta = !cached && previous && options.patches?.();
    if (delta) deltas = true;
    const id = writes++;
    inFlight.set(id, delta ? [reference, previous!.reference] : [reference]);
    const conversationRetain = [...new Set([...(deltas && previous ? [previous.reference] : []),
      ...[...inFlight.values()].flat(), ...turnBases.values()])].filter((held) => held !== reference);
    try {
      await write({ ...(cached ? status
        : delta ? { ...status, conversationPatch: diffPrinted(previous!.print, print, { messages, transcripts }, previous!.reference) }
          // A full write still serializes once at the activity boundary, so
          // later in-place edits of `messages` cannot reach a pending write.
          : { ...status, ...JSON.parse(JSON.stringify({ messages, transcripts })) as ViewConversation }), conversationRetain }, reference);
    } finally { inFlight.delete(id); }
    previous = { key, reference, print };
  };
  return Object.assign(publish, {
    turnBase(messages: Message[], role: string) {
      const count = previous ? printedPrefix(printedTranscript(previous.print, role), messages.map(fingerprint)) : 0;
      // A role runs one turn at a time: its next turn releases this base.
      if (count && previous) turnBases.set(role, previous.reference);
      else turnBases.delete(role);
      return count && previous
        ? { base: { reference: previous.reference, role, count }, messages: messages.slice(count) }
        : { messages };
    },
    acknowledges(conversation: ViewConversation) {
      return previous?.key === JSON.stringify(printOf(conversation)) ? previous.reference : undefined;
    },
    seed(reference: string, conversation: ViewConversation) {
      const print = printOf(conversation);
      previous = { key: JSON.stringify(print), reference, print };
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
    // Only an ask that states its urgency carries one: the inbox keeps the
    // level an ask was raised at when a later tick says nothing.
    ...(view.waitingFor?.urgency ? { urgency: view.waitingFor.urgency } : {}),
    agentTurn: view.agentTurn?.state ?? null,
    agentRole: view.agentTurn?.role ?? null,
  };
}

/** A wait on durable jobs needs its world running: parking would freeze them.
 * `job` waits before `jobs` was recorded still say so by their kind. */
export function watchesJobs(view: Pick<TaskView, 'waitingFor'>): boolean {
  return view.waitingFor?.kind === 'job' || Boolean(view.waitingFor?.jobs?.length);
}

/** These waits still own live work or are about to enter a turn (a retry after
 * an infrastructure failure is seconds to minutes away). */
export function hasLiveWorldWork(view: Pick<TaskView, 'waitingFor'>): boolean {
  return view.waitingFor?.kind === 'agentSlot' || view.waitingFor?.kind === 'subagent'
    || view.waitingFor?.kind === 'shell' || view.waitingFor?.kind === 'retry';
}
