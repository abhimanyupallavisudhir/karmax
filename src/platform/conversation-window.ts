import { createHash } from 'node:crypto';
import type { Message, TaskView } from '../domain/types.js';

// The console's task page reads the newest messages of a conversation, and
// earlier ones only as the reader asks for them (wiki ops/performance-history,
// "Task page with a long conversation"). A month-long task (pramana#137: 940
// messages) made every open and every refresh carry 2.3 MB, the Do transcript
// twice, and made the page redraw every message on every event.

/** The most messages one read returns. */
export const CONVERSATION_WINDOW_MAX = 1000;

type Transcript = { role: string; label: string; messages: Message[] };
type Conversation = { messages?: Message[]; transcripts?: Transcript[] };

export interface ConversationWindow {
  /** Changes whenever a message of the window changes or one is added. */
  revision: string;
  /** Per transcript (`do` is `messages`): the index of the first message read, and how many there are. */
  roles: Record<string, { from: number; total: number }>;
  /** The caller's `known` revision is still current: `messages` and `transcripts` are left out. */
  unchanged?: true;
}

export type WindowedConversation<T extends Conversation> = Omit<T, 'messages' | 'transcripts'> & {
  messages?: Message[];
  /** The Do transcript is `messages` itself, so it says so instead of repeating them. */
  transcripts?: ({ role: string; label: string } & ({ messages: Message[] } | { sameAsMessages: true }))[];
  conversationWindow: ConversationWindow;
};

/** `view` with only the newest `size` messages of each transcript. `known`: the
 * revision the caller holds; when it is current the messages are left out. */
export function windowedConversation<T extends Conversation>(view: T, size: number, known?: string): WindowedConversation<T> {
  const { messages = [], transcripts, ...rest } = view;
  const roles: ConversationWindow['roles'] = {};
  const tail = (role: string, all: Message[]) => {
    const from = Math.max(0, all.length - size);
    roles[role] = { from, total: all.length };
    return all.slice(from);
  };
  const windowMessages = tail('do', messages);
  // In every workflow the Do transcript is `messages` (TaskView.transcripts).
  const windowTranscripts = transcripts?.map(({ role, label, messages: own }) => role === 'do'
    ? { role, label, sameAsMessages: true as const }
    : { role, label, messages: tail(role, own) });
  const revision = createHash('sha256')
    .update(JSON.stringify([size, roles, windowMessages, windowTranscripts]))
    .digest('base64url').slice(0, 22);
  if (known === revision) return { ...rest, conversationWindow: { revision, unchanged: true, roles } };
  return { ...rest, messages: windowMessages, ...(windowTranscripts ? { transcripts: windowTranscripts } : {}),
    conversationWindow: { revision, roles } };
}

/** The `limit` messages of `role`'s transcript before index `before`. */
export function conversationSlice(view: Pick<TaskView, 'messages' | 'transcripts'>, role: string, before: number, limit: number)
  : { role: string; from: number; total: number; messages: Message[] } {
  const all = role === 'do' ? view.messages ?? [] : view.transcripts?.find((transcript) => transcript.role === role)?.messages ?? [];
  const end = Math.max(0, Math.min(before, all.length));
  const from = Math.max(0, end - limit);
  return { role, from, total: all.length, messages: all.slice(from, end) };
}

/** A `messages`/`limit` query value: 0 when absent, null when it is not a
 * whole number from 1 to CONVERSATION_WINDOW_MAX. */
export function conversationWindowSize(raw: string | null): number | null {
  if (raw === null || raw === '') return 0;
  const size = Number(raw);
  return Number.isSafeInteger(size) && size >= 1 && size <= CONVERSATION_WINDOW_MAX ? size : null;
}
