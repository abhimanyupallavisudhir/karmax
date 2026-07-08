import { Message } from '../domain/types.js';
import type { TurnInput } from './types.js';

/**
 * The messages an adapter should actually deliver to the provider this turn.
 *
 * A stateful provider session (Claude Agent SDK, Codex thread/response) already
 * holds the whole prior conversation server-side. So when we RESUME one, the only
 * thing new to say is the messages added since it last advanced — NOT the entire
 * transcript. The two historical bugs this guards against:
 *   • Re-sending everything (the old Claude Agent-SDK path) wastes tokens every
 *     turn and folds the agent's OWN past replies back in as if they were fresh
 *     user input — a follow-up became "here is the whole conversation again".
 *   • Sending only the single latest message (the old Codex path) silently DROPS
 *     any others queued since the last turn — e.g. a human follow-up plus a
 *     drained sub-task event both arriving before the agent's next turn.
 *
 * `deliveredMessages` is how many leading `messages` the resumed session already
 * contains (the workflow sets it to the count sent on prior turns); everything
 * after that boundary is the delta to send now.
 *
 * On a FRESH session — or a fork, which branches from a *different* session's
 * history — we send the full transcript so the new session is seeded with the
 * entire conversation. Stateless paths (the Anthropic Messages API) must likewise
 * rebuild the full history every call and so do NOT use this helper.
 */
export function messagesToDeliver(input: TurnInput): Message[] {
  const resuming = !!input.session && !input.fork;
  if (!resuming) return input.messages;
  const delivered = Math.min(Math.max(input.deliveredMessages ?? 0, 0), input.messages.length);
  return input.messages.slice(delivered);
}
