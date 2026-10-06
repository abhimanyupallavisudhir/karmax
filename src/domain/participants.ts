/**
 * The agents of one task and their shared conversation (software-dev ≥1.27).
 *
 * A task is ONE conversation with several speakers: the main agent, the
 * Responder and Reviewer agents the workflow calls, and any agent a person (or
 * another agent) calls in with `@`. Every agent works in the task's world with
 * its own provider session, and is handed the conversation as it happened —
 * the other speakers' messages labelled with who said them — instead of a
 * templated digest. Only one agent works at a time; an agent called while
 * another is mid-turn waits in the task's queue.
 *
 * Pure (no Node imports): the workflow sandbox, activities, gateway and tests
 * share it.
 */
import type { AgentRole, Message } from './types.js';

/** The main agent's key. Messages without an `author` are its own. */
export const MAIN_AGENT = 'do';
/** Recipient selector prefix for agents (`agent:do`, `agent:responder`…). */
export const AGENT_SELECTOR = 'agent:';

const KEY = /^(do|responder|confirm(?:-[2-9]|-[1-9][0-9])?|agent-[1-9][0-9]{0,2})$/;

export function isParticipantKey(key: unknown): key is string {
  return typeof key === 'string' && KEY.test(key);
}

/** The workflow role a participant runs under: its prompt and its duties. */
export function participantRole(key: string): AgentRole {
  if (key === MAIN_AGENT) return 'do';
  if (key === 'responder') return 'responder';
  if (key.startsWith('confirm')) return 'confirm';
  return 'agent';
}

/** What people call it. Reviewers are numbered from the second. */
export function participantLabel(key: string): string {
  if (key === MAIN_AGENT) return 'Agent';
  if (key === 'responder') return 'Responder';
  if (key === 'confirm') return 'Reviewer';
  const review = /^confirm-(\d+)$/.exec(key);
  if (review) return `Reviewer ${review[1]}`;
  const agent = /^agent-(\d+)$/.exec(key);
  return agent ? `Agent ${agent[1]}` : key;
}

/** Participant key of the reviewer playing agent Review layer `agentIndex`
 * (0-based among the route's agent layers). */
export function reviewerKey(agentIndex: number): string {
  return agentIndex <= 0 ? 'confirm' : `confirm-${agentIndex + 1}`;
}

/** The next free key for an agent called in with `@`, numbered after every
 * agent the task already lists so `[n] Agent n` lines up in the picker. */
export function nextAgentKey(existing: readonly string[]): string {
  const used = new Set(existing);
  for (let n = Math.max(1, existing.length); n < 1000; n++) {
    if (!used.has(`agent-${n}`)) return `agent-${n}`;
  }
  throw new Error('a task can have at most 999 agents');
}

export function agentSelector(key: string): string {
  return `${AGENT_SELECTOR}${key}`;
}

/** The participant a recipient selector names, or undefined for people. */
export function selectorAgent(selector: string): string | undefined {
  if (!selector.startsWith(AGENT_SELECTOR)) return undefined;
  const key = selector.slice(AGENT_SELECTOR.length);
  return isParticipantKey(key) ? key : undefined;
}

export function messageAuthor(m: Pick<Message, 'role' | 'author'>): string | undefined {
  if (m.role === 'agent') return m.author && isParticipantKey(m.author) ? m.author : MAIN_AGENT;
  return m.author;
}

/** Whether `m` calls agent `key` (asks it to take a turn). A message with no
 * recipients is for the main agent, as every message was before 1.27. */
export function addressedTo(m: Pick<Message, 'role' | 'author' | 'to'>, key: string): boolean {
  if (m.role === 'agent' && messageAuthor(m) === key) return false;
  if (!m.to) return key === MAIN_AGENT && !(m.role === 'agent' && messageAuthor(m) !== MAIN_AGENT);
  return m.to.includes(agentSelector(key));
}

/** The agents `m` calls, in mention order. */
export function calledAgents(m: Pick<Message, 'role' | 'author' | 'to'>): string[] {
  if (!m.to) return addressedTo(m, MAIN_AGENT) ? [MAIN_AGENT] : [];
  const out: string[] = [];
  for (const selector of m.to) {
    const key = selectorAgent(selector);
    if (key && !out.includes(key) && addressedTo(m, key)) out.push(key);
  }
  return out;
}

/** The people `m` mentions (everything in `to` that is not an agent). */
export function mentionedPeople(m: Pick<Message, 'to'>): string[] {
  return [...new Set((m.to ?? []).filter((selector) => !selector.startsWith(AGENT_SELECTOR)))];
}

/**
 * The recipients of a message typed in a composer: `mentions` are the
 * selectors in the order they first appear in the text. Text before the first
 * mention is spoken to the default recipient (the main agent), which then goes
 * first; a message that starts with a mention reaches only those mentioned.
 */
export function composeRecipients(text: string, mentions: Array<{ selector: string; index: number }>,
  defaultRecipient = agentSelector(MAIN_AGENT)): string[] {
  const ordered = [...mentions].sort((a, b) => a.index - b.index);
  const first = ordered[0]?.index ?? text.length;
  const out: string[] = [];
  if (!ordered.length || text.slice(0, first).trim()) out.push(defaultRecipient);
  for (const mention of ordered) if (!out.includes(mention.selector)) out.push(mention.selector);
  return out;
}

/**
 * The conversation as agent `key` receives it: its own replies stay its own
 * (`agent`), and everything anyone else said becomes input (`user`) prefixed
 * with the speaker, so a resumed or freshly started provider session reads one
 * natural multi-party thread. One output message per input message, so indices
 * (delivered counts, live-delivery cursors) mean the same in both arrays.
 */
export function conversationFor(messages: readonly Message[], key: string,
  labelOf: (participant: string) => string = participantLabel,
  workOf?: (m: Message) => string | undefined): Message[] {
  return messages.map((m) => {
    if (m.role === 'system') return m;
    const author = messageAuthor(m);
    if (m.role === 'agent') {
      if (author === key) return m;
      // What it did on the way, compactly (commands, edits, tools), so the
      // thread reads like the one people see, without its full output.
      const work = workOf?.(m);
      return { ...m, role: 'user', text: `${labelOf(author!)}: ${work ? `${work}\n` : ''}${m.text}` };
    }
    const speaker = m.authorLabel?.trim();
    const label = speaker && m.author ? `${speaker}: ` : '';
    return label ? { ...m, text: `${label}${m.text}` } : m;
  });
}

/** Agents to call next, appended in order without duplicates; the running
 * agent is not re-queued by its own message. */
export function enqueueAgents(queue: readonly string[], keys: readonly string[], running?: string): string[] {
  const out = [...queue];
  for (const key of keys) if (key !== running && !out.includes(key)) out.push(key);
  return out;
}

/** One line summarising an agent turn's work items for the other agents:
 * `(ran \`npm test\` ✓; edited src/a.ts; used browser ✗ …)`. */
export function workDigest(items: ReadonlyArray<{ kind?: string; title?: string; phase?: string }>, max = 30): string | undefined {
  const done = items.filter((item) => item.title && ['command', 'file', 'tool', 'search', 'subagent'].includes(item.kind ?? '')
    && (item.phase === 'completed' || item.phase === 'failed'));
  if (!done.length) return undefined;
  const clip = (text: string) => (text.length > 120 ? `${text.slice(0, 119)}…` : text);
  const shown = done.slice(-max).map((item) => {
    const mark = item.phase === 'failed' ? ' ✗' : '';
    const title = clip(item.title!.replace(/\s+/g, ' ').trim());
    return item.kind === 'command' ? `ran \`${title}\`${mark}` : `${title}${mark}`;
  });
  return `(${done.length > max ? `… ${done.length - max} earlier steps; ` : ''}${shown.join('; ')})`;
}
